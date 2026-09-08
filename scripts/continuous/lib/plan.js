import {
  BASELINE_SLACK_BATCHES,
  BATCH_OPS,
  DRAIN_UNDER,
  GROW_MARGIN,
  MAX_STEAL_FRACTION,
  MIN_LEAD_MS,
  MIN_STEAL_FRACTION,
  MONEY_FLOOR_BATCHES,
  NO_ROOM_TOLERANCE,
  SPACER_MS,
  STEAL_HEADROOM,
  STEAL_MIN_SAMPLES,
  STEAL_STEP_DOWN,
  STEAL_STEP_UP,
} from "scripts/continuous/config";

/**
 * Batch timing and thread math. Pure - no ns calls at all, so it costs 0 GB to
 * import and runs unchanged under node for testing.
 *
 * Everything here works in EFFECTIVE (one-core-equivalent) threads for grow and
 * weaken, and in raw threads for hack. ServerPool.allocateEffective turns the
 * former into real placements; hack gets no core bonus, so for it the two are
 * the same number.
 */

/**
 * Landing offsets relative to the batch anchor, which is weaken-1's landing.
 *
 *   H  anchor - s      W1  anchor      G  anchor + s      W2  anchor + 2s
 *
 * Anchored on weaken because it is the longest op, so every other offset comes
 * out reachable. Hack lands FIRST - it must take its cut before grow refills -
 * and each weaken lands immediately after the op whose security it cancels.
 */
export function landingOffsets(spacer = SPACER_MS) {
  return { H: -spacer, W1: 0, G: spacer, W2: 2 * spacer };
}

/** Which op time governs each slot. Both weakens run for a full weaken time. */
export function opTimesByOp(times) {
  return { H: times.hack, W1: times.weaken, G: times.grow, W2: times.weaken };
}

/**
 * When the next batch's anchor should be.
 *
 * This is the function that makes a stream a stream, and it is doing two jobs
 * at once:
 *
 *  1. Pace. Anchors are one cadence apart, so landings interleave into a
 *     continuous sequence rather than arriving in bursts.
 *
 *  2. Monotonicity, which is the streaming-specific hazard. As hacking level
 *     rises, weakenTime SHRINKS. A batch dispatched later therefore finishes
 *     sooner than one already in the air, and can land its hack inside an older
 *     batch's hack-to-grow gap - stealing money that batch's grow was not sized
 *     to replace. Taking the max against `prev + cadence` makes a new anchor
 *     strictly later than the previous one whatever the op times do, so the
 *     stream self-corrects into a slower cadence rather than eating itself.
 *
 * The shotgun cannot hit this: it sizes one volley from one snapshot and every
 * batch in it shares the same op times.
 *
 * @param {number|null} prevAnchor previous batch's anchor, null for the first
 * @param {number} now
 * @param {number} weakenTime current weaken time for the target
 * @param {number} cadence
 * @param {number} [minLead] cushion so hack's additionalMsec stays positive
 * @returns {number} absolute epoch ms for weaken-1's landing
 */
export function nextAnchor(prevAnchor, now, weakenTime, cadence, minLead = MIN_LEAD_MS) {
  // The earliest anchor a batch dispatched right now could possibly reach: a
  // full weaken from here, plus the cushion hack needs to still be launchable.
  const earliest = now + weakenTime + minLead;
  if (prevAnchor === null) return earliest;
  return Math.max(prevAnchor + cadence, earliest);
}

/**
 * additionalMsec for one op of a batch.
 *
 * MUST be recomputed at that op's own exec, never once per batch. A dispatch is
 * several exec calls spanning real wall time, and a delay computed up front is
 * correct only for the first worker out of the door.
 *
 * Clamped at zero: a negative delay means the op cannot reach its slot, which
 * is a scheduling failure to report, not something to paper over by launching
 * an op that will land in the wrong order.
 */
export function delayFor(land, opTime, now) {
  return Math.max(0, land - now - opTime);
}

/** True when an op still has time to reach its landing slot. */
export function reachable(land, opTime, now) {
  return land - now - opTime >= 0;
}

