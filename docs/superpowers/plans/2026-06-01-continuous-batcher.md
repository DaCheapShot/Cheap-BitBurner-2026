# Continuous Batcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform manager.js from a "dispatch-all-then-sleep-weakenTime" cycle into a 200ms continuous loop that dispatches one batch per farming target per tick.

**Architecture:** Replace `stackBatches` (N-batch shotgun) with `dispatchOneBatch` (single batch, no offset — dispatch timing provides stagger). Heavy periodic work (scan, contracts, share) moves onto interval timers so the tight 200ms tick only does drift checks and one-batch dispatch. New per-target `prepEndMs` and `batchCounter` Maps guard prep re-dispatch and track batch indices.

**Tech Stack:** Bitburner NetscriptJS — no build step, no test runner. Verification is done in-game: sync via `run sync.js`, run `manager.js --debug`, observe `manager.log.txt`.

---

## File map

| File | Change |
|---|---|
| `manager.js` | All changes — single file |
| `sync.js` | No change needed |

---

## Task 1: Add new constants and state variables

**Files:**
- Modify: `manager.js:31-73` (constants block), `manager.js:507-516` (state init in `main`)

- [ ] **Step 1: Add three new constants after the existing constants block (around line 70)**

```js
// ─── Continuous batcher intervals ────────────────────────────────────────────

// How often to re-scan the network, re-score targets, and prune stale state.
const SCAN_INTERVAL_MS = 5_000;

// How often to re-run contracts.js (same cadence as root.js is fine).
const CONTRACTS_INTERVAL_MS = 60_000;

// Fixed duration of one ns.share() call — used to calculate share thread deadline.
const SHARE_MS = 10_000;
```

- [ ] **Step 2: Add new state Maps and cached variables inside `main()`, alongside the existing `targetPhase` and `lastRootTime` declarations (around line 512)**

Replace this block:
```js
  const targetPhase = new Map();

  // Timestamp of last root.js launch (ms). Initialized to 0 so it fires on first cycle.
  let lastRootTime = 0;
  const ramMgr = new RamManager({ homeReserveGb: HOME_RESERVE_GB, homeReservePct: HOME_RESERVE_PCT });
```

With:
```js
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
```

- [ ] **Step 3: Sync and run to confirm startup still works**

In-game terminal:
```
run sync.js
run manager.js --debug
```

Expected: manager starts, prints `=== manager.js started ===`, no errors.

- [ ] **Step 4: Commit**

```
git add manager.js
git commit -m "refactor: add continuous batcher constants and state vars"
```

---

## Task 2: Extract 5-second scan block

Move `scanNetwork`, `pickTargets`, `formulasAvailable`, `ns.clearLog()`, and stale-target pruning out of the every-cycle path into a 5s interval guard. The loop variable declarations (`const allServers`, `const targets`, `const formulasAvailable`) become reads of the cached `let` vars declared in Task 1.

**Files:**
- Modify: `manager.js:518-566` (main loop, sections 1b–4)

- [ ] **Step 1: Replace the always-running scan code inside the `while (true)` loop**

Find and remove these lines (currently executed every cycle, around lines 538–566):
```js
    // ── 1b. Scan for and solve contracts ─────────────────────────────────────
    ns.exec("contracts.js", "home", 1);

    // ── 2. Discover all servers ───────────────────────────────────────────────
    const allServers = scanNetwork(ns);

    // ── 2b. Detect Formulas.exe ───────────────────────────────────────────────
    const formulasAvailable = ns.fileExists("Formulas.exe", "home");
    log.debug(`[cycle] mode=${formulasAvailable ? "HGW" : "HWGW"}`);

    // ── 3. Build exec host list; deploy workers to new hosts ─────────────────
    ramMgr.refresh(ns, allServers, deployedHosts);
    log.info(`[hosts] ${ramMgr.hostCount()} exec host(s) | ${ramMgr.totalFree().toFixed(1)}GB total free`);

    // ── 3b. Reserve share RAM before HWGW dispatch ────────────────────────────
    let shareThreads = 0;
    if (shareEnabled) {
      shareThreads = ramMgr.setAsideForShare(SHARE_RAM_PCT, SCRIPT_RAM["share.js"]);
      log.info(`[share] ON — reserved ${(shareThreads * SCRIPT_RAM["share.js"]).toFixed(1)}GB for ${shareThreads} share threads`);
    }

    // ── 4. Score and select top targets ──────────────────────────────────────
    const targets = pickTargets(ns, allServers, TOP_TARGETS);

    if (targets.length === 0) {
      log.warn("no eligible targets yet — retrying in 10s");
      await ns.sleep(10_000);
      continue;
    }
```

