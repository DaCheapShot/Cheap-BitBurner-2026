/**
 * Batch worker: one weaken, one report.
 *
 * RAM: 1.60 base + 0.15 ns.weaken = 1.75 GB per thread.
 * See scripts/hack.js for why the delay uses additionalMsec and why there is
 * exactly one port write.
 *
 * Runs both weaken slots of a batch. The slot tag ("W1" or "W2") arrives as an
 * argument, not baked in, so the manager can tell the two landings apart when
 * checking H,W,G,W order.
 *
 * argv: target, delayMs, batchId, port, plannedLandMs, opTag, threads
 *
 * The report's r field is ns.weaken's own return value - the security it
 * actually removed (Promise<number>). A report arriving without r means the copy
 * of this file in the game is older than the one on disk.
 */

/** @param {NS} ns */
export async function main(ns) {
  const [target, delay, batch, port, planned, op, threads] = ns.args;

  const result = await ns.weaken(target, { additionalMsec: Number(delay) });

  ns.writePort(port, { b: batch, op, t: threads, p: planned, a: Date.now(), r: result });
}
