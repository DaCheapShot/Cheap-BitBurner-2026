/**
 * Weaken worker for the continuous batcher. One op, one port write, no imports.
 * See scripts/continuous/hack.js for why the no-imports rule is load-bearing.
 *
 * 1.75 GB per thread (1.60 base + 0.15 for ns.weaken).
 *
 * `r` is the amount security was actually reduced by, which is the only honest
 * measure of a weaken's effect: it already includes the executing host's core
 * bonus, so comparing it against the raw thread count is how a core-aware
 * placement gets checked against what the game really did.
 */

/** @param {NS} ns */
export async function main(ns) {
  const [target, delay, batch, port, planned, op, threads] = ns.args;

  const result = await ns.weaken(target, { additionalMsec: Number(delay) });

  ns.writePort(port, { b: batch, op, t: threads, p: planned, a: Date.now(), r: result });
}
