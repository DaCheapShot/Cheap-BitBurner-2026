import { ServerPool } from "./ram.js";
import {
  STEAL_FRACTION,
  SPACER_MS,
  BATCH_SPACING_MS,
  GROW_MARGIN,
  HACK_CONTIGUOUS,
  HOME_RESERVE_GB,
  WORKER_FILES,
  WORKER_RAM_FALLBACK,
} from "./config.js";

/**
 * Phase 1 harness: prove the Server/ServerPool RAM math against the live game.
 *
 * Prints:
 *   1. per-host RAM table
 *   2. pool totals
 *   3. auto-target scoring (top N)
 *   4. HWGW thread math + how many batches fit for the winning target
 *
 * Usage:  run scripts/capacity.js
 *         run scripts/capacity.js --target n00dles     (override auto-pick)
 *         run scripts/capacity.js --steal 0.02         (override STEAL_FRACTION)
 *         run scripts/capacity.js --all                (show every host, not just RAM-bearing)
 *
 * RAM cost of this script (all verified against the fork's markdown docs):
 *   base                             1.60
 *   ram.js imports (scan/max/used/root) 0.35
 *   getScriptRam                     0.10
 *   getServerMaxMoney                0.10
 *   getServerMoneyAvailable          0.10
 *   getServerSecurityLevel           0.10
 *   getServerMinSecurityLevel        0.10
 *   getServerRequiredHackingLevel    0.10
 *   getHackingLevel                  0.05
 *   getHackTime / getGrowTime / getWeakenTime  0.15
 *   hackAnalyze                      1.00
 *   hackAnalyzeSecurity              1.00
 *   growthAnalyze                    1.00
 *   growthAnalyzeSecurity            1.00
 *   weakenAnalyze                    1.00
 *   ------------------------------------
 *   ~7.75 GB
 * The five analyze functions are 1 GB EACH and dominate. The cloud probe lives
 * in scripts/cloudprobe.js so its extra 1.05 GB isn't charged here.
 */

// ---------------------------------------------------------------- config ----
// Tunables live in scripts/config.js so the harness, workers and manager can't
// drift apart. Only harness-specific settings stay here.

// Live steal fraction, overridable with --steal <fraction> so you can probe what
// the current network can actually seat without editing config.js.
let stealFraction = STEAL_FRACTION;

const TOP_N = 5; // how many scored targets to print

