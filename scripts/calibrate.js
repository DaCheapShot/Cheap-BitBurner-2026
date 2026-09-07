/**
 * Measure the batcher's constant-valued analyze functions once and cache them
 * to /data/calib.json, so the long-lived manager doesn't have to carry 3-4 GB of
 * analyze functions forever.
 *
 * Three of the five 1 GB analyze functions return values that are LINEAR in
 * thread count and independent of server money/security and of hacking level:
 *
 *   weakenAnalyze(t)           security removed per weaken thread
 *   hackAnalyzeSecurity(t)     security added per hack thread
 *   growthAnalyzeSecurity(t)   security added per grow thread
 *
 * They vary only with cores and BitNode/augment multipliers - things that change
 * when you buy a home upgrade or install augs, not minute to minute. Measured
 * once here, the manager reads three numbers from JSON and multiplies.
 *
 * This script does NOT assert that linearity, it verifies it across a wide
 * thread range and refuses to write a cache if the relationship doesn't hold.
 *
 * IMPORTANT: the two security functions are called WITHOUT a host argument. With
 * a host, the docs say the result is capped by the threads needed to reach max
 * money, which makes the value non-linear at high thread counts. Uncapped is the
 * true per-thread constant, and it's safe for batching because a batch's hack
 * threads are always well under that cap.
 *
 * Also caches, per host, the per-thread growth multiplier AT MINIMUM SECURITY.
 * growthAnalyze normally varies with current security, but a batcher only ever
 * fires at a prepped (minimum-security) target, so that one value is all the
 * manager needs. Hosts not currently at minimum security are skipped rather
 * than cached wrong.
 *
 * RE-RUN THIS after: installing augmentations, buying home cores, or entering a
 * new BitNode. The cache records the hacking level and timestamp so staleness is
 * visible.
 *
 * RAM: 1.60 base + weakenAnalyze/hackAnalyzeSecurity/growthAnalyzeSecurity/
 *      growthAnalyze 4.00 + scan 0.20 + hasRootAccess 0.05
 *      + getServerMaxMoney/MinSecurityLevel/SecurityLevel 0.30
 *      + getHackingLevel 0.05  =  6.20 GB   (read/write/tprint are 0)
 *
 * Usage: run scripts/calibrate.js
 */

export const CALIB_PATH = "/data/calib.json";

// Thread counts to probe. Spans four orders of magnitude so a non-linearity
// (a cap, a rounding floor) shows up rather than hiding in a narrow range.
const PROBE_THREADS = [1, 2, 3, 7, 10, 100, 1000, 10000];

// Floating point tolerance for "is this exactly linear".
const LINEARITY_EPS = 1e-9;

/**
 * Check f(t) == t * f(1) across PROBE_THREADS.
 * @returns {{ok: boolean, perThread: number, worst: number, detail: string}}
 */
function checkLinear(label, fn) {
  const unit = fn(1);
  if (!Number.isFinite(unit) || unit <= 0) {
    return { ok: false, perThread: unit, worst: NaN, detail: `${label}(1) returned ${unit}` };
  }

  let worst = 0;
  let worstAt = 1;
  for (const t of PROBE_THREADS) {
    const got = fn(t);
    const expect = unit * t;
    const relErr = Math.abs(got - expect) / expect;
    if (relErr > worst) {
      worst = relErr;
      worstAt = t;
    }
  }

  return {
    ok: worst <= LINEARITY_EPS,
    perThread: unit,
    worst,
    detail: `${label}: ${unit} per thread, worst relative error ${worst.toExponential(2)} at t=${worstAt}`,
  };
}

