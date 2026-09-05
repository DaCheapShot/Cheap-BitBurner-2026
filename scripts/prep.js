import { prepCli } from "./prepper.js";
import * as math from "./mathAnalyze.js";

/**
 * Phase 3 CLI: bring one target to max money and minimum security, using the
 * *Analyze API and the calibration cache.
 *
 * All the logic lives in scripts/prepper.js (prepCli) - shared with
 * scripts/prep-formulas.js so the two CLIs can't drift apart, the same shape
 * managerCore.run() already shares between manager.js and manager-formulas.js.
 * The manager still calls prep() in-process rather than through this file -
 * only one process may own the ServerPool and the report port at a time.
 *
 * Usage:  run scripts/prep.js --target foodnstuff
 *         run scripts/prep.js                      (auto: richest server you can hack)
 *         run scripts/prep.js --target n00dles --max-cycles 5
 *
 * RAM: 1.60 base + prepper.js 2.00 + mathAnalyze 2.55 = 6.15 GB
 * Requires /data/calib.json: run scripts/calibrate.js first.
 */

/** @param {NS} ns */
export async function main(ns) {
  await prepCli(ns, math);
}
