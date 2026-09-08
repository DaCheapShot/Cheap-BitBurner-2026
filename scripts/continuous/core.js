import { ServerPool } from "scripts/continuous/lib/server";
import { coreMap } from "scripts/continuous/lib/cores";
import { deployWorkers, describeDeploy } from "scripts/continuous/lib/deploy";
import { clear } from "scripts/continuous/lib/report";
import { isPrepped, rankTargets } from "scripts/continuous/lib/target";
import { launchPrepWave, placePrepWave, prepTargets } from "scripts/continuous/lib/prep";
import { createStream } from "scripts/continuous/lib/stream";
import {
  baselineDrift,
  batchRam,
  clampSteal,
  moneyPerGbSec,
  planThreads,
  weaken2For,
} from "scripts/continuous/lib/plan";
import {
  CADENCE_MS,
  CONT_REPORT_PORT,
  HOME_RESERVE_GB,
  MAX_IN_FLIGHT,
  MAX_STEAL_FRACTION,
  MAX_TARGETS,
  POOL_WAIT_CYCLES,
  POOL_WAIT_MS,
  PREP_CONCURRENCY,
  PREP_MAX_CYCLES,
  PROMOTE_PREP_FIRST,
  REPREP_GRACE_MS,
  RESCAN_MS,
  STEAL_FRACTION,
  STREAM_TICK_MS,
  TARGET_RAM_BUDGET,
  WORKER_FILES,
  WORKER_RAM_FALLBACK,
} from "scripts/continuous/config";

/**
 * The continuous batcher's engine. Math-free by construction: every number that
 * depends on hacking maths arrives through the `math` argument, so this file
 * can be shared by both backends without either being reachable from the other.
 *
 * Adds beyond its imports:
 *
 *   ns.getScriptRam   0.10
 *   ns.ps             0.20
 *   ns.self           0.00
 *
 * Shape of a run: guard against a second pool owner, deploy the workers, rank
 * candidates, then supervise: stream what is prepped, prep what is not, and
 * re-evaluate the target set on a timer. Prep runs CONCURRENTLY with
 * streaming, never as a phase before it.
 */

const INDENT = "  ";

// ----------------------------------------------------------------- guard ----

/**
 * Scripts that must not be running alongside this one.
 *
 * ns.ps reports filenames WITHOUT a leading slash, which is how the game stores
 * them - so these are written the way ps will show them, not the way exec takes
 * them.
 */
const RIVALS = [
  "scripts/manager.js",
  "scripts/manager-formulas.js",
  "scripts/continuous/manager.js",
  "scripts/continuous/manager-formulas.js",
];

/**
 * Refuse to start beside anything else that owns the RAM pool or the port.
 *
 * Two owners is not a degraded mode, it is silent corruption in two directions
 * at once: port.read() REMOVES a message, so each drain loop eats reports meant
 * for the other and every batch looks half-landed; and each pool believes the
 * other's reservations are free RAM, so both over-commit the same hosts until
 * exec starts returning 0 across the fleet.
 *
 * This does NOT kill the rival. Which system should be running is the user's
 * decision, and a manager that kills whatever it finds would turn a
 * double-launch into a fight where the last one started wins.
 */
export function findRivals(ns) {
  const selfPid = ns.self().pid;
  const found = [];
  for (const p of ns.ps("home")) {
    if (p.pid === selfPid) continue;
    if (RIVALS.includes(p.filename)) found.push(`${p.filename} (pid ${p.pid})`);
  }
  return found;
}

// ------------------------------------------------------------ worker ram ----

/** Real per-thread RAM if the worker exists, otherwise the expected value. */
export function workerRam(ns) {
  const out = {};
  let missing = [];
  for (const [op, file] of Object.entries(WORKER_FILES)) {
    const real = ns.getScriptRam(file, "home");
    if (real > 0) out[op] = real;
    else {
      out[op] = WORKER_RAM_FALLBACK[op];
      missing.push(file);
    }
  }
  out.missing = missing;
  return out;
}

