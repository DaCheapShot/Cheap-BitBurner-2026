/**
 * manager.js — HWGW batch farming orchestrator.
 *
 * Runs continuously on home. Each cycle:
 *   1. Re-launches root.js every 60s to crack newly reachable servers
 *   2. Discovers execution hosts; deploys worker scripts to new ones via deploy.js
 *   3. Scores all hackable targets; picks top 5
 *   4. For each target: prep to minSec+maxMoney, then run HWGW farm batches
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
 *   ns.sleep() / ns.print() 0.00 GB  — free
 *   Total: ~7.70 GB + 1.60 GB base = ~9.30 GB
 */

// ─── Tuning constants ────────────────────────────────────────────────────────

// Fraction of moneyMax to steal per farm batch.
// 50% is a reliable default: high income, and grow can restore it in one batch.
const HACK_STEAL_PCT = 0.50;

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

// RAM to keep free on home for manager itself and any scripts run manually.
// Reserved = max(floor, percentage) so it scales with home upgrades.
const HOME_RESERVE_GB  = 32;
const HOME_RESERVE_PCT = 0.25;

// Hardcoded RAM per thread for each worker. Avoids needing ns.getScriptRam() in manager
// (which would add ~1 GB to manager's permanent RAM reservation).
// Formula: 1.60 GB base + function cost
const SCRIPT_RAM = {
  "hack.js":   1.70, // 1.60 + 0.10 (ns.hack)
  "grow.js":   1.75, // 1.60 + 0.15 (ns.grow)
  "weaken.js": 1.75, // 1.60 + 0.15 (ns.weaken)
};

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
 * Logs a warning if we run out of RAM before deploying all threads.
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
    const canFit = Math.floor(entry.freeRam / ramPerThread);
    if (canFit <= 0) continue;

    const threads = Math.min(canFit, remaining);
    const pid     = ns.exec(script, entry.host, threads, ...args);
    if (pid > 0) {
      entry.freeRam -= threads * ramPerThread; // track consumed RAM for this cycle
      remaining     -= threads;
    }
  }

  if (remaining > 0) {
    ns.print(`WARN fitAndExec: ${remaining}/${totalThreads} threads undeployed for ${script}`);
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

  // Home: always available, apply the reserved-RAM floor
  const home     = ns.getServer("home");
  const reserved = Math.max(HOME_RESERVE_GB, home.maxRam * HOME_RESERVE_PCT);
  const homeFree = Math.max(0, home.maxRam - home.ramUsed - reserved);
  if (homeFree > 0) hosts.push({ host: "home", freeRam: homeFree });

  // All rooted servers on the network (purchased servers appear here too via BFS)
  for (const host of allServers) {
    const server = ns.getServer(host);
    if (!server.hasAdminRights) continue; // can't run scripts without root
    if (server.maxRam < 2)      continue; // too small for even one worker thread

    if (!deployedHosts.has(host)) {
      // First time seeing this host: launch deploy.js and record it.
      // Skip it as an exec host this cycle — deploy.js may still be running.
      if (ns.exec("deploy.js", "home", 1, host) > 0) {
        deployedHosts.add(host);
        ns.print(`[deploy] Queuing workers → ${host}`);
      }
      continue; // available next cycle
    }

    const freeRam = server.maxRam - server.ramUsed;
    if (freeRam > 0) hosts.push({ host, freeRam });
  }

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

  ns.print(
    `[prep] ${target} | ` +
    `sec ${server.hackDifficulty.toFixed(1)}→${server.minDifficulty.toFixed(1)} | ` +
    `money $${(server.moneyAvailable / 1e6).toFixed(1)}m→$${(server.moneyMax / 1e6).toFixed(1)}m | ` +
    `w1=${weaken1Threads} g=${growThreads} w2=${weaken2Threads}`
  );

  // delay=0 for all three — timing is not critical for prep, only for farm
  fitAndExec(ns, execHosts, "weaken.js", weaken1Threads, [target, 0]);
  fitAndExec(ns, execHosts, "grow.js",   growThreads,    [target, 0]);
  fitAndExec(ns, execHosts, "weaken.js", weaken2Threads, [target, 0]);
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const deployedHosts = new Set(["home"]);
  const allServers    = scanNetwork(ns);
  const execHosts     = buildExecHosts(ns, allServers, deployedHosts);
  const targets       = pickTargets(ns, allServers, 1);
  if (targets.length === 0) { ns.tprint("No targets"); return; }
  const server = ns.getServer(targets[0]);
  dispatchPrep(ns, targets[0], server, execHosts);
  ns.tprint(`Prep dispatched for ${targets[0]}`);
}
