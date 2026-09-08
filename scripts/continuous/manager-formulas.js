import { run } from "scripts/continuous/core";
import * as math from "scripts/continuous/lib/mathFormulas";

/**
 * Continuous batcher, formulas build. Needs Formulas.exe on home.
 *
 * This entry point exists ONLY to bind core.js to one math backend. Nothing
 * else may live here: the moment this file reaches anything from
 * lib/mathAnalyze.js, Bitburner charges this script for both backends and it
 * can still only use one.
 *
 * prepare() checks for the program and refuses to run without it rather than
 * failing later inside a formulas call, where the error would surface as a
 * throw in the middle of a prep wave with reservations already placed.
 *
 * Usage:  run scripts/continuous/manager-formulas.js
 *         run scripts/continuous/manager-formulas.js --targets 5
 *         run scripts/continuous/manager-formulas.js --verbose
 */

/** @param {NS} ns */
export async function main(ns) {
  await run(ns, math);
}