Replace with:
```js
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
```

Also remove the `ns.clearLog()` call at the very end of the loop (currently after the big sleep), since clearLog now lives in the scan block.

- [ ] **Step 2: Move `ramMgr.refresh` to just before the per-target loop (where section 3 was)**

After the `targets.length === 0` guard, add:
```js
    // ── 3. Refresh RAM snapshot (every tick) ─────────────────────────────────
    ramMgr.refresh(ns, allServers, deployedHosts);
    log.debug(`[hosts] ${ramMgr.hostCount()} exec host(s) | ${ramMgr.totalFree().toFixed(1)}GB total free`);
```

- [ ] **Step 3: Sync and verify**

In-game:
```
run sync.js
run manager.js --debug
```

Open `manager.log.txt`. Expected:
- `[scan]` log line appears once on startup, then every ~5s
- `[hosts]` log line appears every cycle (still running the old big sleep for now)
- Batching behaviour unchanged

- [ ] **Step 4: Commit**

```
git add manager.js
git commit -m "refactor: move scan/score/prune into 5s interval block"
```

---

## Task 3: Move contracts.js to 60-second timer

**Files:**
- Modify: `manager.js` — contracts exec line

- [ ] **Step 1: Replace the always-running contracts exec with a 60s guard**

Find (currently removed from Task 2, but if still present):
```js
    ns.exec("contracts.js", "home", 1);
```

Add this block after the root.js 60s check:
```js
    // ── 1b. 60s: Solve contracts ─────────────────────────────────────────────
    if (now - lastContractsTime >= CONTRACTS_INTERVAL_MS) {
      ns.exec("contracts.js", "home", 1);
      lastContractsTime = now;
    }
```

- [ ] **Step 2: Sync and verify**

In-game:
```
run sync.js
run manager.js --debug
```

In `manager.log.txt`: contracts should no longer spam every cycle. It fires once at startup (~t=0 since `lastContractsTime=0`), then every 60s.

- [ ] **Step 3: Commit**

```
git add manager.js
git commit -m "refactor: move contracts.js exec to 60s timer"
```

---

## Task 4: Replace `stackBatches` + `dispatchFarm` with `dispatchOneBatch`

Remove the N-batch loop and `batchOffset`. Add a `batchIdx` parameter. The steal% search now checks per-script `canFit` instead of `totalFree / totalRam`. Remove the thin `dispatchFarm` wrapper.

**Files:**
- Modify: `manager.js:409-475` (`stackBatches`, `dispatchFarm`)

- [ ] **Step 1: Delete `stackBatches` (lines 409–471) and `dispatchFarm` (lines 473–475) entirely**

- [ ] **Step 2: Add `dispatchOneBatch` in their place**

```js
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
```

- [ ] **Step 3: Update the farm dispatch call in the main loop**

Find (around line 608):
```js
      // Phase is "farm" — either it was already, or just promoted above.
      const batches = dispatchFarm(ns, target, server, ramMgr, weakenTime, formulasAvailable);
      if (batches > 0) {
        const endMs = weakenTime + (batches - 1) * BATCH_PADDING_MS;
        maxEndMs = Math.max(maxEndMs, endMs);
      }
```

