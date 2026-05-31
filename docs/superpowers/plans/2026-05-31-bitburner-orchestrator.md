# Bitburner HWGW Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a RAM-efficient Bitburner orchestrator that auto-roots servers and runs staged HWGW batch farming across multiple targets simultaneously.

**Architecture:** Six scripts total. Three minimal workers (hack/grow/weaken) each use one NS function for minimum RAM per thread. Two short-lived helpers (root/deploy) are launched and exit so their RAM is freed. One persistent manager orchestrates everything from home.

**Tech Stack:** Bitburner 3.0.1 NS API (JavaScript ES modules), no external dependencies.

---

## File Map

| File | Role | Key NS functions |
|---|---|---|
| `hack.js` | Worker — steal money | `ns.hack` (0.10 GB) |
| `grow.js` | Worker — restore money | `ns.grow` (0.15 GB) |
| `weaken.js` | Worker — reduce security | `ns.weaken` (0.15 GB) |
| `deploy.js` | Helper — copy workers to a host, then exit | `ns.scp` (0.60 GB) |
| `root.js` | Helper — crack and nuke new servers, then exit | `ns.scan`, `ns.getServer`, `ns.fileExists`, 5 crackers, `ns.nuke` |
| `manager.js` | Orchestrator — runs forever on home | `ns.scan`, `ns.exec`, `ns.getServer`, `ns.getHackTime`, `ns.getGrowTime`, `ns.getWeakenTime`, `ns.growthAnalyze`, `ns.hackAnalyzeThreads`, `ns.hackAnalyzeChance`, `ns.getHackingLevel` |

**manager.js permanent RAM reservation (all functions summed):**
`0.20 + 1.30 + 2.00 + 0.05 + 0.05 + 0.05 + 1.00 + 1.00 + 1.00 + 0.05 = ~7.70 GB` plus 1.60 GB base = **~9.30 GB total**.

---

## Task 1: Worker Scripts

Three minimal workers. Each uses exactly one NS function — the minimum possible RAM per thread.
Workers accept `target` and an optional `delay` (ms). The delay is free (`sleep` costs 0 GB) and is used by the farm dispatcher to stagger HWGW completions.

**Files:**
- Create: `hack.js`
- Create: `grow.js`
- Create: `weaken.js`

- [ ] **Step 1: Write hack.js**

```js
/**
 * hack.js — steal money from a target server, then exit.
 * RAM: 1.60 GB base + 0.10 GB (ns.hack) = 1.70 GB per thread.
 *
 * Args:
 *   ns.args[0] {string} target — hostname to hack
 *   ns.args[1] {number} delay  — ms to sleep before acting (HWGW batch timing)
 */
/** @param {NS} ns */
export async function main(ns) {
  const target = /** @type {string} */ (ns.args[0]);
  const delay  = /** @type {number} */ (ns.args[1] ?? 0);
  await ns.sleep(delay);
  await ns.hack(target);
}
```

- [ ] **Step 2: Write grow.js**

```js
/**
 * grow.js — increase money on a target server, then exit.
 * RAM: 1.60 GB base + 0.15 GB (ns.grow) = 1.75 GB per thread.
 *
 * Args:
 *   ns.args[0] {string} target — hostname to grow
 *   ns.args[1] {number} delay  — ms to sleep before acting (HWGW batch timing)
 */
/** @param {NS} ns */
export async function main(ns) {
  const target = /** @type {string} */ (ns.args[0]);
  const delay  = /** @type {number} */ (ns.args[1] ?? 0);
  await ns.sleep(delay);
  await ns.grow(target);
}
```

- [ ] **Step 3: Write weaken.js**

```js
/**
 * weaken.js — reduce security on a target server, then exit.
 * RAM: 1.60 GB base + 0.15 GB (ns.weaken) = 1.75 GB per thread.
 *
 * Args:
 *   ns.args[0] {string} target — hostname to weaken
 *   ns.args[1] {number} delay  — ms to sleep before acting (HWGW batch timing)
 */
/** @param {NS} ns */
export async function main(ns) {
  const target = /** @type {string} */ (ns.args[0]);
  const delay  = /** @type {number} */ (ns.args[1] ?? 0);
  await ns.sleep(delay);
  await ns.weaken(target);
}
```

- [ ] **Step 4: Verify RAM costs in Bitburner terminal**

