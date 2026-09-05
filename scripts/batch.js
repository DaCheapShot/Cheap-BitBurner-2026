import { ServerPool } from "./ram.js";
import {
  STEAL_FRACTION,
  SPACER_MS,
  GROW_MARGIN,
  HACK_CONTIGUOUS,
  HOME_RESERVE_GB,
  REPORT_PORT,
  WORKER_FILES,
  WORKER_RAM_FALLBACK,
  BATCH_OPS,
  OP_WORKER,
} from "./config.js";
import { loadCalibration, growThreadsFor } from "./calib.js";
import { analyzeBatch } from "./verify.js";

/**
 * Phase 4: fire exactly ONE HWGW batch and prove it lands in H, W, G, W order.
 *
 * This is the correctness gate for the whole batcher. If a single batch can't
 * land in order with small drift, a 500-batch volley certainly can't.
 *
 * Verifies four things and reports each:
 *   1. every op reported back
 *   2. actual landing ORDER is H, W1, G, W2, with every realised gap positive
 *   3. JITTER (spread of drift within the batch) stays under SPACER_MS. Note
 *      this is not absolute drift: the game's loop routinely lands a whole
 *      batch tens of ms late together, which shifts all four landings equally
 *      and cannot reorder anything. Only relative drift threatens order.
 *   4. the target is back at max money / min security afterwards - the batch
 *      left no residue, which is what makes batches repeatable
 *
 * FIRST CONSUMER OF THE CALIBRATION CACHE. It calls none of weakenAnalyze,
 * hackAnalyzeSecurity, growthAnalyzeSecurity or growthAnalyze - all four come
 * from /data/calib.json instead, which is why this costs 4.90 GB where the
 * equivalent live-analyze version would cost 8.90 GB. Run scripts/calibrate.js
 * first; this refuses to guess if the cache is missing or stale.
 *
 * Usage:  run scripts/batch.js --target joesguns
 *         run scripts/batch.js --target n00dles --steal 0.05
 *         run scripts/batch.js --target n00dles --force   (skip the prep check)
 *
 * RAM: 1.60 base + ram.js 0.35 + exec 1.30 + getScriptRam 0.10
 *      + getServerMaxMoney/MoneyAvailable/SecurityLevel/MinSecurityLevel 0.40
 *      + getWeakenTime/getHackTime/getGrowTime 0.15 + hackAnalyze 1.00
 *      = 4.90 GB   (calib.js, ports, sleep, print are all 0)
 */

/** Extra wait past the last expected landing before declaring a report lost. */
const REPORT_GRACE_MS = 5000;

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const fmtRam = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(2)}TB` : `${gb.toFixed(2)}GB`);

function fmtMoney(m) {
  for (const [div, suf] of [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]]) {
    if (Math.abs(m) >= div) return `$${(m / div).toFixed(2)}${suf}`;
  }
  return `$${(m ?? 0).toFixed(0)}`;
}

const fmtTime = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(2)}m` : `${(ms / 1000).toFixed(2)}s`);

function workerRam(ns) {
  const out = {};
  for (const [kind, file] of Object.entries(WORKER_FILES)) {
    const real = ns.getScriptRam(file, "home");
    out[kind] = real > 0 ? real : WORKER_RAM_FALLBACK[kind];
  }
  return out;
}

/**
 * Thread counts for one batch, entirely from the calibration cache plus a single
 * live hackAnalyze.
 *
 * hackAnalyze stays live deliberately - it moves with hacking level, and
 * reacting to that is the point of recomputing per batch.
 */
function planThreads(ns, host, calib, steal, sec) {
  const perThread = ns.hackAnalyze(host);
  if (!(perThread > 0)) {
    return { error: `hackAnalyze("${host}") returned ${perThread} - level too low or no root` };
  }
  const hack = Math.max(1, Math.ceil(steal / perThread));

  // Cached per-thread constants; see scripts/calibrate.js for why these are
  // safe to cache and why they were measured WITHOUT a host argument.
  const secFromHack = calib.hackSecPerThread * hack;
  const weaken1 = Math.max(1, Math.ceil(secFromHack / calib.weakenPerThread));

  const growMult = 1 / (1 - steal);
  const growRaw = growThreadsFor(calib, host, growMult, sec);
  if (growRaw === null) {
    return {
      error:
        `no usable growth base for ${host} at security ${sec.toFixed(2)}. ` +
        `Prep it to minimum security, then re-run scripts/calibrate.js.`,
    };
  }
  const grow = Math.max(1, Math.ceil(growRaw * GROW_MARGIN));

  const secFromGrow = calib.growSecPerThread * grow;
  const weaken2 = Math.max(1, Math.ceil(secFromGrow / calib.weakenPerThread));

  return { hack, weaken1, grow, weaken2, perThread, secFromHack, secFromGrow, growMult };
}

/**
 * Landing schedule. See scripts/capacity.js batchTiming for the full rationale:
 * all four exec at the same instant, additionalMsec does the spacing.
 */
