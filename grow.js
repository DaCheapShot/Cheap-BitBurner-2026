/**
 * grow.js — increase money on a target server, then exit.
 * RAM: 1.60 GB base + 0.15 GB (ns.grow) = 1.75 GB per thread.
 *
 * Args:
 *   ns.args[0] {string} target — hostname to grow (required)
 *   ns.args[1] {number} delay  — ms to sleep before acting (HWGW batch timing)
 */
/** @param {NS} ns */
export async function main(ns) {
  const target = /** @type {string} */ (ns.args[0]);
  const delay  = /** @type {number} */ (ns.args[1] ?? 0);
  await ns.sleep(delay);
  await ns.grow(target);
}
