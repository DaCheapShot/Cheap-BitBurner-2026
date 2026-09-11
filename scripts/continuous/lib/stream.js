import {
  baselineDrift,
  batchRam,
  batchVerdict,
  delayFor,
  landingOffsets,
  nextAnchor,
  maxStealForDrift,
  nextSteal,
  opTimesByOp,
  planThreads,
  reachable,
} from "scripts/continuous/lib/plan";
import {
  BASELINE_SLACK_BATCHES,
  BATCH_GRACE_MS,
  BATCH_OPS,
  CADENCE_MS,
  CONT_REPORT_PORT,
  DESYNC_STRIKES,
  DRAIN_UNDER,
  DRIFT_DECAY,
  DRIFT_SAFETY,
  GROW_DRIFT_TOLERANCE,
  MAX_ANCHOR_SWING,
  MAX_DRIFT_TOLERANCE,
  MIN_DRIFT_TOLERANCE,
  MAX_IN_FLIGHT,
  LATE_TOLERANCE_MS,
  LAUNCH_LEAD_MS,
  MAX_STEAL_FRACTION,
  MIN_LEAD_MS,
  OPTIME_REFRESH_MS,
  OP_FILL_ORDER,
  OP_WORKER,
  SPACER_MS,
  STEAL_FRACTION,
  WORKER_FILES,
} from "scripts/continuous/config";

/**
 * One continuous stream against one prepped target.
 *
 *   ns.exec   1.30
 *
 * plus the pool and the math backend, which the caller already pays for.
 *
 * A stream owns no loop of its own. The caller ticks it, feeds it reports, and
 * retires its finished batches - which is what lets several streams share one
 * pool and, critically, ONE drain loop. port.read() removes the message, so two
 * drain loops on one port silently destroy each other's reports.
 *
 * ---------------------------------------------------------------------------
 * Launch order is W1, G, W2, then H - deliberately not landing order
 *
 * A batch must be all-or-nothing: one that hacks but fails to grow steals money
 * and never puts it back, which is worse than not firing at all. But a dispatch
 * is several exec calls and any of them can return 0.
 *
 * Launching hack LAST makes that safe for free. Every op before it can only
 * move the target toward prepped, so aborting partway leaves grow and weaken
 * running with no hack - the target simply stays at max money, since grow
 * clamps there. And if hack itself is the exec that fails, the same is true.
 * There is no ordering of the four that can leave a hack running without its
 * grow, so no kill path is needed and ns.kill's 0.5 GB is never paid.
 *
 * The LANDING order is still H, W1, G, W2. Separation comes from additionalMsec
 * alone; the order the execs happen in has nothing to do with it.
 */

/**
 * Ops in the order they come DUE, which under JIT is derived rather than chosen.
 *
 * due = land - opTime, and with G = 0.8W, H = 0.25W:
 *
 *   due_W1 = A - W          due_W2 = A + 2s - W
 *   due_G  = A + s - 0.8W   due_H  = A - s - 0.25W
 *
 * so W1 < W2 < G < H whenever W > 3.6s - always. Note W2 comes before G, which
 * is why weaken-2 has to be sized at plan time from grow's effective count:
 * grow has not been placed yet when weaken-2 goes out.
 *
 * The array order matters when several ops fall due inside one tick, because
 * tick() drains the queues in this sequence. Getting it wrong is not fatal -
 * additionalMsec still lands each op where it belongs - but it launches ops out
 * of due order, which wastes the head start the earlier one was given.
 *
 * Hack is last in every case, and that is what makes aborting a batch part-way
 * safe: there is no ordering that strands a hack without its grow.
 */
const LAUNCH_ORDER = ["W1", "W2", "G", "H"];

