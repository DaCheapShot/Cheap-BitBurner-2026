import { prepCli } from "./prepper.js";
import * as math from "./math.js";

/**
 * Phase 3 CLI: bring one target to max money and minimum security.
 *
 * All the logic lives in scripts/prepper.js (prepCli). There used to be a
 * prep-formulas.js beside this one, for the same reason there were twin
 * managers; scripts/math.js holds both backends now, so there is one CLI.
 * The manager still calls prep() in-process rather than through this file -
 * only one process may own the ServerPool and the report port at a time.
 *
 * Usage:  run scripts/prep.js --target foodnstuff
 *         run scripts/prep.js                      (auto: richest server you can hack)
 *         run scripts/prep.js --target n00dles --max-cycles 5
 *
 * RAM: 1.60 base + prepper/ram 2.40 + math.js 1.00 = 5.00 GB
 * Requires no cache and no program. Uses ns.formulas when Formulas.exe is
 * owned, the *Analyze API otherwise, and *Analyze always under --no-formulas.
 */

/** @param {NS} ns */
export async function main(ns) {
  await prepCli(ns, math);
}
