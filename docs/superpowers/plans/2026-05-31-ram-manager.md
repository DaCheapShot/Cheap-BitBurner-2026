# RamManager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `manager.js` to consolidate all RAM tracking, allocation, and home-reserve math into a single `RamManager` class, and add a pre-flight `canFit()` check before each batch dispatch.

**Architecture:** The `RamManager` class is added inside `manager.js` in three incremental layers — snapshot + summary helpers, then allocation, then pre-flight checks — each committed independently. `buildExecHosts()` and `fitAndExec()` are deleted once replaced.

**Tech Stack:** Plain Bitburner JavaScript. No build system, no test runner. Verification is manual: commit → push → `run sync.js` in-game → `run manager.js --debug` → check `manager.log.txt`.

---

### Task 1: Add RamManager class (constructor + refresh + summary helpers)

Adds the class without touching any existing code. The game continues running via the old `buildExecHosts` + `fitAndExec` path after this commit.

**Files:**
- Modify: `manager.js` (insert after `makeLogger`, before `// ─── Utility helpers`)

- [ ] **Step 1: Insert RamManager class**

Add this block immediately after the closing `}` of `makeLogger` (after line 91) and before the `// ─── Utility helpers` comment:

```js
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
```

- [ ] **Step 2: Commit**

```bash
git add manager.js
git commit -m "feat: add RamManager class (constructor, refresh, summary helpers)"
```

---

### Task 2: Wire RamManager into main loop; replace buildExecHosts + fitAndExec

Removes both old functions and switches all callsites. After this commit `execHosts` is gone; the class owns all RAM state.

**Files:**
- Modify: `manager.js`

- [ ] **Step 1: Add allocate() method inside RamManager class**

Insert after `hostCount()`, still inside the class body:

```js
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
  }
```

- [ ] **Step 2: Replace the entire dispatchPrep function**

Replace the function starting `function dispatchPrep(ns, target, server, execHosts)` with:

```js
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

  ramMgr.allocate(ns, "weaken.js", weaken1Threads, [target, 0]);
  ramMgr.allocate(ns, "grow.js",   growThreads,    [target, 0]);
  ramMgr.allocate(ns, "weaken.js", weaken2Threads, [target, 0]);
}
```

- [ ] **Step 3: Replace the entire dispatchFarm function**

Replace the function starting `function dispatchFarm(ns, target, server, execHosts, weakenTime)` with:

```js
function dispatchFarm(ns, target, server, ramMgr, weakenTime) {
  const hackTime = ns.getHackTime(target);
  const growTime = ns.getGrowTime(target);

  const hackThreads    = Math.max(1, Math.floor(
    ns.hackAnalyzeThreads(target, server.moneyMax * HACK_STEAL_PCT)
  ));
  const weaken1Threads = Math.max(1, Math.ceil(hackThreads * 0.002 / 0.05));
  const restoreMult    = 1 / (1 - HACK_STEAL_PCT);
  const growThreads    = Math.max(1, Math.ceil(ns.growthAnalyze(target, restoreMult)));
  const weaken2Threads = Math.max(1, Math.ceil(growThreads * 0.004 / 0.05));

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

  ramMgr.allocate(ns, "hack.js",   hackThreads,    [target, hackDelay]);
  ramMgr.allocate(ns, "weaken.js", weaken1Threads, [target, weaken1Delay]);
  ramMgr.allocate(ns, "grow.js",   growThreads,    [target, growDelay]);
  ramMgr.allocate(ns, "weaken.js", weaken2Threads, [target, weaken2Delay]);
}
```

- [ ] **Step 4: Update main() — create ramMgr instance**

In `main()`, after the line `let lastRootTime = 0;` and before the `while (true) {` line, insert:

```js
  const ramMgr = new RamManager({ homeReserveGb: HOME_RESERVE_GB, homeReservePct: HOME_RESERVE_PCT });
```

- [ ] **Step 5: Update main() — replace buildExecHosts call and log line**

Inside the `while` loop, replace this block:

```js
    // ── 3. Build exec host list; deploy workers to new hosts ─────────────────
    const execHosts    = buildExecHosts(ns, allServers, deployedHosts);
    const totalFreeRam = execHosts.reduce((sum, e) => sum + e.freeRam, 0);
    log.info(`[hosts] ${execHosts.length} exec host(s) | ${totalFreeRam.toFixed(1)}GB total free`);
```

with:

```js
    // ── 3. Build exec host list; deploy workers to new hosts ─────────────────
    ramMgr.refresh(ns, allServers, deployedHosts);
    log.info(`[hosts] ${ramMgr.hostCount()} exec host(s) | ${ramMgr.totalFree().toFixed(1)}GB total free`);
```

- [ ] **Step 6: Update main() — fix dispatchPrep and dispatchFarm call sites**

Replace:

```js
          dispatchPrep(ns, target, server, execHosts);
```