/**
 * Force a steal fraction into the range the batch math can actually survive.
 *
 * MAX_STEAL_FRACTION used to exist only as prose. Nothing read it, so
 * `--steal 0.99` was accepted, and so was `--steal 5` - which produces a hack
 * thread count sized to take five times the server's money, a grow sized to
 * restore from a balance that cannot occur, and a target drained to nothing
 * within one window. A mistyped terminal argument was enough.
 *
 * Clamped rather than rejected, so a too-large number costs the difference
 * rather than the whole run. Anything unparseable or non-positive returns null
 * instead: NaN compares false against every bound, so silently treating it as a
 * default would let garbage through the exact check meant to stop it.
 *
 * @returns {number|null} null when the input is not a usable fraction
 */
export function clampSteal(steal, cap = MAX_STEAL_FRACTION) {
  const n = Number(steal);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, cap);
}

/**
 * How much a batch's hack may overshoot its plan before its own grow can no
 * longer put the money back.
 *
 * From `net = (1 - actual) * growMargin / (1 - planned) >= 1`:
 *
 *     tolerance = ((growMargin - 1) / growMargin) * (1 - steal) / steal
 *
 * The headroom collapses as steal rises - 19% at 20%, 0.25% at 95% - which is
 * why the top of the range is where a batcher dies rather than merely
 * underperforms.
 */
export function stealTolerance(steal, growMargin = GROW_MARGIN) {
  if (!(steal > 0) || !(steal < 1)) return 0;
  return ((growMargin - 1) / growMargin) * ((1 - steal) / steal);
}

/**
 * Decide the next steal fraction from what the last window of batches actually
 * did.
 *
 * The shotgun could never do this: it sizes a volley, fires it, and by the time
 * the reports arrive the decision is long spent. A stream has every batch
 * reporting the money it really took against the money it was planned to take -
 * so the drift that MAX_STEAL_FRACTION exists to bound is MEASURED here, not
 * assumed. That is the whole reason the ceiling could be raised.
 *
 * Asymmetric by design. A step too low costs a few percent of income; a step
 * too high costs a drained target and a re-prep, and the tolerance shrinks as
 * the fraction rises, so an overshoot compounds into the next step. Hence a
 * fast climb-down, a slow climb-up, and a step up only from comfortably inside
 * the tolerance rather than from its edge.
 *
 * @param {number} steal current fraction
 * @param {object} window evidence since the last change:
 *   `batches`    retired in the window
 *   `bad`        judged not ok (order, intrusion, incomplete)
 *   `worstOver`  max(stolen / plannedTake - 1). Money clamps at maxMoney, so a
 *                POSITIVE value can only mean hack effectiveness rose between
 *                dispatch and landing - the drift the ceiling bounds.
 *   `worstUnder` min of the same ratio. NEGATIVE means the server was not full
 *                when the hack landed, ie. the previous batch did not restore.
 *   `attempts`   dispatch attempts
 *   `noRoom`     of those, ones the pool could not seat
 * @param {number} cap MAX_STEAL_FRACTION
 * @returns {{steal: number, reason: string, changed: boolean}}
 */