// -------------------------------------------------------------- admission ---

/**
 * Take targets down the priced ranking until the RAM budget or the ceiling
 * stops us.
 *
 * `continue` rather than `break` on an over-budget target: a cheap target
 * further down the list can still fit in what a expensive one could not use, so
 * one unaffordable entry must not end the search.
 *
 * The first target is admitted unconditionally. A budget too small for even the
 * best candidate should mean "run the best one anyway", not "run nothing" -
 * streaming nothing earns nothing, while an over-budget stream simply fails
 * some dispatches for want of RAM and reports the skips.
 *
 * @param {object[]} priced sorted best-first; each needs {gb, times.weaken}
 * @param {number} budget GB
 * @param {number} maxTargets
 * @returns {{admitted: object[], committed: number}} entries are mutated with
 *   the `depth` and `want` that were used, for reporting.
 */
export function admitTargets(priced, budget, maxTargets, opts = {}) {
  const { cadence = CADENCE_MS, maxInFlight = MAX_IN_FLIGHT } = opts;

  const admitted = [];
  let committed = 0;

  for (const p of priced) {
    if (admitted.length >= maxTargets) break;

    const depth = Math.min(Math.ceil(p.times.weaken / cadence), maxInFlight);
    const want = depth * p.gb;

    if (committed + want > budget && admitted.length > 0) continue;

    p.depth = depth;
    p.want = want;
    committed += want;
    admitted.push(p);
  }

  return { admitted, committed };
}

// ------------------------------------------------------------------- run ----

/**
 * @param {NS} ns
 * @param {object} math one of lib/mathAnalyze or lib/mathFormulas
 */
