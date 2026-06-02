/**
 * manager.js — HWGW batch farming orchestrator.
 *
 * Runs continuously on home. Each cycle:
 *   1. Re-launches root.js every 60s to crack newly reachable servers
 *   2. Discovers execution hosts; deploys worker scripts to new ones via deploy.js
 *   3. Scores all hackable targets; picks top 5
 *   4. For each target: prep to minSec+maxMoney, then run HWGW farm batches
 *
 * Usage:
 *   run manager.js           — minimal log window output; all detail in manager.log.txt
 *   run manager.js --debug   — full verbose output in both log window and file
 *
 * Permanent RAM reservation (summed across all NS functions used):
 *   ns.scan()               0.20 GB  — BFS network discovery each cycle
 *   ns.exec()               1.30 GB  — launch workers and helpers
 *   ns.getServer()          2.00 GB  — all server state in one call
 *   ns.getHackTime()        0.05 GB  — HWGW batch timing
 *   ns.getGrowTime()        0.05 GB  — HWGW batch timing
 *   ns.getWeakenTime()      0.05 GB  — HWGW batch timing + cycle sleep
 *   ns.growthAnalyze()      1.00 GB  — grow thread count
 *   ns.hackAnalyzeThreads() 1.00 GB  — hack thread count
 *   ns.hackAnalyzeChance()  1.00 GB  — target scoring
 *   ns.getHackingLevel()    0.05 GB  — target eligibility
 *   ns.write()              1.00 GB  — log file output
 *   ns.sleep() / ns.print() 0.00 GB  — free
 *   ns.getPortHandle()      10.00 GB  — runtime config port peek each cycle
 *   Total: ~18.70 GB + 1.60 GB base = ~20.30 GB
 */

// ─── Tuning constants ────────────────────────────────────────────────────────

// Steal% range for dynamic RAM-driven selection. stackBatches tries from MAX
// down to MIN in STEP increments, picking the highest that lets ≥1 full batch fit.
const STEAL_PCT_MAX  = 0.95;
const STEAL_PCT_MIN  = 0.10;
const STEAL_PCT_STEP = 0.05;

// Max targets managed in parallel. More targets = higher RAM usage per cycle.
const TOP_TARGETS = 5;

// Minimum ms between manager cycles (prevents spin-looping on fast servers).
const CYCLE_SLEEP_MS = 2_000;

// How often to re-run root.js (ms). Catches servers that become rootable as hack level rises.
const ROOT_INTERVAL_MS = 60_000;

// Gap between consecutive HWGW batch finish events (ms).
// 200ms gives the game scheduler room to process each completion in order.
const BATCH_PADDING_MS = 200;

// Drift thresholds: if a farming target degrades past these, demote it to prep.
const DRIFT_MONEY_FLOOR = 0.90; // re-prep if moneyAvailable < 90% of moneyMax
const DRIFT_SEC_CEILING = 5;    // re-prep if hackDifficulty > minDifficulty + 5

// Thresholds for detecting that a prep cycle has completed.
const PREP_READY_SEC_TOLERANCE = 0.1;  // max sec above minDifficulty to consider prepped
const PREP_READY_MONEY_FLOOR   = 0.99; // min fraction of moneyMax to consider prepped

// RAM to keep free on home for manager itself and any scripts run manually.
// Reserved = max(floor, percentage) so it scales with home upgrades.
const HOME_RESERVE_GB  = 32;
const HOME_RESERVE_PCT = 0.10;

// Port number for runtime config (ctrl.js writes; manager.js peeks each cycle).
const CONFIG_PORT   = 1;

// Fraction of free RAM reserved for ns.share() threads when share mode is on.
const SHARE_RAM_PCT = 0.20;

// Populated at startup from ns.getScriptRam() — accurate regardless of Bitburner version.
const SCRIPT_RAM = { "hack.js": 0, "grow.js": 0, "weaken.js": 0, "deploy.js": 0, "share.js": 0 };

// ─── Continuous batcher intervals ────────────────────────────────────────────

// How often to re-scan the network, re-score targets, and prune stale state.
const SCAN_INTERVAL_MS = 5_000;

// How often to re-run contracts.js (same cadence as root.js is fine).
const CONTRACTS_INTERVAL_MS = 60_000;

