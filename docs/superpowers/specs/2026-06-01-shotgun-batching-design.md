# Shotgun Batching Design

**Date:** 2026-06-01
**Branch:** worktree-shotgun-batching

## Problem

The current HWGW batching in `manager.js` spaces batches 800ms apart (`batchPeriod = BATCH_PADDING_MS * numOps = 200 * 4`). This means for a target with `weakenTime = 100s`, we can fit at most 125 batches per cycle window. In late-game nodes with abundant RAM across many purchased servers, this leaves 3 out of every 4 possible 200ms slots unused, capping throughput at 25% of what the hardware could support.

## Solution: Shotgun Batching

Use `additionalMsec` in `ns.hack()` and `ns.grow()` to pad those operations to exactly `weakenTime`. All four ops in a batch share the same start delay (`i * 200ms`). Since Bitburner's JS event loop is single-threaded, ops dispatched in order resolve in dispatch order (W1 → H → G → W2) within the same tick. This shrinks `batchPeriod` from 800ms to 200ms — 4× more batches per cycle when RAM is not the bottleneck.

Early bitnodes remain RAM-limited; the change has no negative effect there. Late game with abundant purchased-server RAM, throughput scales up to 4×.

This approach is also the natural foundation for a future continuous-manager upgrade (Option C): each batch occupies one 200ms slot, making slot-registry tracking straightforward.

## Files Changed

| File | Change |
|---|---|
| `hack.js` | Add `additionalMsec = ns.args[2] ?? 0`; pass to `ns.hack(target, { additionalMsec })` |
| `grow.js` | Add `additionalMsec = ns.args[2] ?? 0`; pass to `ns.grow(target, { additionalMsec })` |
| `weaken.js` | No change |
| `manager.js` | Rewrite timing in `stackBatches` |

## Worker Interface

### hack.js (new)
```
args[0]  target         string   hostname to hack
args[1]  delay          number   ms to sleep before acting
args[2]  additionalMsec number   ms to pad operation (default 0)
args[3]  label          string   phase label for ps() readability
args[4]  batchIndex     number   batch index for ps() readability
```

### grow.js (new)
```
args[0]  target         string   hostname to grow
args[1]  delay          number   ms to sleep before acting
args[2]  additionalMsec number   ms to pad operation (default 0)
args[3]  label          string   phase label for ps() readability
args[4]  batchIndex     number   batch index for ps() readability
```

### weaken.js (unchanged)
```
args[0]  target         string   hostname to weaken
args[1]  delay          number   ms to sleep before acting
args[2]  label          string   phase label for ps() readability
args[3]  batchIndex     number   batch index for ps() readability
```

## Timing Logic (stackBatches)

### Before
```js
const batchPeriod   = BATCH_PADDING_MS * numOps;              // 800ms
const hackDelay     = Math.max(0, weakenTime - hackTime - BATCH_PADDING_MS + offset);
const weaken1Delay  = offset;
const growDelay     = Math.max(0, weakenTime - growTime + BATCH_PADDING_MS + offset);
const weaken2Delay  = BATCH_PADDING_MS * 2 + offset;
// allocate: [target, delay, label, i]
```

Completion order: H → W1 → G → W2 (H fires 200ms before W1).

### After
```js
const batchPeriod   = BATCH_PADDING_MS;                       // 200ms
const delay         = i * batchPeriod;
const hackAddlMs    = Math.max(0, weakenTime - hackTime);
const growAddlMs    = Math.max(0, weakenTime - growTime);
// allocate weaken1: [target, delay,             label, i]
// allocate hack:    [target, delay, hackAddlMs, label, i]
// allocate grow:    [target, delay, growAddlMs, label, i]
// allocate weaken2: [target, delay,             label, i]
```

Completion order: W1 → H → G → W2 (all complete at `weakenTime + delay`, ordered by JS event loop).

### maxEndMs calculation
```js
// Before: weakenTime + BATCH_PADDING_MS * (numOps - 2) + (batches - 1) * batchPeriod
// After:  weakenTime + (batches - 1) * batchPeriod
const endMs = weakenTime + (batches - 1) * batchPeriod;
```

## Ordering Improvement

The current approach lands H 200ms before W1 within the same batch. At steady state this works (H sees min security from the previous batch's W2), but it relies on cross-batch state. The shotgun lands W1 first, then H — each batch is self-contained. This is a more robust guarantee and matches standard HWGW guidance.

## Compatibility with Future Option C

Each batch occupies exactly one 200ms slot at `weakenTime + i * 200ms`. A continuous slot-registry manager (Option C) just needs to track which of those slots are already booked. No worker interface changes are needed for that upgrade.

## Constraints

- `additionalMsec` is only passed to `hack.js` and `grow.js`, not `weaken.js` (weaken is already the reference duration).
- `Math.max(0, ...)` guards against `hackAddlMs` / `growAddlMs` going negative if `hackTime > weakenTime` (impossible in practice, but defensive).
- `batchPeriod` change also affects the `maxEndMs` calculation in `main()` — that inline calculation must be updated alongside `stackBatches`.
- `sync.js` does not need updating (no new files).
- `numOps` in both `stackBatches` and the `main()` dispatch loop is only used for `batchPeriod` and `endMs` — both of which change to no longer need it. Remove `numOps` from both sites to avoid dead code.