// ---------------------------------------------------------------- format ----

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function fmtRam(gb) {
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)}TB`;
  return `${gb.toFixed(2)}GB`;
}

function fmtMoney(m) {
  const units = [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]];
  for (const [div, suf] of units) {
    if (Math.abs(m) >= div) return `$${(m / div).toFixed(2)}${suf}`;
  }
  return `$${m.toFixed(0)}`;
}

function fmtTime(ms) {
  if (ms >= 60000) return `${(ms / 60000).toFixed(2)}m`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ------------------------------------------------------------ worker ram ----

/** Real per-thread RAM if the worker exists, otherwise the expected value. */
function workerRam(ns) {
  const out = {};
  let anyMissing = false;
  for (const [op, file] of Object.entries(WORKER_FILES)) {
    const real = ns.getScriptRam(file, "home");
    if (real > 0) {
      out[op] = real;
    } else {
      out[op] = WORKER_RAM_FALLBACK[op];
      anyMissing = true;
    }
  }
  out.estimated = anyMissing;
  return out;
}

// --------------------------------------------------------- target picking ----

// Simulating a full 500+ batch volley for every candidate is wasted work when
// we only need to rank them. Anything above this is throughput-equivalent.
const MAX_SIM_BATCHES = 400;

/**
 * Fully evaluate one candidate: thread math, batch RAM, how many batches the
 * pool can ACTUALLY seat, and the resulting money per second.
 *
 * Returns null for hosts that can't be hacked at all.
 */
function evaluateTarget(ns, host, pool, ram, level) {
  const maxMoney = ns.getServerMaxMoney(host);
  if (maxMoney <= 0) return null;

  const reqLevel = ns.getServerRequiredHackingLevel(host);
  if (reqLevel > level) return null; // hackAnalyze returns 0 below this

  const money = ns.getServerMoneyAvailable(host);
  const sec = ns.getServerSecurityLevel(host);
  const minSec = ns.getServerMinSecurityLevel(host);
  const prepped = money >= maxMoney * 0.999 && sec <= minSec + 0.01;

  const base = { host, maxMoney, money, sec, minSec, reqLevel, prepped };

  const th = batchThreads(ns, host);
  if (th.error) return { ...base, error: th.error, fits: 0, moneyPerSec: 0 };

  const time = batchTiming(ns, host);
  const batchRam =
    th.hack * ram.hack + th.grow * ram.grow + (th.weaken1 + th.weaken2) * ram.weaken;

  const byWindow = Math.floor(time.windowMs / time.batchSpacing);
  const sim = simulateVolley(pool, ram, th, Math.min(byWindow, MAX_SIM_BATCHES));

  // The number that actually matters. A volley yields fits * hackAmount and
  // repeats every windowMs, so this is real throughput - not a paper ceiling.
  // A target that cannot seat a single batch scores zero however rich it is.
  const moneyPerSec = (sim.placed * th.hackAmount) / (time.windowMs / 1000);

  return {
    ...base,
    th, time, batchRam,
    fits: sim.placed,
    failedOp: sim.failed?.op ?? null,
    byWindow,
    moneyPerSec,
    // Secondary signal: how RAM-efficient the target is regardless of whether
    // the pool is big enough today. Useful for spotting a foodnstuff-style trap
    // (huge money, abysmal growth rate, absurd grow thread count).
    moneyPerGb: batchRam > 0 ? th.hackAmount / batchRam : 0,
  };
}

/**
 * Rank every rooted, money-bearing host by REAL throughput.
 *
 * The old score was maxMoney/weakenTime, which is a paper ceiling: it made
 * foodnstuff ($50m, but 0.0175% growth per thread => 634 grow threads => 1.08TB
 * per batch) outrank targets that actually fit in the pool and earn money.
 * Ranking on simulated placement instead makes an unaffordable target sort to
 * the bottom where it belongs.
 */
function scoreTargets(ns, pool, ram) {
  const level = ns.getHackingLevel();
  const out = [];

  for (const host of ServerPool.scanAll(ns)) {
    if (host === "home") continue;
    if (!ns.hasRootAccess(host)) continue;

    const ev = evaluateTarget(ns, host, pool, ram, level);
    if (ev) out.push(ev);
  }

  // Affordable targets first, then by throughput. Among equally unaffordable
  // ones, rank by RAM efficiency so the "prep this next" answer is visible.
  out.sort((a, b) => {
    if ((a.fits > 0) !== (b.fits > 0)) return a.fits > 0 ? -1 : 1;
    if (b.moneyPerSec !== a.moneyPerSec) return b.moneyPerSec - a.moneyPerSec;
    return b.moneyPerGb - a.moneyPerGb;
  });
  return out;
}

// ----------------------------------------------------------- batch math -----

/**
 * Thread counts for one HWGW batch against `host`.
 *
 * hack    : threads to take STEAL_FRACTION of MAX money
 * weaken1 : cancels exactly the security that hack added
 * grow    : refills what hack took (1/(1-f) multiplier, padded)
 * weaken2 : cancels exactly the security that grow added
 *
 * IMPORTANT: every analyze function here reads the server's CURRENT money and
 * security, not its prepped state. On an unprepped target growthAnalyze inflates
 * (high security => more threads) and hackAnalyze under-reports. Numbers are an
 * estimate until Phase 3 preps the target.
 */
function batchThreads(ns, host) {
  const maxMoney = ns.getServerMaxMoney(host);
  const hackAmount = maxMoney * stealFraction;

  // hackAnalyze gives the fraction of the server's TOTAL money one thread takes.
  // Deliberately not hackAnalyzeThreads: that one takes an absolute amount and
  // returns -1 whenever the amount exceeds the money CURRENTLY on the server, so
  // it fails on any unprepped target (n00dles at $70k of $1.75m max). The
  // fraction form has no such dependency.
  const perThread = ns.hackAnalyze(host);
  if (perThread <= 0) {
    return {
      error:
        `hackAnalyze("${host}") returned ${perThread} - hacking level too low, ` +
        `or no root access.`,
    };
  }

  const hack = Math.max(1, Math.ceil(stealFraction / perThread));

  // weakenAnalyze(1) is the security drop of a single weaken thread. Asking the
  // game beats hardcoding 0.05 - it moves with cores and BitNode multipliers.
  const weakenPerThread = ns.weakenAnalyze(1);
  if (weakenPerThread <= 0) return { error: "weakenAnalyze(1) returned <= 0" };

  // No host argument on either security function - this is load-bearing.
  //
  // With a host, both cap their result by the threads needed to reach max money.
  // A PREPPED target sits AT max money, so growthAnalyzeSecurity(g, host)
  // returns ~0 and weaken2 gets sized at 1 thread instead of the ~51 needed.
  // The uncancelled security then compounds batch over batch and drifts the
  // target off baseline within a few volleys.
  //
  // The cap is also just wrong for our case: by the time grow lands, hack has
  // already removed STEAL_FRACTION of the money, so the server is NOT at max and
  // those grow threads really do all fire and really do all add security.
  const secFromHack = ns.hackAnalyzeSecurity(hack);
  const weaken1 = Math.max(1, Math.ceil(secFromHack / weakenPerThread));

  // Refill multiplier: taking fraction f leaves (1-f), so we need 1/(1-f)x back.
  const growMult = 1 / (1 - stealFraction);
  const grow = Math.max(1, Math.ceil(ns.growthAnalyze(host, growMult) * GROW_MARGIN));

  const secFromGrow = ns.growthAnalyzeSecurity(grow);
  const weaken2 = Math.max(1, Math.ceil(secFromGrow / weakenPerThread));

  return {
    hack, weaken1, grow, weaken2,
    hackAmount, weakenPerThread, secFromHack, secFromGrow, growMult, perThread,
  };
}

/**
 * Landing schedule, anchored on weaken time (the longest of the three).
 *
 * Landings, in required order, spaced by SPACER_MS:
 *   hack    at  W - s
 *   weaken1 at  W
 *   grow    at  W + s
 *   weaken2 at  W + 2s
 *
 * All four workers are exec'd at the SAME instant. Nothing sleeps between
 * launches. The separation lives inside each op as additionalMsec:
 *
 *   additionalMsec = (that op's landing time) - (that op's own runtime)
 *
 * weaken1's is 0 by construction, which makes it the volley's clock. The others
 * are all non-negative because hack and grow are shorter than weaken.
 *
 * The same trick stacks across a volley: batch k adds k * 4 * spacer to all four
 * values, so an entire volley fires as one burst of execs with zero sleeps.
 */
function batchTiming(ns, host) {
  const W = ns.getWeakenTime(host);
  const H = ns.getHackTime(host);
  const G = ns.getGrowTime(host);
  const s = SPACER_MS;

  return {
    hackTime: H, growTime: G, weakenTime: W, spacer: s,
    land: { hack: W - s, weaken1: W, grow: W + s, weaken2: W + 2 * s },
    // Passed straight to the worker as its `delay` argument.
    additionalMsec: { hack: W - s - H, weaken1: 0, grow: W + s - G, weaken2: 2 * s },
    // Independent of the spacer - see BATCH_SPACING_MS in config.js. Clamped to
    // the 4*spacer floor, below which adjacent batches' ops interleave.
    batchSpacing: Math.max(BATCH_SPACING_MS, 4 * s),
    // The volley window is one weaken time: that's how long before the first
    // batch's RAM comes back.
    windowMs: W,
  };
}

/**
 * How many complete batches the pool can ACTUALLY hold, by placing them for
 * real until one fails.
 *
 * freeRam / batchRam overstates: it treats the pool as one contiguous block.
 * It isn't - every host floors its own thread count independently. And when
 * hack is placed contiguously it must ALSO fit entirely on one machine, so a
 * pool with plenty of total RAM spread thinly across small hosts can fail to
 * seat a single batch. Simulating is the only honest answer, and it costs no
 * extra ns calls.
 *
 * Also reports WHICH op ran out of room first. "Not enough RAM" is not a useful
 * diagnosis when hack seats fine and it's a 351-thread grow that doesn't.
 *
 * Leaves the pool exactly as it found it.
 *
 * @param {boolean} [contiguous=HACK_CONTIGUOUS] pin hack to one host. Passed
 *        explicitly so the report can price both answers side by side.
 */
function simulateVolley(pool, ram, th, cap, contiguous = HACK_CONTIGUOUS) {
  let placed = 0;
  let failed = null;

  const slots = [
    { op: "H", rpt: ram.hack, threads: th.hack, opts: { contiguous } },
    { op: "W1", rpt: ram.weaken, threads: th.weaken1, opts: {} },
    { op: "G", rpt: ram.grow, threads: th.grow, opts: {} },
    { op: "W2", rpt: ram.weaken, threads: th.weaken2, opts: {} },
  ];

  outer: while (placed < cap) {
    const ops = [];
    for (const slot of slots) {
      const p = pool.allocate(slot.rpt, slot.threads, slot.opts);
      if (!p) {
        // Partial batch is useless - hand back whatever this attempt reserved.
        for (const done of ops) pool.release(done);
        if (failed === null) failed = { ...slot, atBatch: placed };
        break outer;
      }
      ops.push(p);
    }
    placed++;
  }

  pool.releaseAll();
  return { placed, failed };
}

/**
 * Largest steal fraction (to 4 decimal places) whose hack thread count still
 * fits on one host.
 *
 * Naively printing maxHack * perThread is wrong: toFixed rounds to NEAREST, so
 * 14 * 0.004125 = 0.05775 prints as 0.0578, and ceil(0.0578 / 0.004125) is 15
 * threads - one more than fits. Truncate instead, then verify the rounded value
 * actually round-trips to <= maxHack threads, stepping down if it doesn't.
 */
function suggestSteal(maxHack, perThread) {
  if (maxHack <= 0 || perThread <= 0) return null;
  let ticks = Math.floor(maxHack * perThread * 1e4); // 4dp, rounded DOWN
  while (ticks > 0 && Math.ceil(ticks / 1e4 / perThread) > maxHack) ticks--;
  return ticks > 0 ? (ticks / 1e4).toFixed(4) : null;
}

// ----------------------------------------------------------------- main -----

/** @param {NS} ns */
export async function main(ns) {
  const args = ns.args.map(String);
  const showAll = args.includes("--all");
  const tIdx = args.indexOf("--target");
  const forcedTarget = tIdx >= 0 ? args[tIdx + 1] : null;

  const sIdx = args.indexOf("--steal");
  if (sIdx >= 0) {
    const v = Number(args[sIdx + 1]);
    if (!Number.isFinite(v) || v <= 0 || v >= 1) {
      ns.tprint(`ERROR: --steal needs a fraction in (0,1), got "${args[sIdx + 1]}"`);
      return;
    }
    stealFraction = v;
  }

  const ram = workerRam(ns);
  const pool = ServerPool.build(ns, { homeReserve: HOME_RESERVE_GB });

  const lines = [];
  lines.push("");
  lines.push("=== RAM POOL ===============================================================");
  lines.push(
    `${pad("HOST", 22)}${padL("MAX", 10)}${padL("USED", 10)}${padL("RSV", 8)}` +
      `${padL("FREE", 10)}${padL("t@1.75", 8)}`,
  );

  const shown = showAll ? pool.servers : pool.servers.filter((s) => s.maxRam > 0);
  for (const s of shown) {
    lines.push(
      pad(s.hostname, 22) +
        padL(fmtRam(s.maxRam), 10) +
        padL(fmtRam(s.usedRam), 10) +
        padL(s.staticReserve ? fmtRam(s.staticReserve) : "-", 8) +
        padL(fmtRam(s.freeRam), 10) +
        padL(s.threadsFor(ram.weaken), 8),
    );
  }

  lines.push("-".repeat(76));
  lines.push(
    `${pad(`TOTAL (${pool.servers.length} hosts)`, 22)}` +
      padL(fmtRam(pool.totalRam), 10) +
      padL("", 10) +
      padL(fmtRam(HOME_RESERVE_GB), 8) +
      padL(fmtRam(pool.freeRam), 10) +
      padL(pool.maxThreadsFor(ram.weaken), 8),
  );
  lines.push(
    `usable (max - reserves): ${fmtRam(pool.usableRam)}   ` +
      `largest single host: ${fmtRam(Math.max(0, ...pool.servers.map((s) => s.freeRam)))} free`,
  );

  // Warn loudly if the home reserve ate home entirely.
  const home = pool.get("home");
  if (home && home.usableRam <= 0) {
    lines.push(
      `WARN: HOME_RESERVE_GB (${HOME_RESERVE_GB}) >= home maxRam (${fmtRam(home.maxRam)}) ` +
        `- home contributes nothing. Lower the constant.`,
    );
  }

  lines.push("");
  lines.push(
    `worker RAM/thread: hack ${ram.hack}GB  grow ${ram.grow}GB  weaken ${ram.weaken}GB` +
      (ram.estimated ? "   [ESTIMATED - workers not written yet, Phase 2 will confirm]" : ""),
  );

  // -- targets ---------------------------------------------------------------

  const scored = scoreTargets(ns, pool, ram);
  lines.push("");
  lines.push("=== TARGETS (ranked by real throughput, not paper ceiling) ==================");
  if (scored.length === 0) {
    lines.push("No rooted, money-bearing server is within your hacking level.");
  } else {
    lines.push(
      `${pad("HOST", 20)}${padL("MAX $", 10)}${padL("PREP", 6)}${padL("H", 6)}` +
        `${padL("G", 7)}${padL("BATCH", 10)}${padL("FITS", 6)}${padL("$/SEC", 11)}` +
        `${padL("$/GB", 10)}`,
    );
    for (const t of scored.slice(0, TOP_N)) {
      if (t.error) {
        lines.push(pad(t.host, 20) + padL(fmtMoney(t.maxMoney), 10) + "  " + t.error);
        continue;
      }
      lines.push(
        pad(t.host, 20) +
          padL(fmtMoney(t.maxMoney), 10) +
          padL(t.prepped ? "yes" : "NO", 6) +
          padL(t.th.hack, 6) +
          padL(t.th.grow, 7) +
          padL(fmtRam(t.batchRam), 10) +
          padL(t.fits, 6) +
          padL(t.fits > 0 ? fmtMoney(t.moneyPerSec) : "-", 11) +
          padL(fmtMoney(t.moneyPerGb), 10),
      );
    }
    lines.push(`(scored ${scored.length} candidates at hacking level ${ns.getHackingLevel()})`);

    const affordable = scored.filter((t) => t.fits > 0).length;
    if (affordable === 0) {
      lines.push(
        `WARN: NO target can seat a single batch at ${(stealFraction * 100).toFixed(1)}% steal. ` +
          `Lower --steal, add RAM, or prep a target with better growth.`,
      );
    }

    // An unprepped target's thread math is an estimate, so its ranking is too.
    const unprepped = scored.filter((t) => !t.prepped && !t.error).length;
    if (unprepped > 0) {
      lines.push(
        `NOTE: ${unprepped} candidate(s) NOT prepped - their G counts are inflated by ` +
          `current security, so they rank worse than they really are. Prep, then re-run.`,
      );
    }
  }

  // -- batch math for the winner --------------------------------------------

  // Pick the best AFFORDABLE target. Falling back to scored[0] when nothing
  // fits keeps the detail section useful for diagnosing why.
  const best = scored.find((t) => t.fits > 0) ?? scored[0];
  const target = forcedTarget || best?.host || null;
  if (!target) {
    ns.tprint(lines.join("\n"));
    return;
  }

  const th = batchThreads(ns, target);
  lines.push("");
  lines.push(`=== BATCH MATH: ${target} ${"=".repeat(Math.max(0, 58 - target.length))}`);

  if (th.error) {
    lines.push(`ERROR: ${th.error}`);
    ns.tprint(lines.join("\n"));
    return;
  }

  const time = batchTiming(ns, target);
  const batchRam =
    th.hack * ram.hack + th.grow * ram.grow + (th.weaken1 + th.weaken2) * ram.weaken;
  const totalThreads = th.hack + th.weaken1 + th.grow + th.weaken2;

  const money = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  const sec = ns.getServerSecurityLevel(target);
  const minSec = ns.getServerMinSecurityLevel(target);
  const prepped = money >= maxMoney * 0.999 && sec <= minSec + 0.01;

  lines.push(
    `prep state: money ${fmtMoney(money)}/${fmtMoney(maxMoney)}  ` +
      `sec ${sec.toFixed(2)}/${minSec.toFixed(2)}  => ${prepped ? "PREPPED" : "NOT PREPPED"}`,
  );
  if (!prepped) {
    lines.push("  (thread math below is an estimate - analyze fns read CURRENT server state)");
  }

  lines.push("");
  lines.push(
    `steal fraction ${(stealFraction * 100).toFixed(1)}% = ${fmtMoney(th.hackAmount)} per batch`,
  );
  lines.push(
    `hack effect:   ${(th.perThread * 100).toFixed(4)}% of total money per thread`,
  );
  lines.push(`weaken effect: ${th.weakenPerThread.toFixed(4)} sec/thread`);
  lines.push(
    `  H ${padL(th.hack, 6)}t  -> ${(th.hack * th.perThread * 100).toFixed(2)}% taken, ` +
      `+${th.secFromHack.toFixed(3)} sec   ${fmtRam(th.hack * ram.hack)}`,
  );
  lines.push(
    `  W ${padL(th.weaken1, 6)}t  -> cancels hack           ${fmtRam(th.weaken1 * ram.weaken)}`,
  );
  lines.push(
    `  G ${padL(th.grow, 6)}t  -> x${th.growMult.toFixed(4)} (+${GROW_MARGIN}x margin), ` +
      `+${th.secFromGrow.toFixed(3)} sec  ${fmtRam(th.grow * ram.grow)}`,
  );
  lines.push(
    `  W ${padL(th.weaken2, 6)}t  -> cancels grow           ${fmtRam(th.weaken2 * ram.weaken)}`,
  );
  lines.push(`  = ${totalThreads} threads, ${fmtRam(batchRam)} per batch`);

  lines.push("");
  lines.push("--- timing (anchored on weaken) ---");
  lines.push(
    `hack ${fmtTime(time.hackTime)}   grow ${fmtTime(time.growTime)}   ` +
      `weaken ${fmtTime(time.weakenTime)}   spacer ${time.spacer}ms`,
  );
  lines.push(
    `landings:  H +${time.land.hack.toFixed(0)}ms  W +${time.land.weaken1.toFixed(0)}ms  ` +
      `G +${time.land.grow.toFixed(0)}ms  W +${time.land.weaken2.toFixed(0)}ms`,
  );
  lines.push(
    `additionalMsec (all four exec at once, no sleeps between them):`,
  );
  lines.push(
    `           H ${time.additionalMsec.hack.toFixed(0)}  W1 ${time.additionalMsec.weaken1.toFixed(0)}  ` +
      `G ${time.additionalMsec.grow.toFixed(0)}  W2 ${time.additionalMsec.weaken2.toFixed(0)}`,
  );
  const negative = Object.entries(time.additionalMsec).filter(([, v]) => v < 0);
  if (negative.length) {
    lines.push(
      `WARN: negative launch offset for ${negative.map(([k]) => k).join(", ")} - ` +
        `spacer too large for these times.`,
    );
  }

  // -- how many batches fit --------------------------------------------------

  const byWindow = Math.floor(time.windowMs / time.batchSpacing);
  const naiveByRam = Math.floor(pool.freeRam / batchRam); // ignores fragmentation
  const sim = simulateVolley(pool, ram, th, byWindow);
  const fits = sim.placed;

  // Price the other packing too. Hack contiguity is usually the binding
  // constraint, not total RAM, and the trade is worth seeing as a number:
  // splitting hack costs ~2.5% of a batch's take (config.js explains why) but
  // can multiply the batch count many times over.
  const simPinned = simulateVolley(pool, ram, th, byWindow, true);
  const simSplit = simulateVolley(pool, ram, th, byWindow, false);

  lines.push("");
  lines.push("--- volley capacity ---");
  lines.push(
    `window-limited: ${byWindow} batches  (${fmtTime(time.windowMs)} window / ` +
      `${time.batchSpacing}ms per batch)`,
  );
  lines.push(
    `RAM, naive:     ${naiveByRam} batches  (${fmtRam(pool.freeRam)} free / ` +
      `${fmtRam(batchRam)} - assumes one contiguous block)`,
  );
  lines.push(
    `RAM, actual:    ${fits} batches  (simulated placement, hack ` +
      `${HACK_CONTIGUOUS ? "pinned to one host" : "free to split"})`,
  );
  lines.push(
    `  hack pinned:  ${simPinned.placed} batches` +
      (HACK_CONTIGUOUS ? "   <- HACK_CONTIGUOUS = true, in use" : ""),
  );
  lines.push(
    `  hack split:   ${simSplit.placed} batches  (~2.5% less money per batch)` +
      (HACK_CONTIGUOUS ? "" : "   <- HACK_CONTIGUOUS = false, in use"),
  );
  if (simSplit.placed !== simPinned.placed) {
    // Compare on money, not batch count - more batches at a worse rate is only
    // a win if the extra batches outrun the per-batch loss.
    const pinnedYield = simPinned.placed * th.hackAmount;
    const splitYield = simSplit.placed * th.hackAmount * 0.975;
    const better = splitYield > pinnedYield ? "splitting" : "pinning";
    lines.push(
      `  => ${better} wins here: ${fmtMoney(Math.max(pinnedYield, splitYield))} vs ` +
        `${fmtMoney(Math.min(pinnedYield, splitYield))} per volley`,
    );
  }
  if (naiveByRam !== fits && byWindow > naiveByRam) {
    lines.push(
      `                fragmentation costs ${naiveByRam - fits} batch(es) - ` +
        `RAM exists but not in placeable shape`,
    );
  }
  lines.push(`=> VOLLEY = ${fits} batches, limited by ${fits < byWindow ? "RAM" : "window"}`);
  if (fits > 0) {
    lines.push(
      `   yield/volley ~${fmtMoney(fits * th.hackAmount)} over ${fmtTime(time.windowMs)} ` +
        `(~${fmtMoney((fits * th.hackAmount) / (time.windowMs / 1000))}/sec)`,
    );
    lines.push(`   RAM consumed ~${fmtRam(fits * batchRam)}`);
  }

  // Show where one batch would actually land, and prove reserve/release balances.
  lines.push("");
  lines.push("--- allocate() smoke test (one batch) ---");
  const hackPlace = pool.allocate(ram.hack, th.hack, { contiguous: HACK_CONTIGUOUS });
  const w1Place = pool.allocate(ram.weaken, th.weaken1);
  const growPlace = pool.allocate(ram.grow, th.grow);
  const w2Place = pool.allocate(ram.weaken, th.weaken2);

  const describe = (name, p) =>
    p === null
      ? `  ${name}: FAILED to place`
      : `  ${name}: ${p.map((x) => `${x.host}x${x.threads}`).join(" + ") || "(0 threads)"}`;

  lines.push(describe(HACK_CONTIGUOUS ? "H (pinned)" : "H (split ok)", hackPlace));
  lines.push(describe("W1", w1Place));
  lines.push(describe("G ", growPlace));
  lines.push(describe("W2", w2Place));
  lines.push(`  pool pending after reserve: ${fmtRam(pool.pendingRam)}`);

  pool.release(hackPlace);
  pool.release(w1Place);
  pool.release(growPlace);
  pool.release(w2Place);
  lines.push(`  pool pending after release: ${fmtRam(pool.pendingRam)} (should be 0.00GB)`);

  if (fits === 0 && sim.failed) {
    const f = sim.failed;
    lines.push("");
    lines.push("--- why zero ---");
    lines.push(
      `${f.op} could not be placed: ${f.threads} threads x ${fmtRam(f.rpt)} = ` +
        `${fmtRam(f.threads * f.rpt)} needed, ${fmtRam(pool.freeRam)} free in pool` +
        (f.opts.contiguous ? ` (and must fit on ONE host)` : ""),
    );

    if (f.op === "H") {
      // Hack is the contiguity-bound op: the fix is a smaller steal fraction.
      // Which ceiling applies depends on how hack is being placed - quoting the
      // single-host limit while splitting is allowed would understate it badly.
      const maxHack = HACK_CONTIGUOUS
        ? pool.maxContiguousThreadsFor(ram.hack)
        : pool.maxThreadsFor(ram.hack);
      lines.push(
        `largest ${HACK_CONTIGUOUS ? "contiguous" : "placeable"} hack: ${maxHack} threads = ` +
          `${(maxHack * th.perThread * 100).toFixed(2)}% steal ` +
          `(you asked for ${(stealFraction * 100).toFixed(1)}% = ${th.hack} threads)`,
      );
      const suggestion = suggestSteal(maxHack, th.perThread);
      if (suggestion === null) {
        lines.push(
          `no steal fraction works: not even 1 hack thread (${fmtRam(ram.hack)}) fits on ` +
            `any single host. Buy RAM.`,
        );
      } else {
        lines.push(
          `try: run scripts/capacity.js --steal ${suggestion}` +
            (forcedTarget ? ` --target ${target}` : ""),
        );
      }
    } else if ((f.op === "G" || f.op === "W2") && !prepped) {
      // Grow/weaken2 blowing up on an unprepped target is usually the security
      // level, not the steal fraction: growthAnalyze scales grow threads with
      // current security, so a target sitting above minimum inflates them.
      lines.push(
        `${target} is NOT prepped (sec ${sec.toFixed(2)} vs min ${minSec.toFixed(2)}) - ` +
          `growthAnalyze sizes grow threads at CURRENT security, so this count is ` +
          `inflated. Prep it (Phase 3) before reading this as the real batch cost.`,
      );
      lines.push(
        `a smaller --steal also shrinks grow proportionally, but prep is the real fix.`,
      );
    } else {
      lines.push(`lower --steal, or add RAM to the pool.`);
    }
  }

  lines.push("");
  ns.tprint(lines.join("\n"));
}