```
mem hack.js
mem grow.js
mem weaken.js
```
Expected:
```
hack.js:   1.70 GB
grow.js:   1.75 GB
weaken.js: 1.75 GB
```

- [ ] **Step 5: Smoke-test each worker on a rooted server**

Replace `n00dles` with any server you have root access to:
```
run weaken.js n00dles 0
```
Wait for it to finish. Check the script log window — no errors. The server's security level should decrease.

- [ ] **Step 6: Commit**

```
git add hack.js grow.js weaken.js
git commit -m "feat: add minimal hack/grow/weaken worker scripts"
```

---

## Task 2: deploy.js

One-shot helper that `scp`s the three workers from home to a target host, then exits.
Manager launches this when it discovers a new execution host. By keeping `scp` here rather than in manager, manager avoids permanently reserving 0.60 GB for its lifetime.

**Files:**
- Create: `deploy.js`

- [ ] **Step 1: Write deploy.js**

```js
/**
 * deploy.js — copy worker scripts from home to a target execution host, then exit.
 * RAM: 1.60 GB base + 0.60 GB (ns.scp) = 2.20 GB, freed immediately on exit.
 *
 * Keeping scp here (not in manager.js) saves 0.60 GB from manager's permanent reservation.
 * Manager launches this once per newly discovered host.
 *
 * Args:
 *   ns.args[0] {string} host — destination hostname
 */
/** @param {NS} ns */
export async function main(ns) {
  const host = /** @type {string} */ (ns.args[0]);
  if (!host) {
    ns.tprint("ERROR deploy.js: hostname argument required");
    return;
  }
  const workers = ["hack.js", "grow.js", "weaken.js"];
  const ok = ns.scp(workers, host, "home");
  ns.tprint(ok
    ? `deploy.js: workers deployed to ${host}`
    : `deploy.js: ERROR — scp to ${host} failed`
  );
}
```

- [ ] **Step 2: Verify in terminal**

```
run deploy.js n00dles
ls n00dles
```
Expected: `hack.js`, `grow.js`, `weaken.js` listed on `n00dles`.

- [ ] **Step 3: Commit**

```
git add deploy.js
git commit -m "feat: add deploy.js one-shot worker deployer"
```

---

## Task 3: root.js

One-shot helper that BFS-scans the whole network, applies available port crackers, and nukes servers that have enough ports open. Manager re-runs this every 60 seconds to pick up newly rootable servers as hacking level increases.

By keeping all cracker functions here (not in manager), manager avoids permanently reserving ~1.5 GB of cracker RAM for its lifetime.

**Files:**
- Create: `root.js`

- [ ] **Step 1: Write root.js**

```js
/**
 * root.js — scan the network, apply port crackers, nuke accessible servers, then exit.
 *
 * RAM (~4.25 GB) is freed on exit. Keeping crackers here saves ~1.5 GB
 * from manager.js's permanent reservation.
 *
 * Crackers are detected dynamically from home — works at any game stage.
 * Manager runs this at startup and every 60s.
 */
/** @param {NS} ns */
export async function main(ns) {
  // BFS from home to discover every server on the network
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

  // Map each cracker executable to the NS function that opens its port.
  // Checked dynamically so this works whether we have 0 or 5 crackers.
  const crackers = [
    { file: "BruteSSH.exe",  fn: (h) => ns.brutessh(h)  },
    { file: "FTPCrack.exe",  fn: (h) => ns.ftpcrack(h)  },
    { file: "relaySMTP.exe", fn: (h) => ns.relaysmtp(h) },
    { file: "HTTPWorm.exe",  fn: (h) => ns.httpworm(h)  },
    { file: "SQLInject.exe", fn: (h) => ns.sqlinject(h) },
  ];

  let newlyRooted = 0;
  for (const host of visited) {
    if (host === "home") continue;
    const server = ns.getServer(host);
    if (server.hasAdminRights) continue; // already rooted

    // Apply every cracker we currently own on home
    let openedPorts = 0;
    for (const cracker of crackers) {
      if (ns.fileExists(cracker.file, "home")) {
        cracker.fn(host);
        openedPorts++;
      }
    }

    // Nuke if we opened at least as many ports as the server requires
    if (openedPorts >= server.numOpenPortsRequired) {
      ns.nuke(host);
      newlyRooted++;
      ns.print(`Rooted: ${host}`);
    }
  }

  ns.tprint(
    `root.js: +${newlyRooted} rooted | ` +
    `scanned ${visited.size - 1} servers`
  );
}
```

