import {
  BASELINE_SLACK_BATCHES,
  BATCH_OPS,
  CADENCE_MS,
  DRAIN_UNDER,
  GROW_MARGIN,
  BAD_BATCH_TOLERANCE,
  GROW_DRIFT_TOLERANCE,
  GROW_MARGIN_CAP,
  MONEY_FLOOR_SHARE,
  MAX_STEAL_FRACTION,
  MIN_LEAD_MS,
  MIN_STEAL_FRACTION,
  MONEY_FLOOR_BATCHES,
  NO_ROOM_TOLERANCE,
  SPACER_MS,
  STEAL_HEADROOM,
  STEAL_PROBES,
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
  // Two ceilings, and the derived one usually binds first. MAX_STEAL_FRACTION
  // is a judgement about income per unit of RAM; maxStealForDrift is arithmetic
  // about whether the batch can repair itself at all.
  return Math.min(n, cap, maxStealForDrift());
}

/**
 * The highest steal fraction whose drift budget the margin can actually buy.
 *
 * growMarginFor asks for `(1 - p) / (1 - p(1 + d))`, which diverges as `p`
 * approaches `1 / (1 + d)`. Clamping that at GROW_MARGIN_CAP does not make the
 * fraction safe - it silently hands back less headroom than was asked for, at
 * exactly the fractions where the shortfall drains a target in one window. So
 * the fraction is bounded instead. Inverting `margin <= cap`:
 *
 *     p <= (cap - 1) / (cap * (1 + d) - 1)
 *
 * At cap 3.0 and a 4% budget that is 94.3%. This is what MAX_STEAL_FRACTION was
 * asserting by hand, now with the arithmetic behind it: the ceiling is wherever
 * the drift budget stops being affordable, and it moves when either input does.
 */
export function maxStealForDrift(drift = GROW_DRIFT_TOLERANCE, marginCap = GROW_MARGIN_CAP) {
  const denom = marginCap * (1 + drift) - 1;
  if (!(denom > 0)) return 1;
  return Math.min(1, (marginCap - 1) / denom);
}

/**
 * How much a batch's hack may overshoot its plan before its own grow can no
 * longer put the money back.
 *
 * From `net = (1 - actual) * growMargin / (1 - planned) >= 1`:
 *
 *     tolerance = ((growMargin - 1) / growMargin) * (1 - steal) / steal
 *
 * With a FLAT margin the headroom collapses as steal rises - 19% at 20%, 0.25%
 * at 95% - which is why the top of the range is where a batcher dies rather
 * than merely underperforms. That is no longer how batches are sized: the
 * margin is derived from the fraction so the tolerance stays put and the cost
 * moves instead. Pass an explicit `growMargin` to ask the old question.
 */
export function stealTolerance(steal, growMargin = null, drift = GROW_DRIFT_TOLERANCE) {
  if (!(steal > 0) || !(steal < 1)) return 0;
  // The drift the batches were REALLY sized for, not the pre-evidence default.
  // Without it the controller judged a stream against a 6% tolerance while its
  // batches carried 9%, so the measurement sat permanently above the climb
  // threshold and the fraction froze - a live run held phantasy at 30.4% under
  // an 87% ceiling and iron-gym at 28.0% under 66% for the whole run.
  const m = growMargin ?? growMarginFor(steal, drift);
  return ((m - 1) / m) * ((1 - steal) / steal);
}

/**
 * The grow margin that buys `drift` of hack overshoot at this steal fraction.
 *
 * The inverse of stealTolerance, and the direction the causality actually runs.
 * A batch is safe when its own grow can undo its own hack even if the hack came
 * out `drift` stronger than planned:
 *
 *     margin * (1 - steal * (1 + drift)) / (1 - steal) >= 1
 *     margin >= (1 - steal) / (1 - steal * (1 + drift))
 *
 * Fixing the margin and reading the tolerance off it - what a flat GROW_MARGIN
 * did - puts the constant on the wrong side. A flat margin hands out headroom
 * in inverse proportion to how much is needed. See GROW_DRIFT_TOLERANCE for the
 * live run that measured what that costs.
 *
 * GROW_MARGIN survives as the FLOOR. At low fractions the algebra asks for
 * almost nothing - 1.002 at 10% steal - and there is no reason to trust the
 * model that precisely when the threads are cheap anyway.
 */
