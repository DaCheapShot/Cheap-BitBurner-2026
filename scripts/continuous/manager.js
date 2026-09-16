import { runContinuous } from "scripts/continuous/core";
import * as math from "scripts/continuous/lib/math";

/**
 * The continuous batcher. One entry point for both math backends: lib/math.js
 * uses Formulas.exe when it is owned and the *Analyze functions otherwise, and
 * re-checks every rescan, so buying the program mid-run upgrades this process.
 *
 * Nothing else may live here - core.js takes the math module as an argument so
 * tests can hand it one.
 *
 * Usage:  run scripts/continuous/manager.js
 *         run scripts/continuous/manager.js --targets 5
 *         run scripts/continuous/manager.js --target phantasy
 *         run scripts/continuous/manager.js --no-formulas
 *         run scripts/continuous/manager.js --verbose
 */

/** @param {NS} ns */
export async function main(ns) {
  await runContinuous(ns, math);
}
