/**
 * Batch worker: one grow, one report.
 *
 * RAM: 1.60 base + 0.15 ns.grow = 1.75 GB per thread.
 * See scripts/hack.js for why the delay uses additionalMsec and why there is
 * exactly one port write.
 *
 * argv: target, delayMs, batchId, port, plannedLandMs, opTag, threads, stock
 *
 * `stock` truthy sets the op's own `stock` option: the game then nudges the
 * target company's stock forecast (up) - see STOCK_PUSH_FILE. An
 * option on the call this worker already makes, so it costs nothing per thread.
 *
 * The report's r field is ns.grow's own return value - the growth multiplier it
 * actually achieved (Promise<number>). A report arriving without r means the
 * copy of this file in the game is older than the one on disk.
 */

/** @param {NS} ns */
export async function main(ns) {
  const [target, delay, batch, port, planned, op, threads, stock] = ns.args;

  const result = await ns.grow(target, { additionalMsec: Number(delay), stock: Boolean(stock) });

  ns.writePort(port, { b: batch, op, t: threads, p: planned, a: Date.now(), r: result });
}
