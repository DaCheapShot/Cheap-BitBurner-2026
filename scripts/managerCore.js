import {
  STEAL_FRACTION,
  MAX_STEAL_FRACTION,
  SPACER_MS,
  BATCH_SPACING_MS,
  GROW_MARGIN,
  HACK_CONTIGUOUS,
  HOME_RESERVE_GB,
  REPORT_PORT,
  REPORT_DRAIN_MS,
  PORT_CAPACITY,
  MAX_VOLLEY_BATCHES,
  VOLLEY_GRACE_MS,
  DESYNC_STRIKES,
  VOLLEY_OK_FRACTION,
  TARGET_SWITCH_MARGIN,
  WORKER_FILES,
  BATCH_OPS,
  OP_WORKER,
} from "./config.js";
import { analyzeBatch, batchOk, batchOutcome, restoreStats } from "./verify.js";
import {
  prepGroup, isPrepped, pickTarget, rankTargets, buildWorkerPool, workerRam,
} from "./prepper.js";

/**
 * The shotgun volley loop (math-agnostic core).
 *
 * Each cycle:
 *   1. measure free RAM across the whole rooted network
 *   2. compute how many complete HWGW batches fit in that RAM AND inside one
 *      weaken-time window
 *   3. launch that entire volley at once, staggered so every batch's ops land in
 *      H, W, G, W order
 *   4. wait for the volley to resolve, draining reports as they arrive
 *   5. recompute everything and fire again
 *
 * Recomputing every cycle is the point, not overhead: hacking level rises,
 * op times shrink, RAM appears, and a plan that was right one volley ago is
 * stale. Nothing is carried between cycles except the desync strike count.
 *
 * THIS PROCESS OWNS THE POOL AND THE PORT. Both are single-owner by nature -
 * port.read() removes the message, and Server.pending is per-process memory, so
 * a second allocator believes the same RAM is free. Do not run prep.js beside
 * it, nor anything else that reads REPORT_PORT. Prep runs in-process via
 * prepper.js.
 *
 * The steal fraction is chosen per cycle by default - see chooseSteal for why a
 * fixed one leaves money on the table.
 *
 * `run(ns, math)` is called by the entry scripts, scripts/manager.js and
 * scripts/manager-formulas.js - each injects its own math implementation so
 * this module never has to pick one.
 *
 * Usage:  run scripts/manager.js
 *         run scripts/manager.js --target joesguns
 *         run scripts/manager.js --steal 0.05 --once   (pin the fraction)
 *         run scripts/manager.js --fixed               (use STEAL_FRACTION)
 *         run scripts/manager.js --dry-run        (plan and print, launch nothing)
 *         run scripts/manager.js --verbose        (measured vs planned, per volley)
 *
 * --verbose costs nothing: every figure it prints comes from the worker reports
 * already collected, so it adds no ns calls and no RAM. Use it when the volley
 * looks healthy but the target's money does not add up - it prints what grow
 * ACTUALLY delivered against what the plan assumed, which is the one comparison
 * the normal output cannot make.
 *
 * RAM charged to whoever imports this:
 *   ram.js/prepper.js union 2.00 + exec (already counted) = 2.00 GB
 * The math implementation's cost is added by whichever entry script imports it:
 *   manager.js + mathAnalyze  = 6.15 GB
 *   manager-formulas.js + mathFormulas = 6.10 GB
 */

const padL = (s, n) => String(s).padStart(n);
const fmtRam = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(2)}TB` : `${gb.toFixed(2)}GB`);
const fmtTime = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(2)}m` : `${(ms / 1000).toFixed(1)}s`);

function fmtMoney(m) {
  for (const [div, suf] of [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]]) {
    if (Math.abs(m) >= div) return `$${(m / div).toFixed(2)}${suf}`;
  }
  return `$${(m ?? 0).toFixed(0)}`;
}

/**
 * Thread counts for one batch: cached constants for everything linear, one live
 * hackAnalyze (via math.hackFractionPerThread) for the part that isn't.
 *
 * hackAnalyze stays live deliberately - it moves with hacking level, and
 * reacting to that is the whole reason for recomputing each cycle.
 *
 * consts is forwarded to planThreadsForHack rather than recomputed here - see
 * that function for why it has to stay a passed-in value instead of a fresh
 * math call. NOTE: the design brief for this split wrote this function without
 * a consts parameter, which would pass `undefined` straight into
 * planThreadsForHack's security math. Fixed here so the manual-steal path
 * (--steal / --fixed) doesn't silently NaN its thread counts.
 */
export function planThreads(math, snap, steal, consts) {
  const perThread = math.hackFractionPerThread(snap);
  const hack = Math.max(1, Math.ceil(steal / perThread));
  return planThreadsForHack(math, snap, hack, perThread, consts);
}

/**
 * Thread counts for a batch built around an exact hack thread count.
 *
 * Hack threads are the quantised variable - steal only ever takes the values
 * hack * perThread - so the steal search enumerates these directly.
 *
 * perThread and the three security constants are read ONCE by the caller and
 * passed in, so this stays free of ns calls: the steal search runs hundreds of
 * candidates and must not touch the API.
 */