Replace with:
```js
      // Phase is "farm" — either it was already, or just promoted above.
      dispatchOneBatch(ns, target, server, ramMgr, weakenTime, formulasAvailable, 0);
```

(batchIdx is hardcoded to `0` for now — Task 6 will wire up `batchCounter`.)

- [ ] **Step 4: Update `maxEndMs` to account for the single-batch return**

`maxEndMs` is still used to compute the sleep at the end of the loop. Since we now dispatch at most 1 batch per target, update its calculation:

Find:
```js
    // ── 5. Dispatch batches ───────────────────────────────────────────────────
    let maxEndMs = 0;
```

Keep `maxEndMs` for now — it will be `weakenTime` (1 batch, offset=0), which makes the big sleep `weakenTime + 1_000`. This is correct intermediate behaviour.

- [ ] **Step 5: Sync and verify**

In-game:
```
run sync.js
run manager.js --debug
```

In `manager.log.txt`: `[farm]` lines should show `batch#0` and dispatch exactly 1 batch per target per cycle. The manager still sleeps ~weakenTime between cycles at this point.

- [ ] **Step 6: Commit**

```
git add manager.js
git commit -m "refactor: replace stackBatches with dispatchOneBatch — single batch, no offset"
```

---

## Task 5: Add `prepEndMs` in-flight guard

Prevents prep from being re-dispatched every tick while workers are still running.

**Files:**
- Modify: `manager.js` — per-target loop (prep branch)

- [ ] **Step 1: Add the guard, set, and clear logic in the per-target loop**

Find the prep `else` branch (currently around the `dispatchPrep` call):
```js
        } else {
          if (dispatchPrep(ns, target, server, ramMgr))
            maxEndMs = Math.max(maxEndMs, weakenTime);
          continue; // don't farm until prep completes next cycle
        }
```

Replace with:
```js
        } else {
          // Guard: skip if prep workers are still expected to be in flight
          if (now < (prepEndMs.get(target) ?? 0)) continue;

          if (dispatchPrep(ns, target, server, ramMgr)) {
            prepEndMs.set(target, now + weakenTime + 5_000);
          }
          continue;
        }
```

- [ ] **Step 2: Clear `prepEndMs` on drift demote**

Find the drift demote block:
```js
          targetPhase.set(target, "prep");
          log.info(
            `[drift] ${target} → re-prep | ` +
```

Add `prepEndMs.delete(target);` immediately after `targetPhase.set(target, "prep");`:
```js
          targetPhase.set(target, "prep");
          prepEndMs.delete(target); // allow immediate re-dispatch of prep
          log.info(
            `[drift] ${target} → re-prep | ` +
```

- [ ] **Step 3: Clear `prepEndMs` on farm promotion**

Find the farm promotion block:
```js
          targetPhase.set(target, "farm");
          log.info(`[ready] ${target} is prepped → starting farm`);
```

Add `prepEndMs.delete(target);` after `targetPhase.set(target, "farm");`:
```js
          targetPhase.set(target, "farm");
          prepEndMs.delete(target);
          log.info(`[ready] ${target} is prepped → starting farm`);
```

- [ ] **Step 4: Remove the now-unused `maxEndMs = Math.max(maxEndMs, weakenTime)` line from the prep branch**

The old prep line `maxEndMs = Math.max(maxEndMs, weakenTime);` was already replaced in Step 1 above.

- [ ] **Step 5: Sync and verify**

In-game: kill and restart manager, let a target reach prep phase. Observe `manager.log.txt`:
- `[prep]` line fires once, then is silent until `prepEndMs` expires (~weakenTime + 5s later)
- After expiry, `[prep]` fires again if still not ready

- [ ] **Step 6: Commit**

```
git add manager.js
git commit -m "feat: add prepEndMs guard to prevent prep re-dispatch while in flight"
```

---

