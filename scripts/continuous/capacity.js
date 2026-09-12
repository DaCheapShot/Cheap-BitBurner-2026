import { ServerPool } from "scripts/continuous/lib/server";
import { coreMap, makeCoreBonus } from "scripts/continuous/lib/cores";
import { deployWorkers, describeDeploy } from "scripts/continuous/lib/deploy";
import { analyzeLandings, clear, collect } from "scripts/continuous/lib/report";
import {
  CADENCE_MS,
  CONT_REPORT_PORT,
  HOME_RESERVE_GB,
  NOMINAL_BATCH,
  OP_FILL_ORDER,
  OP_WORKER,
  RAM_SAFETY_FRACTION,
  SPACER_MS,
  WORKER_FILES,
  WORKER_RAM_FALLBACK,
} from "scripts/continuous/config";

/**
 * Phase 1 harness: prove the pool's RAM and core math against the live game.
 *
 * Launches nothing. Every reservation it makes is released before it returns,
 * so it is safe to run beside anything - including the shotgun manager, whose
 * RAM it will simply see as used.
 *
 * Prints:
 *   1. per-host RAM and cores
 *   2. pool totals, and the cores dividend - how much more grow/weaken work the
 *      pool can do than a core-blind count would claim
 *   3. batch profile and its RAM
 *   4. how many batches actually place, core-aware against core-blind
 *   5. cadence-implied in-flight depth for the richest reachable target
 *   6. a reserve/release round trip proving the ledger balances
 *
 * Usage:  run scripts/continuous/capacity.js
 *         run scripts/continuous/capacity.js --all
 *         run scripts/continuous/capacity.js --threads 25,2,60,5
 *         run scripts/continuous/capacity.js --target phantasy
 *         run scripts/continuous/capacity.js --selftest    (Phase 2 gate:
 *             deploys the workers, execs a few weakens by hand, and waits for
 *             their reports. This one DOES launch scripts - weakens only, which
 *             can only move a target toward prepped.)
 *
 * RAM cost (each verified against NetScriptDefinitions.d.ts):
 *   base                                    1.60
 *   lib/server.js  scan/maxRam/usedRam/root 0.35
 *   lib/cores.js   getServer                2.00
 *   lib/deploy.js  scp                      0.60
 *   lib/report.js  getPortHandle/sleep      0.00
 *   getScriptRam                            0.10
 *   weakenAnalyze                           1.00
 *   getWeakenTime                           0.05
 *   getServerMaxMoney                       0.10
 *   getServerRequiredHackingLevel           0.10
 *   getHackingLevel                         0.05
 *   exec                                    1.30
 *   ---------------------------------------------
 *                                          ~7.25 GB
 *
 * weakenAnalyze is 1 GB and buys exactly one thing: the measured core bonus.
 * That is deliberate - hardcoding 1 + (cores-1)/16 would be free and would be
 * wrong the first time a BitNode multiplier or an augmentation moved it.
 *
 * exec and scp are charged even on a plain capacity run, because Bitburner
 * prices every function REACHABLE through the imports, called or not. Paying
 * 1.9 GB on a hand-run diagnostic that lives on home is the cheaper trade
 * against maintaining a second entry point that duplicates the pool setup.
 */

