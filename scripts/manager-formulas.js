import { runVolley } from "./managerCore.js";
import * as math from "./mathFormulas.js";

/**
 * The shotgun volley loop, using ns.formulas.hacking.
 *
 * Exact where the analyze build approximates, and slightly cheaper, because
 * every ns.formulas.* call is 0 GB and the getServer object supplies the money,
 * security and timing reads that would otherwise cost 0.55 GB.
 *
 * Requires Formulas.exe. math.prepare() checks at startup and exits with a
 * message naming manager.js, rather than throwing mid-cycle.
 *
 * Do not import mathAnalyze here - see the note in manager.js.
 *
 * RAM: 1.60 base + managerCore/prepper 2.00 + mathFormulas 2.50 = 6.10 GB
 */

/** @param {NS} ns */
export async function main(ns) {
  await runVolley(ns, math);
}
