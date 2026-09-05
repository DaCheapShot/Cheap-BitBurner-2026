import { readScript, assert } from "./harness.mjs";

// Verified against src/Netscript/RamCostGenerator.ts in this fork.
const COST = {
  scan: 0.2, hack: 0.1, grow: 0.15, weaken: 0.15,
  hackAnalyze: 1, hackAnalyzeSecurity: 1, hackAnalyzeThreads: 1, hackAnalyzeChance: 1,
  growthAnalyze: 1, growthAnalyzeSecurity: 1, weakenAnalyze: 1,
  exec: 1.3, run: 1, spawn: 2, scp: 0.6, kill: 0.5, killall: 0.5,
  hasRootAccess: 0.05, getHostname: 0.05, getHackingLevel: 0.05,
  getServer: 2, getServerMoneyAvailable: 0.1, getServerSecurityLevel: 0.1,
  getServerMinSecurityLevel: 0.1, getServerMaxMoney: 0.1,
  getServerRequiredHackingLevel: 0.1, getServerNumPortsRequired: 0.1,
  getServerGrowth: 0.1, getServerMaxRam: 0.05, getServerUsedRam: 0.05,
  fileExists: 0.1, isRunning: 0.1, ps: 0.2, ls: 0.2,
  getScriptRam: 0.1, getHackTime: 0.05, getGrowTime: 0.05, getWeakenTime: 0.05,
  getPlayer: 0.5, nuke: 0.05, brutessh: 0.05, ftpcrack: 0.05,
  relaysmtp: 0.05, httpworm: 0.05, sqlinject: 0.05,
};
const BASE = 1.6;

function closure(bare, seen = new Set()) {
  if (seen.has(bare)) return seen;
  seen.add(bare);
  for (const m of readScript(bare).matchAll(/from\s+"\.\/([\w-]+)\.js"/g)) closure(m[1], seen);
  return seen;
}

/**
 * Sum each distinct ns function reachable from an entry script.
 *
 * Approximates the game's static analysis: charged ONCE per function, however
 * many call sites. Comments and strings can produce false hits, so this counts
 * only real call syntax `ns.fn(`.
 */
function ramOf(bare) {
  const fns = new Set();
  for (const mod of closure(bare)) {
    const src = readScript(mod).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const m of src.matchAll(/\bns\.(\w+)\s*\(/g)) if (COST[m[1]] !== undefined) fns.add(m[1]);
  }
  return BASE + [...fns].reduce((n, f) => n + COST[f], 0);
}

export const tests = {
  "manager.js (analyze) stays at 6.15 GB": () => {
    const ram = ramOf("manager");
    assert(Math.abs(ram - 6.15) < 0.011, `expected 6.15 GB, got ${ram.toFixed(2)}`);
  },

  "manager-formulas.js costs 6.10 GB": () => {
    const ram = ramOf("manager-formulas");
    assert(Math.abs(ram - 6.10) < 0.011, `expected 6.10 GB, got ${ram.toFixed(2)}`);
  },

  "neither entry pays for the other's backend": () => {
    assert(ramOf("manager") < 8, "analyze entry is paying formulas cost");
    assert(ramOf("manager-formulas") < 8, "formulas entry is paying analyze cost");
  },
};
