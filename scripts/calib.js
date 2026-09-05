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

/** Security removed by n weaken threads. */
export function weakenSecurity(calib, threads) {
  return calib.weakenPerThread * threads;
}

/** Security added by n hack threads. */
export function hackSecurity(calib, threads) {
  return calib.hackSecPerThread * threads;
}

/** Security added by n grow threads. */
export function growSecurity(calib, threads) {
  return calib.growSecPerThread * threads;
}

/** Weaken threads needed to remove `security`, rounded up. */
export function weakenThreadsFor(calib, security) {
  if (security <= 0) return 0;
  return Math.ceil(security / calib.weakenPerThread);
}

/** How far above minimum security still counts as "at minimum". */
export const SEC_TOLERANCE = 0.01;

/**
 * Grow threads needed to multiply a host's money by `mult`.
 *
 * Inverts the cached per-thread growth base: t = log(mult) / log(base).
 *
 * REQUIRES the host's CURRENT security, and returns null unless it is still at
 * minimum. The cached base was measured at minimum security, and real growth per
 * thread gets worse as security rises - so reusing it on a drifted server
 * OVERSTATES growth and hands back too few threads. That under-refills the
 * batch, leaves money below max, makes the next hack take less than planned, and
 * drifts the target further. Silent and compounding.
 *
 * Returning null forces the caller to either use a live ns.growthAnalyze or
 * re-prep. Never guess.
 *
 * @param {object} calib
 * @param {string} host
 * @param {number} mult    desired money multiplier, > 1
 * @param {number} sec     host's CURRENT security level
 * @returns {number|null}  decimal thread count, or null if the cache can't be trusted
 */
export function growThreadsFor(calib, host, mult, sec) {
  const entry = calib?.hosts?.[host];
  if (!entry || !(entry.growBase > 1) || !(mult > 1)) return null;
  if (!Number.isFinite(sec)) return null;
  if (sec > entry.minSec + SEC_TOLERANCE) return null; // drifted - cache invalid
  return Math.log(mult) / Math.log(entry.growBase);
}

/**
 * The cached per-thread growth multiplier for a host, or null if unusable.
 *
 * Same drift guard as growThreadsFor: the base was measured at minimum security
 * and overstates growth anywhere else. Callers that get null must derive the
 * base live (ns.growthAnalyze) or refuse to plan - never fall back to a stale
 * number, which silently under-refills every batch.
 */
export function growBaseFor(calib, host, sec) {
  const entry = calib?.hosts?.[host];
  if (!entry || !(entry.growBase > 1)) return null;
  if (!Number.isFinite(sec) || sec > entry.minSec + SEC_TOLERANCE) return null;
  return entry.growBase;
}

/**
 * True if a cached growth base exists AND the host is still at the security it
 * was measured at. Both halves matter - see growThreadsFor.
 */
export function hasGrowBase(calib, host, sec) {
  const entry = calib?.hosts?.[host];
  if (!entry || !(entry.growBase > 1)) return false;
  return Number.isFinite(sec) && sec <= entry.minSec + SEC_TOLERANCE;
}

/** Rough staleness signal for display; not used for correctness. */
export function calibAgeMs(calib) {
  return Date.now() - (calib?.written ?? 0);
}
