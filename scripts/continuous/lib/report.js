import { PORT_CAPACITY } from "scripts/continuous/config";

/**
 * Landing reports: draining the port, and judging what came off it.
 *
 *   ns.getPortHandle   0 GB
 *   ns.sleep           0 GB
 *
 * So this module is free to import. The analysis half is pure and takes plain
 * arrays, which is what lets it be tested in node without a game.
 *
 * Report shape, written by the workers:
 *
 *   { b: batchId, op: "H"|"W1"|"G"|"W2", t: threads,
 *     p: plannedLandMs, a: actualLandMs, r: opReturnValue }
 *
 * p and a are absolute epoch ms. Drift is a - p.
 */

/** How long to wait between drain passes, ms. */
const DRAIN_MS = 25;

/**
 * Take everything currently on the port and bucket it by batch id.
 *
 * port.read() REMOVES the message, so there must be exactly ONE drain loop per
 * port in the whole system. Two loops silently destroy each other's reports,
 * and the symptom is batches that look half-landed forever.
 *
 * @param {object} port a NetscriptPort handle
 * @param {Map<string, object[]>} byBatch mutated in place
 * @returns {number} messages taken
 */
export function drain(port, byBatch) {
  let got = 0;
  while (!port.empty()) {
    const msg = port.read();
    if (!msg || typeof msg !== "object") continue; // "NULL PORT DATA", or junk
    const key = String(msg.b);
    if (!byBatch.has(key)) byBatch.set(key, []);
    byBatch.get(key).push(msg);
    got++;
  }
  return got;
}

/**
 * Drain until `total` reports arrive or the deadline passes.
 *
 * @param {NS} ns
 * @param {number} portNumber
 * @param {number} total how many reports are expected
 * @param {number} deadline absolute epoch ms to give up at
 * @returns {Promise<{byBatch: Map<string, object[]>, got: number, sawFull: boolean}>}
 */
export async function collect(ns, portNumber, total, deadline) {
  const port = ns.getPortHandle(portNumber);
  const byBatch = new Map();
  let got = 0;
  let sawFull = false;

  while (got < total && Date.now() < deadline) {
    // A full port DISCARDS THE OLDEST entry, so an overflow does not merely
    // delay reports - it destroys the earliest landings of a batch, which is
    // exactly the data the order check needs. Worth reporting loudly.
    if (port.full()) sawFull = true;
    got += drain(port, byBatch);
    await ns.sleep(DRAIN_MS);
  }

  // One last sweep: the loop can exit on the deadline with messages already
  // sitting on the port.
  if (port.full()) sawFull = true;
  got += drain(port, byBatch);

  return { byBatch, got, sawFull };
}

/** Empty the port. Do this before a run so stale reports cannot be credited. */
export function clear(ns, portNumber) {
  ns.getPortHandle(portNumber).clear();
}

/** True when a report count is at risk of having overflowed the port. */
export const nearCapacity = (n) => n >= PORT_CAPACITY;

/**
 * Judge a set of landings that were all meant to arrive together.
 *
 * The signal is JITTER - the spread of drift across the group - not absolute
 * lateness. The game lands whole groups tens of ms late together, and a common
 * offset cannot reorder anything; a spread can. Reporting lateness as the error
 * makes a healthy stream look broken and hides the case that actually matters.
 *
 * @param {object[]} reports
 * @returns {{n, lateness, jitter, earliest, latest, drifts}}
 */
export function analyzeLandings(reports) {
  const drifts = reports
    .map((r) => Number(r.a) - Number(r.p))
    .filter((d) => Number.isFinite(d));

  if (drifts.length === 0) {
    return { n: 0, lateness: 0, jitter: 0, earliest: 0, latest: 0, drifts: [] };
  }

  const earliest = Math.min(...drifts);
  const latest = Math.max(...drifts);

  return {
    n: drifts.length,
    lateness: drifts.reduce((a, b) => a + b, 0) / drifts.length,
    jitter: latest - earliest,
    earliest,
    latest,
    drifts,
  };
}

/**
 * Did one batch's four ops land in the required order, spaced by the spacer?
 *
 * Ordered by ACTUAL landing time, not by planned - the question is what the
 * game did, and sorting by plan would answer it by assumption.
 *
 * @param {object[]} reports one batch's reports
 * @param {string[]} ops expected op order, e.g. ["H","W1","G","W2"]
 * @param {number} spacerMs
 */
export function analyzeBatch(reports, ops, spacerMs) {
  const seen = [...reports].sort((a, b) => Number(a.a) - Number(b.a));
  const orderSeen = seen.map((r) => r.op);

  const complete = reports.length === ops.length;
  const orderOk = complete && orderSeen.every((op, i) => op === ops[i]);

  // Gaps between consecutive landings. A gap far under the spacer means two ops
  // effectively landed together and their order was luck.
  const gaps = [];
  for (let i = 1; i < seen.length; i++) {
    gaps.push({ from: seen[i - 1].op, to: seen[i].op, ms: Number(seen[i].a) - Number(seen[i - 1].a) });
  }
  const tightest = gaps.length ? Math.min(...gaps.map((g) => g.ms)) : Infinity;

  const landing = analyzeLandings(reports);

  return {
    ...landing,
    complete,
    orderSeen,
    orderOk,
    gaps,
    tightest,
    // The batch is healthy if the four ops arrived in order and nothing landed
    // close enough to another op for jitter to have swapped them.
    ok: orderOk && landing.jitter < spacerMs && tightest > 0,
  };
}