// ---------------------------------------------------------------- format ----

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function fmtRam(gb) {
  if (gb >= 1024 * 1024) return `${(gb / 1024 / 1024).toFixed(2)}PB`;
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)}TB`;
  return `${gb.toFixed(2)}GB`;
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

/** Per-thread RAM for one batch op, via the worker it runs. */
const ramForOp = (ram, op) => ram[OP_WORKER[op]];

// ------------------------------------------------------------- placement ----

/**
 * Place one batch. Hack goes down as raw threads; the three boosted ops are
 * sized in EFFECTIVE threads and placed core-aware.
 *
 * @returns {{ops: object[][], failed: string|null, raw: object}}
 */
function placeBatch(pool, ram, threads, coreBonus, { coreAware = true } = {}) {
  const ops = [];
  const raw = {};

  for (const op of ["H", "W1", "G", "W2"]) {
    const rpt = ramForOp(ram, op);
    const order = coreAware ? OP_FILL_ORDER[op] : "ram";

    let placed;
    if (op === "H" || !coreAware) {
      // Hack gets no core bonus, so its demand IS its raw thread count. The
      // core-blind comparison run deliberately treats every op this way - that
      // is the whole point of the comparison.
      placed = pool.allocate(rpt, threads[op], { order });
      if (placed) raw[op] = threads[op];
    } else {
      const got = pool.allocateEffective(rpt, threads[op], coreBonus, { order });
      placed = got && got.placements;
      if (got) raw[op] = got.rawThreads;
    }

    if (!placed) {
      for (const done of ops) pool.release(done);
      return { ops: [], failed: op, raw: {} };
    }
    ops.push(placed);
  }

  return { ops, failed: null, raw };
}

/**
 * How many complete batches the pool can ACTUALLY hold, by placing them for
 * real until one fails.
 *
 * freeRam / batchRam overstates the answer: it treats the pool as one
 * contiguous block, and it isn't - every host floors its own thread count
 * independently. Simulating is the only honest answer and costs no ns calls.
 *
 * Leaves the pool exactly as it found it.
 */
function simulateStream(pool, ram, threads, coreBonus, cap, opts = {}) {
  let placed = 0;
  let failed = null;
  let firstRaw = null;

  while (placed < cap) {
    const batch = placeBatch(pool, ram, threads, coreBonus, opts);
    if (batch.failed) {
      failed = batch.failed;
      break;
    }
    if (firstRaw === null) firstRaw = batch.raw;
    placed++;
  }

  pool.releaseAll();
  return { placed, failed, firstRaw };
}

// ------------------------------------------------------------ target pick ----

/**
 * Richest host we could hack, for the cadence report only.
 *
 * Deliberately NOT the ranking the manager will use - real ranking needs
 * money/sec and hack chance, which cost analyze calls this harness has no other
 * use for. Phase 3 does that properly. All this needs is a plausible weaken
 * time to turn a cadence into an in-flight depth.
 */
function richestTarget(ns) {
  const level = ns.getHackingLevel();
  let best = null;

  for (const host of ServerPool.scanAll(ns)) {
    if (host === "home") continue;
    if (!ns.hasRootAccess(host)) continue;
    if (ns.getServerRequiredHackingLevel(host) > level) continue;
    const money = ns.getServerMaxMoney(host);
    if (money <= 0) continue;
    if (!best || money > best.maxMoney) best = { host, maxMoney: money };
  }
  return best;
}

/**
 * Cheapest target to weaken, for the selftest.
 *
 * Deliberately the FASTEST weaken rather than the richest: the selftest has to
 * wait out a whole weaken before it can report, and on a late-game target that
 * is minutes of staring at nothing.
 */
function fastestTarget(ns) {
  const level = ns.getHackingLevel();
  let best = null;

  for (const host of ServerPool.scanAll(ns)) {
    if (host === "home") continue;
    if (!ns.hasRootAccess(host)) continue;
    if (ns.getServerRequiredHackingLevel(host) > level) continue;
    if (ns.getServerMaxMoney(host) <= 0) continue;
    const w = ns.getWeakenTime(host);
    if (!best || w < best.weakenTime) best = { host, weakenTime: w };
  }
  return best;
}

// ------------------------------------------------------------- selftest -----

/**
 * Phase 2 gate: deploy the workers, exec a few by hand, and prove the reports
 * come back.
 *
 * Weaken ONLY, and on purpose. It is the one op with no downside to fire
 * unpaired: it moves the target toward prepped and can never lose money, while
 * a lone hack drains a server nothing is going to grow back. Whether hack.js
 * and grow.js are themselves sound is answered by getScriptRam - a missing or
 * unparseable script reads 0 - which the report prints alongside.
 *
 * The batch id carries the host (`st<n>:<host>`), because the report shape has
 * no host field. That is not an oversight in the workers: a per-thread script
 * must not spend bytes on anything the manager can already derive, and the
 * manager always knows where it placed a job.
 */
async function selftest(ns, pool, ram, out) {
  const runId = Date.now() % 100000;

  out("=== SELFTEST (Phase 2: workers, deploy, port) ===============================");

  // -- worker files ---------------------------------------------------------

  out("");
  out("--- worker files on home ---");
  let filesOk = true;
  for (const [op, file] of Object.entries(WORKER_FILES)) {
    const got = ns.getScriptRam(file, "home");
    const want = WORKER_RAM_FALLBACK[op];
    const ok = got > 0;
    if (!ok) filesOk = false;
    out(
      `  ${pad(op, 8)}${pad(file, 34)}${ok ? `${got.toFixed(2)}GB/thread` : "MISSING or unparseable (0GB)"}` +
        (ok && Math.abs(got - want) > 0.001 ? `   [expected ${want.toFixed(2)} - update WORKER_RAM_FALLBACK]` : ""),
    );
  }
  if (!filesOk) {
    out("");
    out("ABORT: a worker reads 0GB on home. Either the filesync extension has not pushed");
    out("scripts/continuous/ (it fails silently), or the file has a syntax error.");
    return;
  }

  // -- deploy ---------------------------------------------------------------

  const hosts = pool.servers.map((s) => s.hostname);
  const deployed = deployWorkers(ns, hosts);
  out("");
  out("--- deploy ---");
  out(`  scp'd the workers to ${deployed.copied}/${hosts.length - deployed.skipped} host(s)`);
  const complaint = describeDeploy(deployed, hosts.length);
  if (complaint) out("  " + complaint.split("\n").join("\n  "));

  // -- pick a target and some hosts -----------------------------------------

  const target = fastestTarget(ns);
  if (!target) {
    out("");
    out("ABORT: no rooted, money-bearing host within your hacking level to weaken.");
    return;
  }

  // Spread across as many hosts as possible, home LAST. The single most
  // valuable thing this test can prove is that a worker runs somewhere other
  // than home - that is the exact failure mode where exec returns a bare 0 and
  // the log blames a busy pool.
  const usable = pool
    .hostsBy("ram")
    .filter((s) => s.threadsFor(ram.weaken) >= 1)
    .sort((a, b) => (a.hostname === "home" ? 1 : b.hostname === "home" ? -1 : 0));

  const picked = usable.slice(0, 4);
  if (picked.length === 0) {
    out("");
    out(`ABORT: no host has ${ram.weaken}GB free for a single weaken thread.`);
    return;
  }

  const offHome = picked.filter((s) => s.hostname !== "home").length;

  // -- launch ---------------------------------------------------------------

  const W = ns.getWeakenTime(target.host);

  // Land everything at one instant, far enough out that the last exec still has
  // a non-negative delay to work with.
  const LAUNCH_PAD_MS = 1000;
  const land = Date.now() + W + LAUNCH_PAD_MS;

  clear(ns, CONT_REPORT_PORT);

  out("");
  out("--- launch ---");
  out(`  target ${target.host}, weaken ${fmtTime(W)}, all landing together in ${fmtTime(W + LAUNCH_PAD_MS)}`);

  const launched = [];
  for (const s of picked) {
    const placement = pool.allocate(ram.weaken, 1, { order: "ram" });
    if (!placement) continue;

    const batch = `st${runId}:${s.hostname}`;

    // The delay is recomputed HERE, at this worker's own exec, not once for the
    // group. A dispatch spans real wall time, and a delay computed up front is
    // correct only for the first worker out of the door.
    const delay = Math.max(0, land - Date.now() - W);
    const pid = ns.exec(
      WORKER_FILES.weaken, s.hostname, 1,
      target.host, delay, batch, CONT_REPORT_PORT, land, "W1", 1,
    );

    if (pid === 0) {
      // scp said yes and exec still said no: a per-host refusal, NOT a deploy
      // problem. Naming the wrong one of those is what cost the shotgun two
      // live runs.
      out(
        `  ${pad(s.hostname, 20)} exec returned 0 - refused. ` +
          `asked ${ram.weaken}GB, pool believed ${s.freeRam.toFixed(2)}GB free` +
          (deployed.failed.includes(s.hostname) ? " (and scp had failed here)" : " (scp succeeded here)"),
      );
      pool.release(placement);
      continue;
    }

    pool.commit(placement);
    launched.push({ host: s.hostname, batch, pid, delay });
    out(`  ${pad(s.hostname, 20)} pid ${padL(pid, 6)}  delay ${padL(delay.toFixed(0), 7)}ms  cores ${s.cores}`);
  }

  if (launched.length === 0) {
    out("");
    out("ABORT: nothing launched.");
    return;
  }

  // -- collect --------------------------------------------------------------

  const REPORT_GRACE_MS = 10000;
  const { byBatch, got, sawFull } = await collect(
    ns, CONT_REPORT_PORT, launched.length, land + REPORT_GRACE_MS,
  );

  out("");
  out("--- landings ---");
  out(pad("  HOST", 22) + padL("PLANNED", 15) + padL("ACTUAL", 15) + padL("DRIFT", 9) + padL("SEC", 9));

  const all = [];
  for (const l of launched) {
    const reports = byBatch.get(l.batch) ?? [];
    if (reports.length === 0) {
      out(pad("  " + l.host, 22) + padL("-", 15) + padL("NO REPORT", 15) + padL("-", 9) + padL("-", 9));
      continue;
    }
    for (const r of reports) {
      all.push(r);
      out(
        pad("  " + l.host, 22) +
          padL(String(Number(r.p) % 1e7), 15) +
          padL(String(Number(r.a) % 1e7), 15) +
          padL(`${(Number(r.a) - Number(r.p)).toFixed(0)}ms`, 9) +
          padL(Number(r.r).toFixed(4), 9),
      );
    }
  }

  const stats = analyzeLandings(all);

  out("");
  out(`  reports: ${got}/${launched.length}` + (sawFull ? "   WARN: port hit capacity - oldest entries were DISCARDED" : ""));
  if (stats.n > 0) {
    out(`  lateness (mean drift): ${stats.lateness.toFixed(0)}ms   jitter (spread): ${stats.jitter.toFixed(0)}ms`);
    out(
      `  jitter is the number that matters - a common lateness cannot reorder ops, ` +
        `a spread can. Spacer is ${SPACER_MS}ms.`,
    );
  }

  // -- verdict --------------------------------------------------------------

  out("");
  out("--- verdict ---");
  const checks = [
    [got === launched.length, `every worker reported (${got}/${launched.length})`],
    [offHome > 0 && launched.some((l) => l.host !== "home"), `a worker ran OFF home (${offHome} non-home host(s) picked)`],
    [
      launched.filter((l) => l.host !== "home").every((l) => (byBatch.get(l.batch) ?? []).length > 0),
      "every non-home worker reported - imports and deploy are sound",
    ],
    [stats.n > 0 && stats.jitter < SPACER_MS, `jitter ${stats.jitter.toFixed(0)}ms is under the ${SPACER_MS}ms spacer`],
    [!sawFull, "the port never filled"],
  ];
  for (const [ok, text] of checks) out(`  ${ok ? "PASS" : "FAIL"}  ${text}`);

  if (checks.every(([ok]) => ok)) {
    out("");
    out("Phase 2 gate met: workers deploy, exec off home, and report on the port.");
  }
}