export function planThreadsForHack(math, snap, hack, perThread, consts) {
  const steal = hack * perThread;
  if (!(steal < 1)) return { error: `hack ${hack}t would take ${steal} of the server` };

  const weaken1 = Math.max(1, Math.ceil((consts.hackSec * hack) / consts.weakenSec));

  // Money after this batch's hack lands, which is the state its grow must undo.
  // atSecurity is minSec: the batch's first weaken has already landed by then,
  // so grow executes at baseline security - not at whatever the server shows now.
  // Ask for the threads to climb back from a LOWER starting point than the batch
  // will really be at. That is what buys the safety margin, and it buys the SAME
  // margin at every steal fraction.
  //
  // The margin used to multiply the THREAD count, which quietly made it useless
  // exactly where it was needed. Threads relate to the multiplier exponentially,
  // so `threads * 1.05` delivers `mult^1.05` - worth 9% of headroom at a x5.64
  // restore but only 2% at x1.49 and 0.5% at x1.11. Measured runs match: volleys
  // at 77-82% steal (8-9% headroom) held the server at max money, while volleys
  // at 32.74% and 69.31% (2.0% and 6.1%) drained it to nothing, because every
  // batch is planned against max money and any shortfall compounds geometrically.
  //
  // Overshooting is free: the game clamps money at maxMoney, so grow threads
  // beyond what is needed do nothing rather than something harmful.
  const afterHack = snap.maxMoney * (1 - steal);
  const grow = Math.max(1, Math.ceil(
    math.growThreadsToRestore(snap, afterHack / GROW_MARGIN, snap.maxMoney, snap.minSec),
  ));

  const weaken2 = Math.max(1, Math.ceil((consts.growSec * grow) / consts.weakenSec));

  // Actual take, from the rounded-up thread count - not the requested fraction.
  // ceil() means a batch almost always steals a little more than asked, and the
  // steal search has to compare what batches really earn.
  const hackAmount = snap.maxMoney * steal;
  return { hack, weaken1, grow, weaken2, perThread, steal, hackAmount };
}

/** GB one batch of these thread counts occupies. */
function batchRamOf(th, ram) {
  return th.hack * ram.hack + th.grow * ram.grow + (th.weaken1 + th.weaken2) * ram.weaken;
}

/**
 * Pick the steal fraction that earns the most per volley, right now.
 *
 * Total yield is (batches that fit) x (money per batch), and batch count is a
 * FLOOR of free RAM over batch RAM - so yield is a sawtooth, not a curve.
 * Raising steal makes each batch richer but can drop a whole batch off the end.
 * Measured on a real pool: 8% earned $15.0m, and reserving 32GB of home moved
 * the same 8% to $10.0m while 7.5% earned $14.06m. The best fraction moves with
 * every RAM purchase, every level-up and every change to the home reserve,
 * which is why this is computed per cycle instead of configured.
 *
 * Two passes, because an exact fit test costs real work:
 *   1. screen every hack thread count analytically (free RAM / batch RAM)
 *   2. re-test the best few by actually reserving batches, which is the only
 *      thing that accounts for fragmentation and hack contiguity
 *
 * Near-equal earners are separated by BATCH COUNT, then by spare RAM. Both
 * preferences are evidence-based rather than cosmetic: jitter scales with how
 * many workers land at once (a single batch jittered 6-7ms where a 2-batch
 * volley jittered 48ms), so of two fractions earning the same money, the one
 * flying fewer, larger batches is less likely to mistime. Spare RAM breaks the
 * remaining ties because the analytic optimum tends to fill the pool to within
 * a couple of GB, which fragmentation then eats.
 */
const SCREEN_KEEP = 8;
const TIE_BAND = 0.02;

export function chooseSteal(pool, ram, math, snap, perThread, consts, cap) {
  const free = pool.freeRam;
  const screened = [];

  for (let hack = 1; ; hack++) {
    const steal = hack * perThread;
    // Above this the volley cannot survive the hacking level rising while it
    // is in flight - see MAX_STEAL_FRACTION for the measured collapse and the
    // tolerance arithmetic. Every larger hack count is worse, so stop here.
    if (steal > MAX_STEAL_FRACTION) break;
    const th = planThreadsForHack(math, snap, hack, perThread, consts);
    if (th.error) break;

    const br = batchRamOf(th, ram);
    if (br > free) break; // every larger hack count is worse; stop
    const n = Math.min(cap, Math.floor(free / br));
    if (n < 1) break;

    screened.push({ hack, steal, th, batchRam: br, n, yield: n * th.hackAmount });
  }

  if (!screened.length) return null;

  // Exact-test the most promising few. Ordering by analytic yield first keeps
  // this to a handful of reservation runs however wide the search was.
  //
  // Ties break toward FEWER batches here as well as at the end. Yield is capped
  // by free RAM over GB-per-unit-steal, so many different fractions hit exactly
  // the same number and the top of this list is mostly ties - without the same
  // preference applied before truncation, which of them survives into the exact
  // test is arbitrary, and the pick flips shape between cycles for no reason.
  screened.sort((a, b) => b.yield - a.yield || a.n - b.n);
  const tested = [];
  for (const c of screened.slice(0, SCREEN_KEEP)) {
    const { batches } = reserveVolley(pool, ram, c.th, cap);
    pool.releaseAll();
    if (!batches.length) continue;
    tested.push({
      ...c,
      n: batches.length,
      yield: batches.length * c.th.hackAmount,
      spare: free - batches.length * c.batchRam,
    });
  }
  if (!tested.length) return null;

  tested.sort((a, b) => b.yield - a.yield);
  const best = tested[0];
  const chosen = tested
    .filter((c) => c.yield >= best.yield * (1 - TIE_BAND))
    .sort((a, b) => a.n - b.n || b.spare - a.spare)[0];

  // What we gave up, if anything. Only a REAL sacrifice counts: ties are the
  // normal case here, and reporting "gave up $0" for one invents a trade-off
  // that was never made.
  const tradedFor = chosen !== best && best.yield > chosen.yield ? best : null;
  return { chosen, best, tradedFor, second: tested.find((c) => c !== chosen) ?? null };
}

/**
 * Landing schedule for a batch, relative to launch.
 *
 * All ops of all batches exec at the same instant; every bit of separation comes
 * from additionalMsec. The weaken time is the anchor because it is the longest
 * of the three, so every other op can be delayed into place behind it.
 */
function planTiming(math, snap) {
  const { hack: H, grow: G, weaken: W } = math.opTimes(snap);
  const s = SPACER_MS;

  return {
    W, H, G, s,
    opTime: { H, W1: W, G, W2: W },
    land: { H: W - s, W1: W, G: W + s, W2: W + 2 * s },
    // Batches cannot pack tighter than the four landings they contain, or
    // adjacent batches interleave instead of merely reordering internally.
    spacing: Math.max(BATCH_SPACING_MS, 4 * s),
    windowMs: W,
  };
}