export async function run(ns, math) {
  ns.disableLog("ALL");
  ns.ui.openTail();

  const args = ns.args.map(String);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };

  const verbose = args.includes("--verbose");
  const maxTargets = Number(flag("--targets", MAX_TARGETS));
  const forced = flag("--target", null);
  const askedSteal = flag("--steal", STEAL_FRACTION);
  const steal = clampSteal(askedSteal);
  // --fixed-steal pins the fraction where it starts. Useful for a controlled
  // sweep, where an adapting controller would confound the measurement.
  const adaptive = !args.includes("--fixed-steal");

  const log = (s = "") => ns.print(s);
  const say = (s = "") => { ns.print(s); ns.tprint(s); };

  log(`=== continuous batcher [${math.NAME}] ===`);

  if (steal === null) {
    say(`ABORT: --steal "${askedSteal}" is not a usable fraction. Wants (0, ${MAX_STEAL_FRACTION}].`);
    return;
  }
  if (steal !== Number(askedSteal)) {
    say(
      `NOTE: --steal ${askedSteal} clamped to ${steal} (MAX_STEAL_FRACTION). ` +
        `Above it a batch cannot survive the hacking level rising while it is in flight.`,
    );
  }

  // -- guard ----------------------------------------------------------------

  const rivals = findRivals(ns);
  if (rivals.length > 0) {
    say(`ABORT: another pool owner is running: ${rivals.join(", ")}`);
    say("Only one process may own the RAM pool and the report port. Kill it first.");
    return;
  }

  // -- math backend ---------------------------------------------------------

  const ready = math.prepare(ns);
  if (!ready.ok) {
    say(`ABORT: the ${math.NAME} backend is unavailable: ${ready.error}`);
    return;
  }

  // -- workers --------------------------------------------------------------

  const ram = workerRam(ns);
  if (ram.missing.length > 0) {
    say(`ABORT: worker(s) read 0GB on home: ${ram.missing.join(", ")}`);
    say("The filesync extension has not pushed them, or one has a syntax error.");
    return;
  }

  const hosts = ServerPool.scanAll(ns);
  const cores = coreMap(ns, hosts);
  const deployed = deployWorkers(ns, hosts.filter((h) => ns.hasRootAccess(h)));
  const complaint = describeDeploy(deployed, hosts.length);
  if (complaint) log(INDENT + complaint.split("\n").join("\n" + INDENT));
  log(`${INDENT}workers on ${deployed.copied} host(s), home excluded`);

  // Stale reports from a previous run would be credited to batch ids that no
  // longer exist, and a port that starts near capacity drops the OLDEST entry -
  // so the first real batch's earliest landings would vanish.
  clear(ns, CONT_REPORT_PORT);

  const pool = ServerPool.build(ns, { homeReserve: HOME_RESERVE_GB, cores });
  log(
    `${INDENT}pool: ${pool.servers.length} hosts, ` +
      `${(pool.freeRam / 1024).toFixed(2)}TB free, ` +
      `${pool.servers.filter((s) => s.cores > 1).length} multi-core`,
  );

  // -- rank -----------------------------------------------------------------

  const ranked = rankTargets(ns, math, { steal });
  if (ranked.length === 0) {
    say("ABORT: no rooted, money-bearing host is within your hacking level.");
    return;
  }

  const chosen = forced
    ? ranked.filter((t) => t.host === forced)
    : ranked.slice(0, Math.max(1, maxTargets));

  if (chosen.length === 0) {
    say(`ABORT: --target ${forced} is not a rankable candidate (rooted? in level range?).`);
    return;
  }

  log("");
  log(`--- ranked ${ranked.length} candidates, taking ${chosen.length} ---`);
  const show = verbose ? ranked : ranked.slice(0, Math.max(chosen.length, 8));
  for (const t of show) {
    log(
      `${INDENT}${t.host.padEnd(20)}` +
        `$${(t.perBatch / 1e6).toFixed(2)}m/batch  ` +
        `chance ${(t.chance * 100).toFixed(0)}%  ` +
        `depth ${String(t.depth).padStart(4)}  ` +
        `$${(t.moneyPerSecPerDepth / 1e3).toFixed(1)}k/s/depth  ` +
        `${isPrepped(t.snap) ? "prepped" : "unprepped"}`,
    );
  }

  // -- prep-only keeps the old blocking behaviour ---------------------------

  if (args.includes("--prep-only")) {
    log("");
    log(`--- prep: ${chosen.map((t) => t.host).join(", ")} ---`);
    const result = await prepTargets(ns, math, chosen.map((t) => t.host), {
      pool, ram, port: CONT_REPORT_PORT,
      maxCycles: PREP_MAX_CYCLES,
      poolWaitCycles: POOL_WAIT_CYCLES,
      poolWaitMs: POOL_WAIT_MS,
      log,
    });
    say(`prep finished after ${result.cycles} cycle(s): ${result.reason}`);
    for (const host of [...result.prepped, ...result.pending]) {
      const s = math.snapshot(ns, host);
      say(
        `${INDENT}${result.prepped.includes(host) ? "PREPPED  " : "PENDING  "} ${host.padEnd(20)}` +
          `$${(s.money / 1e6).toFixed(2)}m/$${(s.maxMoney / 1e6).toFixed(2)}m  ` +
          `sec ${s.sec.toFixed(2)}/${s.minSec.toFixed(2)}`,
      );
    }
    pool.releaseAll();
    return;
  }

  // -- run ------------------------------------------------------------------

  const minutes = Number(flag("--minutes", 0));
  say("");
  say(
    `supervising up to ${maxTargets} target(s), steal ${(steal * 100).toFixed(1)}% ` +
      `${adaptive ? `climbing toward ${(MAX_STEAL_FRACTION * 100).toFixed(0)}%` : "FIXED"}, ` +
      `cadence ${CADENCE_MS}ms, rescan every ${(RESCAN_MS / 1000).toFixed(0)}s`,
  );
  if (minutes > 0) say(`${INDENT}stopping after ${minutes} minute(s)`);

  await supervise(ns, math, {
    pool, ram, steal, adaptive, maxTargets, forced, log, say, minutes, verbose,
  });
}

