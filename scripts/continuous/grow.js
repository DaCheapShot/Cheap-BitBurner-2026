/**
 * Grow worker for the continuous batcher. One op, one port write, no imports.
 * See scripts/continuous/hack.js for why the no-imports rule is load-bearing.
 *
 * 1.75 GB per thread (1.60 base + 0.15 for ns.grow).
 *
 * `r` is grow's return value: the total effective multiplier applied to the
 * server's money, after both the additive $1-per-thread and the exponential
 * term. That is the number the landing analysis needs to tell a grow that
 * restored the batch's take from one that fell short.
 */

/** @param {NS} ns */
export async function main(ns) {
  const [target, delay, batch, port, planned, op, threads] = ns.args;

  const result = await ns.grow(target, { additionalMsec: Number(delay) });

  ns.writePort(port, { b: batch, op, t: threads, p: planned, a: Date.now(), r: result });
}
