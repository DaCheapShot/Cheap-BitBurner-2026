/**
 * Hack worker for the continuous batcher. One op, one port write, no imports.
 *
 * Imports NOTHING, and that is a hard rule rather than a style preference:
 *
 *  - A worker pays its RAM cost PER THREAD. This file is 1.70 GB (1.60 base +
 *    0.10 for ns.hack), and tens of thousands of threads run at once. One
 *    import that reached a single 1 GB analyze function would add that GB to
 *    every thread.
 *  - Bitburner resolves imports on the server the script STARTS on. A missing
 *    import makes exec return a bare 0 - the same value it returns when the
 *    script is absent entirely - so the failure is invisible and lands on every
 *    host except home.
 *
 * Args, positional: target, delay, batch, port, planned, op, threads
 *
 *   delay    additionalMsec. NOT a sleep. All four ops of a batch exec at the
 *            same instant and separate purely through this value, because a
 *            sleep-then-op recomputes its duration from the security level at
 *            wake-up and lands somewhere else.
 *   planned  absolute epoch ms this op was meant to land. Drift is a - p.
 */

/** @param {NS} ns */
export async function main(ns) {
  const [target, delay, batch, port, planned, op, threads] = ns.args;

  const result = await ns.hack(target, { additionalMsec: Number(delay) });

  // Exactly one write, never retried. A full port DISCARDS THE OLDEST entry, so
  // a retry would evict another worker's report rather than making room.
  ns.writePort(port, { b: batch, op, t: threads, p: planned, a: Date.now(), r: result });
}
