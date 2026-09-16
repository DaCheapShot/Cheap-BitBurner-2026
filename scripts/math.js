import { MONEY_TOLERANCE, SEC_TOLERANCE } from "./config.js";
import { rpc } from "./rpc.js";

/**
 * The thread math, both backends, in one module.
 *
 * There used to be two - mathAnalyze.js and mathFormulas.js - and a test
 * (tests/isolation.test.mjs) whose whole job was keeping them apart, because a
 * script reachable from both paid for both. That split forced twin entry points
 * on everything above it: manager.js/manager-formulas.js,
 * prep.js/prep-formulas.js, and a swap in boot.js to kill one and start the
 * other whenever Formulas.exe was bought or lost.
 *
 * None of that is necessary any more, and the reason is worth stating because
 * it looks like it should not work:
 *
 *   - every *Analyze call lives inside an rpc body, which is a string literal
 *     to the RAM calculator, so this module is not charged for any of them;
 *   - every ns.formulas.* function is 0 GB ALREADY - what cost 2.50 was
 *     getServer and getPlayer, the two reads that fetch the objects to hand it;
 *   - and those objects survive JSON. helpers.server() in NetscriptHelpers.tsx
 *     checks only that 14 plain data keys are present (hostname, cpuCores,
 *     maxRam, moneyMax, ...), and helpers.person() likewise. So snapshot() can
 *     fetch them through rpc and the formulas calls run resident, for free, on
 *     the round-tripped objects.
 *
 * So BOTH backends together cost 1.00 GB - rpc.js's ns.run, once. It was 2.55
 * for analyze alone.
 *
 * The choice is made per PROCESS, at prepare(), not per file. Buying Formulas
 * mid-run no longer needs a manager swap; it needs a restart of the one manager,
 * which boot already does when a manager exits. `--no-formulas` forces the
 * analyze path and is read straight off ns.args, so boot only has to forward it.
 */

let useFormulas = false;
let consts = null;

/** Which path prepare() chose. Logged by managerCore's verbose state line. */
export function backend() {
  return useFormulas ? "formulas" : "analyze";
}

/**
 * Pick a backend and measure whatever it needs. Called once at startup.
 *
 * Formulas is detected by CALLING it, not by fileExists: ns.formulas.* throws
 * when the program is missing, and it throws at call time rather than import
 * time, so without this the failure would surface mid-cycle as a raw exception
 * with reservations already placed.
 *
 * The three security constants are fetched only on the analyze path - formulas
 * has weakenEffect for one of them and the other two are fixed game constants.
 * NO HOST ARGUMENT on either *AnalyzeSecurity: with one they cap their result
 * by the threads needed to reach max money, so on a PREPPED target
 * growthAnalyzeSecurity returns ~0 and weaken-2 gets sized at 1 thread instead
 * of the ~51 actually needed.
 */
export async function prepare(ns) {
  useFormulas = false;
  if (!ns.args.map(String).includes("--no-formulas")) {
    try {
      // Any formulas call would do; this one is also the constant we need.
      useFormulas = ns.formulas.hacking.weakenEffect(1, 1) > 0;
    } catch {
      useFormulas = false;
    }
  }
  if (useFormulas) return { ok: true };

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
  // manager here, not propagate an undefined into thread math as NaN.
  if (!(consts?.weakenPerThread > 0) || !(consts?.hackSecPerThread > 0) || !(consts?.growSecPerThread > 0)) {
    return { ok: false, error: `security constants came back unusable: ${JSON.stringify(consts)}` };
  }
  return { ok: true };
}

/**
 * Everything the planner needs about a host, in ONE round trip either way.
 *
 * On the analyze path, growthLogK is the load-bearing field. ServerHelpers.ts:
 *
 *     numCycleForGrowth(server, growth) = Math.log(growth) / calculateServerGrowthLog(...)
 *
 * The divisor does not depend on `growth`, and nothing rounds or clamps, so
 * growthAnalyze is EXACTLY logarithmic in its multiplier - measured in-game as
 * bit-identical across multipliers from 1.01 to 1000. One reading therefore
 * answers every multiplier, and growThreadsToRestore needs no ns call at all.
 *
 * Everything downstream reads this snapshot and stays SYNCHRONOUS, which is what
 * keeps `async` from cascading through managerCore and prepper.
 */
