import { ServerPool } from "./ram.js";
import {
  SPACER_MS,
  GROW_MARGIN,
  HOME_RESERVE_GB,
  REPORT_PORT,
  WORKER_FILES,
  WORKER_RAM_FALLBACK,
} from "./config.js";
import { growSecurity, weakenThreadsFor } from "./calib.js";

/**
 * Prep logic as a pure module - bring one target to max money, minimum security.
 *
 * Pulled out of prep.js because exactly ONE process may own the ServerPool and
 * the report port. port.read() REMOVES the message, so two readers steal each
 * other's reports; and Server.pending is per-process in-memory state, so two
 * allocators both believe the same RAM is free and over-commit. The manager has
 * to own both, which means prep has to run inside the manager, not beside it.
 *
 * Nothing in here builds a pool or clears a port on its own initiative - the
 * caller passes both in. prep() will build a pool per cycle if you don't give it
 * one, which is what the standalone CLI wants and what the manager avoids.
 *
 * A batch's thread math is only valid against a prepped server: every analyze
 * function reads CURRENT state, so an unprepped target inflates grow threads and
 * misreports hack yield. Nothing fires a volley before this finishes.
 *
 * Each cycle does ONE of two things:
 *
 *   money < max  -> grow AND weaken in the same wave. Grow lands one spacer
 *                   before the weaken, so a single weaken cancels both the
 *                   security the server already carries and the security the
 *                   grow adds. Costs some extra grow threads at high security;
 *                   saves a whole ~50s window per cycle.
 *   money == max -> nothing left to grow, so the wave is all weaken.
 *
 * RAM charged to whoever imports this (verified against the fork's docs):
 *   ram.js 0.35 + exec 1.30 + getScriptRam 0.10
 *   + getServerMaxMoney/MoneyAvailable/SecurityLevel/MinSecurityLevel 0.40
 *   + getWeakenTime/getGrowTime 0.10 + growthAnalyze 1.00
 *   + getServerRequiredHackingLevel 0.10 + getHackingLevel 0.05 + fileExists 0.10
 *   = 3.50 GB   (ports, sleep, print are all 0)
 *
 * Two functions that used to be here are now cache reads, saving 2.00 GB:
 *   weakenAnalyze         -> calib.weakenPerThread
 *   growthAnalyzeSecurity -> calib.growSecPerThread
 * Both are linear in threads and independent of the target's current security,
 * so a cached constant is exactly right, not an approximation. growthAnalyze
 * stays live because it is NOT: it reads security at call time, and prep runs
 * precisely when security is off baseline - which is also why the calibration
 * cache refuses to answer growth questions there.
 */

// Re-exported from config.js so both math implementations and every consumer
// agree on what "prepped" means. Defining them here again would let the two
// drift apart silently.
export { MONEY_TOLERANCE, SEC_TOLERANCE } from "./config.js";

// How long past the expected landing to wait for reports before giving up on
// them and re-measuring anyway. A missing report must not wedge prep.
const REPORT_GRACE_MS = 3000;

export const DEFAULT_MAX_CYCLES = 50;

const fmtRam = (gb) => `${gb.toFixed(2)}GB`;
const padL = (s, n) => String(s).padStart(n);

function fmtMoney(m) {
  for (const [div, suf] of [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]]) {
    if (Math.abs(m) >= div) return `$${(m / div).toFixed(2)}${suf}`;
  }
  return `$${m.toFixed(0)}`;
}

