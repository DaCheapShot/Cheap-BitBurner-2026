import { runVolley } from "./managerCore.js";
import * as math from "./math.js";

/**
 * The shotgun volley loop.
 *
 * THE ONLY SHOTGUN ENTRY POINT. There used to be a second, manager-formulas.js,
 * because a script reachable from both math backends paid for both. scripts/
 * math.js now holds both for 1.00 GB total - every *Analyze name lives in an rpc
 * body, and ns.formulas.* was always 0 GB - so the split, its isolation test and
 * boot's swap between the two files are all gone.
 *
 * math.prepare() picks the backend per process: formulas when the program is
 * owned, analyze otherwise, and analyze always under --no-formulas.
 *
 * RAM: 1.60 base + managerCore/prepper/ram 2.80 + math.js 1.00 = 5.40 GB
 *
 * Both backends for 1.00, where analyze alone used to cost 2.55 and formulas
 * 2.50. The pair of entry points cost 6.95 and 6.90.
 */

/** @param {NS} ns */
export async function main(ns) {
  await runVolley(ns, math);
}
