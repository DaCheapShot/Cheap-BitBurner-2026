# HWGW Batch Stacking + HGW Mode + Dynamic Steal% Design

**Date:** 2026-06-01
**Scope:** `manager.js` only — no new files

---

## Problem

The current manager dispatches one HWGW batch per target then sleeps for `maxWeakenTime + 1000ms`. Workers finish quickly and RAM sits idle for most of the cycle. With 5 targets and a large RAM pool, the majority of available capacity is wasted.

---

## Goals

1. Stack multiple complete batches per target per cycle to fill available RAM.
2. Switch to HGW (3-script batches) when `Formulas.exe` is available — one weaken covers all security delta.
3. Make `HACK_STEAL_PCT` dynamic and RAM-driven: best target claims the highest steal% that fits, subsequent targets use what remains.
4. All-or-nothing batch deployment: never dispatch a partial batch.

---

## Architecture

All changes are in `manager.js`. Two new helper functions replace the guts of `dispatchFarm`.

### New functions

**`calcBatchPlan(ns, target, stealPct, formulasAvailable)`**

Pure calculation — no NS side effects. Returns:
```js
{ hackT, weaken1T, growT, weaken2T, totalRam }
```

- **HWGW mode** (`formulasAvailable = false`):
  - `weaken1T = ceil(hackT × 0.002 / 0.05)` — counteracts hack security increase
  - `weaken2T = ceil(growT × 0.004 / 0.05)` — counteracts grow security increase
  - `totalRam = hackT×hack.ram + weaken1T×weaken.ram + growT×grow.ram + weaken2T×weaken.ram`

- **HGW mode** (`formulasAvailable = true`):
  - `weaken1T = ceil((hackT × 0.002 + growT × 0.004) / 0.05)` — covers both security deltas combined
  - `weaken2T = 0`
  - `totalRam = hackT×hack.ram + weaken1T×weaken.ram + growT×grow.ram`

**`stackBatches(ns, target, server, ramMgr, weakenTime, formulasAvailable)`**

Owns the dynamic steal% search and the stacking loop. Returns the number of complete batches dispatched.

**`dispatchFarm`** (simplified)

Thin caller: calls `stackBatches`, logs result. No batch logic of its own.

### Formulas detection

```js
const formulasAvailable = ns.fileExists("Formulas.exe", "home");
```

Called once at the top of each main loop cycle and passed to `dispatchFarm` → `stackBatches` → `calcBatchPlan`.

---

## Dynamic Steal% Algorithm

`stackBatches` searches for the highest steal% where at least one complete batch fits in currently available RAM:

```
for stealPct from STEAL_PCT_MAX → STEAL_PCT_MIN, step -STEAL_PCT_STEP:
    plan = calcBatchPlan(ns, target, stealPct, formulasAvailable)
    N    = floor(ramMgr.totalFree() / plan.totalRam)
    if N >= 1:
        use this stealPct, dispatch N batches
        break
if no stealPct worked:
    log warn, skip target
```

**Per-target greedy allocation:** targets are processed in score order (best first). The top target searches first against the full RAM pool and claims as many batches as fit at the highest steal% possible. Each subsequent target searches against whatever RAM remains. This ensures the highest-value target always gets the most resources.

### New tuning constants (replaces `HACK_STEAL_PCT`)

| Constant | Default | Purpose |
|---|---|---|
| `STEAL_PCT_MAX` | 0.95 | Highest steal% to try |
| `STEAL_PCT_MIN` | 0.10 | Floor — don't go below this |
| `STEAL_PCT_STEP` | 0.05 | Decrement between attempts |

---

## Batch Stacking with All-or-Nothing Constraint

Once `stealPct` and `N` are determined, batches are dispatched in a loop:

```
numOps = formulasAvailable ? 3 : 4
for i from 0 to N-1:
    batchOffset = i × BATCH_PADDING_MS × numOps

    // All-or-nothing gate
    for each script in batch:
        if ramMgr.canFit(script, threads) < threads:
            log warn "stopped at batch i — RAM exhausted"
            break outer

    // Allocate all scripts with timing delays + batchOffset
    allocate hack    at (weakenTime - hackTime   - BATCH_PADDING_MS      + batchOffset)
    allocate weaken1 at (0                                                + batchOffset)
    allocate grow    at (weakenTime - growTime   + BATCH_PADDING_MS      + batchOffset)
    allocate weaken2 at (BATCH_PADDING_MS × 2                            + batchOffset)  // HWGW only
```

**Batch period:** `BATCH_PADDING_MS × numOps`
- HWGW: 800ms per batch (4 slots × 200ms)
- HGW:  600ms per batch (3 slots × 200ms)

The `canFit` check before each `allocate` call is the all-or-nothing gate. Even if `N` was calculated correctly, RAM may have shifted (another target already allocated), so the check catches any shortfall and stops before deploying a broken partial batch.

---

## Batch Timing Diagrams

### HWGW (no Formulas.exe)
```
Batch 0:  W1──────┤  H──────┤  G──────┤  W2──────┤
          T+0     T+200    T+400    T+600

Batch 1:  W1──────┤  H──────┤  G──────┤  W2──────┤
          T+800   T+1000   T+1200   T+1400
```

### HGW (Formulas.exe available)
```
Batch 0:  W───────┤  H──────┤  G──────┤
          T+0     T+200    T+400

Batch 1:  W───────┤  H──────┤  G──────┤
          T+600   T+800    T+1000
```

---

## What Does NOT Change

- `prepDispatch` — prep logic is unchanged
- `RamManager` class — unchanged
- `pickTargets` scoring — unchanged
- `root.js`, `buy.js`, `contracts.js`, workers — unchanged
- Cycle sleep: still `max(CYCLE_SLEEP_MS, maxWeakenTime + 1000)`
- Drift detection thresholds — unchanged
