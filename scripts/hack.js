/**
 * Batch worker: one hack, one report.
 *
 * RAM: 1.60 base + 0.10 ns.hack = 1.70 GB per thread.
 * ns.args, ns.writePort and Date.now() are all free - deliberately nothing else
 * in here, since this cost is multiplied by every thread in every batch.
 *
 * argv: target, delayMs, batchId, port, plannedLandMs, opTag, threads
 *
 * The report's r field is ns.hack's own return value - money actually stolen
 * (Promise<number>, 0 when the hack fails its chance roll). Reporting it is what
 * lets the manager confirm the batch DID something, rather than only that it
 * landed on time. A report arriving without r means the copy of this file in the
 * game is older than the one on disk.
 *
 * The landing delay uses additionalMsec rather than sleeping first. The wait
 * happens INSIDE the op, so the game schedules the effect at the right moment;
 * a sleep-then-hack would recompute the hack's own duration from the security
 * level at wake-up time and land somewhere else.
 *
 * Exactly one port write, never a retry: writePort on a full port pops the
 * OLDEST queued item to make room, so a second write would discard another real
 * report and make the loss worse. The manager detects a full port and missing
 * b+op reports on its side instead.
 */

/** @param {NS} ns */
export async function main(ns) {
  const [target, delay, batch, port, planned, op, threads] = ns.args;

  const result = await ns.hack(target, { additionalMsec: Number(delay) });

  ns.writePort(port, { b: batch, op, t: threads, p: planned, a: Date.now(), r: result });
}