// Fixed duration of one ns.share() call — used to calculate share thread deadline.
const SHARE_MS = 10_000;

// ─── Logger ──────────────────────────────────────────────────────────────────

// Module-level logger so all helper functions share it without extra parameters.
// Initialized in main() after args are parsed.
let log = null;

/**
 * Create a logger that always writes to logFile and selectively prints to the
 * in-game log window.
 *
 * log.info(msg)  — always visible in window + written to file
 * log.debug(msg) — file only (window only if --debug was passed)
 * log.warn(msg)  — always visible in window (prefixed WARN) + written to file
 *
 * @param {NS} ns
 * @param {boolean} debug   — true if --debug flag was passed
 * @param {string}  logFile — filename to append log lines to
 */
function makeLogger(ns, debug, logFile) {
  const ts    = () => new Date().toLocaleTimeString();
  const write = (msg) => ns.write(logFile, `${ts()} ${msg}\n`, "a");
  return {
    info:  (msg) => { write(msg);            ns.print(`${ts()} ${msg}`); },
    debug: (msg) => { write(msg);            if (debug) ns.print(`${ts()} ${msg}`); },
    warn:  (msg) => { write(`WARN: ${msg}`); if (debug) ns.print(`${ts()} WARN: ${msg}`); },
  };
}

// ─── RAM Manager ─────────────────────────────────────────────────────────────

class RamManager {
  constructor({ homeReserveGb, homeReservePct }) {
    this._homeReserveGb  = homeReserveGb;
    this._homeReservePct = homeReservePct;
    this._hosts          = new Map(); // insertion-ordered; home always first
  }

  /**
   * Rebuild the per-host free-RAM snapshot from live game state.
   * Call once per cycle before any allocate() calls.
   * Handles deploy.js launches for newly rooted hosts and immediately
   * deducts their RAM from home so subsequent allocate() calls stay accurate.
   */
  refresh(ns, allServers, deployedHosts) {
    this._hosts.clear();

    // Insert home first so allocate() fills it with priority.
    const home     = ns.getServer("home");
    const reserved = Math.max(this._homeReserveGb, home.maxRam * this._homeReservePct);
    const homeFree = Math.max(0, home.maxRam - home.ramUsed - reserved);
    this._hosts.set("home", { maxRam: home.maxRam, freeRam: homeFree });

    for (const host of allServers) {
      const server = ns.getServer(host);
      if (!server.hasAdminRights || server.maxRam < 2) {
        log.debug(`[hosts] SKIP ${host}: ${!server.hasAdminRights ? "no root" : "maxRam=" + server.maxRam + "GB < 2"}`);
        continue;
      }

      if (!deployedHosts.has(host)) {
        if (ns.exec("deploy.js", "home", 1, host) > 0) {
          deployedHosts.add(host);
          const entry = this._hosts.get("home");
          entry.freeRam = Math.max(0, entry.freeRam - SCRIPT_RAM["deploy.js"]);
          log.info(`[deploy] Queuing workers → ${host} (${SCRIPT_RAM["deploy.js"]}GB)`);
        }
        continue;
      }

      const freeRam = server.maxRam - server.ramUsed;
      log.debug(`[hosts] ${host}: ${server.maxRam}GB max | ${server.ramUsed.toFixed(1)}GB used → ${freeRam.toFixed(1)}GB free`);
      if (freeRam > 0) this._hosts.set(host, { maxRam: server.maxRam, freeRam });
    }

    const homeEntry = this._hosts.get("home");
    log.debug(
      `[hosts] home: ${homeEntry.maxRam}GB max | ` +
      `${home.ramUsed.toFixed(1)}GB used | ` +
      `${reserved.toFixed(1)}GB reserved → ${homeEntry.freeRam.toFixed(1)}GB free`
    );
  }

  /** Sum of freeRam across all hosts in the current snapshot. */
  totalFree() {
    let total = 0;
    for (const { freeRam } of this._hosts.values()) total += freeRam;
    return total;
  }

  /** Number of hosts in the current snapshot. */
  hostCount() {
    return this._hosts.size;
  }

  /**
   * How many threads of `script` could be placed right now across all hosts?
   * Read-only — does not mutate snapshot. Returns min(placeable, threads).
   */
  canFit(script, threads) {
    const ramPerThread = SCRIPT_RAM[script];
    let placeable = 0;
    for (const { freeRam } of this._hosts.values()) {
      placeable += Math.floor(freeRam / ramPerThread);
    }
    return Math.min(placeable, threads);
  }