// --------------------------------------------------------------- pricing ----

/**
 * Price the prepped candidates on what a batch really costs.
 *
 * The paper ranking in lib/target.js is a CEILING: with the cadence identical
 * for every target it reduces to maxMoney * steal * chance / weakenTime, and
 * nothing in it knows what a batch costs. Grow threads are exactly where
 * targets differ - the shotgun's capacity.js records foodnstuff ($50m max,
 * 0.0175% growth per thread, 634 grow threads, 1.08TB per batch) outranking
 * targets that actually fit.
 *
 * Only prepped targets are priced. On an unprepped one growthAnalyze reads
 * CURRENT security and inflates the grow count, so it would be priced as though
 * its worst moment were permanent.
 *
 * ---------------------------------------------------------------------------
 * "Prepped" means two different things here, and conflating them cost a run
 *
 * For a target that is NOT yet streaming, the strict prep-time test is right:
 * it must genuinely be at max money and minimum security before the first batch
 * is sized against it.
 *
 * For one that IS streaming, that same test is a trap. A running stream is
 * permanently mid-batch - money dips by one batch's steal between a hack
 * landing and its grow two spacers later - so a perfectly healthy target fails
 * it a good fraction of the time. And it gets WORSE as the controller succeeds:
 * a bigger steal means a deeper dip. The live symptom was targets being dropped
 * from the ranking, wound down, and recreated from scratch at the default steal
 * every time - the adaptive controller resetting itself for no reason.
 *
 * So a streaming host is judged by the same baselineDrift the dispatch gate
 * uses, whose tolerance is derived from the batch in flight.
 *
 * @param {Set<string>} [streaming] hosts that already have a live stream
 * @param {Map<string, number>} [stealFor] per-host fraction the controller has
 *   actually reached. Pricing a stream that has backed off to 30% as though it
 *   were still at the 95% start over-states its RAM by an order of magnitude,
 *   and admission would then refuse targets that comfortably fit.
 */
export function priceTargets(ns, math, ram, steal, ranked, streaming = new Set(), stealFor = new Map()) {
  const priced = [];

  for (const entry of ranked) {
    const snap = math.snapshot(ns, entry.host);

    const th = planThreads(math, snap, stealFor.get(entry.host) ?? steal);
    if (!th) continue;

    if (streaming.has(entry.host)) {
      if (baselineDrift(snap, th).off) continue;
    } else if (!isPrepped(snap)) {
      continue;
    }

    const times = math.opTimes(snap);
    // weaken-2 is priced from grow's EFFECTIVE count, since nothing is placed
    // yet. That over-states it - placement uses fewer raw threads - but it
    // biases every candidate the same way, so the ordering holds.
    const gb = batchRam(th, ram, weaken2For(math, th.grow));

    priced.push({
      host: entry.host, snap, th, times, gb,
      chance: entry.chance ?? 1,
      score: moneyPerGbSec(th.take, entry.chance ?? 1, gb, times.weaken),
    });
  }

  priced.sort((a, b) => b.score - a.score);
  return priced;
}

/**
 * Price a candidate as though it were already prepped.
 *
 * The only way to answer "is this unprepped server worth more than one I am
 * streaming?" - and with three slots, that question decides whether the batcher
 * ever finds the best three servers or just keeps whichever three happened to
 * be ready first.
 *
 * Both sides then sit on the same money-per-GB-second scale, so the comparison
 * is a comparison rather than two different metrics stared at side by side.
 *
 * The analyze backend under-states the result and cannot help it: growthAnalyze
 * reads CURRENT security, so a dirty candidate is priced with an inflated grow
 * count. That biases against promoting, which is the safe direction - it delays
 * a swap rather than causing a bad one. The formulas backend honours the
 * hypothetical security and prices it properly.
 */