function planTiming(ns, host) {
  const W = ns.getWeakenTime(host);
  const H = ns.getHackTime(host);
  const G = ns.getGrowTime(host);
  const s = SPACER_MS;

  return {
    W, H, G, s,
    // Offsets from launch, in required landing order.
    land: { H: W - s, W1: W, G: W + s, W2: W + 2 * s },
    delay: { H: W - s - H, W1: 0, G: W + s - G, W2: 2 * s },
  };
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();

  const args = ns.args.map(String);
  const tIdx = args.indexOf("--target");
  const target = tIdx >= 0 ? args[tIdx + 1] : null;
  const force = args.includes("--force");

  const sIdx = args.indexOf("--steal");
  let steal = STEAL_FRACTION;
  if (sIdx >= 0) {
    const v = Number(args[sIdx + 1]);
    if (!Number.isFinite(v) || v <= 0 || v >= 1) {
      ns.tprint(`ERROR: --steal needs a fraction in (0,1), got "${args[sIdx + 1]}"`);
      return;
    }
    steal = v;
  }

  if (!target) {
    ns.tprint("ERROR: pass --target <host>");
    return;
  }

  const calib = loadCalibration(ns);
  if (!calib) {
    ns.tprint("ERROR: /data/calib.json missing or invalid. Run scripts/calibrate.js first.");
    return;
  }

  // -- state check ----------------------------------------------------------

  const maxMoney = ns.getServerMaxMoney(target);
  const money0 = ns.getServerMoneyAvailable(target);
  const minSec = ns.getServerMinSecurityLevel(target);
  const sec0 = ns.getServerSecurityLevel(target);
  const prepped = money0 >= maxMoney * 0.999 && sec0 <= minSec + 0.01;

  ns.print(
    `${target}: ${fmtMoney(money0)}/${fmtMoney(maxMoney)}  sec ${sec0.toFixed(2)}/${minSec.toFixed(2)}` +
      `  => ${prepped ? "PREPPED" : "NOT PREPPED"}`,
  );

  if (!prepped && !force) {
    ns.tprint(
      `ERROR: ${target} is not prepped. Batch thread math is only valid at max money / ` +
        `min security. Run scripts/prep.js --target ${target} first, or pass --force.`,
    );
    return;
  }

  // -- plan -----------------------------------------------------------------

  const ram = workerRam(ns);
  const pool = ServerPool.build(ns, { homeReserve: HOME_RESERVE_GB });

  const th = planThreads(ns, target, calib, steal, sec0);
  if (th.error) {
    ns.tprint(`ERROR: ${th.error}`);
    return;
  }

  const t = planTiming(ns, target);
  const threadsFor = { H: th.hack, W1: th.weaken1, G: th.grow, W2: th.weaken2 };
  const batchRam =
    th.hack * ram.hack + th.grow * ram.grow + (th.weaken1 + th.weaken2) * ram.weaken;

  ns.print(
    `plan: H ${th.hack}t  W1 ${th.weaken1}t  G ${th.grow}t  W2 ${th.weaken2}t  = ${fmtRam(batchRam)}`,
  );
  ns.print(
    `times: hack ${fmtTime(t.H)}  grow ${fmtTime(t.G)}  weaken ${fmtTime(t.W)}  spacer ${t.s}ms`,
  );

  const negative = Object.entries(t.delay).filter(([, v]) => v < 0);
  if (negative.length) {
    ns.tprint(
      `ERROR: negative additionalMsec for ${negative.map(([k]) => k).join(", ")} - ` +
        `spacer ${t.s}ms is too large for these op times.`,
    );
    return;
  }

  // -- allocate -------------------------------------------------------------

  const placements = {};
  for (const op of BATCH_OPS) {
    const kind = OP_WORKER[op];
    // Only hack cares about contiguity, and only when HACK_CONTIGUOUS is set -
    // see config.js for why splitting it costs ~2.5% of the take but buys a far
    // larger volley. Grow and weaken are linear in threads, so splitting them
    // changes nothing.
    const p = pool.allocate(ram[kind], threadsFor[op], {
      contiguous: op === "H" && HACK_CONTIGUOUS,
    });
    if (!p) {
      for (const done of Object.values(placements)) pool.release(done);
      ns.tprint(
        `ERROR: could not place ${op} x${threadsFor[op]} ` +
          `(${fmtRam(threadsFor[op] * ram[kind])}) - ${fmtRam(pool.freeRam)} free. ` +
          `Lower --steal or add RAM.`,
      );
      return;
    }
    placements[op] = p;
  }

  // -- launch ---------------------------------------------------------------

  const batchId = `b${Date.now() % 1000000}`;
  const port = ns.getPortHandle(REPORT_PORT);
  port.clear(); // stale reports would be counted as ours

  const t0 = Date.now();
  const plannedLand = {};
  let launched = 0;

  for (const op of BATCH_OPS) {
    plannedLand[op] = t0 + t.land[op];
    const kind = OP_WORKER[op];
    for (const p of placements[op]) {
      const pid = ns.exec(
        WORKER_FILES[kind],
        p.host,
        p.threads,
        target,
        t.delay[op],
        batchId,
        REPORT_PORT,
        plannedLand[op],
        op,
        p.threads,
      );
      if (pid === 0) {
        ns.print(`ERROR: exec ${WORKER_FILES[kind]} on ${p.host} x${p.threads} returned 0`);
      } else {
        launched++;
      }
    }
  }

  if (launched === 0) {
    for (const p of Object.values(placements)) pool.release(p);
    ns.tprint("ERROR: nothing launched - run scripts/deploy.js first.");
    return;
  }

  ns.print(`launched ${launched} worker(s) as ${batchId}, last landing in ${fmtTime(t.land.W2)}`);

  // -- collect --------------------------------------------------------------

  const got = [];
  const deadline = t0 + t.land.W2 + REPORT_GRACE_MS;

  while (got.length < launched && Date.now() < deadline) {
    await ns.sleep(Math.min(500, Math.max(50, deadline - Date.now())));
    while (!port.empty()) {
      const msg = port.read();
      if (typeof msg === "object" && msg !== null && msg.b === batchId) got.push(msg);
    }
  }

  for (const p of Object.values(placements)) pool.release(p);

  // -- verify ---------------------------------------------------------------

  const out = [""];
  out.push(`=== BATCH ${batchId} on ${target} ===`);
  out.push(
    pad("OP", 5) + padL("THREADS", 9) + padL("DRIFT", 12) + padL("LANDED +", 12) + "  RESULT",
  );

  // All the landing math lives in verify.js so this and the manager judge a
  // batch identically. staleReports: a report with no r field predates workers
  // reporting their op's return value, so every RESULT cell below is unknowable.
  const a = analyzeBatch(got, BATCH_OPS);
  const { byActual, orderSeen, orderOk, lateness, jitter, gaps, gapsOk } = a;
  const staleReports = a.stale;

  for (const m of byActual) {
    const drift = m.a - m.p;
    const result =
      m.r === undefined
        ? "(no result field)"
        : m.op === "H"
          ? `stole ${fmtMoney(m.r)}`
          : m.op === "G"
            ? `x${Number(m.r).toFixed(4)}`
            : `-${Number(m.r).toFixed(3)} sec`;
    out.push(
      pad(m.op, 5) +
        padL(m.t, 9) +
        // Date.now() is sub-millisecond in this fork, so round - three decimal
        // places of jitter is noise, and an unrounded value overflows the column.
        padL(`${drift >= 0 ? "+" : ""}${drift.toFixed(1)}ms`, 12) +
        padL(`${Math.round(m.a - t0)}ms`, 12) +
        `  ${result}`,
    );
  }

  out.push("");
  out.push(`reports:  ${got.length}/${launched}${got.length < launched ? "  <- MISSING" : ""}`);
  out.push(`order:    ${orderSeen.join(" -> ") || "(none)"}   ${orderOk ? "OK" : "WRONG"}`);
  out.push(
    `gaps:     ${gaps.map((g) => `${g.from}->${g.to} ${g.ms.toFixed(1)}ms`).join("   ")}` +
      `   (planned ${t.s}ms each)`,
  );
  out.push(
    `lateness: ${lateness >= 0 ? "+" : ""}${lateness.toFixed(1)}ms mean - ` +
      `whole batch shifted together, does not affect ordering`,
  );
  out.push(
    `jitter:   ${jitter.toFixed(1)}ms spread against a ${t.s}ms spacer   ` +
      (jitter >= t.s ? "<- EXCEEDS SPACER, raise SPACER_MS" : "OK"),
  );
  if (staleReports) {
    out.push(
      `workers:  ${staleReports}/${got.length} report(s) carried no result field ` +
        `<- STALE WORKERS in game. The copies on your hosts predate the ones on disk, ` +
        `so nothing below can be trusted to reflect what the ops actually did. ` +
        `Sync scripts/ into the game, then run scripts/deploy.js and re-run this.`,
    );
  }

  const money1 = ns.getServerMoneyAvailable(target);
  const sec1 = ns.getServerSecurityLevel(target);
  const backToBaseline = money1 >= maxMoney * 0.999 && sec1 <= minSec + 0.01;
  out.push(
    `after:    ${fmtMoney(money1)}/${fmtMoney(maxMoney)}  sec ${sec1.toFixed(2)}/${minSec.toFixed(2)}` +
      `   ${backToBaseline ? "BASELINE RESTORED" : "<- DRIFTED, batch is not repeatable"}`,
  );

  // Ordering is judged on jitter and on the realised gaps, never on lateness.
  const timingOk =
    got.length === launched && orderOk && gapsOk && backToBaseline && jitter < t.s;
  out.push("");
  if (timingOk && staleReports) {
    // Deliberately not a PASS. The timing is provably fine, but this run cannot
    // confirm money moved, and a green light here would hide a deploy that never
    // reached the hosts.
    out.push("INCONCLUSIVE: timing is correct, but stale workers hid every result. Re-deploy.");
  } else {
    out.push(timingOk ? "PASS: batch landed in order and left no residue." : "FAIL: see above.");
  }
  out.push("");

  ns.tprint(out.join("\n"));
  for (const line of out) ns.print(line);
}
