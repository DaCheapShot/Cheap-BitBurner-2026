# Continuous Batcher Design

**Date:** 2026-06-01  
**File:** `manager.js`

## Problem

The current manager runs a "cycle and wait" loop: dispatch all N batches at once (shotgun), then sleep `weakenTime + (N-1)*200ms + 1s` until all workers finish. Two consequences:

1. **Slow drift recovery** — a target that drifts below thresholds isn't noticed until the big sleep ends (up to ~60s late).
2. **Idle freed RAM** — workers from early batches finish and free their RAM mid-sleep, but the manager is sleeping. That RAM sits unused until the next cycle.

## Goal

Transform the loop into a continuous batcher that:
- Dispatches one batch per farming target every 200ms
- Detects drift within one tick (200ms)
- Reclaims freed RAM within one tick

## Approach: Single-batch-per-tick (Option A)

Replace the big sleep with `await ns.sleep(BATCH_PADDING_MS)` (200ms always). Dispatch exactly **1 batch per target per tick**. The `batchOffset = i * batchPeriod` term is **removed entirely** — because each batch is dispatched 200ms after the previous one, dispatch timing itself provides the correct 200ms stagger between batch completions. Worker delays become fixed constants per target:

```
hackAddlMs   = max(0, weakenTime - hackTime)
growAddlMs   = max(0, weakenTime - growTime)
weakenAddlMs = 0
```

`maxEndMs` is removed. `stackBatches` is renamed `dispatchOneBatch` with the N-loop removed. The thin `dispatchFarm` wrapper is removed; the main loop calls `dispatchOneBatch` directly.

## Interval structure

| Work | Interval | Notes |
|---|---|---|
| `ramMgr.refresh` + drift check + 1-batch dispatch | 200ms (every tick) | Core continuous loop |
| `scanNetwork` + `pickTargets` + `formulasAvailable` + stale-state prune | 5s | `SCAN_INTERVAL_MS = 5_000` |
| `ns.clearLog()` | 5s (in scan block) | Avoids unreadable flashing |
| `root.js` relaunch | 60s (before refresh) | `ROOT_INTERVAL_MS = 60_000` — no RAM needed |
| Share dispatch | 60s (after refresh) | Same cadence as root.js; gated by `lastRootTime` just-set check |
| `contracts.js` | 60s | Moves from per-tick; `CONTRACTS_INTERVAL_MS = 60_000` |

Two new state vars: `lastScanTime = 0`, `lastContractsTime = 0`. `lastRootTime` already exists.

`allServers`, `targets`, and `formulasAvailable` are cached between 5s scans. `ramMgr.refresh(ns, allServers, deployedHosts)` uses the cached `allServers` on per-tick calls; new hosts won't appear until the next 5s scan (acceptable).

## Main loop skeleton

```
while (true) {
  now = Date.now()

  // 60s: root.js (no RAM snapshot needed — just exec)
  if (now - lastRootTime >= ROOT_INTERVAL_MS) {
    ns.exec("root.js", ...)
    lastRootTime = now
  }

  // 5s: heavy scan work
  if (now - lastScanTime >= SCAN_INTERVAL_MS) {
    allServers = scanNetwork(ns)
    formulasAvailable = ns.fileExists("Formulas.exe", "home")
    targets = pickTargets(ns, allServers, TOP_TARGETS)
    // prune stale targetPhase / prepEndMs / batchCounter for dropped targets
    ns.clearLog()
    lastScanTime = now
  }

  // 60s: contracts
  if (now - lastContractsTime >= CONTRACTS_INTERVAL_MS) {
    ns.exec("contracts.js", ...)
    lastContractsTime = now
  }

  if (targets.length === 0) { await ns.sleep(CYCLE_SLEEP_MS); continue }

  // Fresh RAM snapshot — must come before share set-aside and batch dispatch
  ramMgr.refresh(ns, allServers, deployedHosts)

  // 60s: share dispatch — after refresh so setAsideForShare sees current free RAM
  if (shareEnabled && now - lastRootTime < BATCH_PADDING_MS) {
    // fires in the same tick as root.js (lastRootTime was just set above)
    shareThreads = ramMgr.setAsideForShare(SHARE_RAM_PCT, SCRIPT_RAM["share.js"])
    ramMgr.allocateLive(ns, "share.js", shareThreads, [ROOT_INTERVAL_MS + SHARE_MS])
  }

  for (target of targets) {
    // drift check → maybe demote to prep
    // prep guard (prepEndMs) → dispatchPrep if needed → continue
    // farm: dispatchOneBatch(...)
  }

  await ns.sleep(BATCH_PADDING_MS)
}
```

Note: share dispatch is gated by checking that `lastRootTime` was just updated this tick (`now - lastRootTime < BATCH_PADDING_MS`). This avoids a separate `lastShareTime` variable — share fires on the same 60s cadence as root.js, always after `ramMgr.refresh()`.

## Per-target state changes

New `Map`: `prepEndMs`. After `dispatchPrep` succeeds, set:

```
prepEndMs.set(target, now + weakenTime + 5_000)
```

On each tick, skip prep dispatch if `now < (prepEndMs.get(target) ?? 0)` — workers are still in flight. Clear `prepEndMs` on:
- Drift demote (so prep re-fires immediately next tick)
- Promotion to farm

If `dispatchPrep` returns false (RAM exhausted), do not set `prepEndMs` — retry next tick.

New `Map`: `batchCounter` — per-target integer, increments each successful dispatch, wraps at 10,000. Replaces the loop variable `i` in worker args `[target, addlMs, "farm", batchIdx]` for `ps()` visibility.

## Share threading

`ns.share()` is a fixed 10-second call. Share.js loops calling it until a deadline arg is exceeded. Dispatching for less than 10s means it exits immediately without running.

Share dispatch fires on the same 60s cadence as root.js but is positioned AFTER `ramMgr.refresh()` in the loop so `setAsideForShare` sees a fresh snapshot. It is gated by checking that `lastRootTime` was just updated in the current tick.

Duration arg passed to share.js:
```
ROOT_INTERVAL_MS + SHARE_MS = 60_000 + 10_000 = 70_000ms
```

The 10s buffer ensures the next wave is already running before the previous one expires — no gap, no overlap beyond that buffer.

On subsequent per-tick calls, `ramMgr.refresh()` reads live `ramUsed`, which includes running share.js workers. Batch dispatch naturally sees reduced free RAM without any set-aside needed on non-share ticks.

## What is removed

- `maxEndMs` — no longer needed; sleep is always `BATCH_PADDING_MS`
- `batchOffset = i * batchPeriod` — dispatch timing is the stagger
- N-loop in `stackBatches` — replaced by single dispatch in `dispatchOneBatch`
- `dispatchFarm` wrapper function — inlined into main loop
- `contracts.js` exec from every-cycle — moved to 60s timer

## New constants

```js
const SCAN_INTERVAL_MS      = 5_000;
const CONTRACTS_INTERVAL_MS = 60_000;
const SHARE_MS              = 10_000; // ns.share() fixed duration — for share deadline calc
```

## Throughput note

The 200ms tick = `BATCH_PADDING_MS` is deliberate. Steady-state concurrent batches = `floor(weakenTime / 200ms)`. Increasing the tick interval reduces throughput proportionally. When RAM-constrained (can't fill the full pipeline), throughput is RAM-limited regardless of tick rate.