export function pricePotential(ns, math, ram, steal, ranked) {
  const priced = [];

  for (const entry of ranked) {
    const snap = math.snapshot(ns, entry.host);
    if (!(snap.maxMoney > 0)) continue;

    const ideal = {
      ...snap,
      money: snap.maxMoney,
      sec: snap.minSec,
      moneyOk: true,
      secOk: true,
    };
    // The formulas backend reads its numbers off snap.server, so the
    // hypothetical has to be applied there too or it prices the live server.
    if (snap.server) {
      ideal.server = {
        ...snap.server,
        moneyAvailable: snap.maxMoney,
        hackDifficulty: snap.minSec,
      };
    }

    const th = planThreads(math, ideal, steal);
    if (!th) continue;

    const times = math.opTimes(ideal);
    if (!(times.weaken > 0)) continue;

    const gb = batchRam(th, ram, weaken2For(math, th.grow));
    priced.push({
      host: entry.host, snap, th, times, gb,
      chance: entry.chance ?? 1,
      score: moneyPerGbSec(th.take, entry.chance ?? 1, gb, times.weaken),
    });
  }

  priced.sort((a, b) => b.score - a.score);
  return priced;
}

// ------------------------------------------------------------ supervisor ----

/**
 * Own the streams: dispatch, drain, retire, prep and re-evaluate, all from one
 * loop.
 *
 * ONE drain loop for everything. port.read() REMOVES the message, so a drain
 * per stream would have them eating each other's reports and every batch would
 * look permanently half-landed. For the same reason prep runs here as a state
 * machine rather than through prepTargets, which drains the port itself.
 *
 * Prep is CONCURRENT with streaming, not a phase before it. Blocking the run
 * until every target was prepped left the already-prepped ones - the good ones,
 * which is why they were picked - idle while a deep, dirty target was brought
 * up. On a 12-target set that is potentially an hour of earning nothing.
 */
export async function supervise(ns, math, opts) {
  const {
    pool, ram, steal, maxTargets, forced, log, say, adaptive = true,
    minutes = 0, verbose = false, tick = STREAM_TICK_MS, rescanMs = RESCAN_MS,
  } = opts;

  const port = ns.getPortHandle(CONT_REPORT_PORT);
  const started = Date.now();
  const until = minutes > 0 ? started + minutes * 60000 : Infinity;

  /** Active streams, best-priced first. Dispatch order IS the contention rule. */
  let streams = [];
  /** host -> {wave, deadline} for prep waves in the air, initial and repair alike. */
  const preps = new Map();
  /**
   * host -> the steal fraction the controller had reached there.
   *
   * Survives a stream being dropped and re-added. Each step up costs a full
   * weaken window of holding, so re-climbing from the default is minutes of
   * measurement discarded for nothing.
   */
  const learned = new Map();

  let orphans = 0;
  let sawFull = false;
  let repaired = 0;
  let nextReport = started + 10000;
  let nextRescan = 0;

  while (Date.now() < until) {
    const now = Date.now();

    // The game frees a worker's RAM when it exits; refresh is how the pool
    // learns about it. Committed placements are off our ledger already, so this
    // cannot double-count them.
    pool.refresh();

    if (now >= nextRescan) {
      nextRescan = now + rescanMs;
      for (const s of streams) learned.set(s.host, s.steal);
      streams = rescan(ns, math, {
        pool, ram, steal, adaptive, maxTargets, forced, streams, preps, learned, log, verbose,
      });
    }

    for (const s of streams) {
      if (s.isDue(now)) s.dispatch(now);
    }

    if (port.full()) sawFull = true;
    while (!port.empty()) {
      const msg = port.read();
      if (!msg || typeof msg !== "object") continue;
      let taken = false;
      for (const s of streams) {
        if (s.credit(msg)) { taken = true; break; }
      }
      // Orphans are EXPECTED from two harmless sources: a batch that aborted
      // mid-dispatch was never registered, and prep waves' reports are
      // deliberately never collected. Any other source would be a routing bug,
      // which is why they are counted rather than dropped in silence.
      if (!taken) orphans++;
    }

    for (const s of streams) s.retire(now);

    repaired += servicePreps(ns, { math, pool, ram, streams, preps, log });

    // A wound-down stream is gone once its last batch has landed. Removing it
    // earlier would abandon batches whose hack has already taken money and
    // whose grow has not yet put it back.
    for (const s of streams) {
      if (s.retiring && s.depth === 0) learned.set(s.host, s.steal);
    }
    streams = streams.filter((s) => !(s.retiring && s.depth === 0));

    if (Date.now() >= nextReport) {
      nextReport = Date.now() + 10000;
      report({ streams, preps, pool, started, orphans, sawFull, repaired, log, verbose });
    }

    await ns.sleep(tick);
  }

  // Nothing to hand back: every placement a stream still holds was COMMITTED,
  // so the game owns that RAM and frees it when the worker exits.
  say("");
  report({ streams, preps, pool, started, orphans, sawFull, repaired, log: say, verbose: true });
}