const fmtTime = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(2)}m` : `${(ms / 1000).toFixed(1)}s`);

/**
 * Build a pool containing only hosts that actually hold the worker scripts.
 *
 * exec requires the script to already exist on the target and returns a bare 0
 * otherwise, so a host without workers is not merely useless - it silently
 * breaks whatever batch was placed on it, and a batch that hacks without
 * growing is worse than no batch at all.
 *
 * This is load-bearing now that cloud.js no longer scp's on purchase: a freshly
 * bought server exists, is rooted, and has RAM, but stays empty until boot.js
 * notices the marker and runs deploy.js. Filtering here makes that window
 * merely idle instead of destructive.
 */
export function buildWorkerPool(ns, opts = {}) {
  const pool = ServerPool.build(ns, { homeReserve: HOME_RESERVE_GB, ...opts });
  pool.servers = pool.servers.filter((s) => ns.fileExists(WORKER_FILES.hack, s.hostname));
  return pool;
}

/** Per-thread worker RAM, real if deployed, expected otherwise. */
export function workerRam(ns) {
  const out = {};
  for (const [kind, file] of Object.entries(WORKER_FILES)) {
    const real = ns.getScriptRam(file, "home");
    out[kind] = real > 0 ? real : WORKER_RAM_FALLBACK[kind];
  }
  return out;
}

/** Current money/security of a host, plus the two "is it there yet" flags. */
export function measure(ns, host) {
  const maxMoney = ns.getServerMaxMoney(host);
  const money = ns.getServerMoneyAvailable(host);
  const minSec = ns.getServerMinSecurityLevel(host);
  const sec = ns.getServerSecurityLevel(host);
  return {
    maxMoney, money, minSec, sec,
    moneyOk: money >= maxMoney * MONEY_TOLERANCE,
    secOk: sec <= minSec + SEC_TOLERANCE,
  };
}

/** True if a measure() result is at max money AND minimum security. */
export const isPrepped = (m) => m.moneyOk && m.secOk;

/**
 * Richest server we can actually hack. Only used without an explicit target.
 *
 * The hacking-level check is load-bearing, not a nicety. NUKE ignores hacking
 * level entirely - scripts/root.js roots every server whose ports it can open -
 * so "rooted" says nothing about whether hacking it will work. Picking the
 * richest rooted server would hand back something far above your level, where
 * hackAnalyze returns 0 and the manager exits immediately; a supervisor would
 * then restart it into the same failure forever.
 */
export function pickTarget(ns) {
  const level = ns.getHackingLevel();
  let best = null;
  for (const host of ServerPool.scanAll(ns)) {
    if (host === "home" || !ns.hasRootAccess(host)) continue;
    const maxMoney = ns.getServerMaxMoney(host);
    if (maxMoney <= 0) continue;
    if (ns.getServerRequiredHackingLevel(host) > level) continue;
    if (!best || maxMoney > best.maxMoney) best = { host, maxMoney };
  }
  return best?.host ?? null;
}

/**
 * Size a grow+weaken wave that fits in the pool.
 *
 * Grow raises security, so the paired weaken count depends on the grow count,
 * which depends on how much RAM is left after the weaken... circular. Resolve it
 * by scaling down from the ideal until the pair fits.
 *
 * "Fits" is decided by actually trial-placing both ops, not by comparing GB
 * totals. Free RAM is spread across hosts that each floor their own thread
 * count, so a byte comparison lies - and once two ops with different per-thread
 * sizes compete, even maxThreadsFor is only exact for one of them at a time.
 * A real allocate/release pair is the only honest test.
 */
export function sizeGrowWave(pool, ram, calib, growWanted, extraWeaken = 0) {
  let grow = Math.min(growWanted, pool.maxThreadsFor(ram.grow));

  while (grow > 0) {
    // Cached per-thread constant, measured with NO host argument. With a host,
    // growthAnalyzeSecurity caps its answer by the threads needed to reach max
    // money; as prep closes in on max money that cap collapses toward zero, the
    // paired weaken gets sized at 1 thread, and security creeps back up exactly
    // when prep is trying to finish. The uncapped per-thread figure is honest at
    // any money level, which is what makes it cacheable.
    // extraWeaken covers security the server is ALREADY carrying, on top of
    // what this grow will add. Both are cancelled by the same weaken landing.
    const weaken = Math.max(1, weakenThreadsFor(calib, growSecurity(calib, grow)) + extraWeaken);

    const g = pool.allocate(ram.grow, grow);
    if (g) {
      const w = pool.allocate(ram.weaken, weaken);
      pool.release(g);
      if (w) {
        pool.release(w);
        return { grow, weaken };
      }
    }

    // Shrink by the overshoot ratio, and always make progress.
    const need = grow * ram.grow + weaken * ram.weaken;
    const scaled = Math.floor(grow * (pool.freeRam / need));
    grow = Math.min(scaled, grow - 1);
  }

  // No room for any grow at all - still spend the wave weakening, so the cycle
  // is not wasted entirely.
  return { grow: 0, weaken: Math.min(extraWeaken, pool.maxThreadsFor(ram.weaken)) };
}

/**
 * Decide what one prep cycle should do, given a fresh measurement.
 *
 * @returns {{grow: number, weaken: number, mode: string}}
 */
export function planPrepWave(ns, host, pool, ram, calib, m) {
  // Threads needed purely to undo the security the server is already carrying.
  const excess = Math.max(0, m.sec - m.minSec);
  const fixSec = weakenThreadsFor(calib, excess);

  if (m.moneyOk) {
    // Money is already at max, so there is nothing to grow - spend the whole
    // wave on weaken.
    //
    // maxThreadsFor, NOT freeRam / ramPerThread. Free RAM is spread across hosts
    // and each host floors its own thread count, so the total is not divisible:
    // 78.85GB free can be under 45 placeable threads at 1.75GB. maxThreadsFor
    // sums the per-host floors, which is exactly what allocate() can seat.
    const fits = pool.maxThreadsFor(ram.weaken);
    return {
      grow: 0,
      weaken: Math.min(fixSec, fits),
      mode: `weaken (need ${fixSec}t for ${excess.toFixed(2)} sec)`,
    };
  }

  // Money is low, so grow AND weaken in the same wave, whatever the security.
  //
  // These used to be sequential - weaken to minimum first, then grow - on the
  // reasoning that grow is inefficient at high security. That reasoning is
  // sound but the conclusion was wrong: each phase costs a full weaken window
  // (~50s), and the wave already lands grow one spacer BEFORE weaken, so the
  // same weaken that fixes the existing drift also cancels what the grow adds.
  // Running them together spends extra grow threads to save whole cycles, and
  // threads are the cheap resource once the pool is large.
  //
  // growthAnalyze is evaluated at CURRENT security, which is exactly right
  // here: grow lands before the weaken, so it really does execute at this
  // security level.
  //
  // The ratio is capped at current money: at very low money growthAnalyze's
  // multiplier explodes, and the +$1/thread additive growth it ignores means
  // fewer threads are really needed anyway.
  const ratio = m.maxMoney / Math.max(m.money, 1);
  const wanted = Math.ceil(ns.growthAnalyze(host, ratio) * GROW_MARGIN);
  const plan = sizeGrowWave(pool, ram, calib, wanted, fixSec);
  // When the drift alone needs more threads than the pool holds, grow is
  // squeezed out entirely and the wave is pure weaken - say so rather than
  // labelling a 0-thread grow as a grow.
  const mode =
    plan.grow === 0
      ? `weaken only (${excess.toFixed(2)} sec drift needs ${fixSec}t; no room left to grow)`
      : `grow (want ${wanted}t for x${ratio.toFixed(2)})` +
        (fixSec > 0 ? ` + ${fixSec}t weaken for ${excess.toFixed(2)} sec drift` : "");
  return { ...plan, mode };
}

/**
 * Launch one wave and wait for it to land.
 *
 * All workers exec at the same instant; separation comes from additionalMsec,
 * never from sleeping between launches. Grow lands one spacer BEFORE weaken so
 * the weaken cancels the security the grow just added.
 *
 * The caller owns the port - this reads from it but never clears it.
 *
 * @returns {{launched: number, reports: number, threads: number}}
 */
export async function runPrepWave(ns, host, pool, ram, plan, batch, port, log) {
  const W = ns.getWeakenTime(host);
  const G = ns.getGrowTime(host);

  const jobs = [];
  if (plan.grow > 0) {
    // Grow lands at W - spacer, so its own runtime is absorbed by the delay.
    jobs.push({ op: "G", kind: "grow", threads: plan.grow, delay: Math.max(0, W - SPACER_MS - G) });
  }
  if (plan.weaken > 0) {
    jobs.push({ op: "W1", kind: "weaken", threads: plan.weaken, delay: 0 });
  }

  const landAt = Date.now() + W;
  let launched = 0;
  let threads = 0;
  const placements = [];

  for (const job of jobs) {
    let place = pool.allocate(ram[job.kind], job.threads);
    if (!place) {
      // The pool can shrink between planning and launching (another script
      // started, a host went away). Take what's left rather than losing the
      // whole cycle - a smaller wave still makes progress.
      const fits = pool.maxThreadsFor(ram[job.kind]);
      if (fits > 0) {
        log(`WARN: ${job.op} x${job.threads} did not fit, shrinking to x${fits}`);
        place = pool.allocate(ram[job.kind], fits);
      }
      if (!place) {
        log(`WARN: could not place ${job.op} x${job.threads} at all - skipped`);
        continue;
      }
    }
    placements.push(place);

    for (const p of place) {
      const pid = ns.exec(
        WORKER_FILES[job.kind],
        p.host,
        p.threads,
        host,          // target
        job.delay,     // additionalMsec
        batch,
        port,
        landAt,        // planned land time, absolute epoch ms
        job.op,
        p.threads,
      );
      if (pid === 0) {
        log(
          `ERROR: exec ${WORKER_FILES[job.kind]} on ${p.host} x${p.threads} returned 0 - ` +
            `run scripts/deploy.js first`,
        );
      } else {
        launched++;
        threads += p.threads;
      }
    }
  }

  // Wait for reports, but never past the deadline: a lost report (full port,
  // killed worker) must not wedge prep. We re-measure regardless.
  const handle = ns.getPortHandle(port);
  const deadline = landAt + REPORT_GRACE_MS;
  let reports = 0;

  while (reports < launched && Date.now() < deadline) {
    await ns.sleep(Math.min(500, Math.max(50, deadline - Date.now())));
    while (!handle.empty()) {
      const msg = handle.read();
      if (typeof msg === "object" && msg !== null && msg.b === batch) reports++;
    }
  }

  for (const p of placements) pool.release(p);
  return { launched, reports, threads };
}

/**
 * Run prep cycles until the target is prepped, RAM runs out, or cycles run out.
 *
 * Re-measures every cycle rather than computing one plan up front. Same
 * self-correcting principle as the volley loop: hacking level and timings move,
 * and a wave that was right three minutes ago may not be now.
 *
 * @param {NS} ns
 * @param {string} host
 * @param {object} opts
 * @param {object} opts.calib      loaded calibration cache (required)
 * @param {object} [opts.ram]      per-thread worker RAM; computed if omitted
 * @param {number} [opts.port]     report port; defaults to REPORT_PORT
 * @param {number} [opts.maxCycles]
 * @param {string} [opts.idPrefix] batch id prefix, so a manager can tell prep
 *                                 waves apart from volley batches on the port
 * @param {() => ServerPool} [opts.buildPool] called once per cycle. Defaults to
 *        a fresh buildWorkerPool - pass your own if you already own a pool.
 * @param {(s: string) => void} [opts.log]
 * @returns {Promise<{ok: boolean, cycles: number, reason: string, m: object}>}
 */
export async function prep(ns, host, opts = {}) {
  const {
    calib,
    ram = workerRam(ns),
    port = REPORT_PORT,
    maxCycles = DEFAULT_MAX_CYCLES,
    idPrefix = "prep",
    buildPool = () => buildWorkerPool(ns),
    log = (s) => ns.print(s),
  } = opts;

  if (!calib) {
    return { ok: false, cycles: 0, reason: "no calibration cache", m: measure(ns, host) };
  }

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    // Rebuild every cycle: hosts get rooted, RAM gets bought, other scripts
    // start and stop. A stale pool would over-commit.
    const pool = buildPool();
    const m = measure(ns, host);

    if (isPrepped(m)) {
      log(
        `PREPPED after ${cycle - 1} cycle(s): ${fmtMoney(m.money)}/${fmtMoney(m.maxMoney)}, ` +
          `sec ${m.sec.toFixed(2)}`,
      );
      return { ok: true, cycles: cycle - 1, reason: "prepped", m };
    }

    const plan = planPrepWave(ns, host, pool, ram, calib, m);

    if (plan.grow === 0 && plan.weaken === 0) {
      // freeRam alone reads like a contradiction here ("2.00GB free, need
      // 1.75GB") because free RAM is spread across hosts that each floor their
      // own thread count. Quote the placeable thread count too - that is the
      // number that actually decided this.
      const smallest = Math.min(ram.grow, ram.weaken);
      return {
        ok: false,
        cycles: cycle - 1,
        reason:
          `nothing fits - ${fmtRam(pool.freeRam)} free across the pool but ` +
          `0 threads placeable at ${fmtRam(smallest)} each ` +
          `(largest single-host gap holds ${pool.maxContiguousThreadsFor(smallest)}). ` +
          `Free RAM or buy more`,
        m,
      };
    }

    const W = ns.getWeakenTime(host);
    log(
      `cycle ${padL(cycle, 2)}  ${plan.mode}  ->  ` +
        `G ${padL(plan.grow, 5)}t  W ${padL(plan.weaken, 5)}t  ` +
        `(${fmtRam(plan.grow * ram.grow + plan.weaken * ram.weaken)} of ` +
        `${fmtRam(pool.freeRam)})  eta ${fmtTime(W)}`,
    );

    const res = await runPrepWave(ns, host, pool, ram, plan, `${idPrefix}-${cycle}`, port, log);
    if (res.launched === 0) {
      return {
        ok: false,
        cycles: cycle - 1,
        reason: "nothing launched - run scripts/deploy.js and check hosts are rooted",
        m,
      };
    }

    const after = measure(ns, host);
    log(
      `         landed ${res.reports}/${res.launched} report(s), ${res.threads}t  ->  ` +
        `${fmtMoney(after.money)} (${((after.money / after.maxMoney) * 100).toFixed(1)}%), ` +
        `sec ${after.sec.toFixed(2)}`,
    );
    if (res.reports < res.launched) {
      // Harmless on its own - prep trusts the measurement above, not the port.
      // Near-always a second process reading the same port and consuming the
      // reports before we see them.
      log(
        `         WARN: ${res.launched - res.reports} report(s) never arrived - ` +
          `is something else reading port ${port}? ` +
          `(prep uses the measurement, not the reports, so this is cosmetic)`,
      );
    }
  }

  return { ok: false, cycles: maxCycles, reason: "hit max cycles", m: measure(ns, host) };
}
