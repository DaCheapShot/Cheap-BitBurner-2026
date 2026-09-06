import { prepCli } from "./prepper.js";
import * as math from "./mathFormulas.js";

/**
 * Phase 3 CLI: bring one target to max money and minimum security, using
 * ns.formulas.hacking.
 *
 * Identical to prep.js except for which math module it injects - this one is
 * exact but requires Formulas.exe on home. Shared body lives in
 * scripts/prepper.js (prepCli), so the two CLIs can't drift apart.
 *
 * Usage:  run scripts/prep-formulas.js --target foodnstuff
 *         run scripts/prep-formulas.js                      (auto: richest server you can hack)
 *         run scripts/prep-formulas.js --target n00dles --max-cycles 5
 *
 * RAM: 1.60 base + prepper.js 2.00 + mathFormulas 2.50 = 6.10 GB
 * Requires Formulas.exe on home.
 */

/** @param {NS} ns */
export async function main(ns) {
  await prepCli(ns, math);
}