  /**
   * Distribute `threads` of `script` across exec hosts in snapshot order.
   * Performs a live RAM check per host as a safety net for RAM consumed after
   * snapshot time. Mutates freeRam entries. Logs a warning if threads go undeployed.
   */
  allocate(ns, script, threads, args) {
    const ramPerThread = SCRIPT_RAM[script];
    let remaining = threads;

    for (const [host, entry] of this._hosts) {
      if (remaining <= 0) break;

      const live        = ns.getServer(host);
      const liveReserve = host === "home"
        ? Math.max(this._homeReserveGb, live.maxRam * this._homeReservePct)
        : 0;
      const liveFree      = Math.max(0, live.maxRam - live.ramUsed - liveReserve);
      const effectiveFree = Math.min(entry.freeRam, liveFree);
      const canFit        = Math.floor(effectiveFree / ramPerThread);

      log.debug(`  [fit] ${host}: tracked=${entry.freeRam.toFixed(1)}GB live=${liveFree.toFixed(1)}GB canFit=${canFit}`);
      if (canFit <= 0) continue;

      const toPlace = Math.min(canFit, remaining);
      const pid     = ns.exec(script, host, toPlace, ...args);
      if (pid > 0) {
        entry.freeRam -= toPlace * ramPerThread;
        remaining     -= toPlace;
      } else {
        log.warn(`allocate: exec failed ${toPlace}t ${script} on ${host}`);
      }
    }

    if (remaining > 0) {
      log.warn(`allocate: ${remaining}/${threads} threads undeployed for ${script}`);
    }
    return threads - remaining;
  }

  setAsideForShare(pct, shareRam) {
    const threads = Math.floor(this.totalFree() * pct / shareRam);
    let remaining = threads * shareRam;
    for (const entry of this._hosts.values()) {
      if (remaining <= 0) break;
      const take    = Math.min(entry.freeRam, remaining);
      entry.freeRam -= take;
      remaining     -= take;
    }
    return threads;
  }

  allocateLive(ns, script, threads, args) {
    const ramPerThread = SCRIPT_RAM[script];
    let remaining      = threads;

    for (const [host] of this._hosts) {
      if (remaining <= 0) break;
      const live        = ns.getServer(host);
      const liveReserve = host === "home"
        ? Math.max(this._homeReserveGb, live.maxRam * this._homeReservePct)
        : 0;
      const liveFree = Math.max(0, live.maxRam - live.ramUsed - liveReserve);
      const canFit   = Math.floor(liveFree / ramPerThread);
      if (canFit <= 0) continue;
      const toPlace = Math.min(canFit, remaining);
      const pid     = ns.exec(script, host, toPlace, ...args);
      if (pid > 0) remaining -= toPlace;
      else log.warn(`allocateLive: exec failed ${toPlace}t ${script} on ${host}`);
    }

    if (remaining > 0) log.warn(`allocateLive: ${remaining}/${threads} threads undeployed for ${script}`);
    return threads - remaining;
  }
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

/**
 * BFS scan from home to find every hostname on the network.
 * Returns all hostnames excluding "home" itself.
 *
 * @param {NS} ns
 * @returns {string[]}
 */
function scanNetwork(ns) {
  const visited = new Set(["home"]);
  const queue   = ["home"];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const neighbor of ns.scan(current)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  visited.delete("home");
  return [...visited];
}

/**
 * Score all hackable servers and return the best N hostnames.
 *
 * Score = moneyMax × hackChance / weakenTime
 *   Higher moneyMax   → more income per hack
 *   Higher hackChance → more reliable income (important early game)
 *   Lower weakenTime  → faster cycles → higher income per hour
 *
 * A server is eligible to target when:
 *   - We have root access
 *   - Our hacking level meets its requirement
 *   - It has money (filters out purchased servers, special servers, etc.)
 *
 * @param {NS} ns
 * @param {string[]} allServers
 * @param {number} maxCount
 * @returns {string[]} hostnames sorted best-first, up to maxCount
 */
function pickTargets(ns, allServers, maxCount) {
  const hackLevel = ns.getHackingLevel();
  const scored    = [];

  for (const host of allServers) {
    const server = ns.getServer(host);
    if (!server.hasAdminRights)                   continue;
    if (server.requiredHackingSkill > hackLevel)  continue;
    if (!server.moneyMax || server.moneyMax <= 0) continue; // excludes pserv-*, etc.

    const score = server.moneyMax
                * ns.hackAnalyzeChance(host)
                / ns.getWeakenTime(host);
    scored.push({ host, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxCount).map(s => s.host);
}

function dispatchPrep(ns, target, server, ramMgr) {
  const secDelta       = server.hackDifficulty - server.minDifficulty;
  const weaken1Threads = Math.max(1, Math.ceil(secDelta / 0.05));

  const growMult    = server.moneyMax / Math.max(server.moneyAvailable, 1);
  const growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, growMult)));

