/**
 * Charge every fragment, round and round, until killed. Started by
 * scripts/stanek/stanek.js on the largest host that is not home, with the whole
 * of it up to stanek.maxGb; each call adds `threads x coreBonus` to one
 * fragment and takes 1 s (200 ms in bonus time).
 *
 * Imports nothing and reads no file, like the batch workers: it is paid per
 * thread. The roots arrive as args, flattened: x0 y0 x1 y1 ...
 *
 * Charging never stops on purpose. After the first round highestCharge is set,
 * but numCharge keeps growing, and the effect carries ((numCharge+1)/5)^0.07:
 * x0.94 after one charge, x1.70 after ten thousand.
 *
 * RAM: 1.60 base + chargeFragment 0.40 = 2.00 GB per thread
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const roots = [];
  for (let i = 0; i + 1 < ns.args.length; i += 2) roots.push([Number(ns.args[i]), Number(ns.args[i + 1])]);
  if (!roots.length) return;
  for (;;) {
    for (const [x, y] of roots) await ns.stanek.chargeFragment(x, y);
  }
}