- [ ] **Step 2: Verify in terminal**

```
run root.js
```
Expected output (example): `root.js: +3 rooted | scanned 14 servers`

Open the network map and confirm previously locked servers now show root access (green padlock).

- [ ] **Step 3: Commit**

```
git add root.js
git commit -m "feat: add root.js network scanner and auto-rooter"
```

---

## Task 4: manager.js — Constants, scanNetwork, fitAndExec

Start building `manager.js`. This task adds the module-level constants and two utility functions used by every other part of the manager.

**Files:**
- Create: `manager.js`

- [ ] **Step 1: Write manager.js with constants and utility functions**

```js
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
```

- [ ] **Step 2: Verify it loads and scans**

```
run manager.js
```
Expected:
```
manager.js: constants and utilities loaded OK
Discovered 14 servers via BFS
```
(Server count depends on BitNode. No errors = success.)

- [ ] **Step 3: Check RAM cost**

```
mem manager.js
```
Expected: approximately 9–10 GB. If much higher, a function was accidentally included.

- [ ] **Step 4: Commit**

```
git add manager.js
git commit -m "feat: add manager.js constants, scanNetwork, fitAndExec"
```

---

## Task 5: manager.js — buildExecHosts

Add the function that builds the execution host list and deploys workers to new hosts.

**Files:**
- Modify: `manager.js`

- [ ] **Step 1: Add buildExecHosts to manager.js**

Add this function after `fitAndExec`, before `main`:

```js
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
```

Update `main()` to test this function:
```js
/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const deployedHosts = new Set(["home"]);
  const allServers    = scanNetwork(ns);
  const execHosts     = buildExecHosts(ns, allServers, deployedHosts);
  ns.tprint("Exec hosts this cycle:");
  for (const { host, freeRam } of execHosts) {
    ns.tprint(`  ${host}: ${freeRam.toFixed(1)} GB free`);
  }
}
```

- [ ] **Step 2: Verify**

```
run manager.js
```
Expected: home listed with RAM minus reserved amount. Any newly rooted servers should trigger `[deploy]` log lines and appear next run.

Run it a second time:
```
run manager.js
```
Servers from the first run should now appear as exec hosts.

- [ ] **Step 3: Commit**

```
git add manager.js
git commit -m "feat: add buildExecHosts to manager.js"
```

---

## Task 6: manager.js — pickTargets

Add the scoring and target-selection function.

**Files:**
- Modify: `manager.js`

- [ ] **Step 1: Add pickTargets to manager.js**

Add after `buildExecHosts`, before `main`:

```js
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
```

Update `main()` to test:
```js
/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const allServers = scanNetwork(ns);
  const targets    = pickTargets(ns, allServers, TOP_TARGETS);
  if (targets.length === 0) {
    ns.tprint("No eligible targets — check root access and hack level");
    return;
  }
  ns.tprint(`Top ${targets.length} target(s):`);
  for (const host of targets) {
    const s     = ns.getServer(host);
    const score = s.moneyMax * ns.hackAnalyzeChance(host) / ns.getWeakenTime(host);
    ns.tprint(`  ${host}: $${(s.moneyMax/1e6).toFixed(1)}m | score=${score.toFixed(4)}`);
  }
}
```

- [ ] **Step 2: Verify**

```
run manager.js
```
Expected: a ranked list of servers. Higher-money, lower-security servers should rank first.
In very early BN1 (no crackers), this may show only 1 target (e.g. `n00dles`). That's correct.

- [ ] **Step 3: Commit**

```
git add manager.js
git commit -m "feat: add pickTargets scorer to manager.js"
```

---

## Task 7: manager.js — dispatchPrep

Add the prep-phase dispatcher. This brings a target to minimum security and maximum money before farming begins.

**Files:**
- Modify: `manager.js`

- [ ] **Step 1: Add dispatchPrep to manager.js**

Add after `pickTargets`, before `main`:

```js
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
```

Update `main()` to test (dispatches prep for the top target):
```js
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
```

- [ ] **Step 2: Verify**