  const weaken2Threads = Math.max(1, Math.ceil(growThreads * 0.004 / 0.05));

  const prepRamNeeded = weaken1Threads * SCRIPT_RAM["weaken.js"]
                      + growThreads    * SCRIPT_RAM["grow.js"]
                      + weaken2Threads * SCRIPT_RAM["weaken.js"];
  log.info(
    `[prep] ${target} | ` +
    `sec ${server.hackDifficulty.toFixed(1)}→${server.minDifficulty.toFixed(1)} | ` +
    `money $${(server.moneyAvailable / 1e6).toFixed(1)}m→$${(server.moneyMax / 1e6).toFixed(1)}m | ` +
    `w1=${weaken1Threads} g=${growThreads} w2=${weaken2Threads} | ` +
    `RAM needed: ${prepRamNeeded.toFixed(1)}GB`
  );

  const w1Fit = ramMgr.canFit("weaken.js", weaken1Threads);
  if (w1Fit < weaken1Threads) log.warn(`[prep] ${target}: only ${w1Fit}/${weaken1Threads} weaken1 threads fit`);
  let placed = ramMgr.allocate(ns, "weaken.js", weaken1Threads, [target, 0, "prep", 0]);

  const gFit = ramMgr.canFit("grow.js", growThreads);
  if (gFit < growThreads) log.warn(`[prep] ${target}: only ${gFit}/${growThreads} grow threads fit`);
  placed += ramMgr.allocate(ns, "grow.js", growThreads, [target, 0, "prep", 0]);

  const w2Fit = ramMgr.canFit("weaken.js", weaken2Threads);
  if (w2Fit < weaken2Threads) log.warn(`[prep] ${target}: only ${w2Fit}/${weaken2Threads} weaken2 threads fit`);
  placed += ramMgr.allocate(ns, "weaken.js", weaken2Threads, [target, 0, "prep", 0]);

  return placed > 0;
}

// ─── Batch planning ──────────────────────────────────────────────────────────

/**
 * Calculate thread counts and total RAM for one batch.
 *
 * HWGW (formulasAvailable=false): 4 scripts — hack, weaken1, grow, weaken2.
 *   weaken1 covers hack's security delta; weaken2 covers grow's.
 * HGW  (formulasAvailable=true):  3 scripts — hack, weaken1, grow.
 *   weaken1 covers both hack and grow security deltas combined. weaken2T=0.
 *
 * @param {NS} ns
 * @param {string} target
 * @param {object} server  — ns.getServer(target) result
 * @param {number} stealPct — fraction of moneyMax to steal (0.10–0.95)
 * @param {boolean} formulasAvailable
 * @returns {{ hackT: number, weaken1T: number, growT: number, weaken2T: number, totalRam: number }}
 */
function calcBatchPlan(ns, target, server, stealPct, formulasAvailable) {
  const hackT = Math.max(1, Math.floor(ns.hackAnalyzeThreads(target, server.moneyMax * stealPct)));
  const growT = Math.max(1, Math.ceil(ns.growthAnalyze(target, 1 / (1 - stealPct))));

  const hackSecDelta = hackT * 0.002;
  const growSecDelta = growT * 0.004;

  const weaken1T = formulasAvailable
    ? Math.max(1, Math.ceil((hackSecDelta + growSecDelta) / 0.05))
    : Math.max(1, Math.ceil(hackSecDelta / 0.05));
  const weaken2T = formulasAvailable
    ? 0
    : Math.max(1, Math.ceil(growSecDelta / 0.05));

  const totalRam = hackT    * SCRIPT_RAM["hack.js"]
                 + weaken1T * SCRIPT_RAM["weaken.js"]
                 + growT    * SCRIPT_RAM["grow.js"]
                 + weaken2T * SCRIPT_RAM["weaken.js"];

  return { hackT, weaken1T, growT, weaken2T, totalRam };
}

