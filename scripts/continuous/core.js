import { ServerPool } from "scripts/continuous/lib/server";
import { coreMap } from "scripts/continuous/lib/cores";
import { deployWorkers, describeDeploy } from "scripts/continuous/lib/deploy";
import { clear } from "scripts/continuous/lib/report";
import { fmtMoney } from "scripts/continuous/lib/fmt";
import { isPrepped, rankTargets } from "scripts/continuous/lib/target";
import { launchPrepWave, placePrepWave, prepTargets } from "scripts/continuous/lib/prep";
import { serviceShare } from "scripts/continuous/lib/share";
import { createStream } from "scripts/continuous/lib/stream";
import {
  avgConcurrentRam,
  baselineDrift,
  batchRam,
  chooseSteal,
  clampSteal,
  heldAllAtOnce,
  moneyPerGbSec,
  planThreads,
} from "scripts/continuous/lib/plan";
import {
  CADENCE_MS,
  CONT_LOG_FILE,
  CONT_REPORT_PORT,
  GROW_DRIFT_TOLERANCE,
  HOME_RESERVE_GB,
  MAX_IN_FLIGHT,
  MAX_STEAL_FRACTION,
  MAX_TARGETS,
  POOL_WAIT_CYCLES,
  POOL_WAIT_MS,
  PREP_CONCURRENCY,
  PREP_MAX_CYCLES,
  PREP_SPARE_SHARE,
  PROMOTE_PREP_FIRST,
  REPREP_GRACE_MS,
  RESCAN_MS,
  SHARE_RAM_FALLBACK,
  SHARE_WORKER,
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

/**
 * Per-thread RAM of the share worker, measured if it is here.
 *
 * NOT added to workerRam.missing: share.js belongs to the shotgun's deploy and
 * a save that has never run it simply does not have the file. That is a reason
 * for share to report nothing, not a reason for the batcher to refuse to start.
 * The fallback keeps the arithmetic sane in the meantime.
 */
export function shareWorkerRam(ns) {
  return ns.getScriptRam(SHARE_WORKER, "home") || SHARE_RAM_FALLBACK;
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

    // The target's OWN pace, when the calculator has picked one. A target too
    // big for its budget widens its cadence rather than shrinking its bite, so
    // its depth is a fraction of what the configured rate would ask for -
    // pricing it at the configured rate over-states it by exactly that factor.
    const pace = p.fit?.cadence ?? cadence;
    const depth = Math.min(Math.ceil(p.times.weaken / pace), maxInFlight);
    // avgConcurrentRam when the caller priced it, `depth * gb` otherwise. The
    // two agree under the all-at-once dispatcher; they diverge under JIT, where
    // an op holds RAM for its own duration rather than the whole window.
    const want = p.avgRam ?? depth * p.gb;

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
 * Named runContinuous, not run. The game's RAM checker bills identifiers rather
 * than call sites, and a function named `run` resolves against ns.run for
 * 1.00 GB in every entry point that imports it.
 *
 * @param {NS} ns
 * @param {object} math one of lib/mathAnalyze or lib/mathFormulas
 */
export async function runContinuous(ns, math) {
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
  // No --steal means the fraction is CALCULATED per target from the server and
  // the RAM it can have; see chooseSteal. Passing one pins it, which is for
  // controlled measurement - an adapting or self-sizing fraction confounds a
  // sweep. STEAL_FRACTION survives only as the seed used before the first
  // rescan has run its calculation.
  const askedSteal = flag("--steal", null);
  const pin = askedSteal === null ? null : clampSteal(askedSteal);
  const steal = pin ?? clampSteal(STEAL_FRACTION);
  // A pinned fraction also stops the controller moving it, for the same reason.
  const adaptive = pin === null && !args.includes("--fixed-steal");

  // The in-game log window keeps a bounded number of lines, so a run long
  // enough to be interesting has already discarded its own start - including
  // the rescan that chose the targets and every OFF BASELINE line but the last
  // few. Mirroring to a file costs nothing: ns.write is 0 GB, which
  // tests/ram.test.mjs pins by asserting the entry's total is unchanged.
  const logFile = flag("--log", CONT_LOG_FILE);
  if (logFile) ns.write(logFile, `=== ${new Date().toISOString()} ===\n`, "w");
  const toFile = (s) => { if (logFile) ns.write(logFile, s + "\n", "a"); };

  const log = (s = "") => { ns.print(s); toFile(s); };
  const say = (s = "") => { ns.print(s); ns.tprint(s); toFile(s); };

  log(`=== continuous batcher [${math.NAME}] ===`);
  // Named out loud because the file is written to the GAME's filesystem, not to
  // disk - the filesync extension only pushes the other way. Without the terminal
  // command spelled out, a log that is being written perfectly reads as one that
  // is not being written at all.
  if (logFile) log(`${INDENT}logging to ${logFile}  (terminal: download ${logFile})`);

  if (steal === null) {
    say(`ABORT: --steal "${askedSteal}" is not a usable fraction. Wants (0, ${MAX_STEAL_FRACTION}].`);
    return;
  }
  if (askedSteal !== null && steal !== Number(askedSteal)) {
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
        `${fmtMoney(t.perBatch)}/batch  ` +
        `chance ${(t.chance * 100).toFixed(0)}%  ` +
        `depth ${String(t.depth).padStart(4)}  ` +
        `${fmtMoney(t.moneyPerSecPerDepth)}/s/depth  ` +
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
          `${fmtMoney(s.money)}/${fmtMoney(s.maxMoney)}  ` +
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
    `supervising up to ${maxTargets} target(s), steal ` +
      `${pin === null ? "CALCULATED per target" : `PINNED at ${(pin * 100).toFixed(1)}%`}` +
      `${adaptive ? ", adaptive" : ", fixed"}, ` +
      `cadence ${CADENCE_MS}ms, rescan every ${(RESCAN_MS / 1000).toFixed(0)}s`,
  );
  if (minutes > 0) say(`${INDENT}stopping after ${minutes} minute(s)`);

  await supervise(ns, math, {
    pool, ram, steal, pin, adaptive, maxTargets, forced, log, say, minutes, verbose,
    shareRam: shareWorkerRam(ns),
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
 * So a streaming host is judged the same way the dispatch gate judges it - and
 * a money snapshot alone is not enough for either. At 95% steal a healthy
 * target sits at 5% of max for half of every cadence, so a snapshot says
 * "drained" a good fraction of the time whatever the stream is really doing. A
 * live run dropped rho-construction ($31.79b/s) and catalyst ($29.92b/s) in one
 * rescan and handed their slots to the-hub ($11.21b/s) and omega-net
 * ($3.55b/s): they were not outranked, they were not PRICED, because the
 * snapshot happened to land in the dip. The stream's own reports measure the
 * same thing at the instant a hack landed, which is the only moment the balance
 * has to be right.
 *
 * @param {Set<string>} [streaming] hosts that already have a live stream
 * @param {Set<string>} [drained] of those, the ones whose own reports say the
 *   target really is not being refilled.
 * @param {Map<string, number>} [driftFor] per-host drift budget the stream has
 *   MEASURED. Without it the calculator prices every target at the conservative
 *   pre-evidence default, which is a ceiling of 91.7% - so a target that has
 *   proved itself steady at 0.22% drift stays pinned there for the whole run,
 *   because the stream's own ceiling can never exceed the base the calculator
 *   hands it. Only these may be dropped on money.
 * @param {Map<string, number>} [stealFor] per-host fraction the controller has
 *   actually reached. Pricing a stream that has backed off to 30% as though it
 *   were still at the 95% start over-states its RAM by an order of magnitude,
 *   and admission would then refuse targets that comfortably fit.
 */
export function priceTargets(
  ns, math, ram, steal, ranked, streaming = new Set(), stealFor = new Map(),
  slice = Infinity, pin = null, drained = new Set(), driftFor = new Map(),
) {
  const priced = [];

  for (const entry of ranked) {
    const snap = math.snapshot(ns, entry.host);

    const th = planThreads(math, snap, stealFor.get(entry.host) ?? steal);
    if (!th) continue;

    if (streaming.has(entry.host)) {
      const off = baselineDrift(snap, th);
      // Security is additive and its ceiling already carries the batch's own
      // transient, so a snapshot of it means what it says. Money does not.
      if (off.secOff || (off.moneyOff && drained.has(entry.host))) continue;
    } else if (!isPrepped(snap)) {
      continue;
    }

    const times = math.opTimes(snap);
    // weaken-2 is priced from grow's EFFECTIVE count, since nothing is placed
    // yet. That over-states it - placement uses fewer raw threads - but it
    // biases every candidate the same way, so the ordering holds.
    const gb = batchRam(th, ram, th.weaken2);

    // What the target actually ties up in steady state, as opposed to what one
    // batch costs. Under the all-at-once dispatcher every op is held ~W, so
    // this reduces to gb * depth - the figure admission has always used - but
    // stating it this way means the JIT dispatcher changes only the held times.
    const avgRam = avgConcurrentRam(
      th, ram, heldAllAtOnce(times), th.weaken2,
    );

    const chance = entry.chance ?? 1;

    // Rank on the income this target would actually produce inside its RAM
    // slice, not on RAM efficiency.
    //
    // moneyPerGbSec - money per GB-second - is the right metric when the budget
    // binds. It is the wrong one when it does not, and it cost a live run its
    // best target: alpha-ent, earning $8.1b/s, was evicted for one earning
    // $2.1b/s while 19 PB of the pool sat free. Two errors compounded. It
    // optimised RAM efficiency in a situation where RAM was not scarce, and it
    // divides by weaken time, which penalises exactly the long-weaken targets a
    // deep pipeline had just made viable.
    //
    // Income within the slice unifies both cases. With RAM to spare every
    // target reaches the ceiling and this reduces to maxMoney * chance. When
    // RAM binds, chooseSteal hands an expensive-to-grow target a smaller
    // fraction, so its income falls out low on its own - which means the
    // foodnstuff trap is caught by the calculator rather than by the metric.
    const fit = chooseSteal(math, snap, ram, slice, { pin, drift: driftFor.get(entry.host) });

    // Landings per second, which is NOT simply one per configured cadence. Two
    // separate things slow a target below it: the calculator widening its pace
    // to fit the RAM budget, and a pipeline needing more depth than
    // MAX_IN_FLIGHT allows - it lands cap/W instead. Scoring at the configured
    // rate over-states precisely the targets that are constrained, which on a
    // live run were the two biggest.
    const byCadence = 1000 / (fit?.cadence ?? CADENCE_MS);
    const byCap = (MAX_IN_FLIGHT * 1000) / times.weaken;
    const rate = Math.min(byCadence, byCap);
    const score = fit ? fit.threads.take * chance * rate : 0;

    priced.push({
      // The calculator's own figure once it has one: it prices the target at
      // the pace it will really run, where avgRam above assumes the configured
      // cadence and so over-states a target that had to slow down.
      host: entry.host, snap, th, times, gb, avgRam: fit?.gb ?? avgRam, chance, fit, score,
      // Kept for the log: what the target costs per unit of income is still
      // worth seeing, it is just not what admission sorts on.
      perGbSec: moneyPerGbSec(th.take, chance, gb, times.weaken),
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

    const gb = batchRam(th, ram, th.weaken2);
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
    pool, ram, steal, pin = null, maxTargets, forced, log, say, adaptive = true,
    minutes = 0, verbose = false, tick = STREAM_TICK_MS, rescanMs = RESCAN_MS,
    shareRam = SHARE_RAM_FALLBACK,
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
        pool, ram, steal, pin, adaptive, maxTargets, forced,
        streams, preps, learned, log, verbose, shareRam,
      });
    }

    for (const s of streams) {
      if (s.isDue(now)) s.dispatch(now);
      // Launch whatever has come due. Separate from dispatch on purpose: a
      // dispatch only PLANS a batch now, and its four ops go out at their own
      // times - which is what stops a worker holding RAM it is not using.
      s.tick(now);
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
    pool, ram, steal, pin = null, adaptive = true, maxTargets, forced,
    streams, preps, learned = new Map(), log, verbose,
    shareRam = SHARE_RAM_FALLBACK,
  } = opts;

  const live = new Set(streams.filter((s) => !s.retiring).map((s) => s.host));

  // Take in RAM that did not exist when the pool was built. cloud.js upgrades
  // purchased servers and buys new ones while this runs, and root.js roots more
  // hosts; without this the pool plans for ever against the network as it stood
  // at startup. A live run watched the slice sit at 12.73TB while RAM was being
  // bought the whole time.
  //
  // The deploy is not optional and not a tidy-up: exec returns a bare 0 for a
  // script that is not on the host, which is the same value it returns for one
  // the host refused - so a new server without the workers would read as a RAM
  // problem for ever. See lib/deploy.js.
  const grown = pool.sync((h) => coreMap(ns, [h])[h]);
  if (grown.added.length > 0) {
    const sent = deployWorkers(ns, grown.added);
    const complaint = describeDeploy(sent, grown.added.length);
    if (complaint) log("  " + complaint.split("\n").join("\n  "));
    log(
      `  pool +${grown.added.length} host(s): ${grown.added.slice(0, 6).join(", ")}` +
        (grown.added.length > 6 ? `, +${grown.added.length - 6} more` : "") +
        `, workers on ${sent.copied}`,
    );
  }
  if (grown.grewGb > 1) {
    log(`  pool grew ${(grown.grewGb / 1024).toFixed(2)}TB since the last rescan`);
  }

  // Share BEFORE the budget, and the order is not cosmetic. Share workers exec
  // outside the reservation system and are never released, so a budget measured
  // first would price RAM share is about to take - and the calculator would then
  // commit a steal fraction it cannot place, which reads in the log as "no room
  // for batch" against a pool that looked fine one line earlier.
  //
  // refresh() rather than sync(): sync's job is to find hosts and capacity that
  // did not exist, and neither changed. What changed is used RAM, on hosts we
  // already know, which is exactly the shallow pass.
  // `shared`, not `share`: the RAM checker bills the identifier, and a local
  // named `share` buys ns.share at 2.40 GB for a function only the WORKER calls.
  const shared = serviceShare(ns, pool, log, { ramPerThread: shareRam });
  if (shared && shared.launched > 0) pool.refresh();

  const ranked = rankTargets(ns, math, { steal });
  const candidates = forced ? ranked.filter((t) => t.host === forced) : ranked;
  // Priced against the slice a FULL complement of targets would each get, so
  // ranking does not depend on how many happen to be admitted this pass.
  // Admission then re-slices among the ones actually taken.
  const provisional = (pool.placeableRam(ram.grow) * TARGET_RAM_BUDGET) / Math.max(1, maxTargets);
  const sick = new Set(streams.filter((s) => s.drained).map((s) => s.host));
  const drifts = new Map(streams.map((s) => [s.host, s.drift]));
  const priced = priceTargets(
    ns, math, ram, steal, candidates.slice(0, maxTargets * 3), live, learned,
    provisional, pin, sick, drifts,
  );

  // Budget off the pool's CAPACITY, not its free RAM. Free RAM shrinks as the
  // streams fill it, so budgeting from it would shrink the budget every rescan
  // and evict the very streams that were using it - a feedback loop that
  // ratchets the target count to zero.
  //
  // placeableRam, not usableRam: every host floors its own thread count, so the
  // raw byte total overstates what can be placed. A live run budgeted against
  // usableRam, chose 84.9% steal, and then failed 402 of 439 dispatches with
  // "no room" - the bytes were there and the threads would not fit.
  const budget = pool.placeableRam(ram.grow) * TARGET_RAM_BUDGET;
  const { admitted: feasible } = admitTargets(priced, budget, maxTargets);

  // Each admitted target gets an equal SHARE of the budget, not the whole of it.
  //
  // Sizing every target against the full budget was harmless while the pool was
  // far larger than three targets could spend - and stopped being harmless the
  // moment it was not. On a 145 TB pool the top target calculated 84.9% steal
  // needing 122 TB, which left nothing for the other two and nothing for prep,
  // and then failed 402 of 439 dispatches.
  //
  // ---------------------------------------------------------------------------
  // How MANY targets is a profit question, not a capacity one
  //
  // Running the most targets that fit is only right when the budget is not the
  // constraint. When it is, every extra target narrows the slice for all of
  // them, and income is close to linear in the slice - so the third target does
  // not add its income, it buys it by taking a third of the budget away from
  // the best one. A live run on a 1.6 TB pool measured the trade exactly:
  //
  //     phantasy alone, 1403 GB          $2.84m/s
  //     phantasy + iron-gym + joesguns   $0.94 + $0.54 + $0.48 = $1.96m/s
  //
  // 45% given away for diversification nobody asked for. So the count is chosen
  // by evaluating each one and taking the best total - which comes out at 1 on a
  // small pool and rises to MAX_TARGETS on its own as the pool grows, because
  // once every target can reach its ceiling a narrower slice costs nothing. That
  // ramp needs no threshold and no new setting.
  const evaluate = (n) => {
    const take = feasible.slice(0, n);
    if (take.length < n) return null;
    const width = budget / n;
    const picks = new Map();
    let total = 0;
    for (const p of take) {
      const fit = chooseSteal(math, p.snap, ram, width, { pin, drift: drifts.get(p.host) });
      if (!fit) return null;
      picks.set(p.host, fit);
      // A target whose single batch cannot fit its slice earns NOTHING - it
      // places weakens and never places its grow. Scoring it at its arithmetic
      // income would have it justify the slice it is about to waste.
      if (fit.fitsPeak) total += fit.income * 1000 * (p.chance ?? 1);
    }
    return { admitted: take, slice: width, picks, total };
  };

  let plan = null;
  const totals = [];
  for (let n = 1; n <= feasible.length; n++) {
    const cand = evaluate(n);
    if (!cand) continue;
    totals.push(`${n}:${fmtMoney(cand.total)}/s`);
    if (!plan || cand.total > plan.total) plan = cand;
  }

  const admitted = plan ? plan.admitted : [];
  const slice = plan ? plan.slice : budget;
  const want = new Set(admitted.map((p) => p.host));
  if (verbose && totals.length > 1) {
    log(`  target count by income: ${totals.join("  ")} -> taking ${admitted.length}`);
  }

  const byHost = new Map(streams.map((s) => [s.host, s]));
  const next = [];

  const baseFor = new Map();
  // What the admitted streams will really occupy, at the fraction and pace the
  // calculator settled on. admitTargets' own `committed` is priced against the
  // PROVISIONAL slice - budget / maxTargets - so on a pool where one target is
  // admitted it under-states the commitment threefold, and prep would read the
  // other two thirds as spare when the one live stream is about to take it.
  let spent = 0;

  for (const p of admitted) {
    const picked = plan.picks.get(p.host);
    if (!picked) continue;
    // Re-stated at the slice this plan actually gives out. admitTargets priced
    // depth against the provisional slice, which is a different number whenever
    // the chosen count is not maxTargets.
    p.depth = Math.min(Math.ceil(p.times.weaken / picked.cadence), MAX_IN_FLIGHT);
    baseFor.set(p.host, picked.steal);
    spent += picked.gb;
    // Re-state the admission figures at the fraction actually chosen. Leaving
    // them at the seed fraction used for ranking would have the log report a
    // batch size the stream never uses.
    p.picked = picked;
    p.want = picked.gb;
    if (verbose) {
      log(
        `  =${p.host}: steal ${(picked.steal * 100).toFixed(1)}% ` +
          // The plan's OWN income, not p.score - that was priced against the
          // provisional slice and disagrees with this one whenever the chosen
          // count is not maxTargets, which is exactly when it is read.
          `(${fmtMoney(picked.income * 1000 * (p.chance ?? 1))}/s, ${picked.hack}t hack, ` +
          `${(picked.gb / 1024).toFixed(2)}TB of a ${(slice / 1024).toFixed(2)}TB slice` +
          `${picked.capped ? ", at the ceiling" : ""}` +
          // Not an error any more. A target too big for its budget slows down
          // instead of shrinking to one hack thread, so this line reports the
          // pace it settled on rather than announcing a failure.
          `${picked.fits ? "" : `, paced at ${(picked.cadence / 1000).toFixed(1)}s`})`,
      );
    }
  }

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
      // A ceiling, not an assignment - a stream that has backed off after a
      // fault keeps its reduced fraction and climbs back toward this.
      const base = baseFor.get(p.host);
      if (base !== undefined) existing.setBase(base);
      if (p.picked) existing.setCadence(p.picked.cadence);
      next.push(existing);
      continue;
    }

    // Start from what was measured last time this target ran, if anything. A
    // target dropped for RAM and re-admitted later should not have to re-climb
    // from the default - that is minutes of measurement thrown away, one weaken
    // window per step.
    // Start at the calculated optimum, so the controller descends from it
    // rather than climbing to it. `learned` still wins when this target has run
    // before and backed off - that measurement is worth more than the
    // calculator's RAM-only view.
    const base = baseFor.get(p.host) ?? steal;
    const start = Math.min(learned.get(p.host) ?? base, base);
    log(
      // The picked plan's batch, not the seed fraction's. Printing the seed's
      // made a live log read `batch 9.29TB x depth 1 = 0.5TB`, which is three
      // numbers that cannot all be true at once.
      `  +${p.host}: batch ${((p.picked?.peak ?? p.gb) / 1024).toFixed(2)}TB x depth ${p.depth} = ` +
        `${(p.want / 1024).toFixed(1)}TB, ${fmtMoney(p.score)}/GB-s` +
        `, steal ${(start * 100).toFixed(1)}%` +
        (start < base ? ` (resuming below the ${(base * 100).toFixed(1)}% optimum)` : ""),
    );
    next.push(createStream(ns, math, {
      host: p.host, pool, ram, steal: start, cap: base, adaptive, log,
      cadence: p.picked?.cadence,
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
  // Who is already at baseline, and therefore must never be queued for prep.
  //
  // `priced` is NOT the answer to that question, though it was used as one.
  // priceTargets only ever sees candidates.slice(0, maxTargets * 3) and drops
  // anything that fails to price, so a prepped target below that cutoff is
  // absent from it and reads as unprepped. With one prep slot - which is what a
  // pool the streams have fully spoken for grants - it then takes that slot on
  // every rescan and hands it straight back: a live run sat on
  // `~nectar-net: queued for prep` / `nectar-net: prepped, eligible from the
  // next rescan` once a minute forever, at rank 10 of 17, while iron-gym,
  // the-hub, neo-net and zer0 were never prepped at all.
  //
  // So test the snapshot rankTargets already took. It costs nothing - the same
  // snap is what the ranking table prints prepped/unprepped from - and it
  // cannot be fooled by a pricing failure or a cutoff.
  const prepped = new Set(priced.map((p) => p.host));
  for (const t of candidates) {
    if (isPrepped(t.snap)) prepped.add(t.host);
  }
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
  // The whole ranking, not a slice of it. A cutoff of maxTargets * 2 is mostly
  // consumed by the streams themselves - three running out of six eligible -
  // so the slot math below could grant four slots and find only one host to
  // put in them, and the pool's spare RAM went unused however idle it got.
  // Nothing bounds the queue now because nothing needs to: `slots` bounds how
  // many are taken and the dedupe below skips the rest, both per entry.
  const queue = [
    ...promote.map((p) => ({ host: p.host, why: `would displace at ${fmtMoney(p.score)}/GB-s` })),
    ...candidates.map((t) => ({ host: t.host, why: "next in line" })),
  ];

  // How many targets may be QUEUED for prep. Not how many get RAM - that is
  // decided by servicePreps, which stops at the first wave the pool could not
  // cover in full. Queuing reserves nothing, so an extra entry here costs a map
  // slot and a line in the report.
  //
  // Spare is what the ADMITTED STREAMS will not use, NOT what happens to be free
  // this instant. Free RAM was the first attempt and it is wrong at exactly the
  // moment that matters: at startup nothing is placed yet, so the pool reads
  // 100% idle and every slot is granted. `spent` is the calculator's own figure
  // for what the streams will occupy in steady state, which is the honest
  // answer - but note it does not save this from the startup case either, since
  // with no target prepped there is nothing to admit and `spent` is 0. Only
  // placement knows whether one target's need fits; see the `tight` gate in
  // servicePreps.
  const capacity = pool.placeableRam(ram.grow);
  const idle = Math.max(0, budget - spent);
  const spare = capacity > 0 ? Math.floor(idle / (capacity * PREP_SPARE_SHARE)) : 0;
  let slots = Math.min(PREP_CONCURRENCY, 1 + spare) - preps.size;
  for (const t of queue) {
    if (slots <= 0) break;
    if (prepped.has(t.host) || streaming.has(t.host) || preps.has(t.host)) continue;
    // Marked with no wave: servicePreps picks it up on the next tick and places
    // the actual wave, so rescan never does placement work.
    preps.set(t.host, freshPrep());
    slots--;
    // Promotions are worth saying out loud - they are the only reason a target
    // that is already streaming will ever be replaced.
    if (t.why !== "next in line") log(`  ~${t.host}: PRIORITY prep, ${t.why}`);
    else if (verbose) log(`  ~${t.host}: queued for prep`);
  }

  return next;
}

/**
 * A queued prep with no wave placed yet.
 *
 * Always an object, never a bare null, because `waves` has to survive the gaps
 * BETWEEN waves - the entry is cleared every time one lands, and a give-up
 * condition needs a count that outlives that. `shrunk` outlives the wave for
 * the same reason: it has to still be readable while the wave is in flight.
 */
const freshPrep = () => ({ wave: null, deadline: 0, waves: 0, shrunk: false });

/**
 * Advance every prep in flight by one tick: place a wave, wait for it to land,
 * re-check, repeat until the target is prepped.
 *
 * Serves both jobs, because they are the same job - bringing a target to
 * baseline. A host arrives here either because rescan queued it (never streamed
 * yet) or because its stream drifted and stopped.
 *
 * How many of the queued preps actually get a wave is decided HERE, not by the
 * slot count rescan granted - see the `tight` gate below. On a pool with room
 * every queued prep gets one; on a pool that cannot cover a single target's
 * need, exactly one does.
 *
 * Deliberately NOT prepTargets, which drains the port itself and awaits its own
 * waves. The first would eat live batches' reports; the second would freeze
 * every other stream for a whole weaken window - minutes - to fix one target.
 */
export function servicePreps(ns, { math, pool, ram, streams, preps, log }) {
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
    if (!preps.has(s.host)) preps.set(s.host, freshPrep());
  }

  // Extras get LEFTOVERS, never a share of what the first prep needed.
  //
  // A wave is sized by need, but placePrepWave backs the grow request down x0.7
  // until it fits, so a second prep on an almost-full pool does not fail and
  // wait - it gets a smaller wave. Early in a BitNode, where one target's need
  // exceeds the whole pool, three queued preps split it three ways and all three
  // crawl instead of one finishing and starting to earn.
  //
  // PREP_SPARE_SHARE cannot catch this. It compares RAM SHARES, and at startup
  // no target is prepped, so nothing is admitted, `spent` is 0, `idle` is the
  // whole budget and every slot is granted however small the pool is. Need
  // against capacity is knowable only here, at placement.
  let tight = false;

  // Repairs before fresh preps. A stopped stream is a target we already admitted
  // that earns nothing until it is back on baseline, so with prep serialised it
  // must not queue behind a host that has never streamed. Stable sort, so queue
  // order - which is rank order - still decides within each group.
  const ordered = [...preps].sort(
    (a, b) => Number(byHost.get(b[0])?.stopped ?? false)
            - Number(byHost.get(a[0])?.stopped ?? false),
  );

  for (const [host, active] of ordered) {
    if (active.wave && now < active.deadline) {
      // A short wave still in flight is still the pool's constraint. Without
      // this the gate just moves the split from space into time: this host holds
      // a short wave, the next takes the crumbs, this one releases, the next
      // holds, and the pool is halved all the same.
      if (active.shrunk) tight = true;
      continue;
    }

    if (active.wave) {
      // The wave has landed. Its reservations were never committed - a prep
      // waits for its own landings rather than racing ahead - so release is the
      // right verb.
      pool.release(active.wave.grow.placements);
      pool.release(active.wave.weaken.placements);
      // Cleared in place rather than replaced, so the wave COUNT survives to the
      // next pass. Without that there is no give-up condition at all.
      active.wave = null;
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

    // Give up on a target that will not converge.
    //
    // prepTargets has always had this bound; the supervisor path never did, and
    // four concurrent slots hid the omission - one stuck target still left three
    // working. With prep serialised on a small pool it would block every other
    // prep for the whole run, so the cap has to exist here too.
    //
    // A wave is sized by need, so a healthy prep converges in a handful of them.
    // Hitting this means something else is draining the target, or grow is too
    // weak to outrun the security it adds.
    if (active.waves >= PREP_MAX_CYCLES) {
      preps.delete(host);
      log(
        `  ${host}: prep ABANDONED after ${active.waves} waves - ` +
          `${fmtMoney(snap.money)} of ${fmtMoney(snap.maxMoney)}, ` +
          `sec ${snap.sec.toFixed(2)} of ${snap.minSec.toFixed(2)}. Slot released.`,
      );
      continue;
    }

    // Placed only AFTER the release, finish and abandon handling above, which
    // every entry still needs every tick - skipping the release would leak the
    // reservation of a wave that has already landed.
    if (tight) continue;

    const wave = placePrepWave(pool, ram, math, snap);
    if (!wave) { tight = true; continue; } // pool busy - try again next tick

    const times = math.opTimes(snap);
    const res = launchPrepWave(ns, snap, wave, `pr${Date.now() % 100000}:${host}`, { times, log });
    active.wave = wave;
    active.deadline = res.landAt + REPREP_GRACE_MS;
    active.waves++;
    active.shrunk = wave.shrunk;
    if (wave.shrunk) tight = true;
  }

  return finished;
}

function report({ streams, preps, pool, started, orphans, sawFull, repaired, log, verbose }) {
  const now = Date.now();
  const secs = Math.max(1, (now - started) / 1000);
  let totalStolen = 0;
  let totalRecent = 0;

  for (const s of streams) {
    totalStolen += s.stats.stolen;
    const st = s.stats;

    // Income since the LAST report, not since the run started.
    //
    // A cumulative average includes prep, the ramp, and any stopped period, so
    // a target that only recently reached depth reads roughly an order of
    // magnitude below what it is currently earning - and stays that way. That
    // made the reported rate disagree with the admission score by ~100x and
    // sent two separate investigations after phantom regressions. The rate now
    // is the number worth looking at; the cumulative one is kept because it is
    // what the totals are actually made of.
    const since = st.reportedAt ? Math.max(0.001, (now - st.reportedAt) / 1000) : secs;
    const recent = (st.stolen - (st.reportedStolen ?? 0)) / since;
    st.reportedAt = now;
    st.reportedStolen = st.stolen;
    totalRecent += recent;
    const avgJitter = st.retired > 0 ? st.jitterSum / st.retired : 0;
    const hitRate = st.hackTries > 0 ? (st.hackHits / st.hackTries) * 100 : 0;

    log(
      `${INDENT}${s.host.padEnd(18)}steal ${(s.steal * 100).toFixed(1).padStart(4)}%` +
        // The ceiling too when the controller has backed off below it - the
        // gap is the whole story of what the run has learned about this target.
        `${s.steal < s.cap - 1e-9 ? `/${(s.cap * 100).toFixed(0)}%` : "    "}  ` +
        `depth ${String(s.depth).padStart(4)}  ` +
        `sent ${String(st.dispatched).padStart(5)}  done ${String(st.retired).padStart(5)}  ` +
        `ok ${String(st.ok).padStart(5)}  bad ${String(st.bad).padStart(4)}  ` +
        `hit ${hitRate.toFixed(0)}%  ` +
        `${fmtMoney(st.stolen)}  ${fmtMoney(recent)}/s now` +
        `  (${fmtMoney(st.stolen / secs)}/s avg)`,
    );
    log(
      `${INDENT}${" ".repeat(18)}jitter avg ${avgJitter.toFixed(0)}ms max ${st.jitterMax.toFixed(0)}ms` +
        (st.intrusions > 0 ? `   intrusions ${st.intrusions}` : "") +
        // Aborted batches leave flight WITHOUT being retired, so without this
        // they are invisible: `sent` climbs, `done` does not, and nothing says
        // why. A live run abandoned 1450 of 1826 batches silently.
        (st.aborted > 0 ? `   aborted ${st.aborted}` : "") +
        (st.lateLaunches > 0 ? `   late ${st.lateLaunches}` : "") +
        // What the pipeline still owes the pool: ops planned but not yet placed.
        // Without it, a stream that has stopped dispatching against a pool with
        // free RAM on the same line looks broken. It is not - the free RAM is
        // spoken for by grows that have not come due yet.
        (s.queuedRam > 0 ? `   queued ${(s.queuedRam / 1024).toFixed(2)}TB` : "") +
        // Only when it is not the configured rate. A widened cadence is the
        // single most important number for reading a small-pool run - it is why
        // depth is low, why `sent` climbs slowly, and why income is what it is.
        (s.cadence > CADENCE_MS + 1e-9
          ? `   paced ${(s.cadence / 1000).toFixed(1)}s`
          : "") +
        // jitterMax is a LIFETIME maximum and says nothing about whether the
        // tail is fattening. This does: batches whose spread came within half a
        // spacer of reordering. One outlier is noise; a rising count is the
        // signal to widen SPACER_MS before `bad` starts moving.
        (st.nearMiss > 0 ? `   near-miss ${st.nearMiss}/${st.retired}` : "") +
        (s.strikes > 0 ? `   bad-batch strikes ${s.strikes}` : "") +
        (s.baselineStrikes > 0 ? `   baseline strikes ${s.baselineStrikes}` : "") +
        // Only once it has learned something. A target sitting on the floor
        // budget has nothing to say; one that has raised it is explaining why
        // its ceiling is below what the calculator offered.
        (s.drift > GROW_DRIFT_TOLERANCE + 1e-9
          ? `   drift budget ${(s.drift * 100).toFixed(1)}%`
          : "") +
        // How full the target was when its last hack landed. A stop for "money
        // off baseline" is not actionable without it - it separates a real
        // drain from a snapshot taken during a healthy post-hack dip.
        (st.hackHits > 0 && s.lastUnder < -0.01
          ? `   last hack found it ${((1 + s.lastUnder) * 100).toFixed(0)}% full`
          : "") +
        (s.stopped ? `   STOPPED: ${s.stopped}` : "") +
        // Without this a draining stream is indistinguishable from a broken
        // one: `sent` freezes while `depth` falls, which reads as a dispatcher
        // that has quietly died rather than a target being handed over.
        (s.retiring ? `   DRAINING (replaced, ${s.depth} batches still to land)` : "") +
        (preps?.has(s.host) ? "   (prep wave in flight)" : ""),
    );

    const skips = Object.entries(st.skips).filter(([, n]) => n > 0);
    if (verbose && skips.length) {
      log(`${INDENT}${" ".repeat(18)}skips: ${skips.map(([k, n]) => `${k} x${n}`).join(", ")}`);
    }
    // Aborts have their own list because they are a different failure: a skip
    // means a batch was never planned, an abort means one was planned, part
    // launched, and then abandoned - which is far more expensive.
    const aborts = Object.entries(st.abortReasons).filter(([, n]) => n > 0);
    if (verbose && aborts.length) {
      log(`${INDENT}${" ".repeat(18)}aborts: ${aborts.map(([k, n]) => `${k} x${n}`).join(", ")}`);
    }
  }

  if (streams.length > 1) {
    log(
      `${INDENT}${"TOTAL".padEnd(18)}${fmtMoney(totalStolen)}  ` +
        `${fmtMoney(totalRecent)}/s now  ` +
        `(${fmtMoney(totalStolen / secs)}/s avg) across ${streams.length} target(s)`,
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