export function createStream(ns, math, opts) {
  const {
    host,
    pool,
    ram,
    port = CONT_REPORT_PORT,
    steal: initialSteal = STEAL_FRACTION,
    cap: initialCap = MAX_STEAL_FRACTION,
    adaptive = true,
    cadence: initialCadence = CADENCE_MS,
    spacer = SPACER_MS,
    maxInFlight = MAX_IN_FLIGHT,
    minLead = MIN_LEAD_MS,
    grace = BATCH_GRACE_MS,
    strikeLimit = DESYNC_STRIKES,
    slack = BASELINE_SLACK_BATCHES,
    lead = LAUNCH_LEAD_MS,
    lateTolerance = LATE_TOLERANCE_MS,
    optimeRefresh = OPTIME_REFRESH_MS,
    idPrefix = "s",
    log = () => {},
  } = opts;

  // Not a constant. chooseSteal widens it per target when the target's pipeline
  // does not fit its RAM budget at the configured rate - fewer, bigger batches
  // beat a floor of one-hack-thread batches that still do not fit. CADENCE_MS is
  // the floor; nothing ever runs faster.
  let cadence = Math.max(CADENCE_MS, initialCadence);

  const inFlight = new Map();

  /**
   * GB of ops that are PLANNED but not yet placed.
   *
   * The piece the first affordability gate was missing, and the reason it did
   * not work. Checking one batch against pool.freeRam refuses a batch that is
   * too big on its own - it does nothing about seventy batches that are each
   * affordable and collectively are not. A queued op reserves nothing, so the
   * pool looks free right up until the grows come due together: a live run held
   * `depth 70 sent 70 done 0` and logged `no room for G x69` while free RAM sat
   * at 0.03 TB.
   *
   * Maintained rather than recomputed because the queues hold four items per
   * batch and this is read at every dispatch. Invariant, with L the RAM already
   * placed: `L + queuedRam + oneMoreBatch <= pool capacity`, which is the whole
   * of what stops the pipeline over-committing.
   */
  let queuedRam = 0;

  // One FIFO per op type, each ordered by landing time. Anchors are monotonic
  // and every item in a queue shares an op time, so they are ordered by DUE
  // time too - which is what lets the scheduler check only the head.
  const queues = { H: [], W1: [], G: [], W2: [] };
  // Op times for the due-ness scan only. The delay an op launches with is
  // always measured fresh; see launchOp.
  let scanTime = null;
  let timesAt = 0;

  let anchor = null;
  let seq = 0;
  let dueAt = 0;
  let stopped = null;

  // Two counters, deliberately not one. A drifted baseline and a mis-ordered
  // landing are different faults with different fixes, and the first live run
  // stopped a stream on a mixture of the two - one bad verdict plus two
  // transient snapshots - so neither count on its own would have explained it.
  let strikes = 0;          // batches that landed wrong
  let baselineStrikes = 0;  // dispatches refused because the target had drifted
  // How full the target was the last time one of this stream's hacks landed on
  // it. The only measurement of that which is not a matter of timing luck.
  let lastUnder = 0;

  /**
   * Do this stream's own reports say the target is not being refilled?
   *
   * The answer to the only question a money snapshot is trying to ask, and the
   * one measurement of it that does not depend on when the snapshot was taken.
   * False before any hack has landed, because there is no evidence yet.
   */
  const drained = () => stats.hackHits > 0 && lastUnder < -DRAIN_UNDER;

  // Deliberately separate from `stopped`. A wound-down stream is being replaced
  // by a better target and needs no repair; a stopped one has drifted and does.
  // Sharing one flag would have the supervisor re-prepping targets it is in the
  // middle of dropping.
  let retiring = false;

  // Adaptive steal. The feedback delay is one weaken window - a change only
  // shows in batches dispatched after it, which land a full W later - so the
  // controller holds that long after every change. `sample` accumulates the
  // evidence gathered since the last one.
  let steal = initialSteal;
  // The controller's ceiling. Not a constant: setBase moves it to whatever the
  // calculator decides this target can afford, and the controller then descends
  // from there on measured faults.
  // What the calculator says this target can afford. The CEILING is derived
  // from it and from the drift the target has actually shown, so a base that
  // RAM allows is still refused when the arithmetic cannot protect it.
  let base = Math.min(initialCap, MAX_STEAL_FRACTION);
  // The largest overshoot this stream has measured, decayed. Drift is hacking
  // level moving between dispatch and landing, so it scales with the weaken
  // window and differs per target - a constant cannot be right for both a 266s
  // target and a 473s one. See DRIFT_SAFETY.
  let driftSeen = 0;
  /**
   * How much drift this target's batches are sized to survive.
   *
   * Before a single hack has reported there is nothing to go on, so the
   * conservative default stands - and it has to be conservative, because that
   * is exactly the window in which a deep target commits its whole pipeline
   * with no way to learn. nova-med, at depth 1200, dispatched 1200 batches at
   * 94.3% before its first report and drained on a 4.50% drift against a 4.00%
   * budget.
   *
   * Once reports exist they REPLACE the default rather than merely raising it.
   * Measured drift differs by an order of magnitude between targets in one run
   * - 0.34% on alpha-ent against 4.50% on nova-med - so holding a healthy
   * target at a default sized for the worst one costs real income for nothing.
   */
  /**
   * hackFractionPerThread over the last weaken window, sampled at each dispatch.
   *
   * This is the drift itself rather than an inference about it. Drift is
   * hack effectiveness rising between a batch's dispatch and its landing, and
   * `perThread` IS hack effectiveness - so the rise across one weaken window is
   * exactly what a batch dispatched a window ago has just lived through. No
   * money, no reports, nothing to be masked.
   */
  const perThreadLog = [];

  /**
   * Drift the NEXT batch should expect, from the trend rather than the reports.
   *
   * The report-based estimator has two failures and a live run hit both at once.
   *
   * It only sees drift while the target is FULL. `over` is stolen/take - 1, so
   * once the balance sags the negative term swamps the positive one and the
   * drift signal vanishes into it - precisely when it matters, because a sagging
   * target is one whose grows are already losing.
   *
   * And it is a decayed max of a bursty series. Hacking level rises in steps, so
   * quiet windows read 0.02-0.25% and the budget decays toward the floor;
   * then one step arrives and the whole pipeline is sized for a hundredth of it.
   * The log is unambiguous: three targets climbed to 94.7-95.0% on `worst
   * overshoot 0.20% of a 0.50% tolerance` and then took overshoots of 6.23% and
   * 9.16%. All three drained to under 1% of max money.
   *
   * The peak over the window, not the endpoint: a batch dispatched at any point
   * in it is exposed to the worst rise that followed, and the endpoint alone
   * would miss a rise that has since partly reversed.
   */
  function predictedDrift() {
    if (perThreadLog.length < 2 || !(lastWeaken > 0)) return 0;
    const base = perThreadLog[0];
    if (!(base.v > 0)) return 0;
    // Only once the history spans a real weaken window. Extrapolating from a
    // shorter one scales the sampling noise by exactly the factor it scales the
    // trend, and the pre-evidence default already covers the first window -
    // which is the only window that can have no history.
    if (perThreadLog[perThreadLog.length - 1].t - base.t < lastWeaken) return 0;
    let peak = base.v;
    for (const s of perThreadLog) if (s.v > peak) peak = s.v;
    return peak / base.v - 1;
  }

  const driftBudget = () => {
    const measured = Math.max(driftSeen, predictedDrift());
    // The pre-evidence default is a FLOOR until a hack has landed, and only
    // then gives way to the measurement. The trend predictor can raise it
    // before that, which is the point - it needs no landings.
    const floor = stats.hackHits === 0 ? GROW_DRIFT_TOLERANCE : MIN_DRIFT_TOLERANCE;
    // Bounded above as well as below. The margin is derived from this, so an
    // unbounded budget would widen the tolerance to cover whatever just went
    // wrong and the back-off could never fire again - the measurement growing
    // to excuse itself. See MAX_DRIFT_TOLERANCE.
    return Math.min(
      MAX_DRIFT_TOLERANCE,
      Math.max(floor, measured * DRIFT_SAFETY),
    );
  };
  const ceiling = () => Math.min(base, maxStealForDrift(driftBudget()));
  let holdUntil = 0;
  let lastWeaken = 0;
  // `steal` is stamped on the window so credit() can tell whether a retiring
  // batch is evidence about the CURRENT fraction or about the one before it.
  const freshSample = () => ({
    steal, batches: 0, bad: 0, worstOver: 0, worstUnder: 0, attempts: 0, noRoom: 0,
  });
  let sample = freshSample();

  const stats = {
    dispatched: 0,
    retired: 0,
    ok: 0,
    bad: 0,
    hackHits: 0,
    hackTries: 0,
    intrusions: 0,
    stealChanges: 0,
    aborted: 0,
    abortReasons: {},
    lateLaunches: 0,
    nearMiss: 0,
    stolen: 0,
    jitterSum: 0,
    jitterMax: 0,
    skips: {},
    lastThreads: null,
    lastBatchRam: 0,
  };

  const skip = (why) => {
    stats.skips[why] = (stats.skips[why] ?? 0) + 1;
    // The pool refusing a batch is evidence about SIZE, not about the target -
    // and at high steal a batch is over ten times its size at 10%, so a
    // contended pool is fixed by taking a smaller bite, not by queueing.
    if (why.startsWith("no room")) sample.noRoom++;
    return { dispatched: false, why };
  };

  /**
   * Try to put one batch in the air.
   *
   * Everything is re-derived here, at this batch's own dispatch: the snapshot,
   * the op times, the thread counts. That is what makes the stream
   * self-correcting - a rising hacking level changes the next batch rather than
   * invalidating hundreds already in flight, which is the failure the shotgun's
   * MAX_STEAL_FRACTION exists to bound.
   */
  function dispatch(now = Date.now()) {
    if (stopped) return skip(stopped);
    // Also checked in isDue, but it belongs here too: dispatch is what spends
    // the RAM, and a caller that reaches it by any other path must not be able
    // to start a batch on a stream that is being drained.
    if (retiring) return skip("retiring");
    if (inFlight.size >= maxInFlight) return skip("at max depth");

    // Counted here rather than at the top: being at max depth or wound down is
    // not an attempt to place a batch, and folding those in would dilute the
    // no-room ratio with ticks that never asked the pool for anything.
    sample.attempts++;

    const snap = math.snapshot(ns, host);

    const th = planThreads(math, snap, steal, { drift: driftBudget() });
    if (!th) return skip("no hack math");

    // Refuse a batch the pool cannot hold WHOLE, before any of it is placed.
    //
    // Under JIT the four ops are placed at their own launch times, so a pool
    // that is merely tight does not refuse a batch - it accepts W1, then refuses
    // G a hundred seconds later. The weakens already launched then squat their
    // RAM for a full weaken window against a batch that can never land, which
    // fills the pool, which makes the next batch partial too. A live run on a
    // 1.6 TB pool logged `no room for G x15, no room for W2 x6` and never
    // recovered: only weakens were left running against a prepped target, with
    // no hack behind them.
    //
    // batchRam prices grow and weaken at ONE CORE, so it over-states what
    // core-aware placement will really take - the safe direction for a gate
    // whose whole job is to refuse early.
    const need = batchRam(th, ram, th.weaken2);
    if (need > pool.freeRam - queuedRam) {
      // Paced at the cadence, unlike every other skip. dueAt only advances on a
      // successful dispatch, so a stream against a full pool re-planned every
      // tick - 40 snapshots a second - and reported "150/149 dispatches found no
      // room" against a ratio that is supposed to count one attempt per slot.
      dueAt = now + cadence;
      return skip("no room for batch");
    }

    // Never stream a target that has drifted off its baseline: every thread
    // count above assumes max money and minimum security, so streaming one is
    // not slightly wrong, it is arithmetic against numbers that no longer
    // describe the server.
    //
    // The tolerance is derived from THIS batch rather than fixed, because a
    // running stream is permanently mid-batch. See baselineDrift - demanding
    // the prep-time moneyOk/secOk here made the first live run desync a target
    // that was holding steady at max money.
    // Sized against the biggest bite still in the air, not the one about to be
    // taken - see baselineDrift. Recomputed rather than tracked incrementally
    // because batches retire out of order and a stale maximum would keep the
    // floor loose long after the batch that justified it had landed.
    let inFlightSteal = 0;
    for (const b of inFlight.values()) {
      if (b.steal > inFlightSteal) inFlightSteal = b.steal;
    }
    const drift = baselineDrift(snap, th, slack, { floorSteal: inFlightSteal });

    // The money half of the check is a SNAPSHOT, and at the top of the range a
    // snapshot cannot tell a healthy stream from a drained one. At 94.8% steal
    // a target sits at 5.2% of max for half of every cadence, and no floor
    // below that is worth anything while no floor above it is safe. Worse, the
    // sampling is not random: dispatch is paced at exactly the batch cadence,
    // so it reads the SAME point of the money cycle every time. Once that phase
    // lands in the post-hack dip it reads the dip on every consecutive
    // dispatch, and three of those stop the stream.
    //
    // The reports say the same thing exactly. `over` is measured at the instant
    // a hack landed, which is the only moment the balance has to be right, and
    // a drained target makes EVERY batch underfilled rather than every third
    // snapshot. So once this stream has landed a hack, the snapshot only gets
    // to raise the alarm if the reports agree with it. Before that - the first
    // weaken window, where no report exists yet - the snapshot is all there is,
    // and it governs alone. config.js has always said this is what the money
    // floor is for; it just was not wired that way.
    const moneyTrip = drift.moneyOff && (stats.hackHits === 0 || drained());
    if (moneyTrip || drift.secOff) {
      baselineStrikes++;
      if (baselineStrikes >= strikeLimit) {
        stopped = "off baseline";
        log(
          `  ${host}: OFF BASELINE - $${(snap.money / 1e6).toFixed(1)}m of ` +
            `$${(snap.maxMoney / 1e6).toFixed(1)}m (floor $${(drift.moneyFloor / 1e6).toFixed(1)}m), ` +
            `sec ${snap.sec.toFixed(2)} of ${snap.minSec.toFixed(2)} ` +
            `(ceiling ${drift.secCeiling.toFixed(2)}). Stream stopped for re-prep.`,
        );
      }
      return skip(moneyTrip ? "money off baseline" : "security off baseline");
    }
    baselineStrikes = 0;

    const times = math.opTimes(snap);
    if (!(times.weaken > 0)) return skip("no weaken time");
    lastWeaken = times.weaken;

    // Free: planThreads already measured it, and this is the only place that
    // knows both the value and the window it has to be compared across.
    perThreadLog.push({ t: now, v: th.perThread });
    const cutoff = now - lastWeaken * 1.5;
    while (perThreadLog.length > 2 && perThreadLog[0].t < cutoff) perThreadLog.shift();

    // The anchor gets the same swing allowance as the launch lead, and needs
    // it most: weaken-1 lands ON the anchor and runs for a full weaken, so it
    // has to start a full weaken beforehand. With only MIN_LEAD_MS of margin, a
    // weaken time that stretched by seconds would leave it unable to reach its
    // own landing before it had even been queued.
    // How far this target's op times can stretch before its ops launch, as a
    // fraction. Used for TWO different things, and they want different bounds -
    // conflating them cost a run 200 aborts per stream.
    //
    // The launch allowance is generous, because launching early is nearly free:
    // additionalMsec absorbs the difference and the op holds its RAM a little
    // longer. Launching late cannot be undone and costs the whole batch.
    //
    // The ANCHOR allowance is not, because it buys the same insurance at a
    // ruinous price: it pushes the batch's landing - and so its deadline - that
    // fraction of a weaken window further out. At 1 that is a whole extra
    // window, and the ratio reaches 1 precisely when a target has drained,
    // since grow is then sized to climb back from nothing and growSec explodes
    // with it. A live run froze two streams solid that way.
    const swing = snap.minSec > 0
      ? Math.min(1, (th.hackSec + th.growSec) / snap.minSec)
      : 0;
    const anchorSwing = Math.min(MAX_ANCHOR_SWING, swing);

    const at = nextAnchor(anchor, now, times.weaken, cadence, minLead + times.weaken * anchorSwing);
    const offs = landingOffsets(spacer);
    const opTime = opTimesByOp(times);
    const bonus = math.coreBonusFor;

    // -- enqueue; nothing is placed or exec'd here ---------------------------

    // The JIT change in one place. A dispatch PLANS a batch and queues its four
    // ops; tick() launches each one at `land - opTime`, so a worker holds RAM
    // for its own duration instead of from the anchor to its landing. A hack
    // thread used to sit on 1.70 GB doing nothing for nearly a whole weaken
    // window.
    const id = `${idPrefix}${++seq}`;
    // How far this target's op times can stretch before these ops launch.
    //
    // calculateHackingTime is proportional to hackDifficulty, and a streaming
    // target is at minimum security only about half the time - the other half
    // it is carrying one batch's uncancelled hack or grow. So an op time
    // measured at minimum can be under-stated by this fraction, and an op
    // scheduled against the understated figure is already late when it starts.
    //
    // Measured rather than guessed: a fixed 2000ms lead covered a 160s-weaken
    // target's swing of ~8s not at all, and 59% of its grows were abandoned
    // for missing a slot they were never given time to reach. `swing` is
    // computed above, where the anchor needs it too.
    const batch = {
      id,
      steal: th.actualSteal,
      // The CONTROLLER's fraction, which is not th.actualSteal - the thread
      // floor moves them apart. credit() matches on this to keep a window's
      // evidence attributable to one setting.
      plannedAt: steal,
      swing,
      anchor: at,
      deadline: at + offs.W2 + grace,
      take: th.take,
      // Both grow as ops launch: placement counts are not knowable now, which
      // is exactly why `expected` cannot be set up front the way it used to be.
      expected: 0,
      pending: BATCH_OPS.length,
      reports: [],
      aborted: false,
    };

    const want = { H: th.hack, W1: th.weaken1, G: th.grow, W2: th.weaken2 };
    for (const op of LAUNCH_ORDER) {
      // Priced at one core, like batchRam and for the same reason: placement
      // will use fewer raw threads for the boosted ops, so the running total
      // over-states what is owed. Over-stating is the safe direction for a
      // number whose job is to refuse.
      const gb = want[op] * ram[OP_WORKER[op]];
      queues[op].push({ batch, op, land: at + offs[op], threads: want[op], gb });
      queuedRam += gb;
    }

    anchor = at;
    dueAt = now + cadence;
    stats.dispatched++;
    stats.lastThreads = { ...th };
    inFlight.set(id, batch);

    return { dispatched: true, id, anchor: at, threads: th };
  }

  /** Pop the head of a queue, keeping the outstanding-RAM total honest. */
  function dequeue(q) {
    const item = q.shift();
    // Clamped rather than trusted: this is a float sum maintained across
    // thousands of pushes and pops, and a slow negative drift would loosen the
    // dispatch gate by exactly the amount it had drifted.
    queuedRam = Math.max(0, queuedRam - item.gb);
    return item;
  }

  /**
   * Give up on a batch. Its queued ops are discarded lazily, when popped.
   *
   * Safe wherever it happens, and not by luck: the launch order is W1, W2, G, H,
   * so hack is always the LAST op of its batch to go out. An abort can only
   * ever leave weakens and a grow running against a server no hack has touched,
   * and grow clamps at max money. There is no ordering that strands a hack
   * without its grow, which is the only case that loses money.
   */
  function abort(batch, why) {
    if (batch.aborted) return;
    batch.aborted = true;
    // Zeroed so retire() stops waiting for ops that will never launch. What has
    // already launched still reports, and is still credited.
    batch.pending = 0;
    stats.aborted++;
    // Keyed on the op and cause, with any measured figure stripped - otherwise
    // every abort is its own bucket and the report lists a thousand of them.
    const key = why.replace(/ by \d+ms$/, "");
    stats.abortReasons[key] = (stats.abortReasons[key] ?? 0) + 1;
  }

  /**
   * Launch one queued op: measure, place, exec.
   *
   * `opTime` is measured FRESH for this tick, not taken from the scan cache.
   * That is the point of the whole exercise - the game fixes an op's duration
   * at the instant of the call, so measuring at the instant we call is exact,
   * where the old design measured once and hoped it still held a window later.
   */
  function launchOp(item, opTime) {
    const { batch, op, land, threads } = item;

    // Slack is how much time the op has in hand. Negative means it will land
    // late by that much.
    //
    // Tolerated up to LATE_TOLERANCE_MS rather than aborted outright. The ops of
    // a batch are a spacer apart, so a few ms of lateness cannot reorder them,
    // and a batch is far too expensive to abandon over it. The strict check
    // this replaces abandoned ~1450 batches out of 1826 in one live run: the
    // due-ness scan uses a cached op time, hackTime moves with security, and on
    // a 160s-weaken target a 1% swing is 400ms.
    const slack = land - opTime - Date.now();
    if (slack < -lateTolerance) {
      abort(batch, `${op} missed its slot by ${(-slack).toFixed(0)}ms`);
      return;
    }
    if (slack < 0) stats.lateLaunches++;

    const kind = OP_WORKER[op];
    let placements;
    if (op === "H") {
      // Hack gets no core bonus, so its demand IS its raw thread count.
      placements = pool.allocate(ram.hack, threads, { order: OP_FILL_ORDER.H });
    } else {
      const got = pool.allocateEffective(ram[kind], threads, math.coreBonusFor, {
        order: OP_FILL_ORDER[op],
      });
      placements = got && got.placements;
    }

    if (!placements) {
      skip(`no room for ${op}`);
      abort(batch, `no room for ${op}`);
      return;
    }

    const worker = WORKER_FILES[kind];
    let committed = 0;

    for (const p of placements) {
      // Recomputed per exec: even one op's placements span real wall time.
      const delay = delayFor(land, opTime, Date.now());
      const pid = ns.exec(worker, p.host, p.threads, host, delay, batch.id, port, land, op, p.threads);

      if (pid === 0) {
        // Hand back only what never launched. What did launch is running and
        // the game already counts its RAM.
        pool.release(placements.slice(committed));
        abort(batch, `${op} exec refused`);
        return;
      }
      pool.commit([p]);
      batch.expected++;
      committed++;
    }

    batch.pending--;
  }

  /**
   * Launch every op that has come due. Called every tick by the supervisor.
   *
   * Queues are per op type and ordered by landing time, which - because anchors
   * are monotonic and every item in a queue shares one op time - means they are
   * also ordered by DUE time. So only the head needs checking, and draining is
   * O(due) rather than O(pending). At depth 900 that is the difference between
   * a few comparisons a tick and several thousand.
   */
  function tick(now = Date.now()) {
    // A stopped stream has drifted off baseline; firing its queued hacks into a
    // target that is already wrong is the thing being avoided. A RETIRING one
    // keeps launching - those batches are part-paid for, and finishing them
    // earns their money.
    if (stopped) {
      for (const op of LAUNCH_ORDER) {
        for (const item of queues[op]) abort(item.batch, "stream stopped");
        queues[op].length = 0;
      }
      // Nothing is queued any more, so nothing is owed. Zeroed outright rather
      // than decremented item by item, which is the same answer and cannot drift.
      queuedRam = 0;
      return 0;
    }

    if (now - timesAt >= optimeRefresh || !scanTime) {
      const snap = math.snapshot(ns, host);
      scanTime = opTimesByOp(math.opTimes(snap));
      timesAt = now;
    }

    let launched = 0;
    // One fresh measurement per tick, taken lazily - only when something is
    // actually going out.
    let fresh = null;

    for (const op of LAUNCH_ORDER) {
      const q = queues[op];
      while (q.length) {
        const item = q[0];

        if (item.batch.aborted) { dequeue(q); continue; }

        // Due-ness is judged against the LONGEST this op could take, not the
        // length it happens to have right now. Launching early is nearly free -
        // additionalMsec absorbs the difference and the op holds its RAM a
        // little longer - while launching late cannot be undone and costs the
        // whole batch.
        const worst = scanTime[op] * (1 + item.batch.swing);
        if (item.land - worst - now > lead) break;

        dequeue(q);
        if (!fresh) fresh = opTimesByOp(math.opTimes(math.snapshot(ns, host)));
        launchOp(item, fresh[op]);
        launched++;
      }
    }

    return launched;
  }

  /**
   * Batches currently between their own hack and their own grow.
   *
   * This is the whole cross-batch intrusion detector, and it is a set rather
   * than a search because the window is so narrow. A batch is mid-restore for
   * exactly two spacers (200ms); consecutive batches are one cadence apart
   * (400ms). So in a healthy stream this set is empty every time a hack lands,
   * and any occupant when one does means two batches overlapped.
   *
   * That overlap is the streaming-specific way to lose money: the intruding
   * hack takes its cut from a server the older batch's grow was sized to
   * restore from a HIGHER balance, so the older batch under-refills and the
   * shortfall compounds into the next. Per-batch order checks cannot see it -
   * each batch on its own landed in perfect order.
   */
  const midRestore = new Set();

  /**
   * Batches that have received a report since the last retire().
   *
   * Only a batch that has just been credited can newly be complete, so this is
   * what lets retire() stop walking the whole in-flight map every tick. At the
   * depths a long-weaken target needs - 900 batches for a 360s weaken - a full
   * scan across several streams at 40 ticks a second is hundreds of thousands
   * of iterations a second inside a game loop.
   */
  const touched = new Set();

  /** Route one report into its batch. Returns false when the id is unknown. */
  function credit(msg) {
    const key = String(msg.b);
    const b = inFlight.get(key);
    if (!b) return false;
    b.reports.push(msg);
    touched.add(key);

    if (msg.op === "H") {
      // Anything still mid-restore when this hack lands is a batch this hack
      // just stole from.
      for (const other of midRestore) {
        if (other === key) continue;
        // Both are marked: the intruder because its take was not what it
        // planned, the victim because its grow was sized against money that is
        // no longer there.
        b.intruded = true;
        const victim = inFlight.get(other);
        if (victim) victim.intruded = true;
        stats.intrusions++;
      }
      midRestore.add(key);
    } else if (msg.op === "G") {
      midRestore.delete(key);
    }

    return true;
  }

  /**
   * Finish every batch past its deadline, or already complete.
   *
   * Complete-early retirement matters: at depth the in-flight map holds
   * hundreds of batches and walking it is the loop's only real work.
   */
  function retire(now = Date.now()) {
    const done = [];
    const seen = new Set();
    const finish = (b) => {
      if (b && !seen.has(b.id)) { seen.add(b.id); done.push(b); }
    };

    // Deadline sweep, from the OLDEST. inFlight is insertion-ordered and
    // anchors are monotonic, so deadlines are monotonic too - which means the
    // first batch still inside its deadline ends the sweep. No full scan.
    for (const b of inFlight.values()) {
      if (now <= b.deadline) break;
      // Ops still sitting in a queue at this point can never land in sequence,
      // so the batch is written off and they are discarded when popped.
      if (b.pending > 0) abort(b, "deadline passed with ops unlaunched");
      finish(b);
    }

    // Completions. Only a batch credited since the last pass can newly be
    // finished, so this is the whole of the rest of the work.
    //
    // `pending` is ops not yet LAUNCHED. Under JIT a batch is finished only when
    // all four have gone out AND every worker they placed has reported - the
    // pre-JIT check would have retired a batch whose hack had not launched.
    for (const id of touched) {
      const b = inFlight.get(id);
      if (b && b.pending === 0 && b.reports.length >= b.expected) finish(b);
    }
    touched.clear();

    for (const b of done) {
      inFlight.delete(b.id);
      midRestore.delete(b.id); // a batch whose grow never reported would linger
      touched.delete(b.id);

      // An aborted batch is not a landing fault and must not be judged as one.
      // It never had four ops in the air, so batchVerdict would score it
      // incomplete, strike the stream, and eventually stop a target for a
      // dispatch problem that has nothing to do with its timing.
      if (b.aborted) continue;

      stats.retired++;

      // `expected` is the exec count, not the op count: an op split across
      // hosts reports once per placement, so a healthy batch with a split grow
      // sends five messages for four ops.
      const v = batchVerdict(b.reports, spacer, b.expected);
      // An intrusion is a fault even though every op of THIS batch landed in
      // perfect order - which is exactly why the per-batch verdict cannot see
      // it and the flag has to be carried on the batch.
      if (b.intruded) v.ok = false;
      stats.jitterSum += v.jitter;
      stats.jitterMax = Math.max(stats.jitterMax, v.jitter);
      // Came within half a spacer of the ops reordering. Counted because a
      // lifetime maximum cannot distinguish one unlucky batch from a
      // distribution whose tail is growing, and only the second one matters.
      if (v.jitter > spacer / 2) stats.nearMiss++;
      stats.hackTries++;
      if (v.hackHit) {
        stats.hackHits++;
        stats.stolen += v.stolen;
      }

      // Evidence for the steal controller. `over` is how much more this batch
      // took than its grow was sized to put back - the drift that
      // MAX_STEAL_FRACTION exists to bound, measured rather than assumed.
      //
      // Only counted on a HIT: a missed hack takes nothing, so its ratio is -1
      // and would read as a huge undershoot, dragging the worst-case the wrong
      // way and licensing a step up on no evidence at all.
      // Only batches PLANNED at the fraction now in force are evidence about
      // it. Without this the feedback delay has to be a clock - hold for a
      // weaken window and hope - and the hold then applies to backing off as
      // well as climbing, which is what let a 94.7% target drain in 18 batches
      // while the controller waited out ~528 of them. Matching on the batch's
      // own setting makes the delay CAUSAL: after a step the window really is
      // empty until the new fraction's own batches start landing.
      const mine = b.plannedAt === sample.steal;
      if (mine) sample.batches++;
      if (mine && !v.ok) sample.bad++;
      if (v.hackHit && b.take > 0) {
        const over = v.stolen / b.take - 1;
        // One number, two signals, separated by sign. Money clamps at maxMoney,
        // so `over` is (money/maxMoney) * (stealAtLanding/stealAtPlan) - 1:
        // positive can only come from hack effectiveness rising in flight,
        // negative can only mean the server was not full when the hack landed.
        //
        // The CONTROLLER's window takes it only from batches planned at the
        // fraction now in force, because it is deciding about that fraction.
        if (mine) {
          if (over > sample.worstOver) sample.worstOver = over;
          if (over < sample.worstUnder) sample.worstUnder = over;
        }

        // The DRAIN detector takes it from every hack, because it is a question
        // about the TARGET, not about which fraction planned the batch. Gating
        // this on `mine` too was a real outage: the fraction wobbles by a tenth
        // of a percent every window, which resets the attribution, so a stream
        // whose target had emptied stopped corroborating its own money check
        // and never tripped. alpha-ent and rho-construction hacked a server at
        // 0.05% of max for 500 batches and reported `hit 100%, bad 0` the whole
        // way, because every batch really did land in order - on nothing.
        //
        // Latest rather than worst: a drain is a state, not an event.
        lastUnder = over;
      }

      if (v.ok) {
        stats.ok++;
        strikes = 0;
      } else {
        stats.bad++;
        strikes++;
        if (strikes >= strikeLimit && !stopped) {
          stopped = "desynced";
          log(
            `  ${host}: DESYNC after ${strikes} bad batches - last saw ` +
              `[${v.orderSeen.join(",")}], jitter ${v.jitter.toFixed(0)}ms` +
              (b.intruded ? ", another batch's hack landed inside its restore" : "") +
              (v.complete ? "" : `, ${v.orderSeen.length}/4 ops reported`) +
              ". Stream stopped.",
          );
        }
      }
    }

    if (adaptive) adaptSteal(now);
    return done.length;
  }

  /**
   * Move the steal fraction, at most once per weaken window.
   *
   * The hold is not throttling for its own sake - it is the feedback delay. A
   * change only affects batches dispatched after it, and those land a full W
   * later, so evaluating sooner would be judging the new fraction on evidence
   * produced by the old one. Ramping without it is a countdown, not control.
   */
  function adaptSteal(now) {
    if (lastWeaken <= 0) return;

    const decision = nextSteal(steal, sample, ceiling(), { drift: driftBudget() });

    // Backing off does NOT wait. The hold exists because a step's effect is
    // invisible for a weaken window, but that argument only justifies delaying
    // a CLIMB - a back-off is triggered by evidence that is already conclusive,
    // and every cadence spent waiting lands another oversized batch. Since
    // credit() now only counts batches planned at the current fraction, a
    // back-off cannot re-fire on its predecessor's reports either.
    const climbing = decision.steal > steal;
    if (climbing && now < holdUntil) return;
    // Nothing to do and still inside the hold: leave the window alone so the
    // evidence keeps accumulating instead of being reset every retirement.
    if (!decision.changed && now < holdUntil) return;

    if (decision.changed) {
      log(
        `  ${host}: steal ${(steal * 100).toFixed(1)}% -> ` +
          `${(decision.steal * 100).toFixed(1)}% (${decision.reason})`,
      );
      steal = decision.steal;
      stats.stealChanges++;
    }

    // Remember what this window's drift actually was, so the next window's
    // batches are sized for it. Decayed rather than kept: one bad window would
    // otherwise pin the target low for the rest of the run.
    driftSeen = Math.max(sample.worstOver, driftSeen * DRIFT_DECAY);
    if (steal > ceiling()) steal = ceiling();

    // The window resets whether or not the fraction moved: a decision to hold
    // was still made on this evidence, and re-using it would count the same
    // batches toward the next one.
    sample = freshSample();
    holdUntil = now + lastWeaken;
  }

  /**
   * Is this stream due to start another batch?
   *
   * Dispatch is paced in WALL TIME, one batch per cadence - not "as fast as RAM
   * allows". Letting it run flat out would still produce correctly spaced
   * landings, but the anchors would race arbitrarily far ahead of now, and a
   * batch whose threads were sized twenty minutes before it lands is the
   * shotgun's staleness problem rebuilt from the other direction.
   *
   * Paced this way, an anchor is never more than about one weaken window ahead,
   * so no batch's math is staler than that. The cost is that reaching full
   * depth takes one weaken window, which is a one-time ramp.
   */
  function isDue(now = Date.now()) {
    return !stopped && !retiring && now >= dueAt && inFlight.size < maxInFlight;
  }

  /**
   * Stop starting new batches, but keep the ones in the air.
   *
   * How a stream is dropped when a better target displaces it. It must NOT be
   * killed outright: ns.hack credits money when it LANDS, so killing a batch
   * whose hack has already landed forfeits the grow that was going to put the
   * money back, and leaves the target below baseline for whoever streams it
   * next. Draining costs one weaken window and loses nothing.
   */
  function windDown() {
    retiring = true;
  }

  /**
   * Cancel a wind-down, because the target is wanted again.
   *
   * Without this, a stream that was dropped and then re-admitted before it had
   * finished draining would be handed back to the supervisor still flagged
   * retiring - so it would never dispatch, would drain to nothing, and would be
   * replaced by a brand new stream that had learned nothing. Everything the
   * adaptive controller had measured about that target goes with it.
   */
  function reinstate() {
    retiring = false;
  }

  /**
   * Set the calculated optimum for this target as the controller's ceiling.
   *
   * The two do different jobs and neither subsumes the other. chooseSteal knows
   * what the SERVER and the available RAM allow; it cannot know about hacking
   * level drift, which only ever shows up in landing reports. nextSteal knows
   * how much the last window of evidence says we should trust that number.
   *
   * So the calculated value is a ceiling rather than an assignment: a stream
   * that has backed off after a drain keeps its reduced fraction and climbs
   * back toward the new base, instead of being yanked to the optimum by a
   * rescan that has no idea anything went wrong.
   *
   * MAX_STEAL_FRACTION still bounds it - the calculator sizes for RAM, and RAM
   * has nothing to say about the drift tolerance collapsing at the top end.
   */
  function setBase(fraction) {
    const next = Math.min(fraction, MAX_STEAL_FRACTION);
    if (!(next > 0)) return;
    base = next;
    if (steal > ceiling()) steal = ceiling();
  }

  /**
   * Set the pace this target's budget can sustain.
   *
   * Unlike setBase this IS an assignment, not a ceiling, and the asymmetry is
   * real: the fraction is something the controller has evidence about from its
   * own landings, while the cadence is pure arithmetic on the RAM budget, which
   * only rescan can see. There is nothing for a controller to disagree with.
   *
   * Anchors are monotonic, so a cadence that narrows takes effect on the next
   * dispatch and one that widens takes effect immediately - nextAnchor keeps
   * every batch already in the air where it was scheduled either way.
   */
  function setCadence(ms) {
    const next = Math.max(CADENCE_MS, Number(ms) || 0);
    if (!(next > 0)) return;
    cadence = next;
  }

  return {
    host,
    dispatch,
    tick,
    isDue,
    windDown,
    reinstate,
    setBase,
    setCadence,
    get cadence() { return cadence; },
    credit,
    retire,
    stats,
    get retiring() { return retiring; },
    get depth() { return inFlight.size; },
    // What the pipeline still owes the pool. Reported because "why has this
    // stream stopped dispatching against a pool with free RAM" is otherwise
    // unanswerable from a log - the answer is that the free RAM is spoken for.
    get queuedRam() { return queuedRam; },
    get steal() { return steal; },
    get cap() { return ceiling(); },
    // The drift this target has shown, and the budget its batches are sized
    // for. Reported because "why is this stream capped below the calculator's
    // answer" is otherwise unanswerable from a log.
    get drift() { return driftBudget(); },
    get strikes() { return strikes; },
    get baselineStrikes() { return baselineStrikes; },
    // How full the target was when this stream's last hack landed, as a
    // fraction of plan. Reported because a stop for "money off baseline" is not
    // actionable without it.
    get lastUnder() { return lastUnder; },
    // Exposed because the RANKING needs the same verdict the dispatch gate
    // needs. Pricing a live stream by a raw snapshot drops it from the ranking
    // on a coin flip, and admission then hands its slot to whatever was next.
    get drained() { return drained(); },
    get stopped() { return stopped; },
    /**
     * Clear the stop so the caller can restart after a re-prep.
     *
     * The anchor is reset too. Keeping it would have the first batch after the
     * restart anchored one cadence past a landing that happened before the
     * re-prep - which, after a prep wave that took minutes, is far in the past,
     * so nextAnchor would fall through to `now + weaken + lead` anyway. Clearing
     * it says that outright instead of relying on the arithmetic.
     */
    resume() { stopped = null; strikes = 0; baselineStrikes = 0; anchor = null; dueAt = 0; },
    has(id) { return inFlight.has(String(id)); },
  };
}