/**
 * Re-decide which targets should be streaming, and start prepping the ones that
 * should be but are not ready.
 *
 * Called on a timer rather than continuously because none of what it reacts to
 * moves quickly: hacking level, root access, pool size, prep state.
 *
 * @returns {object[]} the new stream list, best-priced first
 */
export function rescan(ns, math, opts) {
  const {
    pool, ram, steal, adaptive = true, maxTargets, forced,
    streams, preps, learned = new Map(), log, verbose,
  } = opts;

  const live = new Set(streams.filter((s) => !s.retiring).map((s) => s.host));

  const ranked = rankTargets(ns, math, { steal });
  const candidates = forced ? ranked.filter((t) => t.host === forced) : ranked;
  const priced = priceTargets(
    ns, math, ram, steal, candidates.slice(0, maxTargets * 3), live, learned,
  );

  // Budget off the pool's CAPACITY, not its free RAM. Free RAM shrinks as the
  // streams fill it, so budgeting from it would shrink the budget every rescan
  // and evict the very streams that were using it - a feedback loop that
  // ratchets the target count to zero.
  const budget = pool.usableRam * TARGET_RAM_BUDGET;
  const { admitted } = admitTargets(priced, budget, maxTargets);
  const want = new Set(admitted.map((p) => p.host));

  const byHost = new Map(streams.map((s) => [s.host, s]));
  const next = [];

  for (const p of admitted) {
    const existing = byHost.get(p.host);
    if (existing) {
      // Wanted again while still draining: cancel the wind-down rather than
      // letting it drain out and be replaced. Handing back a retiring stream
      // would leave a target that never dispatches until it is silently rebuilt
      // from scratch, losing everything the controller had learned about it.
      if (existing.retiring) {
        existing.reinstate();
        log(`  =${p.host}: back in the top ${maxTargets}, wind-down cancelled`);
      }
      next.push(existing);
      continue;
    }

    // Start from what was measured last time this target ran, if anything. A
    // target dropped for RAM and re-admitted later should not have to re-climb
    // from the default - that is minutes of measurement thrown away, one weaken
    // window per step.
    const start = learned.get(p.host) ?? steal;
    log(
      `  +${p.host}: batch ${(p.gb / 1024).toFixed(2)}TB x depth ${p.depth} = ` +
        `${(p.want / 1024).toFixed(1)}TB, $${(p.score / 1e3).toFixed(2)}k/GB-s` +
        (start !== steal ? `, resuming at ${(start * 100).toFixed(1)}% steal` : ""),
    );
    next.push(createStream(ns, math, {
      host: p.host, pool, ram, steal: start, adaptive, log,
      idPrefix: `${p.host.slice(0, 6)}${Date.now() % 1000}-`,
    }));
  }

  // Anything still streaming that no longer earns its slot is wound down, not
  // killed - see stream.windDown for why killing loses money.
  for (const s of streams) {
    if (want.has(s.host)) continue;
    if (!s.retiring) log(`  -${s.host}: no longer in the top ${maxTargets}, draining`);
    s.windDown();
    if (s.depth > 0) next.push(s);
  }

  // Prep the best candidates that are not ready, up to the concurrency limit.
  // These are the ones a future rescan will want; prepping them now is what
  // makes "better servers become available" mean anything.
  const prepped = new Set(priced.map((p) => p.host));
  const streaming = new Set(next.map((s) => s.host));

  // What the WORST admitted target is worth. Anything an unprepped candidate
  // would have to beat to earn a slot.
  const weakest = admitted.length ? admitted[admitted.length - 1].score : 0;

  // Price the unprepped candidates as though they were prepped, so "better than
  // what is running" is an actual comparison rather than two different metrics
  // eyeballed side by side. With only maxTargets slots, a promotion candidate
  // waiting behind targets that will never be admitted is the difference between
  // finding the best set and keeping whichever set was ready first.
  const potential = PROMOTE_PREP_FIRST
    ? pricePotential(ns, math, ram, steal, candidates.slice(0, maxTargets * 3))
        .filter((p) => !prepped.has(p.host) && !streaming.has(p.host))
    : [];

  const promote = potential.filter((p) => p.score > weakest);
  const queue = [
    ...promote.map((p) => ({ host: p.host, why: `would displace at $${(p.score / 1e3).toFixed(2)}k/GB-s` })),
    ...candidates.slice(0, maxTargets * 2).map((t) => ({ host: t.host, why: "next in line" })),
  ];

  let slots = PREP_CONCURRENCY - preps.size;
  for (const t of queue) {
    if (slots <= 0) break;
    if (prepped.has(t.host) || streaming.has(t.host) || preps.has(t.host)) continue;
    // Marked with a null wave: servicePreps picks it up on the next tick and
    // places the actual wave, so rescan never does placement work.
    preps.set(t.host, null);
    slots--;
    // Promotions are worth saying out loud - they are the only reason a target
    // that is already streaming will ever be replaced.
    if (t.why !== "next in line") log(`  ~${t.host}: PRIORITY prep, ${t.why}`);
    else if (verbose) log(`  ~${t.host}: queued for prep`);
  }

  return next;
}

