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
 *   Total: ~8.70 GB + 1.60 GB base = ~10.30 GB
 */

// ─── Tuning constants ────────────────────────────────────────────────────────

// Fraction of moneyMax to steal per farm batch.
// 50% is a reliable default: high income, and grow can restore it in one batch.
const HACK_STEAL_PCT = 0.50;

// Max targets managed in parallel. More targets = higher RAM usage per cycle.
const TOP_TARGETS = 2;

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

// Populated at startup from ns.getScriptRam() — accurate regardless of Bitburner version.
const SCRIPT_RAM = { "hack.js": 0, "grow.js": 0, "weaken.js": 0, "deploy.js": 0 };

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
    info:  (msg) => { write(msg);           ns.print(msg); },
    debug: (msg) => { write(msg);           if (debug) ns.print(msg); },
    warn:  (msg) => { write(`WARN: ${msg}`); ns.print(`WARN: ${msg}`); },
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
 * Split totalThreads of script across available exec hosts, filling each in order.
 * Mutates entry.freeRam so subsequent calls within the same cycle stay accurate.
 *
 * Security constants referenced throughout manager:
 *   ns.hack()   raises target security by 0.002 per thread
 *   ns.grow()   raises target security by 0.004 per thread
 *   ns.weaken() lowers target security by 0.050 per thread
 *
 * @param {NS} ns
 * @param {Array<{host: string, freeRam: number}>} execHosts
 * @param {string} script
 * @param {number} totalThreads
 * @param {(string|number)[]} args   — passed to each exec call (e.g. [target, delay])
 */
function fitAndExec(ns, execHosts, script, totalThreads, args) {
  const ramPerThread = SCRIPT_RAM[script];
  let remaining      = totalThreads;

  for (const entry of execHosts) {
    if (remaining <= 0) break;

    // Read live RAM — deploy.js scripts launched earlier in this cycle may have
    // consumed RAM that isn't reflected in the snapshot entry.freeRam was built from.
    const live = ns.getServer(entry.host);
    const liveReserve = entry.host === "home"
      ? Math.max(HOME_RESERVE_GB, live.maxRam * HOME_RESERVE_PCT)
      : 0;
    const liveFree = Math.max(0, live.maxRam - live.ramUsed - liveReserve);

    // Use the lower of tracked (committed this cycle) and live — whichever is tighter.
    const effectiveFree = Math.min(entry.freeRam, liveFree);
    const canFit = Math.floor(effectiveFree / ramPerThread);
    log.debug(`  [fit] ${entry.host}: tracked=${entry.freeRam.toFixed(1)}GB live=${liveFree.toFixed(1)}GB canFit=${canFit}`);
    if (canFit <= 0) continue;

    const threads = Math.min(canFit, remaining);
    const pid     = ns.exec(script, entry.host, threads, ...args);
    log.debug(`  [fit] exec ${threads}t ${script} → pid=${pid}`);
    if (pid > 0) {
      entry.freeRam -= threads * ramPerThread;
      remaining     -= threads;
    } else {
      log.warn(`fit exec failed: ${threads}t ${script} on ${entry.host} (live RAM too low)`);
    }
  }

  if (remaining > 0) {
    log.warn(`fitAndExec: ${remaining}/${totalThreads} threads undeployed for ${script}`);
  }
}

/**
 * Build the list of servers available to run worker scripts this cycle.
 *
 * - Home is always included, with a reserved-RAM slice withheld.
 * - All rooted network servers (including purchased pserv-*) are included.
 * - When a newly rooted host is seen for the first time, deploy.js is launched
 *   for it and it's skipped as an exec host THIS cycle. Next cycle it's ready.
 *   (This one-cycle gap prevents exec calls on a host before files land.)
 * - Mutates deployedHosts to track which hosts are set up.
 *
 * @param {NS} ns
 * @param {string[]} allServers         — full network from scanNetwork()
 * @param {Set<string>} deployedHosts   — hosts that already have worker scripts
 * @returns {Array<{host: string, freeRam: number}>}
 */