/**
 * Reserve RAM for as many whole batches as will fit, up to `cap`.
 *
 * All-or-nothing per batch: a batch that gets a hack but no grow steals money
 * and never puts it back, which is strictly worse than not firing at all.
 *
 * @returns {{batches: object[], failedOp: string|null, failedPartial: boolean}}
 */
function reserveVolley(pool, ram, th, cap) {
  const batches = [];
  let failedOp = null;
  let failedPartial = false;

  const slots = [
    { op: "H", rpt: ram.hack, threads: th.hack, opts: { contiguous: HACK_CONTIGUOUS } },
    { op: "W1", rpt: ram.weaken, threads: th.weaken1, opts: {} },
    { op: "G", rpt: ram.grow, threads: th.grow, opts: {} },
    { op: "W2", rpt: ram.weaken, threads: th.weaken2, opts: {} },
  ];

  while (batches.length < cap) {
    const placements = {};
    let ok = true;
    for (const slot of slots) {
      const p = pool.allocate(slot.rpt, slot.threads, slot.opts);
      if (!p) {
        for (const done of Object.values(placements)) pool.release(done);
        // WHICH op failed only means something if an earlier op succeeded.
        // Slots are tried in order, so a full pool always fails on the first
        // one - naming it would read as a diagnosis when it is just the
        // alphabetically-first casualty of having no RAM left.
        if (failedOp === null) {
          failedOp = slot.op;
          failedPartial = Object.keys(placements).length > 0;
        }
        ok = false;
        break;
      }
      placements[slot.op] = p;
    }
    if (!ok) break;
    batches.push({ placements });
  }

  return { batches, failedOp, failedPartial };
}

/**
 * Launch every batch in the volley.
 *
 * The delay for each worker is recomputed from Date.now() AT THE MOMENT OF ITS
 * EXEC, not once for the whole volley. This matters: a large volley is hundreds
 * of exec calls, and exec is real wall-clock work. A delay computed once would
 * be correct only for the first worker launched, and every later one would land
 * progressively further behind - a slow, silent skew that grows with volley size
 * and looks exactly like jitter. Anchoring on an absolute landing time and
 * re-deriving the delay per exec absorbs launch latency completely.
 *
 * @returns {{launched: number, aborted: number, expected: Map<string, number>}}
 */
function launchVolley(ns, host, batches, timing, volleyId, log) {
  const t0 = Date.now();
  let launched = 0;
  let aborted = 0;
  const expected = new Map();

  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    b.id = `${volleyId}-${i}`;
    b.plannedLand = {};
    const offset = i * timing.spacing;

    // If we have already spent longer launching than this batch's earliest
    // landing allows, it cannot be placed correctly. Stop here rather than
    // firing a batch we know is mistimed - and stop entirely, since every later
    // batch is further behind still.
    const firstDelay = t0 + timing.land.H + offset - Date.now() - timing.opTime.H;
    if (firstDelay < 0) {
      aborted = batches.length - i;
      log(
        `WARN: launch fell behind at batch ${i}/${batches.length} - dropping the ` +
          `remaining ${aborted}. Lower MAX_VOLLEY_BATCHES or raise BATCH_SPACING_MS.`,
      );
      for (let k = i; k < batches.length; k++) batches[k].dropped = true;
      break;
    }

    let n = 0;
    for (const op of BATCH_OPS) {
      const kind = OP_WORKER[op];
      const land = t0 + timing.land[op] + offset;
      b.plannedLand[op] = land;

      for (const p of b.placements[op]) {
        const delay = Math.max(0, land - Date.now() - timing.opTime[op]);
        const pid = ns.exec(
          WORKER_FILES[kind],
          p.host,
          p.threads,
          host,
          delay,
          b.id,
          REPORT_PORT,
          land,
          op,
          p.threads,
        );
        if (pid === 0) {
          log(`ERROR: exec ${WORKER_FILES[kind]} on ${p.host} x${p.threads} returned 0`);
        } else {
          launched++;
          n++;
        }
      }
    }
    expected.set(b.id, n);
  }

  return { t0, launched, aborted, expected };
}

/**
 * Drain the report port continuously until every expected report has arrived or
 * the deadline passes.
 *
 * Continuous draining is not an optimisation. The port holds PORT_CAPACITY
 * entries and DISCARDS THE OLDEST on overflow, so a volley that reports faster
 * than we read loses its earliest batches silently - which would look like a
 * desync and trigger a pointless re-prep. Landing at all is what we sleep
 * through; from first landing on, we read on a tight interval.
 *
 * @returns {{byBatch: Map<string, object[]>, got: number, sawFull: boolean}}
 */
async function collectVolley(ns, expected, deadline, log) {
  const port = ns.getPortHandle(REPORT_PORT);
  const byBatch = new Map();
  let got = 0;
  let sawFull = false;
  const total = [...expected.values()].reduce((n, v) => n + v, 0);

  while (got < total && Date.now() < deadline) {
    if (port.full()) sawFull = true;
    while (!port.empty()) {
      const msg = port.read();
      if (typeof msg !== "object" || msg === null || !expected.has(msg.b)) continue;
      if (!byBatch.has(msg.b)) byBatch.set(msg.b, []);
      byBatch.get(msg.b).push(msg);
      got++;
    }
    await ns.sleep(REPORT_DRAIN_MS);
  }

  // One last sweep: the final workers may report between the last sleep and the
  // deadline.
  while (!port.empty()) {
    const msg = port.read();
    if (typeof msg !== "object" || msg === null || !expected.has(msg.b)) continue;
    if (!byBatch.has(msg.b)) byBatch.set(msg.b, []);
    byBatch.get(msg.b).push(msg);
    got++;
  }

  if (sawFull) {
    log(
      `WARN: report port hit capacity (${PORT_CAPACITY}) during this volley - ` +
        `the oldest reports were discarded. Raise Options -> Netscript -> ` +
        `"Max port capacity" and update PORT_CAPACITY, or lower MAX_VOLLEY_BATCHES.`,
    );
  }

  return { byBatch, got, sawFull, total };
}

