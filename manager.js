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

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  // Verify the script loads correctly. Full loop added in Task 9.
  ns.tprint("manager.js: constants and utilities loaded OK");
  const allServers = scanNetwork(ns);
  ns.tprint(`Discovered ${allServers.length} servers via BFS`);
}
