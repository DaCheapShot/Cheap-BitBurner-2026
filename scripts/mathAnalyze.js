import { MONEY_TOLERANCE, SEC_TOLERANCE } from "./config.js";
import { rpc } from "./rpc.js";

/**
 * Math interface backed by the *Analyze API, reached entirely through rpc.js.
 *
 * This is the always-available implementation: it needs no programs and works
 * from minute one of a BitNode. It is also honestly approximate - see
 * growThreadsToRestore.
 *
 * RAM charged to whoever imports this: 1.00 GB, all of it rpc.js's ns.run.
 * Every *Analyze function is named only inside an rpc body, which is a string
 * literal to the RAM calculator, so none of them is billed here. It was 2.55
 * when the calls were resident.
 *
 * TWO ns CALLS PER CYCLE, NOT SEVEN. snapshot() fetches the four getServer*
 * fields, the three op times, hackAnalyze AND the growth constant in one round
 * trip, because the body-taking form of rpc() makes a bundle cost exactly what
 * a single value costs. Everything downstream then reads the snapshot and stays
 * SYNCHRONOUS - which is the whole reason this module can change without an
 * async cascade through managerCore and prepper.
 */

export const NAME = "analyze";

let consts = null;

/**
 * Measure the three per-thread security constants. Called once at startup.
 *
 * All three are linear in threads and independent of the target's state, which
 * is what made caching them safe - and is equally what makes one rpc call at
 * startup enough. NO HOST ARGUMENT on either *AnalyzeSecurity: with one they
 * cap their result by the threads needed to reach max money, so on a PREPPED
 * target growthAnalyzeSecurity returns ~0 and weaken-2 gets sized at 1 thread
 * instead of the ~51 actually needed.
 */
export async function prepare(ns) {
  try {
    consts = await rpc(ns, `
      return {
        weakenPerThread: ns.weakenAnalyze(1),
        hackSecPerThread: ns.hackAnalyzeSecurity(1),
        growSecPerThread: ns.growthAnalyzeSecurity(1),
      };
    `);
  } catch (e) {
    return { ok: false, error: `could not measure the security constants: ${e.message ?? e}` };
  }
  // A transient that returned a shape this does not recognise must stop the
  // manager here, not propagate an undefined into thread math as NaN - which is
  // the check the calibration cache's own loader existed to make.
  if (!(consts?.weakenPerThread > 0) || !(consts?.hackSecPerThread > 0) || !(consts?.growSecPerThread > 0)) {
    return { ok: false, error: `security constants came back unusable: ${JSON.stringify(consts)}` };
  }
  return { ok: true };
}

/**
 * Everything the planner needs about a host, in ONE round trip.
 *
 * growthLogK is the load-bearing one. src/Server/ServerHelpers.ts:
 *
 *     numCycleForGrowth(server, growth) = Math.log(growth) / calculateServerGrowthLog(...)
 *
 * The divisor does not depend on `growth`, and there is no rounding or clamping
 * anywhere in it - so growthAnalyze is EXACTLY logarithmic in its multiplier.
 * One call therefore yields the constant, and growThreadsToRestore can answer
 * any multiplier from it locally, with the same number a live call would give
 * at this security.
 *
 * That is the same identity calibrate.js used (growBase = 2 ** (1 / growthAnalyze
 * (host, 2))), but measured per snapshot instead of cached per session, so there
 * is no drifted-host case to guard against - the constant is always read at the
 * security it is about to be used at.
 *
 * ns is re-attached AFTER the round trip: it cannot survive JSON, and nothing
 * downstream needs it any more, but prepper and managerCore still read snap.ns
 * in a few places and the formulas snapshot carries it too.
 */
export async function snapshot(ns, host) {
  const s = await rpc(ns, `
    const host = args[0];
    return {
      maxMoney: ns.getServerMaxMoney(host),
      money: ns.getServerMoneyAvailable(host),
      minSec: ns.getServerMinSecurityLevel(host),
      sec: ns.getServerSecurityLevel(host),
      hackFraction: ns.hackAnalyze(host),
      growthLogK: Math.log(2) / ns.growthAnalyze(host, 2),
      times: {
        hack: ns.getHackTime(host),
        grow: ns.getGrowTime(host),
        weaken: ns.getWeakenTime(host),
      },
    };
  `, host);

  return {
    ns, host, ...s,
    moneyOk: s.money >= s.maxMoney * MONEY_TOLERANCE,
    secOk: s.sec <= s.minSec + SEC_TOLERANCE,
  };
}

/**
 * Max money for many hosts at once.
 *
 * Bundled rather than per-host because rankTargets asks about the WHOLE rooted
 * network - about seventy hosts. Seventy rpc calls would be seventy script
 * launches per cycle, each one a chance for ns.run to return 0 on a busy home,
 * to answer a question one call already answers.
 */
export async function maxMoneyOfAll(ns, hosts) {
  return rpc(ns, `
    const out = {};
    for (const h of args) out[h] = ns.getServerMaxMoney(h);
    return out;
  `, ...hosts);
}

/** From the snapshot, so it moves with hacking level exactly as a live call does. */
export function hackFractionPerThread(snap) {
  return snap.hackFraction;
}

// Measured once by prepare(), above.
export function securityPerHackThread() { return consts.hackSecPerThread; }
export function securityPerGrowThread() { return consts.growSecPerThread; }
export function securityPerWeakenThread() { return consts.weakenPerThread; }

/**
 * Grow threads to take money from fromMoney to toMoney.
 *
 * APPROXIMATE, deliberately and unavoidably. growthLogK was measured at the
 * snapshot's security, so the atSecurity argument cannot be honoured - it is
 * accepted only so this signature matches mathFormulas, which can. When the two
 * disagree, formulas is right.
 *
 * log(mult) / growthLogK is what ns.growthAnalyze(host, mult) would return, by
 * the identity in snapshot() above - not an approximation of it.
 */
export function growThreadsToRestore(snap, fromMoney, toMoney, atSecurity) {
  const from = Math.max(fromMoney, 1);
  const to = Math.min(toMoney, snap.maxMoney);
  if (to <= from) return 0;
  return Math.log(to / from) / snap.growthLogK;
}

export function opTimes(snap) {
  return snap.times;
}
