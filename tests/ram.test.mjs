import { readScript, assert, loadScripts } from "./harness.mjs";

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
  share: 2.4, getSharePower: 0.2,
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
  // 6.15 before share mode; ps (0.20) pays for the census that stops a restarted
  // manager double-launching share workers, and getSharePower (0.20) for the only
  // reading of the bonus that includes the intelligence and home-core multipliers.
  "manager.js (analyze) stays at 6.55 GB": () => {
    const ram = ramOf("manager");
    assert(Math.abs(ram - 6.55) < 0.011, `expected 6.55 GB, got ${ram.toFixed(2)}`);
  },

  "manager-formulas.js costs 6.50 GB": () => {
    const ram = ramOf("manager-formulas");
    assert(Math.abs(ram - 6.50) < 0.011, `expected 6.50 GB, got ${ram.toFixed(2)}`);
  },

  // Charged PER THREAD, and the manager places tens of thousands of them, so a
  // stray import costs more here than anywhere else in the repo: pulling in
  // ram.js would add 0.35 GB to every single thread. config.js has no ns calls
  // at all, which is the only reason importing it is safe.
  "share.js is exactly 4.00 GB and imports only config.js": () => {
    const ram = ramOf("share");
    assert(Math.abs(ram - 4.00) < 0.011, `expected 4.00 GB, got ${ram.toFixed(2)}`);
    const imports = [...readScript("share").matchAll(/from\s+"\.\/([\w-]+)\.js"/g)].map((m) => m[1]);
    assert(imports.length === 1 && imports[0] === "config",
      `share.js should import config.js and nothing else, got ${imports.join(", ") || "(none)"}`);
  },

  // A hand-run toggle, so prepper.js's 2.00 GB is affordable - and it buys the
  // guarantee that the pool it reports is the pool the manager will divide.
  "sharemode.js costs 3.80 GB": () => {
    const ram = ramOf("sharemode");
    assert(Math.abs(ram - 3.80) < 0.011, `expected 3.80 GB, got ${ram.toFixed(2)}`);
  },

  // Bitburner resolves imports on the server a script STARTS on, and
  // RamCalculations.ts returns ImportError when one is missing - so exec returns
  // a bare 0, indistinguishable from the script itself being absent.
  //
  // share.js imports config.js, config.js was not deployed, and share therefore
  // ran on home alone (the one host that has config.js) while every other host
  // refused. Three live runs went into finding that, two of them chasing a
  // diagnostic that blamed deploy. This test is the fix for the CLASS: anything
  // the workers import must ship with them.
  "DEPLOY_LIST is closed under imports": async () => {
    const { DEPLOY_LIST } = (await loadScripts())["config"];
    const deployed = new Set(DEPLOY_LIST.map((f) => f.replace(/^\/+/, "")));

    for (const file of DEPLOY_LIST) {
      const bare = file.replace(/^\/+/, "").replace(/^scripts\//, "").replace(/\.js$/, "");
      for (const m of readScript(bare).matchAll(/from\s+"\.\/([\w-]+)\.js"/g)) {
        assert(deployed.has(`scripts/${m[1]}.js`),
          `${file} imports ${m[1]}.js, which is not in DEPLOY_LIST - exec will return 0 on ` +
            `every host but home, and fileExists will insist the worker is there`);
      }
    }
  },

  // The manager reaches SHARE_WORKER as a STRING from config.js and must never
  // import the worker itself: ns.share is 2.40 GB for a function it never calls.
  "no manager build pays for ns.share": () => {
    for (const entry of ["manager", "manager-formulas", "boot"]) {
      assert(!closure(entry).has("share"),
        `${entry}.js imports share.js - 2.40 GB for a function it never calls`);
    }
  },

  // A hand-run tool, so its 2 GB getServer is affordable - but it must not
  // drift into importing the batcher and dragging that cost somewhere it bites.
  "connectme.js costs 3.85 GB and imports nothing": () => {
    const ram = ramOf("connectme");
    assert(Math.abs(ram - 3.85) < 0.011, `expected 3.85 GB, got ${ram.toFixed(2)}`);
    assert(!readScript("connectme").includes('from "./'), "connectme.js should import no other script");
  },

  "neither entry pays for the other's backend": () => {
    assert(ramOf("manager") < 8, "analyze entry is paying formulas cost");
    assert(ramOf("manager-formulas") < 8, "formulas entry is paying analyze cost");
  },
};