## Task 6: Add `batchCounter` tracking

Wire up the per-target batch index so `ps()` shows incrementing batch numbers.

**Files:**
- Modify: `manager.js` — farm dispatch call in per-target loop

- [ ] **Step 1: Replace the hardcoded `0` batchIdx with `batchCounter` reads/writes**

Find (from Task 4):
```js
      // Phase is "farm" — either it was already, or just promoted above.
      dispatchOneBatch(ns, target, server, ramMgr, weakenTime, formulasAvailable, 0);
```

Replace with:
```js
      // Phase is "farm" — either it was already, or just promoted above.
      const batchIdx   = batchCounter.get(target) ?? 0;
      const dispatched = dispatchOneBatch(ns, target, server, ramMgr, weakenTime, formulasAvailable, batchIdx);
      if (dispatched) {
        batchCounter.set(target, (batchIdx + 1) % 10_000);
      }
```

- [ ] **Step 2: Sync and verify**

In-game:
```
run sync.js
run manager.js --debug
```

In `manager.log.txt`: `[farm]` lines should show `batch#0`, `batch#1`, `batch#2` ... incrementing each cycle. (Still running big sleep, so it increments once per weakenTime for now.)

In-game terminal: `ps` on a worker host should show `[target, addlMs, "farm", N]` with different N values for running workers.

- [ ] **Step 3: Commit**

```
git add manager.js
git commit -m "feat: add batchCounter for per-target batch index tracking"
```

---

## Task 7: Restructure share dispatch

Move share threading from the end-of-cycle sleep block to after `ramMgr.refresh()`, gated on the 60s root.js timer firing.

**Files:**
- Modify: `manager.js` — share set-aside block (currently around line 553) and end-of-loop share dispatch (around line 618)

- [ ] **Step 1: Remove the old share set-aside block**

Find and delete this block (currently near the top of the loop after ramMgr.refresh):
```js
    // ── 3b. Reserve share RAM before HWGW dispatch ────────────────────────────
    let shareThreads = 0;
    if (shareEnabled) {
      shareThreads = ramMgr.setAsideForShare(SHARE_RAM_PCT, SCRIPT_RAM["share.js"]);
      log.info(`[share] ON — reserved ${(shareThreads * SCRIPT_RAM["share.js"]).toFixed(1)}GB for ${shareThreads} share threads`);
    }
```

- [ ] **Step 2: Remove the old end-of-loop share dispatch**

Find and delete this block (currently just before `await ns.sleep(sleepMs)`):
```js
    if (shareEnabled && shareThreads > 0) {
      const placed = ramMgr.allocateLive(ns, "share.js", shareThreads, [sleepMs]);
      log.debug(`[share] ${placed}/${shareThreads} threads placed for ${ns.format.time(sleepMs)}`);
    }
```

- [ ] **Step 3: Add new share dispatch after `ramMgr.refresh()`, gated by `lastRootTime` just-set**

After the `ramMgr.refresh()` call and its debug log, add:
```js
    // ── 4b. 60s: Share dispatch — fires in the same tick as root.js, after refresh
    // Gated by lastRootTime < BATCH_PADDING_MS: true only in the tick where root.js fired.
    if (shareEnabled && now - lastRootTime < BATCH_PADDING_MS) {
      const shareThreads = ramMgr.setAsideForShare(SHARE_RAM_PCT, SCRIPT_RAM["share.js"]);
      if (shareThreads > 0) {
        const placed = ramMgr.allocateLive(ns, "share.js", shareThreads, [ROOT_INTERVAL_MS + SHARE_MS]);
        log.info(`[share] ON — ${placed}/${shareThreads} threads placed for ${ns.tFormat(ROOT_INTERVAL_MS + SHARE_MS)}`);
      }
    }
```

Note: `ns.tFormat` is the Bitburner helper for formatting milliseconds to a human-readable string (e.g. "1 minute 10 seconds"). Use `ns.tFormat` if `ns.format.time` is unavailable in your version; they are equivalent.