/**
 * Find the highest steal% where 1 complete batch fits in free RAM and dispatch it.
 * Returns 1 if a batch was dispatched, 0 if no steal% fit.
 *
 * Dispatch timing provides the 200ms stagger between consecutive batches —
 * no batchOffset is needed here. Worker delays are fixed per target:
 *   hack:   max(0, weakenTime - hackTime)
 *   grow:   max(0, weakenTime - growTime)
 *   weaken: 0
 *
 * @param {NS} ns
 * @param {string} target
 * @param {object} server
 * @param {RamManager} ramMgr
 * @param {number} weakenTime
 * @param {boolean} formulasAvailable
 * @param {number} batchIdx  — per-target counter for ps() visibility
 * @returns {number} 1 if dispatched, 0 if skipped
 */
function dispatchOneBatch(ns, target, server, ramMgr, weakenTime, formulasAvailable, batchIdx) {
  const hackTime = ns.getHackTime(target);
  const growTime = ns.getGrowTime(target);

  // Find highest steal% where every script type can be fully placed
  let stealPct = 0;
  let plan     = null;

  for (let pct = STEAL_PCT_MAX; pct >= STEAL_PCT_MIN - 1e-9; pct -= STEAL_PCT_STEP) {
    const candidate    = calcBatchPlan(ns, target, server, pct, formulasAvailable);
    const totalWeakenT = candidate.weaken1T + candidate.weaken2T;
    if (ramMgr.canFit("hack.js",   candidate.hackT)   >= candidate.hackT   &&
        ramMgr.canFit("weaken.js", totalWeakenT)       >= totalWeakenT      &&
        ramMgr.canFit("grow.js",   candidate.growT)    >= candidate.growT) {
      stealPct = pct;
      plan     = candidate;
      break;
    }
  }

  if (!plan) {
    log.debug(`[farm] ${target}: no steal% fits — skipping`);
    return 0;
  }

  // All-or-nothing gate: re-verify fit before allocating (RAM shifts between targets)
  const totalWeakenT = plan.weaken1T + plan.weaken2T;
  if (ramMgr.canFit("hack.js",   plan.hackT)   < plan.hackT   ||
      ramMgr.canFit("weaken.js", totalWeakenT) < totalWeakenT ||
      ramMgr.canFit("grow.js",   plan.growT)   < plan.growT) {
    log.warn(`[farm] ${target}: RAM check failed before dispatch — skipping`);
    return 0;
  }

  const hackAddlMs   = Math.max(0, weakenTime - hackTime);
  const growAddlMs   = Math.max(0, weakenTime - growTime);
  const weakenAddlMs = 0;

  log.debug(
    `[farm] ${target} | mode=${formulasAvailable ? "HGW" : "HWGW"} | ` +
    `steal=${(stealPct * 100).toFixed(0)}% | batch#${batchIdx} | ` +
    `h=${plan.hackT} w1=${plan.weaken1T} g=${plan.growT}` +
    (plan.weaken2T > 0 ? ` w2=${plan.weaken2T}` : "") +
    ` | RAM/batch=${plan.totalRam.toFixed(1)}GB`
  );

  if (formulasAvailable) {
    // HGW: H → G → W1
    ramMgr.allocate(ns, "hack.js",   plan.hackT,    [target, hackAddlMs,   "farm", batchIdx]);
    ramMgr.allocate(ns, "grow.js",   plan.growT,    [target, growAddlMs,   "farm", batchIdx]);
    ramMgr.allocate(ns, "weaken.js", plan.weaken1T, [target, weakenAddlMs, "farm", batchIdx]);
  } else {
    // HWGW: H → W1 → G → W2
    ramMgr.allocate(ns, "hack.js",   plan.hackT,    [target, hackAddlMs,   "farm", batchIdx]);
    ramMgr.allocate(ns, "weaken.js", plan.weaken1T, [target, weakenAddlMs, "farm", batchIdx]);
    ramMgr.allocate(ns, "grow.js",   plan.growT,    [target, growAddlMs,   "farm", batchIdx]);
    ramMgr.allocate(ns, "weaken.js", plan.weaken2T, [target, weakenAddlMs, "farm", batchIdx]);
  }

  return 1;
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const debug   = ns.args.includes("--debug");
  const logFile = "manager.log.txt";

  // Append a session separator so each run is distinguishable in the log file.
  ns.write(logFile, `\n=== session start ${new Date().toLocaleString()} ===\n`, "a");
  log = makeLogger(ns, debug, logFile);

  // Read actual script RAM from the game — avoids stale hardcoded values across versions.
  SCRIPT_RAM["hack.js"]   = ns.getScriptRam("hack.js");
  SCRIPT_RAM["grow.js"]   = ns.getScriptRam("grow.js");
  SCRIPT_RAM["weaken.js"] = ns.getScriptRam("weaken.js");
  SCRIPT_RAM["deploy.js"] = ns.getScriptRam("deploy.js");
  SCRIPT_RAM["share.js"]  = ns.getScriptRam("share.js");

  log.info("=== manager.js started ===");
  log.info(`[init] Script RAM — hack=${SCRIPT_RAM["hack.js"]}GB grow=${SCRIPT_RAM["grow.js"]}GB weaken=${SCRIPT_RAM["weaken.js"]}GB deploy=${SCRIPT_RAM["deploy.js"]}GB share=${SCRIPT_RAM["share.js"]}GB`);
  if (debug) log.info("[init] debug mode ON — verbose output in log window");
  else       log.info("[init] debug mode OFF — verbose output in manager.log.txt only");

  // Launch the server buyer once. buy.js loops on its own; manager just needs to start it.
  if (ns.exec("buy.js", "home", 1) === 0) {
    log.warn("buy.js failed to launch (already running, or file missing)");
  } else {
    log.info("[buy] buy.js launched");
  }

  // Hosts that already have hack/grow/weaken deployed. Home always has its own files.
  const deployedHosts = new Set(["home"]);

  const targetPhase  = new Map(); // "prep" | "farm" per target
  const prepEndMs    = new Map(); // estimated prep completion time — guards re-dispatch
  const batchCounter = new Map(); // per-target batch index for ps() visibility

  let lastRootTime      = 0; // initialized to 0 so root.js fires on first tick
  let lastScanTime      = 0; // initialized to 0 so scan fires on first tick
  let lastContractsTime = 0;

  // Cached between 5s scans — updated in the scan block each tick
  let allServers        = [];
  let targets           = [];
  let formulasAvailable = false;

  const ramMgr = new RamManager({ homeReserveGb: HOME_RESERVE_GB, homeReservePct: HOME_RESERVE_PCT });

  while (true) {
    const now = Date.now();

    // ── 0. Read runtime config ────────────────────────────────────────────────
    const _cfgPort     = ns.getPortHandle(CONFIG_PORT);
    const cfg          = _cfgPort.empty() ? {} : JSON.parse(_cfgPort.peek());
    const shareEnabled = cfg.share === true;

    // ── 1. Periodically re-run root.js ───────────────────────────────────────
    // root.js BFS-scans the network and nukes any newly rootable servers.
    // Re-running every 60s catches servers that become affordable as hack level rises.
    if (now - lastRootTime >= ROOT_INTERVAL_MS) {
      const rootPid = ns.exec("root.js", "home", 1);
      if (rootPid === 0) {
        log.warn("root.js failed to launch (already running, or file missing)");
      } else {
        lastRootTime = now;
      }
    }

    // ── 1b. 60s: Solve contracts ─────────────────────────────────────────────
    if (now - lastContractsTime >= CONTRACTS_INTERVAL_MS) {
      ns.exec("contracts.js", "home", 1);
      lastContractsTime = now;
    }

    // ── 2. 5s: Scan network, re-score targets, prune stale state ─────────────
    if (now - lastScanTime >= SCAN_INTERVAL_MS) {
      allServers        = scanNetwork(ns);
      formulasAvailable = ns.fileExists("Formulas.exe", "home");
      targets           = pickTargets(ns, allServers, TOP_TARGETS);
      log.debug(`[scan] ${allServers.length} servers | ${targets.length} target(s) | mode=${formulasAvailable ? "HGW" : "HWGW"}`);

      // Prune state maps for targets that dropped out of the top list
      for (const t of [...targetPhase.keys()]) {
        if (!targets.includes(t)) {
          targetPhase.delete(t);
          prepEndMs.delete(t);
          batchCounter.delete(t);
          log.debug(`[scan] dropped target ${t}`);
        }
      }

      ns.clearLog();
      lastScanTime = now;
    }

    if (targets.length === 0) {
      log.warn("no eligible targets yet — retrying in 10s");
      await ns.sleep(10_000);
      continue;
    }

    // ── 3. Refresh RAM snapshot (every tick) ─────────────────────────────────
    ramMgr.refresh(ns, allServers, deployedHosts);
    log.debug(`[hosts] ${ramMgr.hostCount()} exec host(s) | ${ramMgr.totalFree().toFixed(1)}GB total free`);

    // ── 3b. 60s: Share dispatch — fires in same tick as root.js, after fresh RAM snapshot
    // Gated by lastRootTime < BATCH_PADDING_MS: true only in the tick root.js just fired.
    if (shareEnabled && now - lastRootTime < BATCH_PADDING_MS) {
      const shareThreads = ramMgr.setAsideForShare(SHARE_RAM_PCT, SCRIPT_RAM["share.js"]);
      if (shareThreads > 0) {
        const placed = ramMgr.allocateLive(ns, "share.js", shareThreads, [ROOT_INTERVAL_MS + SHARE_MS]);
        log.info(`[share] ON — ${placed}/${shareThreads} threads placed for ${ns.tFormat(ROOT_INTERVAL_MS + SHARE_MS)}`);
      }
    }

    // ── 5. Dispatch batches ───────────────────────────────────────────────────
    let maxEndMs = 0;

    for (const target of targets) {
      const server     = ns.getServer(target);
      const weakenTime = ns.getWeakenTime(target);

      // Drift check: if a farming target has degraded, demote it back to prep.
      let phase = targetPhase.get(target) ?? "prep";

      if (phase === "farm") {
        const moneyDrifted = server.moneyAvailable < server.moneyMax * DRIFT_MONEY_FLOOR;
        const secDrifted   = server.hackDifficulty  > server.minDifficulty + DRIFT_SEC_CEILING;
        if (moneyDrifted || secDrifted) {
          phase = "prep";
          targetPhase.set(target, "prep");
          prepEndMs.delete(target);
          log.info(
            `[drift] ${target} → re-prep | ` +
            `money=${(server.moneyAvailable / server.moneyMax * 100).toFixed(0)}% | ` +
            `sec=${server.hackDifficulty.toFixed(1)}`
          );
        }
      }

      if (phase === "prep") {
        // Check if target is already at minSec + maxMoney (e.g. after a game reload).
        const isReady = server.hackDifficulty <= server.minDifficulty + PREP_READY_SEC_TOLERANCE &&
                        server.moneyAvailable >= server.moneyMax * PREP_READY_MONEY_FLOOR;
        if (isReady) {
          targetPhase.set(target, "farm");
          prepEndMs.delete(target);
          log.info(`[ready] ${target} is prepped → starting farm`);
          // fall through to farm dispatch below
        } else {
          // Guard: skip if prep workers are still expected to be in flight
          if (now < (prepEndMs.get(target) ?? 0)) continue;

          if (dispatchPrep(ns, target, server, ramMgr)) {
            prepEndMs.set(target, now + weakenTime + 5_000);
          }
          continue;
        }
      }

      // Phase is "farm" — either it was already, or just promoted above.
      const batchIdx   = batchCounter.get(target) ?? 0;
      const dispatched = dispatchOneBatch(ns, target, server, ramMgr, weakenTime, formulasAvailable, batchIdx);
      if (dispatched) {
        batchCounter.set(target, (batchIdx + 1) % 10_000);
      }
    }

    // ── 6. Sleep until all batch workers should be done ──────────────────────
    const sleepMs = Math.max(CYCLE_SLEEP_MS, maxEndMs + 1_000);
    log.info(`[cycle] ${targets.length} target(s) | sleep ${ns.format.time(sleepMs)}`);
    await ns.sleep(sleepMs);
  }
}