/** Roll every batch's analysis up into one verdict for the volley. */
function judgeVolley(byBatch, expected, spacerMs) {
  let ok = 0;
  let bad = 0;
  let incomplete = 0;
  let stale = 0;
  let worstJitter = 0;
  const latenesses = [];
  const badIds = [];

  for (const [id, want] of expected) {
    const reports = byBatch.get(id) ?? [];
    if (reports.length < want) {
      incomplete++;
      // An incomplete batch cannot be judged on order - some of its ops simply
      // never spoke. Counted separately so lost reports don't masquerade as
      // mistimed landings.
      continue;
    }
    const a = analyzeBatch(reports, BATCH_OPS);
    stale += a.stale;
    latenesses.push(a.lateness);
    if (a.jitter > worstJitter) worstJitter = a.jitter;
    if (batchOk(a, spacerMs)) ok++;
    else {
      bad++;
      if (badIds.length < 3) badIds.push(`${id} (${a.orderSeen.join("->")})`);
    }
  }

  const latenessSpread = latenesses.length
    ? Math.max(...latenesses) - Math.min(...latenesses)
    : 0;
  const latenessMean = latenesses.length
    ? latenesses.reduce((n, v) => n + v, 0) / latenesses.length
    : 0;

  return { ok, bad, incomplete, stale, worstJitter, latenessMean, latenessSpread, badIds };
}

/**
 * What the volley actually did, measured from the workers' return values.
 *
 * This exists because the manager used to report `batches x plannedHackAmount`
 * as "earned", a figure that prints identically whether every hack succeeded or
 * every hack stole nothing. A 397-batch volley drained its target from $12.99b
 * to $6.81k while reporting $1.69t earned, and nothing in the output disagreed.
 *
 * The number that matters is `growRatio`: achieved grow multiplier over the one
 * the plan assumed. Batches are ALL planned against the same snapshot - money at
 * max - so there is no feedback inside a volley and any per-batch shortfall
 * compounds geometrically. At 397 batches a 1% shortfall leaves under 2% of the
 * server's money.
 *
 * Trend matters as much as magnitude, which is why first/last are kept
 * separately: a CONSTANT shortfall points at the growth model, while one that
 * WORSENS across the volley points at security creeping up under it.
 *
 * Pure arithmetic on reports already collected - no ns calls, 0 GB.
 */
function measureVolley(byBatch, expected, wantGrowMult, breakEvenMult) {
  const samples = [];
  // Kept whole, not just their multipliers: restoreStats has to correlate each
  // batch's grow against whether that same batch's hack landed.
  const outcomes = [];
  let stolen = 0;
  let weakened = 0;
  let unmeasurable = 0;
  let hackHits = 0;
  let hackTries = 0;

  for (const id of expected.keys()) {
    const reports = byBatch.get(id) ?? [];
    if (!reports.length) continue;
    const o = batchOutcome(reports);
    if (o.missing > 0) unmeasurable++;
    stolen += o.stolen;
    weakened += o.weakened;
    hackHits += o.hackHits;
    hackTries += o.hackTries;
    if (o.growThreads > 0) samples.push(o.growMult);
    outcomes.push(o);
  }

  if (!samples.length) {
    return { stolen, weakened, unmeasurable, hackHits, hackTries, samples: 0,
             growMean: 0, growFirst: 0, growLast: 0, growRatio: 0,
             restore: { hacked: 0, restored: 0, median: 0, worst: 0 } };
  }

  /*
   * GEOMETRIC mean, not arithmetic. These are multipliers applied in sequence,
   * so their average is the one that compounds to the same total - and hack has
   * a success chance, which makes the per-batch multiplier vary wildly: a failed
   * hack leaves the server at max, so its grow reports ~1.0, while a successful
   * one reports the full restore.
   *
   * Averaging multipliers arithmetically over that spread is biased upward
   * (Jensen's inequality) and it misled this very analysis: an arithmetic mean
   * of 2.99 implied a 57% hack success rate while the measured take implied 38%.
   * With p=0.4 and a x4.49 restore, the arithmetic mean reads 2.395 where the
   * geometric reads 1.823 - the geometric one is what actually compounds.
   */
  const geoMean = (a) => Math.exp(a.reduce((n, v) => n + Math.log(v > 0 ? v : 1e-12), 0) / a.length);

  // Leading and trailing tenth rather than single batches: one batch is noise,
  // a tenth of the volley is a trend.
  const edge = Math.max(1, Math.floor(samples.length / 10));
  const mean = geoMean(samples);

  return {
    stolen,
    weakened,
    unmeasurable,
    hackHits,
    hackTries,
    samples: samples.length,
    growMean: mean,
    growFirst: geoMean(samples.slice(0, edge)),
    growLast: geoMean(samples.slice(-edge)),
    growRatio: wantGrowMult > 0 ? mean / wantGrowMult : 0,
    // The clamp-free reading. wantGrowMult carries GROW_MARGIN, but a batch can
    // never report more than the clamp allows, so break-even is the yardstick.
    restore: restoreStats(outcomes, breakEvenMult),
  };
}

/**
 * @param {NS} ns
 * @param {object} math injected math implementation - see the math interface
 *                      documented in mathAnalyze.js / mathFormulas.js
 */