/** @param {NS} ns */
export async function main(ns) {
  const lines = [""];
  lines.push("=== CALIBRATION ============================================================");

  // -- the three linear constants -------------------------------------------

  const weaken = checkLinear("weakenAnalyze", (t) => ns.weakenAnalyze(t));
  // No host argument: see the header note about capping.
  const hackSec = checkLinear("hackAnalyzeSecurity", (t) => ns.hackAnalyzeSecurity(t));
  const growSec = checkLinear("growthAnalyzeSecurity", (t) => ns.growthAnalyzeSecurity(t));

  for (const r of [weaken, hackSec, growSec]) {
    lines.push(`  ${r.ok ? "LINEAR  " : "NONLINEAR"}  ${r.detail}`);
  }

  if (!weaken.ok || !hackSec.ok || !growSec.ok) {
    lines.push("");
    lines.push("ABORTED: at least one function is not linear in threads, so a per-thread");
    lines.push("constant would be wrong. The manager must keep calling it live.");
    ns.tprint(lines.join("\n"));
    return;
  }

  // -- per-host growth base, only where the target is already prepped --------

  const seen = new Set(["home"]);
  const queue = ["home"];
  for (let i = 0; i < queue.length; i++) {
    for (const h of ns.scan(queue[i])) {
      if (!seen.has(h)) {
        seen.add(h);
        queue.push(h);
      }
    }
  }

  const hosts = {};
  const skipped = [];

  for (const host of seen) {
    if (host === "home" || !ns.hasRootAccess(host)) continue;
    if (ns.getServerMaxMoney(host) <= 0) continue;

    const minSec = ns.getServerMinSecurityLevel(host);
    const sec = ns.getServerSecurityLevel(host);

    // Only meaningful at minimum security - that's the only state a batcher
    // fires in, and growthAnalyze's answer moves with security.
    if (sec > minSec + 0.01) {
      skipped.push(`${host} (sec ${sec.toFixed(2)} > min ${minSec.toFixed(2)})`);
      continue;
    }

    // growthAnalyze(host, M) returns the thread count t needed to multiply money
    // by M. Invert it: one thread multiplies by M^(1/t). Cache that base, and
    // the manager recovers any thread count as log(mult) / log(base).
    const threadsForDouble = ns.growthAnalyze(host, 2);
    if (!Number.isFinite(threadsForDouble) || threadsForDouble <= 0) {
      skipped.push(`${host} (growthAnalyze returned ${threadsForDouble})`);
      continue;
    }

    hosts[host] = {
      growBase: Math.pow(2, 1 / threadsForDouble),
      minSec,
      // The security this base was actually measured at. Consumers compare the
      // host's live security against it and reject the cache if it has drifted -
      // growth per thread worsens as security rises, so a stale base overstates
      // it and silently under-refills batches.
      measuredAtSec: sec,
      threadsToDouble: threadsForDouble,
    };
  }

  const calib = {
    version: 1,
    written: Date.now(),
    // Recorded for staleness checks. The three constants don't move with level,
    // but if this is wildly old it's a hint that augs/cores may have changed.
    hackingLevel: ns.getHackingLevel(),
    weakenPerThread: weaken.perThread,
    hackSecPerThread: hackSec.perThread,
    growSecPerThread: growSec.perThread,
    hosts,
  };

  ns.write(CALIB_PATH, JSON.stringify(calib, null, 2), "w");

  lines.push("");
  lines.push(`  weakenPerThread   ${calib.weakenPerThread}`);
  lines.push(`  hackSecPerThread  ${calib.hackSecPerThread}`);
  lines.push(`  growSecPerThread  ${calib.growSecPerThread}`);
  lines.push("");
  lines.push(`  growth base cached for ${Object.keys(hosts).length} prepped host(s):`);
  for (const [h, v] of Object.entries(hosts)) {
    lines.push(`    ${h.padEnd(22)} base ${v.growBase.toFixed(6)} (${v.threadsToDouble.toFixed(2)}t to double)`);
  }
  if (skipped.length) {
    lines.push(`  skipped ${skipped.length} not at min security: ${skipped.slice(0, 5).join(", ")}`);
    lines.push(`    (prep them, then re-run to cache their growth base)`);
  }
  lines.push("");
  lines.push(`  written to ${CALIB_PATH}`);
  lines.push(`  RE-RUN after installing augmentations, buying home cores, or a new BitNode.`);
  lines.push("");
  ns.print(lines.join("\n"));
}