export function nextSteal(steal, window, cap = MAX_STEAL_FRACTION, opts = {}) {
  const {
    up = STEAL_STEP_UP,
    down = STEAL_STEP_DOWN,
    minSamples = STEAL_MIN_SAMPLES,
    headroom = STEAL_HEADROOM,
    floor = MIN_STEAL_FRACTION,
    growMargin = GROW_MARGIN,
    drainUnder = DRAIN_UNDER,
    noRoomTol = NO_ROOM_TOLERANCE,
  } = opts;

  // Absent fields default to "nothing seen", so a caller that only tracks some
  // of the signals still gets sane decisions from the ones it does track.
  window = { batches: 0, bad: 0, worstOver: 0, worstUnder: 0, attempts: 0, noRoom: 0, ...window };

  const tol = stealTolerance(steal, growMargin);
  const hold = (reason) => ({ steal, reason, changed: false });
  const back = (reason) => {
    const next = Math.max(floor, steal * down);
    return { steal: next, reason, changed: next !== steal };
  };

  // A bad batch is a sequencing fault, not a sizing one, but the response is
  // the same: a smaller steal makes every subsequent batch cheaper to get wrong
  // and buys back tolerance while the cause is still unknown.
  if (window.bad > 0) return back(`${window.bad} bad batch(es)`);

  // Took MORE than the grow was sized to put back. Since money clamps at
  // maxMoney, a positive `over` can only come from hack effectiveness rising
  // between dispatch and landing - which is precisely the drift the ceiling
  // exists to bound, now measured instead of assumed.
  if (window.worstOver > tol) {
    return back(
      `overshoot ${(window.worstOver * 100).toFixed(2)}% past the ` +
        `${(tol * 100).toFixed(2)}% tolerance`,
    );
  }

  // Took LESS than planned, which by the same identity means the server was not
  // full when the hack landed. The batch before it did not restore, so a
  // smaller bite is the only thing that lets the target climb back while still
  // earning.
  if (window.worstUnder < -drainUnder) {
    return back(
      `target only ${((1 + window.worstUnder) * 100).toFixed(0)}% full when a hack landed`,
    );
  }

  // The pool could not seat the batch often enough to keep the cadence fed. A
  // dispatch that fails loses a slot it never gets back, and at high steal a
  // batch is over ten times its size at 10%, so a smaller batch is the fix -
  // not a queue, and not dropping the target.
  if (window.attempts > 0 && window.noRoom / window.attempts > noRoomTol) {
    return back(
      `${window.noRoom}/${window.attempts} dispatches found no room`,
    );
  }

  if (window.batches < minSamples) return hold("not enough samples yet");

  if (window.worstOver <= tol * headroom) {
    const next = Math.min(cap, steal * up);
    if (next === steal) return hold("at the ceiling");
    return {
      steal: next,
      changed: true,
      reason: `${window.batches} clean, worst overshoot ` +
        `${(Math.max(0, window.worstOver) * 100).toFixed(2)}% of a ` +
        `${(tol * 100).toFixed(2)}% tolerance`,
    };
  }

  return hold("inside tolerance but not comfortably");
}

/**
 * Thread counts for one HWGW batch against a prepped target.
 *
 * Grow and weaken counts are EFFECTIVE threads; hack is raw. weaken-2 is
 * deliberately absent - it can only be sized once grow has been PLACED, because
 * grow's security cost tracks the raw thread count the placement actually used
 * while its money effect tracks the core-weighted one. See weaken2For.
 *
 * @returns {object|null} null when the target cannot be hacked at all
 */
export function planThreads(math, snap, rawSteal, opts = {}) {
  const { growMargin = GROW_MARGIN } = opts;

  const steal = clampSteal(rawSteal);
  if (steal === null) return null;

  const perThread = math.hackFractionPerThread(snap);
  if (!(perThread > 0)) return null;

  const weakenPer = math.weakenPerThread();
  if (!(weakenPer > 0)) return null;

  // FLOOR, not ceil. Rounding up would steal slightly more than planned, and
  // the grow is sized for the planned figure - so the batch would end a hair
  // below where it started, every time, and compound.
  const hack = Math.max(1, Math.floor(steal / perThread));
  const actualSteal = Math.min(hack * perThread, 0.99);

  const hackSec = hack * math.securityPerHackThread();
  const weaken1 = Math.ceil(hackSec / weakenPer);
  const growSecPerThread = math.securityPerGrowThread();

  // The margin is applied to MONEY, not to threads: grow is sized to climb back
  // from `remaining / growMargin` rather than from `remaining`, ie. as though
  // the hack had taken more than it did. Applying it to the thread count
  // instead would raise the multiplier to a power - 9% of headroom at a x5.64
  // restore but 0.5% at x1.11 - so the protection would evaporate exactly where
  // a small steal fraction needs it.
  const remaining = snap.maxMoney * (1 - actualSteal);
  const from = remaining / growMargin;

  // Sized at the security prep holds the target at, not at whatever it reads
  // right now, because grow lands after its weaken. The formulas backend
  // honours this; the analyze backend cannot and answers for current security.
  const grow = math.growThreadsToRestore(snap, from, snap.maxMoney, snap.minSec);

  return {
    hack,
    weaken1,
    grow,
    actualSteal,
    perThread,
    hackSec,
    // Priced off the EFFECTIVE grow count, so it over-states what a placement
    // will really add. That is the right bias for a tolerance: it makes the
    // baseline check a little more forgiving, never less.
    growSec: grow * growSecPerThread,
    weakenPer,
    // What this batch is worth if the hack lands. Not adjusted for hack chance:
    // a failed hack takes nothing, which is a property of the run, not of the
    // plan, and the stream measures the difference from the reports.
    take: snap.maxMoney * actualSteal,
  };
}