export function growMarginFor(steal, drift = GROW_DRIFT_TOLERANCE) {
  if (!(steal > 0) || !(steal < 1)) return GROW_MARGIN;
  const room = 1 - steal * (1 + drift);
  // Asking for more drift than the fraction leaves behind. No finite number of
  // grow threads repairs that, so hand back the cap and let the caller's own
  // limits bind.
  if (room <= 0) return GROW_MARGIN_CAP;
  return Math.min(GROW_MARGIN_CAP, Math.max(GROW_MARGIN, (1 - steal) / room));
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
    growMargin = null,
    drift = GROW_DRIFT_TOLERANCE,
    drainUnder = DRAIN_UNDER,
    badTolerance = BAD_BATCH_TOLERANCE,
    noRoomTol = NO_ROOM_TOLERANCE,
  } = opts;

  // Absent fields default to "nothing seen", so a caller that only tracks some
  // of the signals still gets sane decisions from the ones it does track.
  window = { batches: 0, bad: 0, worstOver: 0, worstUnder: 0, attempts: 0, noRoom: 0, ...window };

  const tol = stealTolerance(steal, growMargin, drift);
  const hold = (reason) => ({ steal, reason, changed: false });
  const back = (reason) => {
    // Never UP. chooseSteal hands back a one-hack-thread plan when even that is
    // over budget, and that fraction can sit BELOW the floor - at which point
    // `max(floor, steal * down)` raises it, on evidence that said to cut. A live
    // run logged `steal 0.3% -> 0.5% (400/400 dispatches found no room)`.
    const next = Math.min(steal, Math.max(floor, steal * down));
    return { steal: next, reason, changed: next !== steal };
  };

  // A bad batch is a sequencing fault, not a sizing one. Backing off is still
  // the right response to a PATTERN of them - a smaller steal makes every
  // subsequent batch cheaper to get wrong while the cause is unknown - but not
  // to a single one, which on a stream carrying jitter close to the spacer is
  // ordinary. See BAD_BATCH_TOLERANCE for the run this cost 40 points.
  if (window.bad > badTolerance) return back(`${window.bad} bad batch(es)`);

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
  const steal = clampSteal(rawSteal);
  if (steal === null) return null;

  const perThread = math.hackFractionPerThread(snap);
  if (!(perThread > 0)) return null;

  // FLOOR, not ceil. Rounding up would steal slightly more than planned, and
  // the grow is sized for the planned figure - so the batch would end a hair
  // below where it started, every time, and compound.
  const hack = Math.max(1, Math.floor(steal / perThread));

  return planThreadsForHack(math, snap, hack, perThread, opts);
}

/**
 * The same batch, sized from a HACK THREAD COUNT rather than a fraction.
 *
 * Split out for chooseSteal, which searches over thread counts. Going through
 * planThreads instead would mean turning a thread count into a fraction and
 * letting the floor above turn it back, and at the boundary that does not
 * round-trip - a probe for h threads can come back as h-1 and the search reads
 * it as "does not fit". The shotgun's managerCore.js carries the same split for
 * the same reason.
 *
 * @param {number} hack thread count, already >= 1
 * @param {number} perThread math.hackFractionPerThread(snap), passed in so a
 *   search does not re-measure it on every probe
 */
