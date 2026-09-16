import { MONEY_TOLERANCE, SEC_TOLERANCE } from "./config.js";
import { rpc } from "./rpc.js";

/**
 * Math interface backed by the *Analyze API plus the calibration cache.
 *
 * This is the always-available implementation: it needs no programs and works
 * from minute one of a BitNode. It is also honestly approximate - see
 * growThreadsToRestore.
 *
 * RAM charged to whoever imports this:
 *   4x getServer* 0.40 + hackAnalyze 1.00 + growthAnalyze 1.00
 *   + getHackTime/getGrowTime/getWeakenTime 0.15 + rpc.js 1.00
 *   = 3.55 GB   (config.js is 0 GB)
 *
 * The three per-thread security constants USED to live in /data/calib.json,
 * written by a calibrate.js transient, purely so this module would not import
 * weakenAnalyze, hackAnalyzeSecurity and growthAnalyzeSecurity at 1.00 GB each.
 * They are read once, at startup, which makes them the cheapest possible rpc
 * call - so the cache, its writer, its staleness guard and boot's refresh phase
 * are all gone, at a cost of the 1.00 GB ns.run that rpc.js carries.
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

export function snapshot(ns, host) {
  const maxMoney = ns.getServerMaxMoney(host);
  const money = ns.getServerMoneyAvailable(host);
  const minSec = ns.getServerMinSecurityLevel(host);
  const sec = ns.getServerSecurityLevel(host);
  return {
    ns, host, maxMoney, money, minSec, sec,
    moneyOk: money >= maxMoney * MONEY_TOLERANCE,
    secOk: sec <= minSec + SEC_TOLERANCE,
  };
}

/**
 * Max money of a host, without building a full snapshot.
 *
 * For scanning many candidates (pickTarget, the retarget check). Kept separate
 * so the formulas build never needs ns.getServerMaxMoney, which is its only
 * remaining use and would cost it 0.10 GB for nothing.
 */
export function maxMoneyOf(ns, host) {
  return ns.getServerMaxMoney(host);
}

/** Live: moves with hacking level, which is why it is never cached. */
export function hackFractionPerThread(snap) {
  return snap.ns.hackAnalyze(snap.host);
}

// Measured once by prepare(), above.
export function securityPerHackThread() { return consts.hackSecPerThread; }
export function securityPerGrowThread() { return consts.growSecPerThread; }
export function securityPerWeakenThread() { return consts.weakenPerThread; }

/**
 * Grow threads to take money from fromMoney to toMoney.
 *
 * APPROXIMATE, deliberately and unavoidably. growthAnalyze evaluates at the
 * target's CURRENT security, so the atSecurity argument cannot be honoured -
 * it is accepted only so this signature matches mathFormulas, which can. When
 * the two disagree, formulas is right.
 *
 * Always a live growthAnalyze. There used to be a cached growth base to prefer,
 * but it carried no information this call does not: calibrate.js computed it as
 * 2 ** (1 / growthAnalyze(host, 2)) at minimum security, so the two agree
 * exactly in the only state the cache was ever used in, and the live call is
 * strictly better when the host has drifted. growthAnalyze is charged to this
 * module either way.
 */
export function growThreadsToRestore(snap, fromMoney, toMoney, atSecurity) {
  const from = Math.max(fromMoney, 1);
  const to = Math.min(toMoney, snap.maxMoney);
  if (to <= from) return 0;
  const mult = to / from;
  return snap.ns.growthAnalyze(snap.host, mult);
}

export function opTimes(snap) {
  return {
    hack: snap.ns.getHackTime(snap.host),
    grow: snap.ns.getGrowTime(snap.host),
    weaken: snap.ns.getWeakenTime(snap.host),
  };
}
