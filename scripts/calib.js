import { SEC_TOLERANCE } from "./config.js";

/**
 * Zero-RAM reader for the calibration cache written by scripts/calibrate.js.
 *
 * ns.read is 0 GB, so importing this costs the manager nothing. That's the whole
 * point: it replaces weakenAnalyze, hackAnalyzeSecurity and growthAnalyzeSecurity
 * (1 GB each) with three numbers from a JSON file, plus growthAnalyze (a 4th GB)
 * for hosts whose growth base was cached at minimum security.
 *
 * What is NOT here, deliberately: hackAnalyze. It moves with hacking level, and
 * reacting to that is the reason the manager recomputes every volley. Caching it
 * would defeat the self-correction.
 */

export const CALIB_PATH = "/data/calib.json";

/**
 * @param {NS} ns
 * @param {string} [path]
 * @returns {object|null} the cache, or null if missing/corrupt
 */
export function loadCalibration(ns, path = CALIB_PATH) {
  const raw = ns.read(path);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Reject anything without the fields callers depend on, rather than letting
    // an undefined propagate into thread math as NaN.
    if (
      typeof parsed?.weakenPerThread !== "number" ||
      typeof parsed?.hackSecPerThread !== "number" ||
      typeof parsed?.growSecPerThread !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The cached per-thread growth multiplier for a host, or null if unusable.
 *
 * REQUIRES the host's CURRENT security, and returns null unless it is still at
 * minimum. The cached base was measured at minimum security, and real growth per
 * thread gets worse as security rises - so reusing it on a drifted server
 * OVERSTATES growth. Callers that get null must derive the base live
 * (ns.growthAnalyze) or refuse to plan - never fall back to a stale number,
 * which silently under-refills every batch.
 */
export function growBaseFor(calib, host, sec) {
  const entry = calib?.hosts?.[host];
  if (!entry || !(entry.growBase > 1)) return null;
  if (!Number.isFinite(sec) || sec > entry.minSec + SEC_TOLERANCE) return null;
  return entry.growBase;
}

/** Rough staleness signal for display; not used for correctness. */
export function calibAgeMs(calib) {
  return Date.now() - (calib?.written ?? 0);
}
