import {
  baselineDrift,
  batchVerdict,
  delayFor,
  landingOffsets,
  nextAnchor,
  nextSteal,
  opTimesByOp,
  planThreads,
  reachable,
  weaken2For,
} from "scripts/continuous/lib/plan";
import {
  BASELINE_SLACK_BATCHES,
  BATCH_GRACE_MS,
  CADENCE_MS,
  CONT_REPORT_PORT,
  DESYNC_STRIKES,
  MAX_IN_FLIGHT,
  MAX_STEAL_FRACTION,
  MIN_LEAD_MS,
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

/** Ops in the order they are LAUNCHED. See the note above. */
const LAUNCH_ORDER = ["W1", "G", "W2", "H"];

export function createStream(ns, math, opts) {
  const {
    host,
    pool,
    ram,
    port = CONT_REPORT_PORT,
    steal: initialSteal = STEAL_FRACTION,
    cap = MAX_STEAL_FRACTION,
    adaptive = true,
    cadence = CADENCE_MS,
    spacer = SPACER_MS,
    maxInFlight = MAX_IN_FLIGHT,
    minLead = MIN_LEAD_MS,
    grace = BATCH_GRACE_MS,
    strikeLimit = DESYNC_STRIKES,
    slack = BASELINE_SLACK_BATCHES,
    idPrefix = "s",
    log = () => {},
  } = opts;

  const inFlight = new Map();
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
  let holdUntil = 0;
  let lastWeaken = 0;
  const freshSample = () => ({
    batches: 0, bad: 0, worstOver: 0, worstUnder: 0, attempts: 0, noRoom: 0,
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

    const th = planThreads(math, snap, steal);
    if (!th) return skip("no hack math");

    // Never stream a target that has drifted off its baseline: every thread
    // count above assumes max money and minimum security, so streaming one is
    // not slightly wrong, it is arithmetic against numbers that no longer
    // describe the server.
    //
    // The tolerance is derived from THIS batch rather than fixed, because a
    // running stream is permanently mid-batch. See baselineDrift - demanding
    // the prep-time moneyOk/secOk here made the first live run desync a target
    // that was holding steady at max money.
    const drift = baselineDrift(snap, th, slack);
    if (drift.off) {
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
      return skip(drift.moneyOff ? "money off baseline" : "security off baseline");
    }
    baselineStrikes = 0;

    const times = math.opTimes(snap);
    if (!(times.weaken > 0)) return skip("no weaken time");
    lastWeaken = times.weaken;

    const at = nextAnchor(anchor, now, times.weaken, cadence, minLead);
    const offs = landingOffsets(spacer);
    const opTime = opTimesByOp(times);
    const bonus = math.coreBonusFor;

    // -- place, all-or-nothing ---------------------------------------------

    const placed = {};
    const undo = () => {
      for (const p of Object.values(placed)) pool.release(p);
    };

    placed.H = pool.allocate(ram.hack, th.hack, { order: OP_FILL_ORDER.H });
    if (!placed.H) { undo(); return skip("no room for H"); }

    const w1 = pool.allocateEffective(ram.weaken, th.weaken1, bonus, { order: OP_FILL_ORDER.W1 });
    if (!w1) { undo(); return skip("no room for W1"); }
    placed.W1 = w1.placements;

    const g = pool.allocateEffective(ram.grow, th.grow, bonus, { order: OP_FILL_ORDER.G });
    if (!g) { undo(); return skip("no room for G"); }
    placed.G = g.placements;

    // Sized from grow's RAW placed threads, which is only knowable now - grow's
    // security cost tracks raw threads while its money effect tracks
    // core-weighted ones.
    const w2Eff = weaken2For(math, g.rawThreads);
    const w2 = pool.allocateEffective(ram.weaken, w2Eff, bonus, { order: OP_FILL_ORDER.W2 });
    if (!w2) { undo(); return skip("no room for W2"); }
    placed.W2 = w2.placements;

    // -- can every op still reach its slot? --------------------------------

    // Checked for ALL ops before any exec. A negative additionalMsec means an op
    // cannot land where it was planned to, and launching it anyway would put it
    // somewhere in the sequence nobody chose.
    const checkAt = Date.now();
    for (const op of LAUNCH_ORDER) {
      if (!reachable(at + offs[op], opTime[op], checkAt)) {
        undo();
        return skip(`${op} unreachable`);
      }
    }

    // -- launch --------------------------------------------------------------

    const id = `${idPrefix}${++seq}`;
    let launched = 0;
    let expected = 0;
    let aborted = null;

    for (const op of LAUNCH_ORDER) {
      const land = at + offs[op];
      const worker = WORKER_FILES[OP_WORKER[op]];

      for (const p of placed[op]) {
        // Recomputed at THIS exec. A dispatch spans real wall time and one
        // delay computed up front is correct only for the first worker.
        const delay = delayFor(land, opTime[op], Date.now());
        const pid = ns.exec(worker, p.host, p.threads, host, delay, id, port, land, op, p.threads);

        if (pid === 0) {
          aborted = `${op} exec refused on ${p.host}`;
          break;
        }
        pool.commit([p]);
        launched++;
        expected++;
      }
      if (aborted) break;
    }

    if (aborted) {
      // Release only what never launched. What DID launch is running and the
      // game is already counting its RAM - handing that back would have the
      // pool give the same bytes out twice.
      undoUnlaunched(pool, placed, LAUNCH_ORDER, launched);

      // Safe by construction: hack launches last, so an abort can only ever
      // leave grow and weaken running. The target stays at max money.
      log(`  ${host}: batch ${id} aborted - ${aborted} (hack never launched, no money lost)`);
      return skip("exec refused");
    }

    anchor = at;
    dueAt = Date.now() + cadence;
    stats.dispatched++;
    stats.lastThreads = { ...th, weaken2: w2Eff, growRaw: g.rawThreads, w1Raw: w1.rawThreads, w2Raw: w2.rawThreads };
    stats.lastBatchRam =
      placed.H.reduce((n, p) => n + p.gb, 0) +
      [...placed.W1, ...placed.G, ...placed.W2].reduce((n, p) => n + p.gb, 0);

    inFlight.set(id, {
      id,
      anchor: at,
      deadline: at + offs.W2 + grace,
      expected,
      reports: [],
      take: th.take,
    });

    return { dispatched: true, id, anchor: at, launched, threads: stats.lastThreads };
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

  /** Route one report into its batch. Returns false when the id is unknown. */
  function credit(msg) {
    const key = String(msg.b);
    const b = inFlight.get(key);
    if (!b) return false;
    b.reports.push(msg);

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

    for (const b of inFlight.values()) {
      if (b.reports.length >= b.expected || now > b.deadline) done.push(b);
    }

    for (const b of done) {
      inFlight.delete(b.id);
      midRestore.delete(b.id); // a batch whose grow never reported would linger
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
      sample.batches++;
      if (!v.ok) sample.bad++;
      if (v.hackHit && b.take > 0) {
        const over = v.stolen / b.take - 1;
        // One number, two signals, separated by sign. Money clamps at maxMoney,
        // so `over` is (money/maxMoney) * (stealAtLanding/stealAtPlan) - 1:
        // positive can only come from hack effectiveness rising in flight,
        // negative can only mean the server was not full when the hack landed.
        if (over > sample.worstOver) sample.worstOver = over;
        if (over < sample.worstUnder) sample.worstUnder = over;
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
    if (now < holdUntil || lastWeaken <= 0) return;

    const decision = nextSteal(steal, sample, cap);
    if (decision.changed) {
      log(
        `  ${host}: steal ${(steal * 100).toFixed(1)}% -> ` +
          `${(decision.steal * 100).toFixed(1)}% (${decision.reason})`,
      );
      steal = decision.steal;
      stats.stealChanges++;
    }

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

  return {
    host,
    dispatch,
    isDue,
    windDown,
    reinstate,
    credit,
    retire,
    stats,
    get retiring() { return retiring; },
    get depth() { return inFlight.size; },
    get steal() { return steal; },
    get strikes() { return strikes; },
    get baselineStrikes() { return baselineStrikes; },
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

/**
 * Hand back the reservations of ops that never launched.
 *
 * `launched` counts placements that got a pid, in LAUNCH_ORDER. Everything at or
 * after that index is still merely reserved, so it is the pool's to take back;
 * everything before it is running and the game already counts its RAM.
 */
function undoUnlaunched(pool, placed, order, launched) {
  let seen = 0;
  for (const op of order) {
    for (const p of placed[op]) {
      if (seen >= launched) pool.release([p]);
      seen++;
    }
  }
}