export function planThreadsForHack(math, snap, hack, perThread, opts = {}) {
  const { growMargin = null, drift = GROW_DRIFT_TOLERANCE } = opts;

  const weakenPer = math.weakenPerThread();
  if (!(weakenPer > 0)) return null;

  const actualSteal = Math.min(hack * perThread, 0.99);

  // Derived from the fraction this batch really takes, not the one that was
  // asked for: the floor in planThreads can move them apart, and it is the real
  // take that grow has to undo.
  const margin = growMargin ?? growMarginFor(actualSteal, drift);

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
  const from = remaining / margin;

  // Sized at the security the grow will really meet, which is minimum ONLY
  // while the stream is holding the target there. Grow lands after its own
  // weaken, so minimum is the intent - but a live run measured alpha-ent at
  // 24.54 against a 17.00 minimum with a weaken window 45% longer than the one
  // it was ranked on, and grow priced at the intent under-restores by whatever
  // the gap is worth.
  //
  // Taking the max is free in the healthy case and self-correcting in the sick
  // one: surplus grow threads clamp at max money, so over-pricing costs RAM and
  // nothing else, while under-pricing compounds. It also closes the gap between
  // the backends - the analyze backend cannot honour `atSecurity` and always
  // answers for current security, which is why it survived a run that the
  // formulas build, sizing faithfully for the minimum, did not.
  const atSec = Math.max(snap.sec ?? snap.minSec, snap.minSec);
  const grow = math.growThreadsToRestore(snap, from, snap.maxMoney, atSec);

  return {
    hack,
    weaken1,
    grow,
    // Sized here, at PLAN time, from grow's EFFECTIVE count - not after
    // placement from its raw one. See weaken2For for why that costs something
    // and why it is nonetheless required.
    weaken2: weaken2For(math, grow),
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
 * Effective weaken threads needed to cancel a grow of `growThreads`.
 *
 * Exact when handed grow's RAW placed count: processSingleServerGrowth fortifies
 * by `2 * ServerFortifyAmount * usedCycles` with usedCycles clamped to the
 * call's own thread count, so security tracks raw threads while money tracks
 * core-weighted ones.
 *
 * A BATCH cannot hand it the raw count, and that is forced rather than chosen.
 * Under JIT the ops launch in the order W1, W2, G, H - weaken-2 goes out before
 * grow does, because due_W2 = A + 2s - W and due_G = A + s - 0.8W, and the
 * difference s - 0.2W is negative for any weaken over half a second. So the raw
 * count does not exist yet when weaken-2 has to be sized.
 *
 * Handed the EFFECTIVE count instead it over-weakens, never under-weakens -
 * coreBonus is always >= 1, so raw <= effective - and weaken clamps at minimum
 * security, so the surplus does nothing. The cost is up to 44% more weaken-2
 * threads on an 8-core pool; weaken-2 is ~6.4% of batch RAM, so ~2.8% of the
 * batch against the ~27% JIT saves. A deliberate trade, not an oversight.
 *
 * PREP still passes the raw count, and should: a prep wave launches its grow
 * and weaken together and places grow first, so the exact figure is available.
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
 * How long each op of a batch HOLDS its RAM, under the current all-at-once
 * dispatcher.
 *
 * Every op execs at the same instant and waits out its own additionalMsec, so
 * each one holds RAM from the launch until its own landing - a hack thread sits
 * on 1.70 GB doing nothing for nearly a whole weaken window.
 *
 * Exists as a separate function because the JIT dispatcher will hand
 * avgConcurrentRam a different set of held times (each op's own duration) and
 * nothing else has to change. Keeping the two side by side is what makes that
 * swap a one-line change rather than a rewrite of the calculator.
 */
export function heldAllAtOnce(times, spacer = SPACER_MS) {
  return {
    H: times.weaken - spacer,
    W1: times.weaken,
    G: times.weaken + spacer,
    W2: times.weaken + 2 * spacer,
  };
}

/**
 * GB-milliseconds one batch occupies, given how long each op holds its RAM.
 *
 * @param {object} threads {hack, weaken1, grow} in EFFECTIVE threads
 * @param {object} ram     {hack, grow, weaken} GB per thread
 * @param {object} held    {H, W1, G, W2} ms each op holds its RAM
 * @param {number} weaken2 effective threads for the second weaken
 */
export function batchRamSeconds(threads, ram, held, weaken2 = 0) {
  return (
    threads.hack * ram.hack * held.H +
    threads.weaken1 * ram.weaken * held.W1 +
    threads.grow * ram.grow * held.G +
    weaken2 * ram.weaken * held.W2
  );
}

/**
 * Steady-state RAM a target ties up, in GB.
 *
 * Little's law: one batch is launched per cadence and each occupies
 * batchRamSeconds GB-ms, so the average concurrent occupancy is that over the
 * cadence.
 *
 * Sanity check on the reduction, because it is what makes this a drop-in
 * replacement for the old model: under heldAllAtOnce every op is held ~W, so
 * this becomes batchRam * W / cadence = batchRam * depth - which is exactly
 * `depth * gb`, the figure admission has always used. A test pins that so the
 * equivalence is demonstrated rather than assumed.
 */
export function avgConcurrentRam(threads, ram, held, weaken2, cadence = CADENCE_MS) {
  if (!(cadence > 0)) return Infinity;
  return batchRamSeconds(threads, ram, held, weaken2) / cadence;
}

/**
 * The best steal fraction AND cadence for a target, given the server and the RAM
 * it may have. Calculated, not configured.
 *
 * ---------------------------------------------------------------------------
 * Two knobs, because one was not enough
 *
 * At a FIXED cadence income is linear in steal with no interior optimum - one
 * batch lands per cadence, so income/sec is maxMoney * steal * chance / cadence
 * and depth does not appear. The best fraction is then just the largest that
 * fits, which is what this used to binary-search for.
 *
 * That answer is useless when the pool is small, and a live run showed how
 * badly. A pipeline needs weakenTime / cadence batches in the air, so on a 1.6
 * TB pool iron-gym (160s weaken, 400 batches deep) had to shrink its bite until
 * ONE HACK THREAD was the answer - 0.3% steal, still 38x over budget - and the
 * stream earned $0.14m/s while refusing 816 dispatches to land 3. Shrinking the
 * bite cannot fix a DEPTH problem: the floor of a batch is one hack thread plus
 * the weakens that cancel it, and 400 of those still do not fit.
 *
 * The other knob does fix it. Little's law says avgConcurrent = ramSeconds /
 * cadence, so the cadence at which a batch of ANY size exactly fills its budget
 * is ramSeconds / budget. Widening costs landings per second and buys the whole
 * fraction back, and since grow threads scale as ln(1/(1-steal)) while income
 * scales linearly, that trade is strongly favourable on a contended pool.
 *
 * So the objective is INCOME, not fit:
 *
 *     cadence(h) = max(CADENCE_MS, batchRamSeconds(h) / budget)
 *     income(h)  = take(h) / cadence(h)
 *
 * On a pool with room this reduces exactly to the old answer - every cadence
 * comes out at the floor, income is linear in the thread count, and the ceiling
 * wins.
 *
 * ---------------------------------------------------------------------------
 * The average is not the constraint when only one batch is in the air
 *
 * Little's law gives a MEAN occupancy, and a mean is only what the pool has to
 * hold when enough batches overlap to smooth it. Widening the cadence pushes
 * depth DOWN - depth is weakenTime / cadence - so the arithmetic that justifies
 * averaging is exactly what the widening destroys. Past depth 1 there is no
 * overlap left to average over and the pool has to hold one whole batch at once.
 *
 * The first build of this missed that and a live run said so plainly:
 *
 *     =iron-gym: steal 27.4% (94t hack, 0.46TB of a 0.46TB slice, paced at 363.9s)
 *     +iron-gym: batch 9.29TB x depth 1
 *
 * A perfectly reasonable 0.46 TB average, made of a 9.29 TB batch on a 1.6 TB
 * pool. It never placed a single grow: `sent 2 done 0`, `no room for G`.
 *
 * So a plan has to satisfy BOTH bounds - the mean through the cadence, and the
 * peak through the thread count. Only the second can bind on a small pool, and
 * no cadence in the world relieves it.
 *
 * Searched by a log-spaced sweep rather than a binary search, because income is
 * NOT monotonic in the thread count once the cadence moves. See STEAL_PROBES.
 *
 * @param {number} budgetGb steady-state RAM this target may occupy
 * @param {object} [opts.pin] a fraction to use instead of searching (--steal)
 * @returns {{steal, hack, threads, gb, cadence, income, fits, capped}|null} null
 *   when the target cannot be hacked at all. `fits` false means the target had
 *   to widen its cadence past CADENCE_MS to stay inside the budget - worth
 *   reporting, but no longer a reason to refuse it.
 */
export function chooseSteal(math, snap, ram, budgetGb, opts = {}) {
  const {
    cadence = CADENCE_MS,
    cap = MAX_STEAL_FRACTION,
    held = null,
    growMargin = null,
    drift = GROW_DRIFT_TOLERANCE,
    pin = null,
    probes = STEAL_PROBES,
  } = opts;

  // The calculator answers a RAM question, and RAM has nothing to say about
  // whether a fraction can repair itself. Without this it happily returned
  // 94.8-95.0% while maxStealForDrift put the protectable ceiling at 94.3%, and
  // those streams ran on a 3.68% tolerance against the 4.00% they were sized
  // for - the shortfall the ceiling exists to prevent.
  const protectable = Math.min(cap, maxStealForDrift(drift));

  const perThread = math.hackFractionPerThread(snap);
  if (!(perThread > 0)) return null;

  const times = math.opTimes(snap);
  if (!(times.weaken > 0)) return null;
  const heldTimes = held ?? heldAllAtOnce(times);

  const budget = budgetGb > 0 ? budgetGb : Infinity;

  const probe = (hack) => {
    const threads = planThreadsForHack(math, snap, hack, perThread, { growMargin, drift });
    if (!threads) return null;
    // What the pool must hold at ONE INSTANT. Every op of a batch is live just
    // before its anchor - W1 and W2 span the whole window, grow 0.8 of it - so
    // the peak really is the whole batch, and it does not shrink when the
    // cadence widens. See the note above.
    const peak = batchRam(threads, ram, threads.weaken2);
    const ramSeconds = batchRamSeconds(threads, ram, heldTimes, threads.weaken2);
    // Little's law, inverted. A batch occupies ramSeconds GB-ms and one lands
    // per cadence, so the cadence at which it exactly fills the budget is
    // ramSeconds / budget. Never faster than the configured floor, which is set
    // by jitter against the spacer and has nothing to do with RAM.
    const fitted = Math.max(cadence, ramSeconds / budget);
    return {
      hack,
      threads,
      peak,
      gb: ramSeconds / fitted,
      cadence: fitted,
      steal: threads.actualSteal,
      income: threads.take / fitted,
      fits: fitted <= cadence * (1 + 1e-9),
      fitsPeak: peak <= budget,
      capped: false,
    };
  };

  const ceiling = Math.max(1, Math.floor((pin ?? protectable) / perThread));
  if (pin !== null) return probe(ceiling) ?? probe(1);

  let best = null;
  const consider = (hack) => {
    const r = probe(hack);
    // A plan whose single batch does not fit is not a slower plan, it is one
    // that never places an op. Excluded rather than scored down, because its
    // income figure is honest arithmetic about a batch that cannot run.
    if (r && r.fitsPeak && (!best || r.income > best.income)) best = r;
  };

  // Log-spaced: the useful range of thread counts spans orders of magnitude and
  // the peak is flat near the top, so a linear walk would spend most of its
  // probes where the answer barely moves and none where it does.
  const seen = new Set();
  const ratio = ceiling > 1 ? Math.pow(ceiling, 1 / Math.max(1, probes - 1)) : 1;
  for (let i = 0; i < probes; i++) {
    const h = Math.min(ceiling, Math.max(1, Math.round(Math.pow(ratio, i))));
    if (seen.has(h)) continue;
    seen.add(h);
    consider(h);
  }
  // The ceiling is the answer whenever RAM is not the constraint, and rounding
  // in the sweep can miss it by a thread. Probed explicitly so the unconstrained
  // case lands exactly on the protectable fraction rather than a hair under it.
  if (!seen.has(ceiling)) consider(ceiling);

  // Not even one hack thread's batch fits the budget. Reported rather than
  // returned as null: the caller knows whether this target was pinned by hand
  // or picked by ranking, and it needs a `take` to score it with either way.
  if (!best) return probe(1);
  return { ...best, capped: best.hack >= ceiling };
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
 *
 * That window assumption is true of the all-at-once dispatcher and FALSE under
 * JIT, where an op holds RAM only for its own duration - hack for 0.25W rather
 * than the full window. Ranking still works, because the error biases every
 * candidate in the same direction, but this should take a held-times argument
 * and defer to batchRamSeconds when the dispatcher changes.
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
  const { moneyBatches = MONEY_FLOOR_BATCHES, floorSteal = null } = opts;

  // The floor must be sized for the LARGEST fraction still in the air, not the
  // one the next batch will use. A live run stepped 84.9% -> 50.9% under RAM
  // pressure, which tightened this floor to (1-0.509)^2 = 24.1% of max
  // instantly - while batches sized at 84.9% kept landing for another whole
  // weaken window and left the server at 15.1%. The stream then stopped itself
  // for a drain that was its own arithmetic. Every step DOWN would do this.
  const steal = Math.max(th.actualSteal, floorSteal ?? 0);

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
  // The MAX of two bounds, because neither covers the whole range. `(1-s)^N` is
  // the tighter one below ~50% steal and stays in charge there; above it the
  // power collapses - 0.28% of max at 94.7% - and a target can lose almost
  // everything before the check objects. A live run reported OFF BASELINE at
  // $9.4m of $4723.8m for exactly that reason. `(1-s) * share` is half the
  // level a healthy stream really sits at the instant after a hack lands, so it
  // stays meaningful however high the fraction goes.
  const moneyFloor = snap.maxMoney * Math.max(
    Math.pow(1 - steal, moneyBatches),
    (1 - steal) * MONEY_FLOOR_SHARE,
  );
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