- [ ] **Step 4: Sync and verify**

Enable share mode: `run ctrl.js share on`

In-game: kill and restart manager. After 60s, `manager.log.txt` should show a `[share]` line. Subsequent checks: `ps` on worker hosts should include `share.js` processes.

- [ ] **Step 5: Commit**

```
git add manager.js
git commit -m "refactor: move share dispatch to 60s post-refresh block"
```

---

## Task 8: Replace big sleep with 200ms tick

This is the final cutover. Remove `maxEndMs`, the `sleepMs` calculation, the big `await ns.sleep(sleepMs)`, and replace with `await ns.sleep(BATCH_PADDING_MS)`.

**Files:**
- Modify: `manager.js` — end of main loop (currently around lines 569, 616–624)

- [ ] **Step 1: Remove `maxEndMs` initialization and all writes to it**

Delete:
```js
    // ── 5. Dispatch batches ───────────────────────────────────────────────────
    let maxEndMs = 0;
```

Also remove the remaining `maxEndMs` write in the prep branch if any still exist (there should be none after Task 5).

- [ ] **Step 2: Replace the big sleep block with a 200ms sleep**

Find:
```js
    // ── 6. Sleep until all batch workers should be done ──────────────────────
    const sleepMs = Math.max(CYCLE_SLEEP_MS, maxEndMs + 1_000);
    log.info(`[cycle] ${targets.length} target(s) | sleep ${ns.format.time(sleepMs)}`);
    await ns.sleep(sleepMs);
    ns.clearLog();
```

Replace with:
```js
    // ── 6. Tick sleep — 200ms between batch dispatches ───────────────────────
    await ns.sleep(BATCH_PADDING_MS);
```

- [ ] **Step 3: Sync and verify continuous behaviour**

In-game:
```
run sync.js
kill manager.js
run manager.js --debug
```

Observe `manager.log.txt`. Expected signs of continuous operation:
- `[farm]` lines appear at ~200ms cadence (log will be very verbose in debug mode — use `tail` or the in-game log window)
- `batch#N` increments every 200ms per target
- `[scan]` appears every ~5s
- `[prep]` fires once per target then is quiet until `prepEndMs` expires

Run for 2–3 minutes and check:
- Targets promoted from prep → farm without full 60s wait
- Workers visible via `ps` on exec hosts with ascending batch indices
- No `WARN` spam about RAM exhaustion (unless truly RAM-limited)

- [ ] **Step 4: Test drift recovery speed**

If comfortable modifying `DRIFT_MONEY_FLOOR` temporarily to `0.99` (almost always triggers), restart manager and verify `[drift]` fires within one tick (appears in log within 200ms of starting farm). Reset to `0.90` after.

- [ ] **Step 5: Commit**

```
git add manager.js
git commit -m "feat: continuous batcher — replace big sleep with 200ms tick"
```

---

## Self-review checklist

- [x] **5s scan block** — Task 2
- [x] **60s contracts** — Task 3
- [x] **60s root.js** — unchanged, already existed
- [x] **`dispatchOneBatch`** — Task 4 (no N-loop, no batchOffset, batchIdx param, canFit-based steal% search)
- [x] **`prepEndMs` guard** — Task 5 (set on dispatch, cleared on drift demote + farm promotion)
- [x] **`batchCounter`** — Task 6
- [x] **Share dispatch** — Task 7 (gated by `lastRootTime < BATCH_PADDING_MS`, duration `ROOT_INTERVAL_MS + SHARE_MS`)
- [x] **200ms sleep** — Task 8 (maxEndMs removed, sleepMs removed)
- [x] **`dispatchFarm` removed** — Task 4
- [x] **`ns.clearLog()` moved to scan block** — Task 2
- [x] **Cached `allServers`, `targets`, `formulasAvailable`** — Task 1 + 2