/**
 * Advance every prep in flight by one tick: place a wave, wait for it to land,
 * re-check, repeat until the target is prepped.
 *
 * Serves both jobs, because they are the same job - bringing a target to
 * baseline. A host arrives here either because rescan queued it (never streamed
 * yet) or because its stream drifted and stopped.
 *
 * Deliberately NOT prepTargets, which drains the port itself and awaits its own
 * waves. The first would eat live batches' reports; the second would freeze
 * every other stream for a whole weaken window - minutes - to fix one target.
 */
function servicePreps(ns, { math, pool, ram, streams, preps, log }) {
  let finished = 0;
  const now = Date.now();
  const byHost = new Map(streams.map((s) => [s.host, s]));

  // Stopped streams need repairing; queue them the same way rescan queues a
  // fresh target. A RETIRING stream is being replaced on purpose and must not
  // be repaired.
  for (const s of streams) {
    if (!s.stopped || s.retiring) continue;
    // Wait for its own batches to clear first: measuring a target while its
    // last hacks are still landing reads the transient as the drift.
    if (s.depth > 0) continue;
    if (!preps.has(s.host)) preps.set(s.host, null);
  }

  for (const [host, active] of [...preps]) {
    if (active && now < active.deadline) continue;

    if (active) {
      // The wave has landed. Its reservations were never committed - a prep
      // waits for its own landings rather than racing ahead - so release is the
      // right verb.
      pool.release(active.wave.grow.placements);
      pool.release(active.wave.weaken.placements);
      preps.set(host, null);
    }

    const snap = math.snapshot(ns, host);
    if (isPrepped(snap)) {
      preps.delete(host);
      finished++;
      const s = byHost.get(host);
      if (s?.stopped) {
        s.resume();
        log(`  ${host}: back on baseline, stream resumed`);
      } else {
        log(`  ${host}: prepped, eligible from the next rescan`);
      }
      continue;
    }

    const wave = placePrepWave(pool, ram, math, snap);
    if (!wave) continue; // pool busy - try again next tick

    const times = math.opTimes(snap);
    const res = launchPrepWave(ns, snap, wave, `pr${Date.now() % 100000}:${host}`, { times, log });
    preps.set(host, { wave, deadline: res.landAt + REPREP_GRACE_MS });
  }

  return finished;
}

