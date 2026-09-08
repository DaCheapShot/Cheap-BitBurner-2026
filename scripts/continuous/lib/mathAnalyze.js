import { MONEY_TOLERANCE, SEC_TOLERANCE } from "scripts/continuous/config";
import { makeCoreBonus } from "scripts/continuous/lib/cores";

/**
 * Math backend built on the *Analyze functions. Always available.
 *
 *   hackAnalyze              1.00
 *   hackAnalyzeChance        1.00
 *   hackAnalyzeSecurity      1.00
 *   growthAnalyze            1.00
 *   growthAnalyzeSecurity    1.00
 *   weakenAnalyze            1.00
 *   getServerMaxMoney        0.10
 *   getServerMoneyAvailable  0.10
 *   getServerSecurityLevel   0.10
 *   getServerMinSecurityLevel 0.10
 *   getHackTime/GrowTime/WeakenTime 0.15
 *   ---------------------------------
 *                            6.55 GB
 *
 * MUST NOT be reachable from the same entry point as mathFormulas.js. Bitburner
 * charges for every ns function reachable through imports, so a script touching
 * both pays for two full backends and can use only one.
 *
 * ---------------------------------------------------------------------------
 * Why there is no calibration cache
 *
 * The shotgun gets this same backend down to 2.55 GB by having a separate
 * script measure the three linear constants (weaken effect, hack security, grow
 * security) into /data/calib.json, which the manager reads back with ns.read at
 * 0 GB - the manager never REACHES those functions, which is what the 1 GB is
 * actually charged for.
 *
 * Not done here. The manager is one process on home, home reserves 32 GB, and
 * 4 GB of it is not worth a second script, a cache file, a staleness check and
 * a rule about when the cache is invalid. The three constants are read once at
 * prepare() and held in this module.
 *
 * ponytail: no calibration cache, 4 GB heavier than it could be. If the manager
 * ever needs to run somewhere other than home, port the shotgun's calibrate.js
 * / calib.js pair into this folder rather than shaving anything else.
 */

export const NAME = "analyze";

/**
 * Constants that are linear in threads and fixed for a run.
 *
 * Measured once rather than per call. Not for RAM - RAM is charged for reaching
 * a function, not for calling it - but because these are called inside the
 * per-batch sizing path, which runs on every cadence tick against every target.
 */
let consts = null;

export function prepare(ns) {
  // No host argument on either security function - this is load-bearing.
  //
  // With a host, both cap their result by the threads needed to reach max
  // money. A PREPPED target sits AT max money, so growthAnalyzeSecurity(g, host)
  // returns ~0 and weaken-2 gets sized at 1 thread instead of the ~51 needed.
  // The uncancelled security then compounds batch over batch.
  //
  // The cap is also simply wrong for a batch: by the time grow lands, hack has
  // already taken its cut, so the server is NOT at max money and every one of
  // those grow threads really does fire and really does add security.
  const weaken = ns.weakenAnalyze(1, 1);
  if (!(weaken > 0)) {
    return { ok: false, error: `weakenAnalyze(1, 1) returned ${weaken}` };
  }

  consts = {
    weaken,
    hackSec: ns.hackAnalyzeSecurity(1),
    growSec: ns.growthAnalyzeSecurity(1),
    coreBonus: makeCoreBonus((t, c) => ns.weakenAnalyze(t, c)),
  };

  return { ok: true };
}

export function snapshot(ns, host) {
  const maxMoney = ns.getServerMaxMoney(host);
  const money = ns.getServerMoneyAvailable(host);
  const minSec = ns.getServerMinSecurityLevel(host);
  const sec = ns.getServerSecurityLevel(host);

  return {
    // Carried so the live-reading functions below need no second argument.
    // hackAnalyze and growthAnalyze must NOT be cached - they move with hacking
    // level and with the server's current security respectively.
    ns,
    host,
    maxMoney,
    money,
    minSec,
    sec,
    moneyOk: maxMoney > 0 && money >= maxMoney * MONEY_TOLERANCE,
    secOk: sec <= minSec + SEC_TOLERANCE,
  };
}

/**
 * Fraction of the server's CURRENT money one hack thread takes.
 *
 * Deliberately not hackAnalyzeThreads: that one takes an absolute amount and
 * returns -1 whenever the amount exceeds the money currently on the server, so
 * it fails on every unprepped target. The fraction form has no such dependency.
 *
 * Stays live rather than being cached - it moves with hacking level, and
 * reacting to that is the entire point of re-deriving each batch at dispatch.
 */
export function hackFractionPerThread(snap) {
  return snap.ns ? snap.ns.hackAnalyze(snap.host) : 0;
}

export function hackChance(snap) {
  return snap.ns ? snap.ns.hackAnalyzeChance(snap.host) : 0;
}

/** Security added per hack thread. Constant; no core bonus applies. */
export const securityPerHackThread = () => consts.hackSec;

/**
 * Security added per grow thread. Constant, and no core bonus applies.
 *
 * That asymmetry is real. From processSingleServerGrowth in the fork's
 * ServerHelpers.ts, grow fortifies by `2 * ServerFortifyAmount * usedCycles`
 * with usedCycles clamped to the CALL's own thread count - so grow's security
 * cost tracks RAW threads while its money effect tracks core-weighted ones.
 *
 * Which is why the weaken that cancels a grow is sized from the grow's RAW
 * placed threads. Note the direction of the error if it were not: coreBonus is
 * always >= 1, so raw <= effective, and sizing off the effective count would
 * OVER-weaken - safe, since weaken clamps at minimum security, but on an
 * 8-core host it asks for ~44% more weaken threads than the grow can possibly
 * justify. The reason to use raw is that it is exact, not that effective is
 * dangerous.
 */
export const securityPerGrowThread = () => consts.growSec;

/** Security removed per weaken thread ON A SINGLE CORE. */
export const weakenPerThread = () => consts.weaken;

/** Multiplier a host's cores apply to grow and weaken. Measured, not assumed. */
export const coreBonusFor = (cores) => consts.coreBonus(cores);

/**
 * Threads to grow `fromMoney` up to `toMoney`, as if run on ONE core.
 *
 * `atSecurity` is ACCEPTED AND IGNORED here, and that is deliberate rather than
 * an omission. growthAnalyze reads the server's security at call time and
 * offers no way to ask "what if security were X", so this backend can only ever
 * answer for the server as it stands right now. mathFormulas can and does
 * honour it. Do not "fix" the two into equivalence - the difference is the
 * whole reason both exist, and a test pins it.
 *
 * The result over-estimates slightly: growthAnalyze covers only the
 * multiplicative term and ignores grow's additive $1 per thread. Over-supply is
 * the safe direction, since the game clamps money at moneyMax.
 */
export function growThreadsToRestore(snap, fromMoney, toMoney, _atSecurity) {
  if (!(toMoney > fromMoney)) return 0;

  // A server at $0 gives an infinite multiplier. Grow's additive term rescues
  // it in the game; here, pretending it holds $1 is enough to get a finite and
  // generous thread count.
  const from = Math.max(fromMoney, 1);
  const mult = toMoney / from;
  if (!(mult > 1)) return 0;

  return Math.ceil(snap.ns.growthAnalyze(snap.host, mult, 1));
}

export function opTimes(snap) {
  return {
    hack: snap.ns.getHackTime(snap.host),
    grow: snap.ns.getGrowTime(snap.host),
    weaken: snap.ns.getWeakenTime(snap.host),
  };
}
