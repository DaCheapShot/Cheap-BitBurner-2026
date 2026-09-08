import { run } from "scripts/continuous/core";
import * as math from "scripts/continuous/lib/mathAnalyze";

/**
 * Continuous batcher, analyze build. Always works - no program required.
 *
 * This entry point exists ONLY to bind core.js to one math backend. Nothing
 * else may live here: the moment this file reaches anything from
 * lib/mathFormulas.js, Bitburner charges this script for both backends and it
 * can still only use one.
 *
 * Prefer manager-formulas.js when Formulas.exe is owned - it is both cheaper
 * (4.60 GB against 6.55) and more precise, because growThreads accounts for
 * grow's additive $1 per thread and can be asked about a hypothetical security
 * level rather than only the current one.
 *
 * Usage:  run scripts/continuous/manager.js
 *         run scripts/continuous/manager.js --targets 5
 *         run scripts/continuous/manager.js --target phantasy
 *         run scripts/continuous/manager.js --verbose
 */

/** @param {NS} ns */
export async function main(ns) {
  await run(ns, math);
}