export async function snapshot(ns, host) {
  if (useFormulas) {
    const got = await rpc(ns, `
      return { server: ns.getServer(args[0]), player: ns.getPlayer() };
    `, host);
    const { server, player } = got;
    const maxMoney = server.moneyMax ?? 0;
    const money = server.moneyAvailable ?? 0;
    const minSec = server.minDifficulty ?? 1;
    const sec = server.hackDifficulty ?? minSec;
    return {
      ns, host, server, player, maxMoney, money, minSec, sec,
      moneyOk: money >= maxMoney * MONEY_TOLERANCE,
      secOk: sec <= minSec + SEC_TOLERANCE,
    };
  }

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
 * to answer a question one call already answers. Backend-independent: money is
 * money.
 */
export async function maxMoneyOfAll(ns, hosts) {
  return rpc(ns, `
    const out = {};
    for (const h of args) out[h] = ns.getServerMaxMoney(h);
    return out;
  `, ...hosts);
}

/** Moves with hacking level either way, which is why it is read per snapshot. */
export function hackFractionPerThread(snap) {
  return useFormulas
    ? snap.ns.formulas.hacking.hackPercent(snap.server, snap.player)
    : snap.hackFraction;
}

// Fixed game constants on the formulas path - the formulas API has no
// hackSecurity/growSecurity entry, only weakenEffect - and the numbers
// prepare() measured on the analyze path. They agree by construction.
export function securityPerHackThread() {
  return useFormulas ? 0.002 : consts.hackSecPerThread;
}
export function securityPerGrowThread() {
  return useFormulas ? 0.004 : consts.growSecPerThread;
}
export function securityPerWeakenThread(snap) {
  // weakenEffect(1) rather than a literal: it is the one security constant the
  // formulas API exposes, and it tracks BitNode multipliers.
  return useFormulas ? snap.ns.formulas.hacking.weakenEffect(1) : consts.weakenPerThread;
}

/**
 * Grow threads to take money from fromMoney to toMoney at a given security.
 *
 * THE TWO PATHS DIFFER HERE, DELIBERATELY, AND A TEST PINS IT.
 *
 * Formulas is EXACT: the server object is cloned and overwritten with the
 * hypothetical state, so it answers "what will grow need when it lands" rather
 * than "what would grow need if it ran now". That distinction is the whole
 * reason the formulas path exists - prep sizes waves for a server whose security
 * is about to change, and a batch's grow runs after its hack took the money.
 * growThreads also models the additive +$1/thread that growthAnalyze ignores.
 *
 * Analyze cannot honour atSecurity at all: growthLogK was measured at the
 * snapshot's security. The argument is accepted only so one signature serves
 * both. When they disagree, formulas is right.
 */
export function growThreadsToRestore(snap, fromMoney, toMoney, atSecurity) {
  const from = Math.max(fromMoney, 1);
  const to = Math.min(toMoney, snap.maxMoney);
  if (to <= from) return 0;

  if (useFormulas) {
    const hypothetical = { ...snap.server, moneyAvailable: from, hackDifficulty: atSecurity };
    return snap.ns.formulas.hacking.growThreads(hypothetical, snap.player, to);
  }
  // log(mult) / growthLogK is what ns.growthAnalyze(host, mult) returns, by the
  // identity in snapshot() above - not an approximation of it.
  return Math.log(to / from) / snap.growthLogK;
}

export function opTimes(snap) {
  if (!useFormulas) return snap.times;
  const f = snap.ns.formulas.hacking;
  return {
    hack: f.hackTime(snap.server, snap.player),
    grow: f.growTime(snap.server, snap.player),
    weaken: f.weakenTime(snap.server, snap.player),
  };
}
