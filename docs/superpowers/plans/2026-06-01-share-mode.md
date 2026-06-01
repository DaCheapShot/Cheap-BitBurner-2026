# Share Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add runtime-togglable share mode to manager.js that reserves 20% of available RAM for ns.share() threads each cycle, boosting faction rep gain without stopping HWGW farming.

**Architecture:** Two new scripts (share.js worker, ctrl.js config writer) plus changes to manager.js. Runtime config lives in NS port 1 as a JSON string. RamManager gets two new methods: `setAsideForShare()` carves 20% of the snapshot out before HWGW dispatch; `allocateLive()` places share threads using live server state after HWGW has consumed the snapshot.

**Tech Stack:** Bitburner NetscriptJS (NS API). No build step, no test runner — verification is done in-game via the Bitburner terminal. Sync changes with `run sync.js`.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `share.js` | Create | Time-bounded share worker — runs ns.share() until a deadline, then exits |
| `ctrl.js` | Create | Runtime config writer — reads/merges/writes port 1 config |
| `manager.js` | Modify | Constants, SCRIPT_RAM, RamManager methods, main loop share integration |

---

### Task 1: Create share.js

**Files:**
- Create: `share.js`

- [ ] **Step 1: Write share.js**

```js
/** @param {NS} ns */
export async function main(ns) {
  const duration = Number(ns.args[0] ?? 60_000);
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    await ns.share();
  }
}
```

- [ ] **Step 2: Add share.js to deploy.js workers list**

`deploy.js` copies worker scripts to remote hosts via `ns.scp`. share.js must be included or `allocateLive()` will fail to exec it on any non-home host.

In `deploy.js` line 18, change:
```js
  const workers = ["hack.js", "grow.js", "weaken.js"];
```
to:
```js
  const workers = ["hack.js", "grow.js", "weaken.js", "share.js"];
```

- [ ] **Step 3: Sync and verify share.js in-game**

In Bitburner terminal:
```
run sync.js
run share.js 5000
```
Expected: script appears in Active Scripts showing 2.4 GB RAM per thread, exits cleanly after ~5 seconds.

- [ ] **Step 4: Commit**

```bash
git add share.js deploy.js
git commit -m "feat: add time-bounded share.js worker; include in deploy.js"
```

---

### Task 2: Create ctrl.js

**Files:**
- Create: `ctrl.js`

- [ ] **Step 1: Write ctrl.js**

```js
/** @param {NS} ns */
export async function main(ns) {
  const CONFIG_PORT = 1;
  const [key, val]  = ns.args;
  const port        = ns.getPortHandle(CONFIG_PORT);

  if (!key || key === "status") {
    const raw = port.empty() ? "NULL" : port.peek();
    const cfg = raw === "NULL" ? {} : JSON.parse(raw);
    ns.tprint(`Config: ${JSON.stringify(cfg)}`);
    return;
  }

  const raw = port.empty() ? "NULL" : port.read();
  const cfg = raw === "NULL" ? {} : JSON.parse(raw);
  cfg[key]  = val === "on" || val === "true";
  port.write(JSON.stringify(cfg));
  ns.tprint(`Config: ${JSON.stringify(cfg)}`);
}
```

- [ ] **Step 2: Sync and verify status on empty port**

```
run sync.js
run ctrl.js status
```
Expected terminal output: `Config: {}`

- [ ] **Step 3: Verify toggle on**

```
run ctrl.js share on
```
Expected: `Config: {"share":true}`

- [ ] **Step 4: Verify config persists across reads**

```
run ctrl.js status
```
Expected: `Config: {"share":true}` — port still holds the value after peek.

- [ ] **Step 5: Verify toggle off**

```
run ctrl.js share off
```
Expected: `Config: {"share":false}`

- [ ] **Step 6: Verify port does not stack items**

Run `ctrl.js share on` three times in a row, then:
```
run ctrl.js status
```
Expected: `Config: {"share":true}` with no errors. Port holds exactly one item — each ctrl.js run reads before writing so it never accumulates.

- [ ] **Step 7: Commit**

```bash
git add ctrl.js
git commit -m "feat: add ctrl.js runtime config writer for port 1"
```

---

### Task 3: Add RamManager.setAsideForShare() and allocateLive()

**Files:**
- Modify: `manager.js` — inside the `RamManager` class, after the `allocate()` method (after line 211, before the closing `}` of the class at line 212)

- [ ] **Step 1: Add the two methods to RamManager**

Insert after the closing brace of `allocate()` at line 211, before the class closing brace:

```js
  /**
   * Reserve share threads from the snapshot before HWGW dispatch.
   * Computes floor(totalFree * pct / shareRam) threads, deducts their exact
   * RAM from the snapshot in host order, and returns the thread count.
   * Hosts with less than shareRam GB free are skipped — no fractional waste.
   */
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

  /**
   * Allocate threads using live server state, bypassing the snapshot.
   * Used for share threads after HWGW dispatch has consumed the snapshot's
   * freeRam — live state still reflects the GB that setAsideForShare carved out.
   */
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
```

- [ ] **Step 2: Sync and verify manager still starts cleanly**

```
run sync.js
run manager.js
```
Expected: manager starts and cycles normally. No new errors in manager.log.txt. The new methods are not yet called so behavior is unchanged.

- [ ] **Step 3: Commit**

```bash
git add manager.js
git commit -m "feat: add setAsideForShare and allocateLive to RamManager"
```

---

### Task 4: Wire share mode into manager.js main loop

**Files:**
- Modify: `manager.js` — constants block (~line 62), SCRIPT_RAM map (~line 65), `main()` function

- [ ] **Step 1: Add new constants**