/**
 * Effective weaken threads needed to cancel a grow that placed `growRaw` raw
 * threads.
 *
 * Raw, not effective, and that distinction is the whole reason this is a
 * separate function called after placement. processSingleServerGrowth fortifies
 * by `2 * ServerFortifyAmount * usedCycles` with usedCycles clamped to the
 * call's own thread count, so security tracks raw threads while money tracks
 * core-weighted ones.
 *
 * Using the effective count here would over-weaken, not under-weaken - coreBonus
 * is always >= 1 - which is safe but wastes up to 44% of the weaken RAM on an
 * 8-core host. Raw is exact.
 */
export function weaken2For(math, growRaw) {
  const sec = growRaw * math.securityPerGrowThread();
  return Math.ceil(sec / math.weakenPerThread());
}

/**
 * RAM one batch needs, given effective thread counts.
 *
 * An ESTIMATE, and always an over-estimate: it prices grow and weaken as if
 * every thread landed on a single core, when core-aware placement will use
 * fewer raw threads than that. Good enough to rank targets and to decide
 * whether to bother attempting a placement; never a substitute for attempting
 * one, because every host floors its own thread count and the byte total
 * overstates what will actually fit.
 */
export function batchRam(threads, ram, weaken2 = 0) {
  return (
    threads.hack * ram.hack +
    threads.grow * ram.grow +
    (threads.weaken1 + weaken2) * ram.weaken
  );
}

/**
 * Money per GB-second: what a target earns for the RAM it ties up.
 *
 * This is the honest ranking number and the reason it needs batch thread math.
 * Income alone is a paper ceiling - it made foodnstuff, with $50m of max money
 * and 0.0175% growth per thread, outrank targets that actually fit in the pool,
 * because its 634 grow threads cost over a terabyte per batch.
 *
 * A batch occupies its RAM for roughly one weaken window (the ops are launched
 * together and the last releases a couple of spacers after the anchor), so
 * GB-seconds per batch is batchRam * weakenTime, and income per batch arrives
 * once per cadence once the stream is at depth.
 */
export function moneyPerGbSec(take, chance, gb, weakenMs) {
  if (!(gb > 0) || !(weakenMs > 0)) return 0;
  return (take * chance) / (gb * (weakenMs / 1000));
}

/**
 * Is the target still sitting on its baseline, allowing for the batches
 * currently in the air?
 *
 * A streaming target is NEVER at rest, and the first live run made that
 * expensive: the gate demanded moneyOk && secOk - the prep-time definition of
 * prepped - and a target holding perfectly steady at max money was reported
 * "unprepped", because the snapshot happened to fall in the 200ms between a
 * hack landing and its grow. That test is one a healthy stream cannot pass.
 *
 * The transient is bounded and knowable, so the tolerance is derived from the
 * batch itself rather than guessed: money may sit `slack` batches' worth of
 * steal low, and security `slack` batches' worth of uncancelled hack-plus-grow
 * high. A genuine drift compounds and clears these within a few cadences.
 */