```
run manager.js
```
Expected log line: `[prep] foodnstuff | sec 10.0→1.0 | money $0.1m→$2.0m | w1=180 g=10 w2=1`
(Numbers depend on server and game state.)

Check workers are running:
```
ps
```
Expected: `weaken.js` and `grow.js` running across various hosts.

Wait for the weaken cycle to complete, then check the server:
```
serverinfo foodnstuff
```
Security should be at or near `minDifficulty`; money at or near `moneyMax`.

- [ ] **Step 3: Commit**

```
git add manager.js
git commit -m "feat: add dispatchPrep to manager.js"
```

---

## Task 8: manager.js — dispatchFarm

Add the farm-phase dispatcher. This sends one HWGW batch with staggered delays so all four workers complete in the correct order.

**Files:**
- Modify: `manager.js`

- [ ] **Step 1: Add dispatchFarm to manager.js**

Add after `dispatchPrep`, before `main`:

```js
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

  ns.print(
    `[farm] ${target} | ` +
    `h=${hackThreads}(+${hackDelay}ms) ` +
    `w1=${weaken1Threads} ` +
    `g=${growThreads}(+${growDelay}ms) ` +
    `w2=${weaken2Threads}(+${weaken2Delay}ms)`
  );

  fitAndExec(ns, execHosts, "hack.js",   hackThreads,    [target, hackDelay]);
  fitAndExec(ns, execHosts, "weaken.js", weaken1Threads, [target, weaken1Delay]);
  fitAndExec(ns, execHosts, "grow.js",   growThreads,    [target, growDelay]);
  fitAndExec(ns, execHosts, "weaken.js", weaken2Threads, [target, weaken2Delay]);
}
```

Update `main()` to test (assumes target is already prepped from Task 7):
```js
/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const deployedHosts = new Set(["home"]);
  const allServers    = scanNetwork(ns);
  const execHosts     = buildExecHosts(ns, allServers, deployedHosts);
  const targets       = pickTargets(ns, allServers, 1);
  if (targets.length === 0) { ns.tprint("No targets"); return; }
  const target      = targets[0];
  const server      = ns.getServer(target);
  const weakenTime  = ns.getWeakenTime(target);
  dispatchFarm(ns, target, server, execHosts, weakenTime);
  ns.tprint(`Farm batch dispatched for ${target}. Weaken time: ${(weakenTime/1000).toFixed(1)}s`);
}
```

- [ ] **Step 2: Verify**

First, ensure the target is prepped (run the prep test from Task 7 and wait for it to finish).

Then:
```
run manager.js
```
Expected: `[farm] foodnstuff | h=5(+45200ms) w1=1 g=8(+62400ms) w2=1(+400ms)`
(Numbers vary by server and hack level.)

Wait for one full weaken cycle, then check:
```
serverinfo foodnstuff
```
Security should remain near `minDifficulty`. Money should still be near `moneyMax` (hack stole some, grow restored it).

- [ ] **Step 3: Commit**

```
git add manager.js
git commit -m "feat: add dispatchFarm HWGW batch dispatcher to manager.js"
```

---

## Task 9: manager.js — Complete Main Loop

Replace the test stub in `main()` with the full persistent orchestration loop.

**Files:**
- Modify: `manager.js` (replace `main()` only — all helper functions stay unchanged)

- [ ] **Step 1: Kill any running test instances**

```
kill manager.js
```

- [ ] **Step 2: Replace main() with the full loop**

Replace the entire current `main()` function at the bottom of `manager.js` with:

```js
/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.print("=== manager.js started ===");

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
      if (ns.exec("root.js", "home", 1) === 0) {
        ns.print("WARN: root.js failed to launch (already running, or file missing)");
      }
      lastRootTime = now;
    }

    // ── 2. Discover all servers ───────────────────────────────────────────────
    const allServers = scanNetwork(ns);

    // ── 3. Build exec host list; deploy workers to new hosts ─────────────────
    const execHosts = buildExecHosts(ns, allServers, deployedHosts);

    // ── 4. Score and select top targets ──────────────────────────────────────
    const targets = pickTargets(ns, allServers, TOP_TARGETS);

    if (targets.length === 0) {
      ns.print("No eligible targets yet. Retrying in 10s...");
      await ns.sleep(10_000);
      continue;
    }

    // ── 5. Dispatch batches ───────────────────────────────────────────────────
    let maxWeakenTime = 0;

    for (const target of targets) {
      const server      = ns.getServer(target);
      const weakenTime  = ns.getWeakenTime(target);
      maxWeakenTime     = Math.max(maxWeakenTime, weakenTime);

      // Drift check: if a farming target has degraded, demote it back to prep.
      // This handles unexpected security spikes or money drops between cycles.
      if (targetPhase.get(target) === "farm") {
        const moneyDrifted = server.moneyAvailable < server.moneyMax * DRIFT_MONEY_FLOOR;
        const secDrifted   = server.hackDifficulty  > server.minDifficulty + DRIFT_SEC_CEILING;
        if (moneyDrifted || secDrifted) {
          targetPhase.set(target, "prep");
          ns.print(
            `[drift] ${target} → re-prep | ` +
            `money=${(server.moneyAvailable / server.moneyMax * 100).toFixed(0)}% | ` +
            `sec=${server.hackDifficulty.toFixed(1)}`
          );
        }
      }

      const phase = targetPhase.get(target) ?? "prep";

      if (phase === "prep") {
        // Check if target is already at minSec + maxMoney (e.g. after a game reload).
        // If so, skip straight to farm without wasting threads on an unnecessary prep.
        const isReady = server.hackDifficulty <= server.minDifficulty + 0.1 &&
                        server.moneyAvailable >= server.moneyMax * 0.99;
        if (isReady) {
          targetPhase.set(target, "farm");
          ns.print(`[ready] ${target} is prepped → starting farm`);
          // fall through to farm dispatch below
        } else {
          dispatchPrep(ns, target, server, execHosts);
          continue; // don't farm until prep completes next cycle
        }
      }

      // Phase is "farm" — either it was already, or just promoted above.
      dispatchFarm(ns, target, server, execHosts, weakenTime);
    }

    // ── 6. Sleep until all batch workers should be done ──────────────────────
    // Use the slowest target's weaken time + a 1s buffer so no old workers are
    // still running when we re-dispatch next cycle.
    const sleepMs = Math.max(CYCLE_SLEEP_MS, maxWeakenTime + 1_000);
    ns.print(
      `[cycle] ${targets.length} target(s) | ` +
      `sleep ${(sleepMs / 1_000).toFixed(1)}s`
    );
    await ns.sleep(sleepMs);
  }
}
```

- [ ] **Step 3: Commit**

```
git add manager.js
git commit -m "feat: complete manager.js main orchestration loop"
```

---

## Task 10: End-to-End Verification

Confirm the full system works from a clean start.

**Files:** None (verification only)

- [ ] **Step 1: Kill all running scripts**

```
killall
```

- [ ] **Step 2: Start the manager**

```
run manager.js
```

- [ ] **Step 3: Confirm root.js fires on startup**

Open the manager.js log window. Within a few seconds you should see:
```
=== manager.js started ===
[cycle] N target(s) | sleep XX.Xs
```
After the first minute, `root.js` should briefly appear in `ps` output and then exit.

- [ ] **Step 4: Confirm deploy.js runs for new hosts**

Look for log lines like:
```
[deploy] Queuing workers → n00dles
```
Then verify on that server:
```
ls n00dles
```
Expected: `hack.js`, `grow.js`, `weaken.js` present.

- [ ] **Step 5: Watch a target move through prep → farm**

Tail the manager log. Over 2–3 cycles expect:
```
[prep] foodnstuff | sec 10.0→1.0 | money $0.1m→$2.0m | w1=180 g=10 w2=1
[cycle] 3 target(s) | sleep 92.3s
[ready] foodnstuff is prepped → starting farm
[farm] foodnstuff | h=5(+45200ms) w1=1 g=8(+62400ms) w2=1(+400ms)
```

- [ ] **Step 6: Confirm security stability after farming**

After 2 farm cycles on the same target:
```
serverinfo foodnstuff
```
Security should remain at or near `minDifficulty`. Money should remain near `moneyMax`.
If either has drifted badly, check logs for `[drift]` entries and investigate whether thread counts are sufficient.

- [ ] **Step 7: Confirm money is increasing**

Check the `money sources` panel (top bar) or run:
```
money
```
The `scripts` income line should be incrementing each second once farm batches are active.

- [ ] **Step 8: Commit any fixes found during verification**

```
git add -p
git commit -m "fix: issues found during E2E verification"
```