function buildExecHosts(ns, allServers, deployedHosts) {
  const hosts = [];
  let deployRamUsed = 0; // RAM consumed on home by deploy.js launches this call

  // Process all rooted servers first — deploy.js launches happen here and consume home RAM.
  for (const host of allServers) {
    const server = ns.getServer(host);
    if (!server.hasAdminRights) { log.debug(`[hosts] SKIP ${host}: no root`); continue; }
    if (server.maxRam < 2)      { log.debug(`[hosts] SKIP ${host}: maxRam=${server.maxRam}GB < 2`); continue; }

    if (!deployedHosts.has(host)) {
      // First time seeing this host: launch deploy.js and record it.
      // Skip it as an exec host this cycle — deploy.js may still be running.
      if (ns.exec("deploy.js", "home", 1, host) > 0) {
        deployedHosts.add(host);
        deployRamUsed += SCRIPT_RAM["deploy.js"]; // track RAM consumed on home
        log.info(`[deploy] Queuing workers → ${host} (${SCRIPT_RAM["deploy.js"]}GB)`);
      }
      continue; // available next cycle
    }

    const freeRam = server.maxRam - server.ramUsed;
    log.debug(`[hosts] ${host}: ${server.maxRam}GB max | ${server.ramUsed.toFixed(1)}GB used → ${freeRam.toFixed(1)}GB free`);
    if (freeRam > 0) hosts.push({ host, freeRam });
  }

  // Compute home free RAM AFTER all deploy.js launches so deployRamUsed is accurate.
  const home     = ns.getServer("home");
  const reserved = Math.max(HOME_RESERVE_GB, home.maxRam * HOME_RESERVE_PCT);
  const homeFree = Math.max(0, home.maxRam - home.ramUsed - reserved - deployRamUsed);
  log.debug(
    `[hosts] home: ${home.maxRam}GB max | ${home.ramUsed.toFixed(1)}GB used | ` +
    `${reserved.toFixed(1)}GB reserved | ${deployRamUsed.toFixed(1)}GB deploy → ${homeFree.toFixed(1)}GB free`
  );
  if (homeFree > 0) hosts.unshift({ host: "home", freeRam: homeFree }); // home first

  return hosts;
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

/**
 * Dispatch prep workers to bring target to minDifficulty + moneyMax.
 * Must complete before farm batches start (prep is a prerequisite for accurate HWGW math).
 *
 * Launches all three workers simultaneously with delay=0.
 * This is safe because grow always finishes before weaken (growTime < weakenTime),
 * so weaken2 will still be running when grow completes and will correctly offset
 * the security that grow added.
 *
 * Thread math:
 *   weaken lowers security by 0.05 per thread
 *   grow   raises security by 0.004 per thread → weaken2 compensates for this
 *
 * @param {NS} ns
 * @param {string} target
 * @param {ReturnType<NS["getServer"]>} server  — ns.getServer(target) result
 * @param {Array<{host: string, freeRam: number}>} execHosts
 */
function dispatchPrep(ns, target, server, execHosts) {
  // Weaken threads to reach minimum security
  const secDelta       = server.hackDifficulty - server.minDifficulty;
  const weaken1Threads = Math.max(1, Math.ceil(secDelta / 0.05));

  // Grow threads to reach maximum money.
  // Clamp moneyAvailable to 1 to avoid division-by-zero on a completely empty server.
  const growMult    = server.moneyMax / Math.max(server.moneyAvailable, 1);
  const growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, growMult)));

  // Weaken threads to offset the security raise from grow (0.004 security per grow thread)
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

  // delay=0 for all three — timing is not critical for prep, only for farm
  fitAndExec(ns, execHosts, "weaken.js", weaken1Threads, [target, 0]);
  fitAndExec(ns, execHosts, "grow.js",   growThreads,    [target, 0]);
  fitAndExec(ns, execHosts, "weaken.js", weaken2Threads, [target, 0]);
}

/**
 * Dispatch one HWGW batch against a prepped target.
 * All four workers launch at the same real-world time but sleep different delays,
 * so they complete in this order (BATCH_PADDING_MS apart):
 *
 *   Hack    finishes at T                 → steals HACK_STEAL_PCT of moneyMax
 *   Weaken1 finishes at T + 200ms         → offsets hack's security raise
 *   Grow    finishes at T + 400ms         → restores stolen money
 *   Weaken2 finishes at T + 600ms         → offsets grow's security raise
 *
 * This ordering keeps the server at minSec + maxMoney after every batch,
 * so the next batch's thread calculations remain accurate without re-prepping.
 *
 * Delay math (all workers launched simultaneously, then sleep their delay):
 *   W1: delay = 0                           → finishes at T + weakenTime (baseline)
 *   H:  delay = weakenTime - hackTime - 200 → finishes at T + weakenTime - 200ms
 *   G:  delay = weakenTime - growTime + 200 → finishes at T + weakenTime + 200ms
 *   W2: delay = 400                         → finishes at T + weakenTime + 400ms
 *
 * Thread math:
 *   hackAnalyzeThreads takes a dollar amount, not a fraction.
 *   hack   raises security 0.002/thread → weaken1 = ceil(hackThreads × 0.002 / 0.05)
 *   grow   raises security 0.004/thread → weaken2 = ceil(growThreads × 0.004 / 0.05)
 *   After stealing 50%, need 1/(1-0.50) = 2× growth to restore to maxMoney.
 *
 * @param {NS} ns
 * @param {string} target
 * @param {ReturnType<NS["getServer"]>} server  — ns.getServer(target), assumed prepped
 * @param {Array<{host: string, freeRam: number}>} execHosts
 * @param {number} weakenTime — ms for ns.weaken() on this target (pre-computed by caller)
 */
