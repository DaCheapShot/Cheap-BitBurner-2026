import { run } from "./managerCore.js";
import * as math from "./mathAnalyze.js";

/**
 * The shotgun volley loop, using the *Analyze API and the calibration cache.
 *
 * This is the always-available build: it needs no programs and works from
 * minute one of a BitNode, which is why it keeps the plain name. If you own
 * Formulas.exe, scripts/manager-formulas.js computes the same batches exactly -
 * see docs/superpowers/specs/2026-09-05-formulas-integration-design.md.
 *
 * Do not import mathFormulas here. Bitburner charges for every ns function
 * reachable through imports, so touching both backends from one script would
 * cost 2.50 GB that this build never uses. tests/isolation.test.mjs enforces it.
 *
 * RAM: 1.60 base + managerCore/prepper 2.00 + mathAnalyze 2.55 = 6.15 GB
 */

/** @param {NS} ns */
export async function main(ns) {
  // Free: fileExists is already charged to this build via buildWorkerPool.
  if (ns.fileExists("Formulas.exe", "home")) {
    ns.print("note: Formulas.exe is available - scripts/manager-formulas.js is more accurate");
  }
  await run(ns, math);
}