export async function run(ns, math) {
  ns.disableLog("ALL");
  ns.ui.openTail();

  const ready = math.prepare(ns);
  if (!ready.ok) {
    ns.tprint(`ERROR: ${ready.error}`);
    return;
  }

  const args = ns.args.map(String);
  const tIdx = args.indexOf("--target");
  const sIdx = args.indexOf("--steal");
  const once = args.includes("--once");
  // Diagnostic detail. Off by default because a 400-batch volley would otherwise
  // bury the one line that matters, but everything it prints comes from data
  // already collected - it costs no ns calls and no RAM.
  const verbose = args.includes("--verbose");
  const dryRun = args.includes("--dry-run");

  // null means "work it out each cycle". A fraction pins it, for comparing
  // against auto or for reproducing a specific run.
  let manualSteal = null;
  if (sIdx >= 0) {
    const v = Number(args[sIdx + 1]);
    if (!Number.isFinite(v) || v <= 0 || v >= 1) {
      ns.tprint(`ERROR: --steal needs a fraction in (0,1), got "${args[sIdx + 1]}"`);
      return;
    }
    manualSteal = v;
  } else if (args.includes("--fixed")) {
    manualSteal = STEAL_FRACTION;
  }

  // Pinned targets never move. An auto-picked one is re-evaluated every cycle:
  // rooting new servers and levelling up both change what is reachable, and a
  // target chosen at launch goes stale within minutes.
  const pinnedTarget = tIdx >= 0 ? args[tIdx + 1] : null;
  let target = pinnedTarget ?? pickTarget(ns, math);
  if (!target) {
    ns.tprint("ERROR: no rooted, money-bearing target found. Pass --target <host>.");
    return;
  }

  const ram = workerRam(ns);
  const log = (s) => ns.print(s);
  const buildPool = () => buildWorkerPool(ns);

  // Stale entries would be attributed to this run's batch ids. Safe to clear:
  // this process owns the port.
  ns.getPortHandle(REPORT_PORT).clear();

  ns.print(
    `manager: target ${target}, steal ` +
      (manualSteal === null
        ? "auto (recomputed each cycle)"
        : `${(manualSteal * 100).toFixed(2)}% (fixed)`),
  );

  // A reserve at or above home's capacity silently drops home from the pool
  // instead of trimming it - the difference between "keep 32GB free for me" and
  // "never use home at all", which is invisible in the volley numbers.
  const homeRam = ns.getServerMaxRam("home");
  if (HOME_RESERVE_GB > 0) {
    if (HOME_RESERVE_GB >= homeRam) {
      ns.print(
        `WARN: HOME_RESERVE_GB (${HOME_RESERVE_GB}) >= home's ${homeRam}GB - home is ` +
          `contributing nothing to the pool. Lower it if you meant to use home.`,
      );
    } else {
      ns.print(
        `home: reserving ${HOME_RESERVE_GB}GB of ${homeRam}GB for scripts you run by hand`,
      );
    }
  }

  // Distinguishes this manager's batch ids from those of a previous run whose
  // workers are still in flight.
  const runId = Date.now() % 100000;
  let strikes = 0;
  let cycle = 0;
  let totalEarned = 0;
  // Shrinks when volleys land badly, recovers when they land clean. The only
  // state carried between cycles, along with the strike count - everything else
  // is re-measured, which is what makes the loop self-correcting.
  let capScale = 1;

  while (true) {
    cycle++;

    // -- retarget -----------------------------------------------------------
    // Before anything else, because prepping is the expensive part and there is
    // no sense prepping a server we are about to abandon. Safe here and nowhere
    // else in the cycle: the previous volley has fully resolved and its RAM is
    // released, so nothing is in flight against the old target.
    if (!pinnedTarget) {
      const best = pickTarget(ns, math);
      if (best && best !== target) {
        const bestMoney = math.maxMoneyOf(ns, best);
        const currentMoney = math.maxMoneyOf(ns, target);
        if (bestMoney > currentMoney * TARGET_SWITCH_MARGIN) {
          ns.print(
            `retargeting ${target} (${fmtMoney(currentMoney)}) -> ${best} ` +
              `(${fmtMoney(bestMoney)}), ${(bestMoney / currentMoney).toFixed(1)}x richer`,
          );
          target = best;
          // The new server is unprepped and its timings differ; carrying either
          // over would judge it by the old target's behaviour.
          strikes = 0;
          capScale = 1;
        }
      }
    }

    // -- prep gate ----------------------------------------------------------
    // Never volley an unprepped target: every thread count above assumes max
    // money and minimum security, and firing at a drifted server compounds the
    // drift instead of correcting it.
    //
    // One snapshot per cycle. Everything downstream reads from it, so the
    // per-cycle ns cost is fixed no matter how many steal candidates are tried.
    let m = math.snapshot(ns, target);
    if (!isPrepped(m)) {
      ns.print(
        `cycle ${cycle}: ${target} needs prep - ${fmtMoney(m.money)}/${fmtMoney(m.maxMoney)}, ` +
          `sec ${m.sec.toFixed(2)}/${m.minSec.toFixed(2)}`,
      );
      // Unique prefix per manager run. Workers still in flight from a previous
      // manager (or a hand-run prep.js) land after this one clears the port and
      // report under their own batch id - a fixed "prep-1" would collide with
      // ours and be counted as one of this wave's reports.
      //
      // extras is a function, not a list, because the ranking is re-evaluated
      // every prep cycle: hosts get rooted and hacking level climbs while a prep
      // runs, and a list captured once would go stale exactly when it matters.
      // The primary is filtered out inside prepGroup, so passing the whole
      // ranking is correct.
      const res = await prepGroup(ns, target, {
        math, ram, port: REPORT_PORT, buildPool, log, verbose,
        idPrefix: `prep${runId}`,
        extras: () => rankTargets(ns, math),
      });
      if (!res.ok) {
        ns.tprint(`ERROR: prep of ${target} failed - ${res.reason}. Manager stopping.`);
        return;
      }
      strikes = 0;
      m = res.m;
    }

    // -- plan ---------------------------------------------------------------

    const pool = buildPool();

    const timing = planTiming(math, m);
    const negative = BATCH_OPS.filter((op) => timing.land[op] - timing.opTime[op] < 0);
    if (negative.length) {
      ns.tprint(
        `ERROR: negative delay for ${negative.join(", ")} - spacer ${timing.s}ms is too ` +
          `large for these op times.`,
      );
      return;
    }

    const byWindow = Math.floor(timing.windowMs / timing.spacing);
    const cap = Math.max(1, Math.floor(Math.min(byWindow, MAX_VOLLEY_BATCHES) * capScale));

    const consts = {
      hackSec: math.securityPerHackThread(m),
      growSec: math.securityPerGrowThread(m),
      weakenSec: math.securityPerWeakenThread(m),
    };
    const perThread = math.hackFractionPerThread(m);
    if (!(perThread > 0)) {
      ns.tprint(`ERROR: hack fraction for ${target} is ${perThread} - level too low or no root`);
      return;
    }

    let th;
    let note = "";
    if (manualSteal !== null) {
      th = planThreads(math, m, manualSteal, consts);
      note = `steal ${(manualSteal * 100).toFixed(2)}% (fixed)`;
    } else {
      const pick = chooseSteal(pool, ram, math, m, perThread, consts, cap);
      if (!pick) {
        ns.tprint(
          `ERROR: no steal fraction fits - not even one hack thread's batch ` +
            `(${fmtRam(pool.freeRam)} free). Buy RAM.`,
        );
        return;
      }
      th = pick.chosen.th;
      note =
        `steal ${(pick.chosen.steal * 100).toFixed(2)}% (auto, ${pick.chosen.hack} hack threads, ` +
        `${pick.chosen.n} batches, ${fmtMoney(pick.chosen.yield)}/volley)` +
        (pick.tradedFor
          ? `  - gave up ${fmtMoney(pick.tradedFor.yield - pick.chosen.yield)} vs ` +
            `${(pick.tradedFor.steal * 100).toFixed(2)}% for ` +
            // Say the real reason. Batch count is the first tie-break, spare RAM
            // the second, so when the counts match it was headroom that decided.
            (pick.chosen.n < pick.tradedFor.n
              ? `${pick.chosen.n} batches instead of ${pick.tradedFor.n} - fewer workers in flight`
              : `${fmtRam(pick.chosen.spare)} spare instead of ${fmtRam(pick.tradedFor.spare)}`)
          : "");
    }
    if (th.error) {
      ns.tprint(`ERROR: ${th.error}`);
      return;
    }

    const batchRam = batchRamOf(th, ram);
    const { batches, failedOp, failedPartial } = reserveVolley(pool, ram, th, cap);
    // Only the partial case is worth naming an op for: it means RAM existed but
    // not in a shape that op could use. A first-slot failure is just a full pool.
    const stopReason = !failedOp
      ? ""
      : failedPartial
        ? `, ${failedOp} could not be placed though earlier ops fit - fragmentation`
        : `, pool full`;

    ns.print(
      `cycle ${padL(cycle, 3)}  ${note}`,
    );
    ns.print(
      `           H ${th.hack}t W1 ${th.weaken1}t G ${th.grow}t W2 ${th.weaken2}t  ` +
        `= ${fmtRam(batchRam)}/batch  window ${fmtTime(timing.windowMs)}`,
    );
    ns.print(
      `           volley ${batches.length} batches ` +
        `(window allows ${byWindow}, cap ${cap}` +
        (capScale < 1 ? ` after backing off to ${(capScale * 100).toFixed(0)}%` : "") +
        stopReason +
        `)  ${fmtRam(batches.length * batchRam)} of ${fmtRam(pool.freeRam + pool.pendingRam)}`,
    );

    if (verbose) {
      // The plan's own assumptions, stated before the volley flies, so the
      // measured numbers printed afterwards have something to be compared to.
      ns.print(
        `           [v] plan:  steal ${(th.steal * 100).toFixed(2)}% of ${fmtMoney(m.maxMoney)} = ` +
          `${fmtMoney(th.hackAmount)}/batch, grow must return x${(1 / (1 - th.steal)).toFixed(4)} ` +
          `(GROW_MARGIN ${GROW_MARGIN} sized ${th.grow}t for it)`,
      );
      ns.print(
        `           [v] state: money ${fmtMoney(m.money)}/${fmtMoney(m.maxMoney)}, ` +
          `sec ${m.sec.toFixed(2)}/${m.minSec.toFixed(2)}, backend ${math.NAME}, ` +
          `hack fraction/thread ${perThread.toExponential(3)}`,
      );
      ns.print(
        `           [v] sec/thread: hack ${consts.hackSec} grow ${consts.growSec} ` +
          `weaken ${consts.weakenSec}  ->  W1 cancels ${(consts.hackSec * th.hack).toFixed(2)} ` +
          `with ${th.weaken1}t, W2 cancels ${(consts.growSec * th.grow).toFixed(2)} with ${th.weaken2}t`,
      );
      // EVERY batch is planned against this one snapshot, so the volley bets the
      // whole window on the grow model being right this many times running.
      ns.print(
        `           [v] exposure: ${batches.length} batches x ${(th.steal * 100).toFixed(2)}% = ` +
          `${(batches.length * th.steal).toFixed(1)}x the target's max money, all planned ` +
          `against the state above - no feedback until the volley ends`,
      );
    }

    if (batches.length === 0) {
      pool.releaseAll();
      ns.tprint(
        `ERROR: not one batch fits (${fmtRam(batchRam)} needed, ` +
          `${fmtRam(pool.freeRam)} free)` +
          (failedPartial
            ? ` - ${failedOp} could not be placed though earlier ops fit, so the RAM ` +
              `exists but not in a usable shape.`
            : `.`) +
          ` Lower --steal or buy RAM.`,
      );
      return;
    }

    if (dryRun) {
      pool.releaseAll();
      ns.tprint(
        `DRY RUN: would fire ${batches.length} batches at ${target} ` +
          `at ${(th.steal * 100).toFixed(2)}% steal, ` +
          `~${fmtMoney(batches.length * th.hackAmount)} per volley over ${fmtTime(timing.windowMs)}.`,
      );
      return;
    }

    // -- fire ---------------------------------------------------------------

    const { t0, launched, aborted, expected } = launchVolley(
      // Same collision reasoning as the prep prefix: a bare "v1-0" would match
      // a previous manager run's still-airborne workers.
      ns, target, batches, timing, `v${runId}c${cycle}`, log,
    );

    if (launched === 0) {
      pool.releaseAll();
      ns.tprint("ERROR: nothing launched - run scripts/deploy.js first.");
      return;
    }

    const live = batches.filter((b) => !b.dropped);
    const lastLand = t0 + timing.land.W2 + (live.length - 1) * timing.spacing;
    const { byBatch, got, total } = await collectVolley(
      ns, expected, lastLand + VOLLEY_GRACE_MS, log,
    );

    // RAM is released after the last landing, not at exec: the reservation has
    // to cover the whole flight, or the next cycle over-commits.
    pool.releaseAll();

    // -- judge --------------------------------------------------------------

    const j = judgeVolley(byBatch, expected, timing.s);
    const after = math.snapshot(ns, target);

    // MEASURED, not planned. The old figure was `cleanBatches * plannedTake`,
    // which prints the same whether every hack succeeded or every hack stole
    // nothing - a volley that drained its target to $6.81k still reported
    // $1.69t earned. Sum what the hack workers actually returned instead, and
    // fall back to the projection only when reports carry no result values
    // (stale workers), saying so rather than passing a guess off as a total.
    const wantGrowMult = th.steal < 1 ? 1 / (1 - th.steal) : 0;
    const vol = measureVolley(byBatch, expected, wantGrowMult, 1 / (1 - th.steal));
    const measured = vol.unmeasurable === 0 && vol.samples > 0;
    totalEarned += measured ? vol.stolen : j.ok * th.hackAmount;

    ns.print(
      `           landed ${j.ok} ok, ${j.bad} mistimed, ${j.incomplete} incomplete  ` +
        `reports ${got}/${total}` +
        (aborted ? `, ${aborted} dropped at launch` : ""),
    );
    ns.print(
      `           jitter max ${j.worstJitter.toFixed(1)}ms / ${timing.s}ms spacer   ` +
        `lateness ${j.latenessMean >= 0 ? "+" : ""}${j.latenessMean.toFixed(1)}ms ` +
        `(spread ${j.latenessSpread.toFixed(1)}ms / ${timing.spacing}ms batch spacing)`,
    );

    // Jitter above the spacer means ops inside a batch can swap order, and it
    // scales with how many workers land at once - so a value measured from a
    // single batch understates a volley badly. Say what to set, not just that
    // something is wrong, and say what it costs: spacing consumes the weaken
    // window, so while the window is not the binding constraint it is free.
    if (j.worstJitter >= timing.s && j.bad > 0) {
      const suggest = Math.ceil((j.worstJitter * 1.5) / 10) * 10;
      const windowRoom = Math.floor(timing.windowMs / (4 * suggest));
      ns.print(
        `           WARN: jitter ${j.worstJitter.toFixed(1)}ms >= spacer ${timing.s}ms. ` +
          `Set SPACER_MS = ${suggest} in config.js` +
          (windowRoom > batches.length
            ? ` - free here, the window would still hold ${windowRoom} batches and ` +
              `RAM only allows ${batches.length}.`
            : ` - costs volley size: the window would hold only ${windowRoom} batches.`),
      );
    }

    // Lateness only threatens correctness when it VARIES by more than the gap
    // between batches - that is when a late batch reaches into its neighbour.
    if (j.latenessSpread >= timing.spacing) {
      ns.print(
        `           WARN: lateness spread ${j.latenessSpread.toFixed(1)}ms exceeds batch ` +
          `spacing ${timing.spacing}ms - batches are reaching into each other. ` +
          `Raise BATCH_SPACING_MS.`,
      );
    }
    // Print which batches went wrong whatever the outcome. Previously this only
    // appeared on the strike path, so a volley that drifted the target off
    // baseline hid the very ordering evidence that explained why.
    if (j.bad > 0 && j.badIds.length) {
      ns.print(`           mistimed: ${j.badIds.join(", ")}`);
    }
    if (j.stale) {
      ns.print(
        `           WARN: ${j.stale} report(s) had no result field - stale workers ` +
          `in game. Run scripts/deploy.js.`,
      );
    }

    // -- measured outcome ----------------------------------------------------
    //
    // A measured grow multiplier BELOW the planned one is normal and healthy on
    // its own: hack only succeeds about half the time, and a batch whose hack
    // missed leaves the server at max money, so its grow hits the clamp
    // immediately and honestly reports ~1.0. Warning on that alone cried wolf at
    // 57% "short" while the server sat at exactly 100% of max.
    //
    // The real test is whether the server came back. If grow were genuinely
    // undersized the money would not be at max, so gate on that.
    const restored = isPrepped(after);
    const rs = vol.restore;
    const breakEven = 1 / (1 - th.steal);

    // Judge on the batches whose hack SUCCEEDED, never on the mean of every
    // batch's multiplier. A batch whose hack missed starts at max money and its
    // grow clamps to ~1.0, so at a 60.8% hack chance a PERFECT volley averages
    // 6.44^0.608 = x3.10 - and a live run reporting x3.55 was warned it was 45%
    // short and told to raise GROW_MARGIN, which would have been wrong.
    if (!restored && rs.hacked > 0) {
      const shortfall = rs.hacked - rs.restored;
      if (shortfall > 0) {
        ns.print(
          `           WARN: ${shortfall}/${rs.hacked} hacked batches failed to restore ` +
            `x${breakEven.toFixed(4)} (median x${rs.median.toFixed(4)}, worst ` +
            `x${rs.worst.toFixed(4)}) and the target did NOT return to max. Grow is ` +
            `genuinely short - raise GROW_MARGIN or lower the steal fraction.`,
        );
      } else {
        // Every hacked batch restored, yet the money still fell. Grow is not the
        // culprit and raising GROW_MARGIN would not help; say so rather than
        // blaming the nearest number.
        ns.print(
          `           WARN: the target did NOT return to max, but all ${rs.hacked} hacked ` +
            `batches restored x${breakEven.toFixed(4)}. Grow is NOT the shortfall - look ` +
            `at ordering, at security under the volley, or at batches lost at launch.`,
        );
      }
    }

    if (verbose) {
      ns.print(
        `           [v] take: ${measured ? fmtMoney(vol.stolen) : "unmeasurable"} measured vs ` +
          `${fmtMoney(j.ok * th.hackAmount)} planned` +
          (vol.unmeasurable ? `  (${vol.unmeasurable} batch(es) had stale workers)` : ""),
      );
      ns.print(
        `           [v] restore: ${vol.restore.restored}/${vol.restore.hacked} hacked batches ` +
          `reached x${(1 / (1 - th.steal)).toFixed(4)}` +
          (vol.restore.hacked
            ? `  (${((vol.restore.restored / vol.restore.hacked) * 100).toFixed(1)}%, ` +
              `median x${vol.restore.median.toFixed(4)}, worst x${vol.restore.worst.toFixed(4)})`
            : ""),
      );
      ns.print(
        `           [v] grow:  want x${wantGrowMult.toFixed(4)}  got x${vol.growMean.toFixed(4)}  ` +
          `(first ${vol.growFirst.toFixed(4)} -> last ${vol.growLast.toFixed(4)}, ${vol.samples} batches)` +
          // This mean mixes clamped and unclamped batches and cannot be read as a
          // shortfall - the restore line above is the one that can. Kept because
          // its TREND across the volley is still informative.
          `  - confounded by the clamp; judge on restore above`,
      );
      // The trend is the diagnosis, and its SIGN is the whole point: grow
      // getting worse across the volley means conditions are degrading under it
      // (security creeping up), while grow getting better means the early
      // batches were starting from a fuller server than the later ones.
      const drift = vol.growFirst > 0 ? (vol.growLast / vol.growFirst - 1) * 100 : 0;
      ns.print(
        `           [v] trend: ${drift >= 0 ? "+" : ""}${drift.toFixed(2)}% first->last  ` +
          (Math.abs(drift) < 0.5
            ? "flat - the shortfall is in the growth model itself"
            : drift < 0
              ? "grow WEAKENING - suspect security creeping up under the volley"
              : "grow STRENGTHENING - later batches start from a lower server, so grow has more room before the max-money clamp"),
      );

      // Measured directly rather than inferred. A failed hack returns 0 and
      // takes nothing, so hits/tries IS the hack chance - no assumption about
      // the server's starting money required. If this is well under 1, the plan
      // is overstating every batch's take by exactly this factor, because
      // nothing in the thread math models hack chance at all.
      if (vol.hackTries > 0) {
        const rate = vol.hackHits / vol.hackTries;
        ns.print(
          `           [v] hack:  ${vol.hackHits}/${vol.hackTries} succeeded (${(rate * 100).toFixed(1)}%)  ` +
            `-> plan overstates take by ${(1 / Math.max(rate, 1e-9)).toFixed(2)}x if chance is unmodelled`,
        );
      }
      ns.print(
        `           [v] weaken: ${vol.weakened.toFixed(2)} sec removed across the volley; ` +
          `security ${after.sec.toFixed(2)}/${after.minSec.toFixed(2)} after`,
      );
      ns.print(
        `           [v] money: ${fmtMoney(m.money)} before -> ${fmtMoney(after.money)} after ` +
          `(${((after.money / after.maxMoney) * 100).toFixed(2)}% of max)`,
      );
    }

    // -- desync --------------------------------------------------------------

    const healthy = j.ok >= Math.ceil(expected.size * VOLLEY_OK_FRACTION);
    const baselineOk = isPrepped(after);

    // The two desyncs are different failures and need different answers.
    if (!baselineOk) {
      // The target moved. Nothing to decide: the prep gate at the top of the
      // next cycle measures and repairs it. Counting strikes here would be
      // theatre, since the gate acts on the very next pass regardless.
      ns.print(
        `           OFF BASELINE: ${fmtMoney(after.money)}/${fmtMoney(after.maxMoney)}, ` +
          `sec ${after.sec.toFixed(2)}/${after.minSec.toFixed(2)} - re-prepping next cycle`,
      );
      strikes = 0;
    } else if (!healthy) {
      // Batches landed wrong while the target sat exactly on baseline. Prep
      // cannot fix this - there is nothing to repair - so re-prepping would be a
      // no-op that hides the problem. The cause is the volley being packed
      // tighter than the game's scheduling can hold, so back off instead.
      strikes++;
      ns.print(
        `           STRIKE ${strikes}/${DESYNC_STRIKES}: only ${j.ok}/${expected.size} ` +
          `batches landed clean, target still on baseline`,
      );
      if (strikes >= DESYNC_STRIKES) {
        capScale = Math.max(0.25, capScale / 2);
        strikes = 0;
        ns.print(
          `           packing too tight - cutting volley size to ` +
            `${(capScale * 100).toFixed(0)}% for the next cycle. If this persists, ` +
            `raise SPACER_MS or BATCH_SPACING_MS.`,
        );
      }
    } else {
      strikes = 0;
      // Creep back toward full size after a clean volley, so one bad patch
      // doesn't permanently halve throughput.
      capScale = Math.min(1, capScale * 2);
    }

    ns.print(
      `           ${fmtMoney(after.money)}/${fmtMoney(after.maxMoney)} ` +
        `sec ${after.sec.toFixed(2)}  |  earned this session ~${fmtMoney(totalEarned)}`,
    );

    if (once) {
      ns.tprint(
        `SUCCESS: one volley of ${expected.size} batches at ${target} - ` +
          `${j.ok} clean, ${j.bad} mistimed, ${j.incomplete} incomplete.`,
      );
      return;
    }
  }
}
