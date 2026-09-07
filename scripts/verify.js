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

/**
 * Did grow actually restore the batches it was supposed to?
 *
 * The geometric mean of every batch's grow multiplier cannot answer this, and
 * reading it as though it could produced a false WARN on a live run. Two things
 * confound it, both of them normal:
 *
 *   - `ns.grow` returns the multiplier AFTER the max-money clamp, so even a
 *     perfect batch reports 1/(1-steal), never the GROW_MARGIN-inflated figure
 *     the plan asked for.
 *   - a batch whose hack MISSED starts at max money, so its grow clamps
 *     immediately and reports ~1.0.
 *
 * At steal 84.48% with a 60.8% hack chance, a perfectly healthy volley averages
 * 6.44^0.608 * 1^0.392 = x3.10. A live run measured x3.55 - better than perfect -
 * while its WARN claimed grow was 45% short and advised raising GROW_MARGIN.
 *
 * Looking only at batches whose hack SUCCEEDED removes both confounds at once.
 * Such a batch starts at (1-steal) of wherever the server was and has room for
 * the full restore, so a healthy one reports at least 1/(1-steal). Anything less
 * is grow genuinely falling short, and by a factor you can read directly.
 *
 * Pure arithmetic over reports already collected - 0 GB.
 *
 * @param {object[]} outcomes  batchOutcome() results, one per batch
 * @param {number} required    1 / (1 - steal), the multiplier that breaks even
 * @param {number} [tolerance] how close counts as restored; floating point and
 *                             the additive +1/thread term both push slightly off
 * @returns {{hacked: number, restored: number, median: number, worst: number}}
 *          hacked is the denominator - batches with no successful hack are not
 *          evidence either way and are excluded entirely
 */
export function restoreStats(outcomes, required, tolerance = 0.99) {
  const mults = [];
  for (const o of outcomes) {
    // growThreads > 0 excludes batches whose grow reports never arrived; a
    // missing grow is unmeasurable, not a failure to restore.
    if (o.hackHits > 0 && o.growThreads > 0) mults.push(o.growMult);
  }
  if (!mults.length) return { hacked: 0, restored: 0, median: 0, worst: 0 };

  const sorted = [...mults].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return {
    hacked: mults.length,
    restored: mults.filter((m) => m >= required * tolerance).length,
    // Median rather than mean: one batch that hacked while the server was
    // already near empty can report an enormous multiplier and drag a mean
    // upward past the thing being measured.
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    worst: sorted[0],
  };
}

/**
 * Did any batch get hacked twice before it could grow?
 *
 * analyzeBatch judges ordering WITHIN a batch and nothing else. That was
 * deliberate - the game lands whole batches tens of ms late together, and
 * failing them for a common offset is wrong. But it leaves a blind spot: the
 * offset is only harmless while it is COMMON. When batches drift by different
 * amounts, one batch's hack can land inside another batch's hack-to-grow gap,
 * and then two hacks are answered by one grow.
 *
 * That drains geometrically and no existing measurement can see it. The batch
 * still lands in order, so batchOk passes. Its grow still achieves the full
 * restore it was sized for, so restoreStats passes. Only the money falls, which
 * is exactly the pattern a live run showed: 109/109 batches restoring while the
 * target went from $499.68b to $2.71k.
 *
 * The invariant is narrow on purpose. A foreign WEAKEN or GROW landing mid-batch
 * costs a little accuracy; a foreign HACK between this batch's hack and its grow
 * costs a whole extra steal that nothing pays back.
 *
 * Pure arithmetic over reports already collected - 0 GB.
 *
 * @param {Map<string, object[]>} byBatch  reports grouped by batch id
 * @returns {{batches: number, collided: number, intrusions: number, worst: number}}
 */
export function crossBatchOrder(byBatch) {
  const rows = [];
  for (const [id, reports] of byBatch) {
    // First landing of each op: a split hack reports once per host, and the
    // earliest is when the money actually started leaving.
    let hack = Infinity;
    let grow = Infinity;
    for (const r of reports) {
      if (r.op === "H" && r.a < hack) hack = r.a;
      if (r.op === "G" && r.a < grow) grow = r.a;
    }
    if (hack < Infinity && grow < Infinity) rows.push({ id, hack, grow });
  }
  if (!rows.length) return { batches: 0, collided: 0, intrusions: 0, worst: 0 };

  const hacks = rows.map((r) => r.hack).sort((a, b) => a - b);

  let collided = 0;
  let intrusions = 0;
  let worst = 0;

  for (const r of rows) {
    // Binary search the first hack strictly after this batch's own, then walk
    // while still inside the gap. Linear scanning is fine at 400 batches but
    // this stays cheap if the volley cap ever rises.
    let lo = 0;
    let hi = hacks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hacks[mid] <= r.hack) lo = mid + 1; else hi = mid;
    }
    let n = 0;
    for (let i = lo; i < hacks.length && hacks[i] < r.grow; i++) n++;

    if (n > 0) {
      collided++;
      intrusions += n;
      if (n > worst) worst = n;
    }
  }

  return { batches: rows.length, collided, intrusions, worst };
}

/**
 * Reconstruct the server's money from what the hacks actually took.
 *
 * Every multiplier-based reading of a volley is confounded, and the second one
 * fooled this analysis as badly as the first. `ns.grow` adds `threads` dollars
 * BEFORE multiplying, so on a drained server the additive term dominates: money
 * of $1 with 1393 grow threads reports a multiplier near x9400 while the server
 * gained $9k. A live run showed exactly that - `restoreStats` reported 259/259
 * batches restoring, median x9361, while the target sat at $9.36k of $499.68b.
 * Multipliers are scale-free; the server is not.
 *
 * Money is not scale-free, and the reports already carry it. `ns.hack` returns
 * the money it took, and it takes a known fraction of whatever is present, so
 *
 *     money at that batch's hack = stolen / steal
 *
 * That is a direct reading of the server's balance at a known instant, immune to
 * both the max-money clamp and the additive term. Batches whose hack missed
 * carry no information and are skipped.
 *
 * Pure arithmetic over reports already collected - 0 GB.
 *
 * @param {object[]} outcomes  batchOutcome() results, in launch order
 * @param {number} steal       the planned fraction each hack takes
 * @param {number} maxMoney    for expressing the trail as a fraction
 * @returns {{samples: number, first: number, median: number, last: number,
 *            min: number, heldAtMax: number}} money as a FRACTION of maxMoney;
 *          heldAtMax counts samples at or above 99% of max
 */
export function moneyTrail(outcomes, steal, maxMoney) {
  if (!(steal > 0) || !(maxMoney > 0)) {
    return { samples: 0, first: 0, median: 0, last: 0, min: 0, heldAtMax: 0 };
  }

  const trail = [];
  for (const o of outcomes) {
    if (o.hackHits > 0 && o.stolen > 0) trail.push(o.stolen / steal / maxMoney);
  }
  if (!trail.length) {
    return { samples: 0, first: 0, median: 0, last: 0, min: 0, heldAtMax: 0 };
  }

  // Median over a SORTED copy; the trail itself must stay in launch order so
  // first and last mean what they say.
  const sorted = [...trail].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return {
    samples: trail.length,
    first: trail[0],
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    last: trail[trail.length - 1],
    min: sorted[0],
    heldAtMax: trail.filter((m) => m >= 0.99).length,
  };
}
