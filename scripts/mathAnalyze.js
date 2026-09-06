import { MONEY_TOLERANCE, SEC_TOLERANCE } from "./config.js";
import { loadCalibration, growBaseFor } from "./calib.js";

/**
 * Math interface backed by the *Analyze API plus the calibration cache.
 *
 * This is the always-available implementation: it needs no programs and works
 * from minute one of a BitNode. It is also honestly approximate - see
 * growThreadsToRestore.
 *
 * RAM charged to whoever imports this:
 *   4x getServer* 0.40 + hackAnalyze 1.00 + growthAnalyze 1.00
 *   + getHackTime/getGrowTime/getWeakenTime 0.15
 *   = 2.55 GB   (calib.js and config.js are 0 GB)
 */

export const NAME = "analyze";

let calib = null;

/** Load the calibration cache. Called once at startup by the entry script. */
export function prepare(ns) {
  calib = loadCalibration(ns);
  if (!calib) {
    return {
      ok: false,
      error: "/data/calib.json missing or invalid. Run scripts/calibrate.js first.",
    };
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

// Cached per-thread constants. All three are linear in threads and independent
// of the target's current state, which is what makes them safe to cache; see
// scripts/calibrate.js for how they are measured.
export function securityPerHackThread() { return calib.hackSecPerThread; }
export function securityPerGrowThread() { return calib.growSecPerThread; }
export function securityPerWeakenThread() { return calib.weakenPerThread; }

/**
 * Grow threads to take money from fromMoney to toMoney.
 *
 * APPROXIMATE, deliberately and unavoidably. growthAnalyze evaluates at the
 * target's CURRENT security, so the atSecurity argument cannot be honoured -
 * it is accepted only so this signature matches mathFormulas, which can. When
 * the two disagree, formulas is right.
 *
 * Prefers the cached growth base when the host is still at the security it was
 * measured at, because that costs nothing; falls back to a live growthAnalyze
 * otherwise. Both are already charged to this module, so the preference is
 * about accuracy, not RAM.
 */
export function growThreadsToRestore(snap, fromMoney, toMoney, atSecurity) {
  const from = Math.max(fromMoney, 1);
  const to = Math.min(toMoney, snap.maxMoney);
  if (to <= from) return 0;
  const mult = to / from;

  const base = growBaseFor(calib, snap.host, atSecurity);
  if (base) return Math.log(mult) / Math.log(base);

  return snap.ns.growthAnalyze(snap.host, mult);
}

export function opTimes(snap) {
  return {
    hack: snap.ns.getHackTime(snap.host),
    grow: snap.ns.getGrowTime(snap.host),
    weaken: snap.ns.getWeakenTime(snap.host),
  };
}
