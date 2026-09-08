import { FORMULAS_PROGRAM, MONEY_TOLERANCE, SEC_TOLERANCE } from "scripts/continuous/config";
import { makeCoreBonus } from "scripts/continuous/lib/cores";

/**
 * Math backend built on ns.formulas.hacking.*. Needs Formulas.exe.
 *
 *   getServer               2.00
 *   getPlayer               0.50
 *   fileExists              0.10
 *   hackAnalyzeSecurity     1.00
 *   growthAnalyzeSecurity   1.00
 *   ns.formulas.*           0.00   (the formulas themselves are free; the
 *                                   Server and Person objects cost)
 *   -----------------------------
 *                           4.60 GB
 *
 * Still cheaper than the analyze backend's 6.55 AND more precise, which is the
 * whole reason to prefer it when the program is owned.
 *
 * The two analyze SECURITY functions are here on purpose. The formulas API
 * exposes no fortify-per-thread getter, so the alternatives were to hardcode
 * 0.002 and 0.004 out of the JSDoc prose or to pay 2 GB to measure them. This
 * repo's standing rule is that game constants come from the API and not from
 * memory - they move with game version and with BitNode multipliers - and a
 * wrong fortify constant does not fail loudly. Too small and weaken-2
 * under-cancels, so security climbs a hair per batch and the target drifts off
 * baseline over minutes with nothing in the log to say why.
 *
 * Reaching two analyze functions is NOT a breach of the two-backends rule.
 * That rule is about not importing both math MODULES from one entry point and
 * paying for two complete backends; these two functions are the cheapest
 * correct source for a number this backend genuinely needs.
 *
 * MUST NOT be reachable from the same entry point as mathAnalyze.js.
 *
 * Note that lib/cores.js already pays the 2.00 for getServer, so importing it
 * here is free - and it is the same measurement machinery both backends use, so
 * the core bonus cannot drift between them.
 */

export const NAME = "formulas";

let consts = null;

export function prepare(ns) {
  if (!ns.fileExists(FORMULAS_PROGRAM, "home")) {
    return { ok: false, error: `${FORMULAS_PROGRAM} is not on home` };
  }

  // weakenEffect depends only on threads and cores - not on any server or
  // player property - so one reading at startup is good for the whole run.
  const weaken = ns.formulas.hacking.weakenEffect(1, 1);
  if (!(weaken > 0)) {
    return { ok: false, error: `weakenEffect(1, 1) returned ${weaken}` };
  }

  consts = {
    weaken,
    // No host argument on either - load-bearing. With one, both cap their
    // result by the threads needed to reach max money, so on a PREPPED target
    // growthAnalyzeSecurity returns ~0 and weaken-2 gets sized at 1 thread
    // instead of the ~51 actually needed.
    hackSec: ns.hackAnalyzeSecurity(1),
    growSec: ns.growthAnalyzeSecurity(1),
    coreBonus: makeCoreBonus((t, c) => ns.formulas.hacking.weakenEffect(t, c)),
  };

  return { ok: true };
}

export function snapshot(ns, host) {
  const server = ns.getServer(host);
  const player = ns.getPlayer();

  const maxMoney = server.moneyMax ?? 0;
  const money = server.moneyAvailable ?? 0;
  const minSec = server.minDifficulty ?? 1;
  const sec = server.hackDifficulty ?? minSec;

  return {
    ns,
    host,
    // Kept so the formulas can be asked hypothetical questions - notably "how
    // many grow threads AT this security", which the analyze backend cannot
    // answer at all.
    server,
    player,
    maxMoney,
    money,
    minSec,
    sec,
    moneyOk: maxMoney > 0 && money >= maxMoney * MONEY_TOLERANCE,
    secOk: sec <= minSec + SEC_TOLERANCE,
  };
}

/** Fraction of the server's current money one hack thread takes. */
export function hackFractionPerThread(snap) {
  return snap.ns.formulas.hacking.hackPercent(snap.server, snap.player);
}

export function hackChance(snap) {
  return snap.ns.formulas.hacking.hackChance(snap.server, snap.player);
}

/** Security added per hack thread. Measured at prepare(); no core bonus. */
export const securityPerHackThread = () => consts.hackSec;

/**
 * Security added per grow thread. Measured; no core bonus applies.
 *
 * From processSingleServerGrowth in the fork's ServerHelpers.ts, grow fortifies
 * by `2 * ServerFortifyAmount * usedCycles` with usedCycles clamped to the
 * CALL's own thread count - so grow's security cost tracks RAW threads while
 * its money effect tracks core-weighted ones. The weaken that cancels a grow is
 * therefore sized from the grow's RAW placed threads, which is exact; sizing it
 * from the effective count would merely over-weaken. See lib/mathAnalyze.js for
 * the full note.
 */
export const securityPerGrowThread = () => consts.growSec;

/** Security removed per weaken thread ON A SINGLE CORE. */
export const weakenPerThread = () => consts.weaken;

/** Multiplier a host's cores apply to grow and weaken. Measured, not assumed. */
export const coreBonusFor = (cores) => consts.coreBonus(cores);

/**
 * Threads to grow `fromMoney` up to `toMoney`, as if run on ONE core.
 *
 * Unlike the analyze backend, this one HONOURS atSecurity, by cloning the
 * server object and answering for the hypothetical state. That matters because
 * what determines a grow's effect is the state of the server when the grow
 * FINISHES, not when it starts - and in a batch, grow lands after a weaken has
 * already pulled security back down.
 *
 * growThreads also accounts for grow's additive $1 per thread, which
 * growthAnalyze cannot express. Expect this backend to ask for fewer threads
 * than the analyze one; that difference is correct, not a discrepancy to
 * reconcile.
 */
export function growThreadsToRestore(snap, fromMoney, toMoney, atSecurity) {
  if (!(toMoney > fromMoney)) return 0;

  const server = {
    ...snap.server,
    moneyAvailable: Math.max(fromMoney, 0),
    hackDifficulty: atSecurity ?? snap.sec,
  };

  return snap.ns.formulas.hacking.growThreads(server, snap.player, toMoney, 1);
}

/**
 * Op durations.
 *
 * Read from the SNAPSHOT's server, so a caller can ask what the times would be
 * at a different security level by handing in a modified snapshot - the analyze
 * backend's getters can only ever answer for the live server.
 */
export function opTimes(snap) {
  const f = snap.ns.formulas.hacking;
  return {
    hack: f.hackTime(snap.server, snap.player),
    grow: f.growTime(snap.server, snap.player),
    weaken: f.weakenTime(snap.server, snap.player),
  };
}