function dispatchFarm(ns, target, server, execHosts, weakenTime) {
  const hackTime = ns.getHackTime(target);
  const growTime = ns.getGrowTime(target);

  // --- Thread counts ---
  // hackAnalyzeThreads(host, dollarAmount) — pass dollar amount, not fraction
  const hackThreads = Math.max(1, Math.floor(
    ns.hackAnalyzeThreads(target, server.moneyMax * HACK_STEAL_PCT)
  ));
  // Each hack thread raises security by 0.002; each weaken thread lowers it by 0.05
  const weaken1Threads = Math.max(1, Math.ceil(hackThreads * 0.002 / 0.05));
  // Restore from (1 - HACK_STEAL_PCT) × moneyMax back to moneyMax
  const restoreMult    = 1 / (1 - HACK_STEAL_PCT); // = 2.0 at 50% steal
  const growThreads    = Math.max(1, Math.ceil(ns.growthAnalyze(target, restoreMult)));
  // Each grow thread raises security by 0.004
  const weaken2Threads = Math.max(1, Math.ceil(growThreads * 0.004 / 0.05));

  // --- Stagger delays (ms) ---
  // Math.max(0, ...) guards against negative delays on very fast servers
  const hackDelay    = Math.max(0, weakenTime - hackTime - BATCH_PADDING_MS);
  const weaken1Delay = 0;
  const growDelay    = Math.max(0, weakenTime - growTime + BATCH_PADDING_MS);
  const weaken2Delay = BATCH_PADDING_MS * 2;

  const farmRamNeeded = hackThreads    * SCRIPT_RAM["hack.js"]
                      + weaken1Threads * SCRIPT_RAM["weaken.js"]
                      + growThreads    * SCRIPT_RAM["grow.js"]
                      + weaken2Threads * SCRIPT_RAM["weaken.js"];
  log.info(
    `[farm] ${target} | ` +
    `h=${hackThreads}(+${hackDelay}ms) ` +
    `w1=${weaken1Threads} ` +
    `g=${growThreads}(+${growDelay}ms) ` +
    `w2=${weaken2Threads}(+${weaken2Delay}ms) | ` +
    `RAM needed: ${farmRamNeeded.toFixed(1)}GB`
  );

  fitAndExec(ns, execHosts, "hack.js",   hackThreads,    [target, hackDelay]);
  fitAndExec(ns, execHosts, "weaken.js", weaken1Threads, [target, weaken1Delay]);
  fitAndExec(ns, execHosts, "grow.js",   growThreads,    [target, growDelay]);
  fitAndExec(ns, execHosts, "weaken.js", weaken2Threads, [target, weaken2Delay]);
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

  log.info("=== manager.js started ===");
  log.info(`[init] Script RAM — hack=${SCRIPT_RAM["hack.js"]}GB grow=${SCRIPT_RAM["grow.js"]}GB weaken=${SCRIPT_RAM["weaken.js"]}GB deploy=${SCRIPT_RAM["deploy.js"]}GB`);
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

  // Current phase for each target: "prep" (getting ready) or "farm" (earning money).
  // New targets default to "prep" — they must reach minSec+maxMoney before farming.
  const targetPhase = new Map();

  // Timestamp of last root.js launch (ms). Initialized to 0 so it fires on first cycle.
  let lastRootTime = 0;

  while (true) {
    const now = Date.now();

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

    // ── 2. Discover all servers ───────────────────────────────────────────────
    const allServers = scanNetwork(ns);

    // ── 3. Build exec host list; deploy workers to new hosts ─────────────────
    const execHosts    = buildExecHosts(ns, allServers, deployedHosts);
    const totalFreeRam = execHosts.reduce((sum, e) => sum + e.freeRam, 0);
    log.info(`[hosts] ${execHosts.length} exec host(s) | ${totalFreeRam.toFixed(1)}GB total free`);

    // ── 4. Score and select top targets ──────────────────────────────────────
    const targets = pickTargets(ns, allServers, TOP_TARGETS);

    if (targets.length === 0) {
      log.warn("no eligible targets yet — retrying in 10s");
      await ns.sleep(10_000);
      continue;
    }

    // ── 5. Dispatch batches ───────────────────────────────────────────────────
    let maxWeakenTime = 0;

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
          log.info(`[ready] ${target} is prepped → starting farm`);
          // fall through to farm dispatch below
        } else {
          dispatchPrep(ns, target, server, execHosts);
          maxWeakenTime = Math.max(maxWeakenTime, weakenTime);
          continue; // don't farm until prep completes next cycle
        }
      }

      // Phase is "farm" — either it was already, or just promoted above.
      dispatchFarm(ns, target, server, execHosts, weakenTime);
      maxWeakenTime = Math.max(maxWeakenTime, weakenTime);
    }

    // ── 6. Sleep until all batch workers should be done ──────────────────────
    const sleepMs = Math.max(CYCLE_SLEEP_MS, maxWeakenTime + 1_000);
    log.info(`[cycle] ${targets.length} target(s) | sleep ${ns.format.time(sleepMs)}`);
    await ns.sleep(sleepMs);
  }
}