// ----------------------------------------------------------------- main -----

/** @param {NS} ns */
export async function main(ns) {
  const args = ns.args.map(String);
  const showAll = args.includes("--all");

  const tIdx = args.indexOf("--target");
  const forcedTarget = tIdx >= 0 ? args[tIdx + 1] : null;

  const threads = { ...NOMINAL_BATCH };
  const thIdx = args.indexOf("--threads");
  if (thIdx >= 0) {
    const parts = String(args[thIdx + 1] ?? "").split(",").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 1)) {
      ns.tprint(`ERROR: --threads wants four positive numbers, "h,w1,g,w2" - got "${args[thIdx + 1]}"`);
      return;
    }
    [threads.H, threads.W1, threads.G, threads.W2] = parts;
  }

  const ram = workerRam(ns);

  // Cores first: the pool is built with them, so every placement decision below
  // is core-aware from the start.
  const hosts = ServerPool.scanAll(ns);
  const cores = coreMap(ns, hosts);
  const coreBonus = makeCoreBonus((t, c) => ns.weakenAnalyze(t, c));

  const pool = ServerPool.build(ns, {
    homeReserve: HOME_RESERVE_GB,
    cores,
  });

  const lines = [];
  const out = (s = "") => lines.push(s);
  out("");

  if (args.includes("--selftest")) {
    await selftest(ns, pool, ram, out);
    out("");
    ns.tprint(lines.join("\n"));
    return;
  }

  // -- 1. per-host ----------------------------------------------------------

  out("");
  out("=== RAM POOL ===============================================================");
  out(
    pad("HOST", 20) + padL("CORES", 6) + padL("BONUS", 8) + padL("MAX", 11) +
      padL("USED", 11) + padL("RSV", 8) + padL("FREE", 11) + padL(`t@${ram.weaken}`, 8),
  );

  const shown = showAll ? pool.servers : pool.servers.filter((s) => s.maxRam > 0);
  for (const s of shown) {
    out(
      pad(s.hostname, 20) +
        padL(s.cores, 6) +
        padL(`x${coreBonus(s.cores).toFixed(3)}`, 8) +
        padL(fmtRam(s.maxRam), 11) +
        padL(fmtRam(s.usedRam), 11) +
        padL(s.staticReserve ? fmtRam(s.staticReserve) : "-", 8) +
        padL(fmtRam(s.freeRam), 11) +
        padL(s.threadsFor(ram.weaken), 8),
    );
  }

  out("-".repeat(83));
  out(
    pad(`TOTAL (${pool.servers.length} hosts)`, 20) +
      padL("", 6) + padL("", 8) +
      padL(fmtRam(pool.totalRam), 11) +
      padL("", 11) +
      padL(fmtRam(HOME_RESERVE_GB), 8) +
      padL(fmtRam(pool.freeRam), 11) +
      padL(pool.maxThreadsFor(ram.weaken), 8),
  );

  // -- 2. pool totals and the cores dividend --------------------------------

  const rawWeaken = pool.maxThreadsFor(ram.weaken);
  const effWeaken = pool.maxEffectiveThreadsFor(ram.weaken, coreBonus);
  const dividend = rawWeaken > 0 ? effWeaken / rawWeaken : 1;

  out("");
  out(
    `usable (max - reserves): ${fmtRam(pool.usableRam)}   ` +
      `largest single host: ${fmtRam(Math.max(0, ...pool.servers.map((s) => s.freeRam)))} free`,
  );
  if (RAM_SAFETY_FRACTION !== 1) {
    out(
      `RAM_SAFETY_FRACTION ${RAM_SAFETY_FRACTION} withholds ` +
        `${fmtRam(pool.totalRam * (1 - RAM_SAFETY_FRACTION))} across the pool`,
    );
  }
  out(
    `worker RAM/thread: hack ${ram.hack}GB  grow ${ram.grow}GB  weaken ${ram.weaken}GB` +
      (ram.estimated ? "   [ESTIMATED - workers land in Phase 2]" : ""),
  );

  const coreHosts = pool.servers.filter((s) => s.cores > 1).length;
  out("");
  out("--- cores dividend (grow and weaken only; hack gets no bonus) ---");
  out(
    `${coreHosts} of ${pool.servers.length} hosts have >1 core, best ` +
      `${Math.max(1, ...pool.servers.map((s) => s.cores))} cores ` +
      `(x${coreBonus(Math.max(1, ...pool.servers.map((s) => s.cores))).toFixed(3)})`,
  );
  out(
    `weaken capacity: ${rawWeaken} raw threads -> ${effWeaken.toFixed(0)} effective ` +
      `(x${dividend.toFixed(4)})`,
  );
  if (dividend > 1.0001) {
    out(
      `  ie. the pool does the grow/weaken work of a ${fmtRam(pool.freeRam * dividend)} ` +
        `single-core pool - ${fmtRam(pool.freeRam * (dividend - 1))} of free capacity a ` +
        `core-blind batcher never sees`,
    );
  } else {
    out("  every host is single-core here, so core-aware placement changes nothing yet");
  }

  // -- 3. batch profile -----------------------------------------------------

  const batchRam =
    threads.H * ram.hack +
    threads.G * ram.grow +
    (threads.W1 + threads.W2) * ram.weaken;

  out("");
  out("=== BATCH PROFILE ==========================================================");
  out(
    thIdx >= 0
      ? "from --threads"
      : "NOMINAL_BATCH from config.js - a stand-in until Phase 3 computes real thread counts",
  );
  out(
    `  H ${padL(threads.H, 5)}t raw        ${fmtRam(threads.H * ram.hack)}` +
      `   (no core bonus, filled ${OP_FILL_ORDER.H})`,
  );
  for (const op of ["W1", "G", "W2"]) {
    out(
      `  ${pad(op, 2)}${padL(threads[op], 5)}t effective  ` +
        `${fmtRam(threads[op] * ramForOp(ram, op))} at 1 core` +
        `   (filled ${OP_FILL_ORDER[op]})`,
    );
  }
  out(`  = ${fmtRam(batchRam)} per batch if every thread landed on a 1-core host`);

  // -- 4. how many batches place --------------------------------------------

  // Cap the simulation: a pool that can seat thousands of batches tells us
  // nothing more than one that seats hundreds, and each simulated batch is real
  // reserve/release work.
  const SIM_CAP = 2000;

  const aware = simulateStream(pool, ram, threads, coreBonus, SIM_CAP, { coreAware: true });
  const blind = simulateStream(pool, ram, threads, coreBonus, SIM_CAP, { coreAware: false });
  const naive = Math.floor(pool.freeRam / batchRam);

  out("");
  out("=== CAPACITY ===============================================================");
  out(`RAM, naive:        ${naive} batches  (free / batchRam - assumes one contiguous block)`);
  out(
    `placed, core-blind:${padL(blind.placed, 5)} batches` +
      (blind.failed ? `   (ran out on ${blind.failed})` : ""),
  );
  out(
    `placed, core-aware:${padL(aware.placed, 5)} batches` +
      (aware.failed ? `   (ran out on ${aware.failed})` : ""),
  );

  if (aware.placed > blind.placed) {
    out(
      `  => cores buy ${aware.placed - blind.placed} extra concurrent batches ` +
        `(+${(((aware.placed - blind.placed) / Math.max(1, blind.placed)) * 100).toFixed(1)}%)`,
    );
  }
  if (aware.firstRaw) {
    out(
      `  first batch raw threads: H ${aware.firstRaw.H}  W1 ${aware.firstRaw.W1}  ` +
        `G ${aware.firstRaw.G}  W2 ${aware.firstRaw.W2}` +
        `   (vs ${threads.W1}/${threads.G}/${threads.W2} effective asked for)`,
    );
  }
  if (naive > aware.placed) {
    out(
      `  fragmentation costs ${naive - aware.placed} batch(es) - RAM exists but not in ` +
        `placeable shape`,
    );
  }
  if (aware.placed === 0) {
    out(
      `WARN: not one batch places. ${aware.failed} is the op that ran out; ` +
        `${fmtRam(pool.freeRam)} free against ${fmtRam(batchRam)} needed.`,
    );
  }

  // -- 5. cadence and in-flight depth ---------------------------------------

  const target = forcedTarget || richestTarget(ns)?.host || null;
  out("");
  out("=== STREAM SHAPE ===========================================================");
  if (!target) {
    out("No rooted, money-bearing host is within your hacking level - cannot size a stream.");
  } else {
    const W = ns.getWeakenTime(target);
    const byCadence = Math.max(1, Math.ceil(W / CADENCE_MS));
    const depth = Math.min(byCadence, aware.placed);

    out(`target (richest reachable): ${target}   weaken ${fmtTime(W)}`);
    out(`cadence ${CADENCE_MS}ms (spacer ${SPACER_MS}ms, floor 4x spacer = ${4 * SPACER_MS}ms)`);
    out(`in-flight depth: ${byCadence} batches by cadence, ${aware.placed} by RAM`);
    out(
      `=> STREAM = ${depth} concurrent batches, limited by ` +
        `${byCadence <= aware.placed ? "CADENCE" : "RAM"}`,
    );
    if (byCadence <= aware.placed) {
      out(
        `   RAM to spare: the stream is paced, not starved. A second target can run ` +
          `beside this one (Phase 5), or tighten CADENCE_MS toward its ${4 * SPACER_MS}ms floor.`,
      );
    } else {
      out(
        `   RAM-bound: ${byCadence - aware.placed} of the ${byCadence} cadence slots go ` +
          `unfilled. Widen CADENCE_MS to stop planning batches that cannot be placed.`,
      );
    }
  }

  // -- 6. ledger round trip -------------------------------------------------

  out("");
  out("--- ledger round trip (one batch) ---");
  const batch = placeBatch(pool, ram, threads, coreBonus);
  if (batch.failed) {
    out(`  could not place a batch: ${batch.failed} ran out of room`);
  } else {
    const names = ["H", "W1", "G", "W2"];
    batch.ops.forEach((placements, i) => {
      out(
        `  ${pad(names[i], 3)}${placements.map((p) => `${p.host}x${p.threads}` +
          (p.cores > 1 ? `(${p.cores}c)` : "")).join(" + ") || "(0 threads)"}`,
      );
    });
    out(`  pending after reserve: ${fmtRam(pool.pendingRam)}`);
    for (const placements of batch.ops) pool.release(placements);
    out(`  pending after release: ${fmtRam(pool.pendingRam)}   (must be 0.00GB)`);
  }

  // commit() is the half of the ledger this harness cannot honestly exercise:
  // it refreshes usedRam from the game and then drops the reservation, which is
  // only correct once a worker is actually running. With nothing exec'd, a
  // commit here would just hand the RAM straight back and look identical to a
  // release. tests/continuous.test.mjs covers it against a mock that moves
  // usedRam, and Phase 2 exercises it for real.
  out("  (commit() needs a running worker to mean anything - see the test suite)");

  out("");
  ns.tprint(lines.join("\n"));
}