After `HOME_RESERVE_PCT = 0.10` at line 62, add:

```js
// Port number for runtime config (ctrl.js writes; manager.js peeks each cycle).
const CONFIG_PORT   = 1;

// Fraction of free RAM reserved for ns.share() threads when share mode is on.
const SHARE_RAM_PCT = 0.20;
```

- [ ] **Step 2: Add share.js to the SCRIPT_RAM map**

Change line 65 from:
```js
const SCRIPT_RAM = { "hack.js": 0, "grow.js": 0, "weaken.js": 0, "deploy.js": 0 };
```
to:
```js
const SCRIPT_RAM = { "hack.js": 0, "grow.js": 0, "weaken.js": 0, "deploy.js": 0, "share.js": 0 };
```

- [ ] **Step 3: Populate SCRIPT_RAM["share.js"] at startup**

In `main()`, find the four existing `ns.getScriptRam()` calls (~lines 444–447) and add a fifth:
```js
SCRIPT_RAM["share.js"]  = ns.getScriptRam("share.js");
```

Update the log line immediately after to include share:
```js
log.info(`[init] Script RAM — hack=${SCRIPT_RAM["hack.js"]}GB grow=${SCRIPT_RAM["grow.js"]}GB weaken=${SCRIPT_RAM["weaken.js"]}GB deploy=${SCRIPT_RAM["deploy.js"]}GB share=${SCRIPT_RAM["share.js"]}GB`);
```

- [ ] **Step 4: Peek config port at top of main loop**

In the `while (true)` loop, immediately after `const now = Date.now();` (~line 473), add:

```js
    // ── 0. Read runtime config ────────────────────────────────────────────────
    const cfgRaw       = ns.getPortHandle(CONFIG_PORT).peek();
    const cfg          = cfgRaw === "NULL" ? {} : JSON.parse(cfgRaw);
    const shareEnabled = cfg.share === true;
```

Note: `ns.getPortHandle(n).peek()` returns the string `"NULL"` when the port is empty (Bitburner default). No need to call `.empty()` first.

- [ ] **Step 5: Reserve share RAM after ramMgr.refresh()**

Find this line (~line 499):
```js
    log.info(`[hosts] ${ramMgr.hostCount()} exec host(s) | ${ramMgr.totalFree().toFixed(1)}GB total free`);
```

Add immediately after it:
```js
    // ── 3b. Reserve share RAM before HWGW dispatch ────────────────────────────
    let shareThreads = 0;
    if (shareEnabled) {
      shareThreads = ramMgr.setAsideForShare(SHARE_RAM_PCT, SCRIPT_RAM["share.js"]);
      log.info(`[share] ON — reserved ${(shareThreads * SCRIPT_RAM["share.js"]).toFixed(1)}GB for ${shareThreads} share threads`);
    }
```

- [ ] **Step 6: Dispatch share threads after sleepMs is calculated**

Find these two lines near the end of the loop (~lines 560–562):
```js
    const sleepMs = Math.max(CYCLE_SLEEP_MS, maxEndMs + 1_000);
    log.info(`[cycle] ${targets.length} target(s) | sleep ${ns.format.time(sleepMs)}`);
    await ns.sleep(sleepMs);
```

Insert between the `log.info` and `await ns.sleep` lines:
```js
    if (shareEnabled && shareThreads > 0) {
      const placed = ramMgr.allocateLive(ns, "share.js", shareThreads, [sleepMs]);
      log.debug(`[share] ${placed}/${shareThreads} threads placed for ${ns.format.time(sleepMs)}`);
    }
```

- [ ] **Step 7: Sync and verify with share disabled**

```
run sync.js
run ctrl.js share off
run manager.js
```

Wait one full cycle, then check manager.log.txt. Expected: no `[share]` lines. Cycle behavior identical to before.

- [ ] **Step 8: Enable share and verify in-game**

```
run ctrl.js share on
```

Wait for the next manager cycle to start (manager reads the port at cycle top). Check manager.log.txt for:
- `[share] ON — reserved X.XGB for N share threads`

Check Active Scripts — share.js processes should appear with 2.4 GB × N threads, then exit when the cycle sleep ends.

- [ ] **Step 9: Disable share and verify clean shutdown**

```
run ctrl.js share off
```

Wait for next cycle. `[share]` reservation lines stop appearing. No new share.js processes in Active Scripts (existing ones from the previous cycle expire naturally).

- [ ] **Step 10: Commit**

```bash
git add manager.js
git commit -m "feat: wire share mode into manager.js main loop"
```

---

### Task 5: Update manager.js header RAM cost comment

**Files:**
- Modify: `manager.js` — header comment (lines 1–28)

- [ ] **Step 1: Measure actual ns.getPortHandle() RAM cost in-game**

In Bitburner terminal:
```
mem manager.js
```
The output shows total script RAM. Compare to the value listed in the header comment. The difference is the cost of `ns.getPortHandle()`. (Expected: 10 GB in most Bitburner versions — verify against actual output.)

- [ ] **Step 2: Update the header comment**

In the RAM breakdown comment at the top of manager.js, add a row for the new NS function and update the total. Using 10 GB as the expected value (adjust if mem output differs):

```js
 *   ns.getPortHandle()      10.00 GB  — runtime config port peek each cycle
```

Update the Total line from:
```js
 *   Total: ~8.70 GB + 1.60 GB base = ~10.30 GB
```
to:
```js
 *   Total: ~18.70 GB + 1.60 GB base = ~20.30 GB
```

If the actual measured cost differs from 10 GB, use the measured value instead.

- [ ] **Step 3: Commit**

```bash
git add manager.js
git commit -m "docs: update manager.js header with ns.getPortHandle RAM cost"
```