function report({ streams, preps, pool, started, orphans, sawFull, repaired, log, verbose }) {
  const secs = Math.max(1, (Date.now() - started) / 1000);
  let totalStolen = 0;

  for (const s of streams) {
    totalStolen += s.stats.stolen;
    const st = s.stats;
    const avgJitter = st.retired > 0 ? st.jitterSum / st.retired : 0;
    const hitRate = st.hackTries > 0 ? (st.hackHits / st.hackTries) * 100 : 0;

    log(
      `${INDENT}${s.host.padEnd(18)}steal ${(s.steal * 100).toFixed(1).padStart(4)}%  ` +
        `depth ${String(s.depth).padStart(4)}  ` +
        `sent ${String(st.dispatched).padStart(5)}  done ${String(st.retired).padStart(5)}  ` +
        `ok ${String(st.ok).padStart(5)}  bad ${String(st.bad).padStart(4)}  ` +
        `hit ${hitRate.toFixed(0)}%  ` +
        `$${(st.stolen / 1e9).toFixed(2)}b  $${(st.stolen / secs / 1e6).toFixed(2)}m/s`,
    );
    log(
      `${INDENT}${" ".repeat(18)}jitter avg ${avgJitter.toFixed(0)}ms max ${st.jitterMax.toFixed(0)}ms` +
        (st.intrusions > 0 ? `   intrusions ${st.intrusions}` : "") +
        (s.strikes > 0 ? `   bad-batch strikes ${s.strikes}` : "") +
        (s.baselineStrikes > 0 ? `   baseline strikes ${s.baselineStrikes}` : "") +
        (s.stopped ? `   STOPPED: ${s.stopped}` : "") +
        (preps?.has(s.host) ? "   (prep wave in flight)" : ""),
    );

    const skips = Object.entries(st.skips).filter(([, n]) => n > 0);
    if (verbose && skips.length) {
      log(`${INDENT}${" ".repeat(18)}skips: ${skips.map(([k, n]) => `${k} x${n}`).join(", ")}`);
    }
  }

  if (streams.length > 1) {
    log(
      `${INDENT}${"TOTAL".padEnd(18)}$${(totalStolen / 1e9).toFixed(2)}b  ` +
        `$${(totalStolen / secs / 1e6).toFixed(2)}m/s across ${streams.length} target(s)`,
    );
  }

  log(
    `${INDENT}pool ${(pool.freeRam / 1024).toFixed(2)}TB free, ` +
      `${(pool.pendingRam / 1024).toFixed(2)}TB reserved` +
      (repaired > 0 ? `   preps completed ${repaired}` : "") +
      // Orphans are expected in two harmless cases: a batch that aborted
      // mid-dispatch was never registered, and a repair wave's reports are
      // deliberately never collected. Any OTHER source would be a routing bug.
      (orphans > 0 ? `   orphan reports ${orphans}` : "") +
      (sawFull ? "   WARN: report port hit capacity, oldest entries DISCARDED" : ""),
  );
}