with:

```js
          dispatchPrep(ns, target, server, ramMgr);
```

Replace:

```js
      dispatchFarm(ns, target, server, execHosts, weakenTime);
```

with:

```js
      dispatchFarm(ns, target, server, ramMgr, weakenTime);
```

- [ ] **Step 7: Delete fitAndExec() and buildExecHosts() functions**

Remove the entire `function fitAndExec(ns, execHosts, script, totalThreads, args) { ... }` block.

Remove the entire `function buildExecHosts(ns, allServers, deployedHosts) { ... }` block.

Both are fully replaced by `RamManager`.

- [ ] **Step 8: Commit**

```bash
git add manager.js
git commit -m "refactor: replace buildExecHosts + fitAndExec with RamManager"
```

- [ ] **Step 9: Verify in game**

```
run sync.js
run manager.js --debug
```

Check `manager.log.txt` after one full cycle. Expected:
- `[hosts] N exec host(s) | X.XGB total free` — same format, same numbers as before
- `[deploy] Queuing workers → <host>` for any new hosts
- `[prep]` or `[farm]` lines for each target (unchanged)
- `[fit]` debug lines per host per allocation (unchanged format)
- No `WARN:` lines about undeployed threads unless RAM is genuinely tight

---

### Task 3: Add canFit() and pre-flight checks

Adds the pre-flight visibility check before each `allocate()` call. Behavior is unchanged — partial fit still proceeds. New `WARN:` lines surface when a script can't be fully placed.

**Files:**
- Modify: `manager.js`

- [ ] **Step 1: Add canFit() method inside RamManager class**

Insert after `hostCount()`, inside the class body:

```js
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
```

- [ ] **Step 2: Add pre-flight checks in dispatchPrep**

Replace the three `ramMgr.allocate` calls at the bottom of `dispatchPrep` with:

```js
  const w1Fit = ramMgr.canFit("weaken.js", weaken1Threads);
  if (w1Fit < weaken1Threads) log.warn(`[prep] ${target}: only ${w1Fit}/${weaken1Threads} weaken1 threads fit`);
  ramMgr.allocate(ns, "weaken.js", weaken1Threads, [target, 0]);

  const gFit = ramMgr.canFit("grow.js", growThreads);
  if (gFit < growThreads) log.warn(`[prep] ${target}: only ${gFit}/${growThreads} grow threads fit`);
  ramMgr.allocate(ns, "grow.js", growThreads, [target, 0]);

  const w2Fit = ramMgr.canFit("weaken.js", weaken2Threads);
  if (w2Fit < weaken2Threads) log.warn(`[prep] ${target}: only ${w2Fit}/${weaken2Threads} weaken2 threads fit`);
  ramMgr.allocate(ns, "weaken.js", weaken2Threads, [target, 0]);
```

- [ ] **Step 3: Add pre-flight checks in dispatchFarm**

Replace the four `ramMgr.allocate` calls at the bottom of `dispatchFarm` with:

```js
  const hFit = ramMgr.canFit("hack.js", hackThreads);
  if (hFit < hackThreads) log.warn(`[farm] ${target}: only ${hFit}/${hackThreads} hack threads fit`);
  ramMgr.allocate(ns, "hack.js", hackThreads, [target, hackDelay]);

  const w1Fit = ramMgr.canFit("weaken.js", weaken1Threads);
  if (w1Fit < weaken1Threads) log.warn(`[farm] ${target}: only ${w1Fit}/${weaken1Threads} weaken1 threads fit`);
  ramMgr.allocate(ns, "weaken.js", weaken1Threads, [target, weaken1Delay]);

  const gFit = ramMgr.canFit("grow.js", growThreads);
  if (gFit < growThreads) log.warn(`[farm] ${target}: only ${gFit}/${growThreads} grow threads fit`);
  ramMgr.allocate(ns, "grow.js", growThreads, [target, growDelay]);

  const w2Fit = ramMgr.canFit("weaken.js", weaken2Threads);
  if (w2Fit < weaken2Threads) log.warn(`[farm] ${target}: only ${w2Fit}/${weaken2Threads} weaken2 threads fit`);
  ramMgr.allocate(ns, "weaken.js", weaken2Threads, [target, weaken2Delay]);
```

- [ ] **Step 4: Commit**

```bash
git add manager.js
git commit -m "feat: add RamManager.canFit() pre-flight checks in dispatch functions"
```

- [ ] **Step 5: Verify in game**

```
run sync.js
run manager.js --debug
```

Check `manager.log.txt`:
- If RAM is plentiful: no new `WARN:` lines (canFit returns full thread count for all scripts)
- If RAM is tight: `WARN:` lines like `[farm] n00dles: only 3/5 hack threads fit` appear immediately before the corresponding `[fit]` debug lines
- `allocate` still proceeds and places what it can — no behavior change, only visibility
