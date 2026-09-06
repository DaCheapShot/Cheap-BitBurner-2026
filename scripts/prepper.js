import { ServerPool } from "./ram.js";
import {
  SPACER_MS,
  GROW_MARGIN,
  PREP_FANOUT,
  HOME_RESERVE_GB,
  REPORT_PORT,
  WORKER_FILES,
  WORKER_RAM_FALLBACK,
  MONEY_TOLERANCE,
  SEC_TOLERANCE,
} from "./config.js";

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
 *   ram.js 0.35 + exec 1.30 + getScriptRam 0.10 + fileExists 0.10
 *   + getServerRequiredHackingLevel 0.10 + getHackingLevel 0.05
 *   = 2.00 GB   (ports, sleep, print are 0; ALL target reads and thread math
 *   now come from the injected math module, which is what lets the two
 *   implementations stay separately priced)
 */

// Single source of truth: both math implementations and every consumer must
// agree on what "prepped" means, so the values live in config.js. Imported AND
// re-exported deliberately - a bare `export ... from` would forward the names to
// importers without binding them here. measure() used to read these directly
// and a bare re-export left them undefined at that call site, throwing at
// runtime; the bound form is kept even though both math modules' snapshot()
// now own that check, so the same class of bug can't come back if something
// here ever needs them again.
export { MONEY_TOLERANCE, SEC_TOLERANCE };

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

/**
 * Current state of a host.
 *
 * Delegates to the math module because the formulas implementation already
 * holds a getServer object with these fields, and paying 0.40 GB for four
 * getServer* calls to re-read them would cancel out the swap's RAM saving.
 */
export function measure(ns, host, math) {
  return math.snapshot(ns, host);
}

/** True if a measure() result is at max money AND minimum security. */
export const isPrepped = (m) => m.moneyOk && m.secOk;

/**
 * Every server we can actually hack, richest first.
 *
 * The hacking-level check is load-bearing, not a nicety. NUKE ignores hacking
 * level entirely - scripts/root.js roots every server whose ports it can open -
 * so "rooted" says nothing about whether hacking it will work. Picking the
 * richest rooted server would hand back something far above your level, where
 * hackAnalyze returns 0 and the manager exits immediately; a supervisor would
 * then restart it into the same failure forever.
 *
 * Returns the whole ranking rather than just the winner because prep fans out
 * across the next few candidates (PREP_FANOUT) with the RAM the primary's wave
 * cannot use. Same ns calls as picking one - the scan was already whole-network.
 */
export function rankTargets(ns, math) {
  const level = ns.getHackingLevel();
  const found = [];
  for (const host of ServerPool.scanAll(ns)) {
    if (host === "home" || !ns.hasRootAccess(host)) continue;
    const maxMoney = math.maxMoneyOf(ns, host);
    if (maxMoney <= 0) continue;
    if (ns.getServerRequiredHackingLevel(host) > level) continue;
    found.push({ host, maxMoney });
  }
  found.sort((a, b) => b.maxMoney - a.maxMoney);
  return found.map((f) => f.host);
}

/**
 * Richest server we can actually hack. Only used without an explicit target.
 *
 * Defined in terms of rankTargets so the manager's choice of primary and prep's
 * choice of extras can never disagree about the ordering.
 */
