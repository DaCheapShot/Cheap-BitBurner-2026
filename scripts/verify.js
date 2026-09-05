/**
 * Landing analysis for a set of worker reports. Pure functions, no ns calls -
 * 0 GB to import.
 *
 * Kept separate from scripts/manager.js because it is the definition of "landed
 * correctly" - the rules below are subtle enough to be worth stating in one
 * place, and any second consumer must judge a batch identically.
 */

/**
 * Analyse one batch's reports.
 *
 * The central distinction, and the reason this is its own module:
 *
 *   lateness - the COMMON offset shared by every op in the batch. The game runs
 *              ops on its own loop, so a whole batch routinely lands tens of ms
 *              after plan, together. That shifts all four landings equally and
 *              cannot reorder anything. Measured runs have seen this swing from
 *              +2ms to +36ms between otherwise identical batches.
 *   jitter   - the SPREAD of drift within the batch. This is the ordering risk:
 *              a gap of one spacer survives until a later op drifts a full
 *              spacer earlier than the op before it. Must stay under SPACER_MS.
 *
 * Judging a batch on absolute drift conflates the two and fails healthy batches.
 *
 * @param {object[]} reports  port messages for ONE batch
 * @param {string[]} ops      expected op tags in required landing order
 */
export function analyzeBatch(reports, ops) {
  // Sort by ACTUAL landing time, not arrival order - two reports written in the
  // same tick can be read in either order, which would be a false failure.
  const byActual = [...reports].sort((a, b) => a.a - b.a);
  const drifts = byActual.map((m) => m.a - m.p);

  // One entry per op even when an op was split across hosts.
  const orderSeen = [];
  for (const m of byActual) if (!orderSeen.includes(m.op)) orderSeen.push(m.op);
  const orderOk = orderSeen.join(",") === ops.join(",");

  const lateness = drifts.length ? drifts.reduce((n, d) => n + d, 0) / drifts.length : 0;
  const jitter = drifts.length ? Math.max(...drifts) - Math.min(...drifts) : 0;

  // Realised gaps between consecutive landings - direct evidence of ordering,
  // no inference. Every one must be positive.
  const firstLand = new Map();
  for (const m of byActual) if (!firstLand.has(m.op)) firstLand.set(m.op, m.a);
  const gaps = [];
  for (let i = 1; i < orderSeen.length; i++) {
    const from = orderSeen[i - 1];
    const to = orderSeen[i];
    gaps.push({ from, to, ms: firstLand.get(to) - firstLand.get(from) });
  }
  const gapsOk = gaps.every((g) => g.ms > 0);

  // A report with no r field predates workers reporting their op's return value:
  // the copy in the game is older than the one on disk.
  const stale = byActual.filter((m) => m.r === undefined).length;

  return { byActual, orderSeen, orderOk, lateness, jitter, gaps, gapsOk, stale };
}

/** True if a batch landed in the required order with survivable jitter. */
export function batchOk(a, spacerMs) {
  return a.orderOk && a.gapsOk && a.jitter < spacerMs;
}
