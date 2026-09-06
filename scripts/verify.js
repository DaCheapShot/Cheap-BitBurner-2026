/**
 * Landing analysis for a set of worker reports. Pure functions, no ns calls -
 * 0 GB to import.
 *
 * Kept separate from scripts/managerCore.js because it is the definition of "landed
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

/**
 * What a batch ACTUALLY did, from the values its workers returned.
 *
 * Every worker already reports its op's return value: hack returns money
 * stolen, grow returns the multiplier it achieved, weaken returns the security
 * it removed. Until now nothing read them, so the manager reported PLANNED
 * figures as though they were measured - and a volley that drained its target
 * to nothing still printed a healthy-looking take.
 *
 * Grow multipliers MULTIPLY rather than sum: a batch's grow is split across
 * hosts, each call scaling whatever money is present when it runs, so the
 * batch's real multiplier is the product of the parts.
 *
 * Pure arithmetic over data already collected - 0 GB, no new ns calls.
 *
 * @param {object[]} reports port messages for ONE batch
 * @returns {{stolen: number, growMult: number, weakened: number,
 *            hackThreads: number, growThreads: number, missing: number}}
 */
export function batchOutcome(reports) {
  let stolen = 0;
  let growMult = 1;
  let weakened = 0;
  let hackThreads = 0;
  let growThreads = 0;
  let missing = 0;
  // Hack has a success CHANCE. A failed hack returns 0 and takes nothing, so
  // counting hits against tries measures that chance directly - far better than
  // inferring it from money, which needs assumptions about the starting state.
  let hackHits = 0;
  let hackTries = 0;

  for (const m of reports) {
    // A report with no numeric r came from a worker deployed before workers
    // returned results. Counting it as zero would understate the batch; count
    // it as missing so the caller can say "unmeasurable" instead of "bad".
    if (typeof m.r !== "number") {
      missing++;
      continue;
    }
    if (m.op === "H") {
      stolen += m.r;
      hackThreads += m.t;
      hackTries++;
      if (m.r > 0) hackHits++;
    } else if (m.op === "G") {
      growMult *= m.r;
      growThreads += m.t;
    } else {
      weakened += m.r;
    }
  }

  return { stolen, growMult, weakened, hackThreads, growThreads, missing, hackHits, hackTries };
}