export function pickTarget(ns, math) {
  return rankTargets(ns, math)[0] ?? null;
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
export function sizeGrowWave(pool, ram, math, snap, growWanted, extraWeaken = 0) {
  let grow = Math.min(growWanted, pool.maxThreadsFor(ram.grow));
  const perWeaken = math.securityPerWeakenThread(snap);
  const perGrow = math.securityPerGrowThread(snap);

  while (grow > 0) {
    // extraWeaken covers security the server is ALREADY carrying, on top of
    // what this grow will add. Both are cancelled by the same weaken landing.
    const weaken = Math.max(1, Math.ceil((perGrow * grow) / perWeaken) + extraWeaken);

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
export function planPrepWave(pool, ram, math, snap) {
  // Threads needed purely to undo the security the server is already carrying.
  const excess = Math.max(0, snap.sec - snap.minSec);
  const perWeaken = math.securityPerWeakenThread(snap);
  const fixSec = excess > 0 ? Math.ceil(excess / perWeaken) : 0;

  if (snap.moneyOk) {
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
  // atSecurity is snap.sec because grow really does execute at the CURRENT
  // security - it lands before this wave's weaken. The formulas implementation
  // uses that argument; the analyze one ignores it and is approximate here.
  const wanted = Math.ceil(
    math.growThreadsToRestore(snap, snap.money, snap.maxMoney, snap.sec) * GROW_MARGIN,
  );
  const plan = sizeGrowWave(pool, ram, math, snap, wanted, fixSec);
  // When the drift alone needs more threads than the pool holds, grow is
  // squeezed out entirely and the wave is pure weaken - say so rather than
  // labelling a 0-thread grow as a grow.
  const mode =
    plan.grow === 0
      ? `weaken only (${excess.toFixed(2)} sec drift needs ${fixSec}t; no room left to grow)`
      : `grow (want ${wanted}t to reach max money)` +
        (fixSec > 0 ? ` + ${fixSec}t weaken for ${excess.toFixed(2)} sec drift` : "");
  return { ...plan, mode };
}

/**
 * Launch one wave. Does NOT wait for it, and does NOT release its RAM.
 *
 * All workers exec at the same instant; separation comes from additionalMsec,
 * never from sleeping between launches. Grow lands one spacer BEFORE weaken so
 * the weaken cancels the security the grow just added.
 *
 * Split from the waiting half so several waves can be in flight against one
 * drain loop. Two drains on one port cannot coexist: port.read() REMOVES the
 * message, so a loop that reads a report belonging to another wave destroys it
 * - which is exactly what the old single-wave version did to anything whose
 * batch id did not match. The caller launches every wave, then calls
 * awaitWaves once, then releases every placement.
 *
 * Placements are returned rather than released because they must stay reserved
 * while later waves are planned - that is what stops an extra target from
 * eating RAM the primary is about to use.
 *
 * times comes from the caller (math.opTimes(snap)), not a fresh ns.getWeakenTime
 * / ns.getGrowTime call here - those are exactly the two ns calls this module
 * is not allowed to make directly, since the formulas build must price them
 * through getServer instead of a dedicated 0.05GB-each ns call.
 *
 * @returns {{host: string, batch: string, launched: number, threads: number,
 *            placements: object[][], landAt: number}}
 */
export function launchPrepWave(ns, host, pool, ram, plan, batch, port, log, times) {
  const W = times.weaken;
  const G = times.grow;

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

  return { host, batch, launched, threads, placements, landAt };
}

/**
 * Drain the port until every wave has reported, or the deadline passes.
 *
 * ONE loop for ALL in-flight waves. A report is credited to its own batch id;
 * anything else is dropped, as before - but "anything else" now means no wave
 * is waiting on it, rather than merely "not the one wave this call knows".
 *
 * The deadline is the caller's, not max(landAt), and that is deliberate. Every
 * placement releases together when the cycle ends, so waiting for a slower
 * extra target would stretch the cycle of the primary - the one server we are
 * actually blocked on. The caller sets the deadline from the primary and lets
 * extras be best-effort.
 *
 * A lost report (full port, killed worker) must never wedge prep: the caller
 * re-measures regardless of what came back.
 *
 * @param {object[]} waves  launchPrepWave results
 * @returns {Promise<Map<string, number>>} batch id -> reports seen
 */
export async function awaitWaves(ns, port, waves, deadline) {
  const handle = ns.getPortHandle(port);
  const seen = new Map(waves.map((w) => [w.batch, 0]));
  const total = waves.reduce((n, w) => n + w.launched, 0);
  let got = 0;

  const drain = () => {
    while (!handle.empty()) {
      const msg = handle.read();
      if (typeof msg !== "object" || msg === null || !seen.has(msg.b)) continue;
      seen.set(msg.b, seen.get(msg.b) + 1);
      got++;
    }
  };

  while (got < total && Date.now() < deadline) {
    await ns.sleep(Math.min(500, Math.max(50, deadline - Date.now())));
    drain();
  }
  // The last workers can report between the final sleep and the deadline.
  drain();

  return seen;
}

/**
 * One wave, launched and waited on. The single-target path, kept so the
 * standalone CLI and anything else with exactly one wave reads the same as it
 * always did.
 *
 * @returns {{launched: number, reports: number, threads: number}}
 */
export async function runPrepWave(ns, host, pool, ram, plan, batch, port, log, times) {
  const wave = launchPrepWave(ns, host, pool, ram, plan, batch, port, log, times);
  const seen = await awaitWaves(ns, port, [wave], wave.landAt + REPORT_GRACE_MS);
  for (const p of wave.placements) pool.release(p);
  return { launched: wave.launched, reports: seen.get(batch) ?? 0, threads: wave.threads };
}

/**
 * Prep `host` until it is ready, fanning out to extra targets with the RAM the
 * primary's own wave cannot use.
 *
 * Re-measures every cycle rather than computing one plan up front. Same
 * self-correcting principle as the volley loop: hacking level and timings move,
 * and a wave that was right three minutes ago may not be now.
 *
 * The fan-out exists because a prep wave is sized by NEED and the manager blocks
 * on it. Growing past max money does nothing and weakening below minimum
 * security does nothing, so a single target cannot use more than a sliver of the
 * pool - a server carrying 50 excess security wants 1000 weaken threads, about
 * 1.75TB of a 3267TB pool - while the manager waits out a whole weaken window
 * earning nothing. The leftovers go to the next-best targets, so that when the
 * manager retargets, the server it moves to is already prepped.
 *
 * Ordering is what makes that safe: the primary is planned AND launched before
 * any extra is planned, so extras can only ever be sized against what is left.
 *
 * @param {NS} ns
 * @param {string} host            the target that must be prepped before this returns
 * @param {object} opts
 * @param {object} opts.math       injected math module (required) - the whole
 *                                 point of this file: no calib, no *Analyze
 * @param {object} [opts.ram]      per-thread worker RAM; computed if omitted
 * @param {number} [opts.port]     report port; defaults to REPORT_PORT
 * @param {number} [opts.maxCycles]
 * @param {string} [opts.idPrefix] batch id prefix, so a manager can tell prep
 *                                 waves apart from volley batches on the port
 * @param {() => ServerPool} [opts.buildPool] called once per cycle. Defaults to
 *        a fresh buildWorkerPool - pass your own if you already own a pool.
 * @param {() => string[]} [opts.extras] candidate extra targets, best first,
 *        re-evaluated every cycle. Defaults to none, which is plain single-host
 *        prep.
 * @param {number} [opts.fanout]   max extra targets per cycle; PREP_FANOUT
 * @param {boolean} [opts.verbose] print a line per extra wave and pool usage
 * @param {(s: string) => void} [opts.log]
 * @returns {Promise<{ok: boolean, cycles: number, reason: string, m: object}>}
 *          ok reflects the PRIMARY only - extras are best-effort and never
 *          decide the result
 */
export async function prepGroup(ns, host, opts = {}) {
  const {
    math,
    ram = workerRam(ns),
    port = REPORT_PORT,
    maxCycles = DEFAULT_MAX_CYCLES,
    idPrefix = "prep",
    buildPool = () => buildWorkerPool(ns),
    log = (s) => ns.print(s),
    extras = () => [],
    fanout = PREP_FANOUT,
    verbose = false,
  } = opts;

  if (!math) {
    return { ok: false, cycles: 0, reason: "no math implementation supplied", m: null };
  }

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    // Rebuild every cycle: hosts get rooted, RAM gets bought, other scripts
    // start and stop. A stale pool would over-commit.
    const pool = buildPool();
    const m = math.snapshot(ns, host);

    if (isPrepped(m)) {
      log(
        `PREPPED after ${cycle - 1} cycle(s): ${fmtMoney(m.money)}/${fmtMoney(m.maxMoney)}, ` +
          `sec ${m.sec.toFixed(2)}`,
      );
      return { ok: true, cycles: cycle - 1, reason: "prepped", m };
    }

    const plan = planPrepWave(pool, ram, math, m);

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

    // Op times come from the snapshot already taken above, not a fresh ns
    // call - see launchPrepWave for why getWeakenTime/getGrowTime cannot be
    // called directly here.
    const times = math.opTimes(m);
    const poolBefore = pool.freeRam;
    log(
      `cycle ${padL(cycle, 2)}  ${plan.mode}  ->  ` +
        `G ${padL(plan.grow, 5)}t  W ${padL(plan.weaken, 5)}t  ` +
        `(${fmtRam(plan.grow * ram.grow + plan.weaken * ram.weaken)} of ` +
        `${fmtRam(poolBefore)})  eta ${fmtTime(times.weaken)}`,
    );

    // The primary launches FIRST, so its RAM is reserved in the pool before any
    // extra is planned. Extras are then sized against leftovers only - that
    // ordering is the whole guarantee that fanning out cannot slow down the one
    // server we are actually blocked on.
    const waves = [
      launchPrepWave(ns, host, pool, ram, plan, `${idPrefix}-${cycle}`, port, log, times),
    ];

    if (waves[0].launched === 0) {
      for (const place of waves[0].placements) pool.release(place);
      return {
        ok: false,
        cycles: cycle - 1,
        reason: "nothing launched - run scripts/deploy.js and check hosts are rooted",
        m,
      };
    }

    // A prep wave is sized by NEED, not capacity: growing past max money and
    // weakening below minimum security both do nothing, so one target can never
    // use more than a sliver of the pool while the manager blocks on it for a
    // whole weaken window. Spend the rest getting the NEXT targets ready, so a
    // later retarget costs no stall.
    //
    // Safe in a way a speculative volley would not be: grow and weaken can only
    // move a server TOWARD prepped. There is no partial-failure mode that loses
    // money the way a batch that hacks but fails to grow does. The worst a
    // mis-sized extra can do is waste RAM and leave a server slightly dirty,
    // which that server's own next cycle re-measures and corrects.
    let n = 0;
    for (const other of extras()) {
      if (n >= fanout) break;
      if (other === host) continue;

      const om = math.snapshot(ns, other);
      if (isPrepped(om)) continue;

      // LOAD-BEARING. Every placement releases together at the end of the cycle,
      // so a wave with a longer window would hold the cycle open past the
      // primary's landing and make prepping the target we care about SLOWER.
      // The primary is the richest target and so usually the slowest, which is
      // why this rejects few candidates in practice.
      const otimes = math.opTimes(om);
      if (otimes.weaken > times.weaken) continue;

      // Planned against the pool as it now stands, with the primary's
      // placements already subtracted.
      const oplan = planPrepWave(pool, ram, math, om);
      // Zero threads means zero room, and every later candidate would be
      // planned against this same exhausted pool - stop rather than pay a
      // snapshot each to learn the same thing.
      if (oplan.grow === 0 && oplan.weaken === 0) break;

      const w = launchPrepWave(
        ns, other, pool, ram, oplan, `${idPrefix}x${n + 1}-${cycle}`, port, log, otimes,
      );
      if (w.launched === 0) {
        for (const place of w.placements) pool.release(place);
        continue;
      }
      n++;
      waves.push(w);
      if (verbose) {
        log(
          `         [v] also prepping ${other}: G ${padL(oplan.grow, 5)}t ` +
            `W ${padL(oplan.weaken, 5)}t  eta ${fmtTime(otimes.weaken)}  ${oplan.mode}`,
        );
      }
    }

    // Deadline comes from the PRIMARY, not the slowest wave. Extras are
    // best-effort and nothing waits on them.
    const seen = await awaitWaves(ns, port, waves, waves[0].landAt + REPORT_GRACE_MS);

    const used = waves.reduce(
      (gb, w) => gb + w.placements.reduce((a, place) => a + place.reduce((g, x) => g + x.gb, 0), 0),
      0,
    );
    for (const w of waves) for (const place of w.placements) pool.release(place);

    const launched = waves[0].launched;
    const reports = seen.get(waves[0].batch) ?? 0;

    const after = math.snapshot(ns, host);
    log(
      `         landed ${reports}/${launched} report(s), ${waves[0].threads}t  ->  ` +
        `${fmtMoney(after.money)} (${((after.money / after.maxMoney) * 100).toFixed(1)}%), ` +
        `sec ${after.sec.toFixed(2)}`,
    );
    if (verbose && waves.length > 1) {
      log(
        `         [v] pool: ${fmtRam(used)} of ${fmtRam(poolBefore)} ` +
          `(${((used / poolBefore) * 100).toFixed(1)}%) across ${waves.length} target(s), ` +
          `${n} extra alongside the primary`,
      );
    }
    if (reports < launched) {
      // Harmless on its own - prep trusts the measurement above, not the port.
      // Near-always a second process reading the same port and consuming the
      // reports before we see them.
      log(
        `         WARN: ${launched - reports} report(s) never arrived - ` +
          `is something else reading port ${port}? ` +
          `(prep uses the measurement, not the reports, so this is cosmetic)`,
      );
    }
  }

  return { ok: false, cycles: maxCycles, reason: "hit max cycles", m: math.snapshot(ns, host) };
}

/**
 * Prep ONE target, with no fan-out.
 *
 * What the standalone CLI wants: a lone prep.js has no manager waiting on it,
 * so there is no stall for extra targets to fill. The manager calls prepGroup
 * directly.
 */
export async function prep(ns, host, opts = {}) {
  return prepGroup(ns, host, { ...opts, extras: () => [] });
}

/**
 * CLI body shared by scripts/prep.js and scripts/prep-formulas.js.
 *
 * The two entry scripts are identical apart from which math module they inject
 * - the same shape managerCore.run() already shares between manager.js and
 * manager-formulas.js. Pulling the body out here stops the two prep CLIs
 * drifting apart the way they had.
 *
 * @param {NS} ns
 * @param {object} math injected math implementation
 */
export async function prepCli(ns, math) {
  ns.disableLog("ALL");
  ns.ui.openTail();

  const args = ns.args.map(String);
  const tIdx = args.indexOf("--target");
  const cIdx = args.indexOf("--max-cycles");
  const maxCycles = cIdx >= 0 ? Number(args[cIdx + 1]) : DEFAULT_MAX_CYCLES;

  const ready = math.prepare(ns);
  if (!ready.ok) {
    ns.tprint(`ERROR: ${ready.error}`);
    return;
  }

  const host = tIdx >= 0 ? args[tIdx + 1] : pickTarget(ns, math);
  if (!host) {
    ns.tprint("ERROR: no rooted, money-bearing target found. Pass --target <host>.");
    return;
  }

  // Drop anything stale so old batch ids can't be counted as this run's reports.
  // Safe here because this process owns the port; the manager clears its own.
  ns.getPortHandle(REPORT_PORT).clear();

  const start = measure(ns, host, math);
  ns.print(
    `prep ${host}: money ${fmtMoney(start.money)}/${fmtMoney(start.maxMoney)}  ` +
      `sec ${start.sec.toFixed(2)}/${start.minSec.toFixed(2)}`,
  );

  const res = await prep(ns, host, { math, maxCycles });

  if (res.ok) {
    ns.tprint(
      `SUCCESS: ${host} prepped in ${res.cycles} cycle(s) - ` +
        `${fmtMoney(res.m.money)} at security ${res.m.sec.toFixed(2)}`,
    );
  } else {
    ns.tprint(
      `WARN: ${host} not prepped after ${res.cycles} cycle(s) - ${res.reason}. ` +
        `${fmtMoney(res.m.money)}/${fmtMoney(res.m.maxMoney)}, ` +
        `sec ${res.m.sec.toFixed(2)}/${res.m.minSec.toFixed(2)}`,
    );
  }
}