export function baselineDrift(snap, th, slack = BASELINE_SLACK_BATCHES, opts = {}) {
  const { moneyBatches = MONEY_FLOOR_BATCHES } = opts;

  // MULTIPLICATIVE, and this is a bug fix. The floor was
  // `maxMoney * (1 - steal * slack)`, which goes NEGATIVE above 1/slack - so
  // above roughly 33% steal the money check silently passed everything, and it
  // was dead exactly where the stakes are highest.
  //
  // N hacks landing before any of their grows leaves `(1 - steal)^N`, so that
  // is the honest bound: tight at low steal (0.81 at 10%), permissive at high
  // steal (0.0025 at 95%), never negative. Permissive is CORRECT there - at 95%
  // the legitimate dip really is almost the whole balance.
  //
  // Security stays additive, because security genuinely adds.
  const moneyFloor = snap.maxMoney * Math.pow(1 - th.actualSteal, moneyBatches);
  const secCeiling = snap.minSec + (th.hackSec + th.growSec) * slack;

  const moneyOff = snap.money < moneyFloor;
  const secOff = snap.sec > secCeiling;

  return {
    off: moneyOff || secOff,
    moneyOff,
    secOff,
    moneyFloor,
    secCeiling,
    // How far off, as a fraction of the allowance - useful in a log line,
    // because "off baseline" without a number is a diagnosis nobody can act on.
    moneyShortfall: moneyOff ? (moneyFloor - snap.money) / snap.maxMoney : 0,
    secExcess: secOff ? snap.sec - secCeiling : 0,
  };
}

/**
 * Judge a batch's reports: did every op land, in order, without the spread that
 * could have reordered them?
 *
 * Grouped BY OP, not by report. An op that was split across hosts produces one
 * report per placement, so a batch whose grow landed on two machines reports
 * [H, W1, G, G, W2] - five messages for four ops. The first version counted
 * messages against BATCH_OPS.length and condemned every split batch as
 * incomplete; the live run desynced a perfectly healthy stream on its first
 * retired batch, at 15ms of jitter with the hack landed and the money restored.
 *
 * Each op is placed at the EARLIEST landing among its own workers. They are all
 * aimed at the same millisecond, so the spread within an op is jitter, not
 * sequence - and taking the earliest is the conservative read when asking
 * whether one op got ahead of another.
 *
 * @param {object[]} reports
 * @param {number} spacerMs
 * @param {number} [expected] exec count, when the caller knows it. Without it,
 *   completeness can only mean "all four ops showed up", which a batch missing
 *   one worker of a split op would still satisfy.
 */
export function batchVerdict(reports, spacerMs = SPACER_MS, expected = null) {
  const landingByOp = new Map();
  let stolen = 0;
  let sawHack = false;

  for (const r of reports) {
    const at = Number(r.a);
    if (!Number.isFinite(at)) continue;
    const prev = landingByOp.get(r.op);
    if (prev === undefined || at < prev) landingByOp.set(r.op, at);

    // Hack can be split too, in which case each call takes its fraction of
    // whatever is left when it resolves - so the take is the SUM, not one
    // worker's return value.
    if (r.op === "H") {
      sawHack = true;
      stolen += Number(r.r) || 0;
    }
  }

  const orderSeen = [...landingByOp.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([op]) => op);

  const allOps = BATCH_OPS.every((op) => landingByOp.has(op));
  const allWorkers = expected === null ? true : reports.length >= expected;
  const complete = allOps && allWorkers;
  const orderOk = complete && orderSeen.length === BATCH_OPS.length &&
    orderSeen.every((op, i) => op === BATCH_OPS[i]);

  const drifts = reports.map((r) => Number(r.a) - Number(r.p)).filter(Number.isFinite);
  const jitter = drifts.length ? Math.max(...drifts) - Math.min(...drifts) : 0;

  return {
    complete,
    allOps,
    orderSeen,
    orderOk,
    jitter,
    stolen,
    // A hack that misses returns 0. That is hack chance showing up, not a
    // fault: the grow was sized for a hit, so the target ends ABOVE where it
    // started, which money clamping makes harmless. Counted separately from a
    // real failure so the hit rate can be read against the target's chance.
    hackHit: sawHack && stolen > 0,
    ok: orderOk && jitter < spacerMs,
  };
}
