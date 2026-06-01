# Shotgun Batching Design

**Date:** 2026-06-01
**Branch:** worktree-shotgun-batching

## Problem

The current HWGW batching in `manager.js` spaces batches 800ms apart (`batchPeriod = BATCH_PADDING_MS * numOps = 200 * 4`). This means for a target with `weakenTime = 100s`, we can fit at most 125 batches per cycle window. In late-game nodes with abundant RAM across many purchased servers, this leaves 3 out of every 4 possible 200ms slots unused, capping throughput at 25% of what the hardware could support.

## Solution: Shotgun Batching

Fold both the batch stagger and the duration padding into a single `additionalMsec` arg on every worker. No sleep is needed. Each operation starts immediately and takes exactly `weakenTime + i*200ms` total:

```
weaken1 batch i:  additionalMsec = i * 200ms
hack    batch i:  additionalMsec = (weakenTime - hackTime) + i * 200ms
grow    batch i:  additionalMsec = (weakenTime - growTime) + i * 200ms
weaken2 batch i:  additionalMsec = i * 200ms
```

All four ops complete at `weakenTime + i * 200ms`. Since Bitburner's JS event loop is single-threaded, ops dispatched in order resolve in dispatch order (W1 → H → G → W2) within the same tick. `batchPeriod` shrinks from 800ms to 200ms — 4× more batches per cycle when RAM is not the bottleneck.

All three workers end up with an identical 2-arg interface (`target`, `additionalMsec`).

Early bitnodes remain RAM-limited; the change has no negative effect there. Late game with abundant purchased-server RAM, throughput scales up to 4×.

This approach is also the natural foundation for a future continuous-manager upgrade (Option C): each batch occupies one 200ms slot, making slot-registry tracking straightforward.

## Files Changed

| File | Change |
|---|---|
| `hack.js` | Replace `sleep(delay); ns.hack(target)` with `ns.hack(target, { additionalMsec })` |
| `grow.js` | Replace `sleep(delay); ns.grow(target)` with `ns.grow(target, { additionalMsec })` |
| `weaken.js` | Replace `sleep(delay); ns.weaken(target)` with `ns.weaken(target, { additionalMsec })` |
| `manager.js` | Rewrite timing in `stackBatches`; update `endMs` in `main()` |

## Worker Interface (all three workers, unified)

```
args[0]  target         string   hostname to operate on (required)
args[1]  additionalMsec number   ms to add to the NS operation duration (default 0)
```

No `delay` arg. No `label` or `batchIndex` — removed since they were unused by worker logic and passing extra args to `ns.exec` is still possible for ps() readability if desired later.

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
const batchPeriod   = BATCH_PADDING_MS;                        // 200ms — same for HGW and HWGW
const batchOffset   = i * batchPeriod;
const hackAddlMs    = Math.max(0, weakenTime - hackTime) + batchOffset;
const growAddlMs    = Math.max(0, weakenTime - growTime) + batchOffset;
const weakenAddlMs  = batchOffset;

// HWGW (formulasAvailable = false): dispatch H, W1, G, W2
allocate("hack.js",   hackT,    [target, hackAddlMs]);
allocate("weaken.js", weaken1T, [target, weakenAddlMs]);
allocate("grow.js",   growT,    [target, growAddlMs]);
if (weaken2T > 0)
  allocate("weaken.js", weaken2T, [target, weakenAddlMs]);

// HGW (formulasAvailable = true, weaken2T = 0): dispatch H, G, W1
allocate("hack.js",   hackT,    [target, hackAddlMs]);
allocate("grow.js",   growT,    [target, growAddlMs]);
allocate("weaken.js", weaken1T, [target, weakenAddlMs]);
```

All ops complete at `weakenTime + batchOffset`, ordered by JS event loop in dispatch sequence.

**Why dispatch order matters:** since `additionalMsec` makes all ops land simultaneously, JS resolves them in the order they were exec'd. W1 and W2 are sized to counter only their paired operation. If a weaken fires from `minSecurity` (before its paired op has raised it), it gets clamped and its effect is wasted — security ends the batch above min.

| Mode | Dispatch order | Completion order | Why |
|---|---|---|---|
| HWGW | H, W1, G, W2 | H → W1 → G → W2 | W1 counters H immediately; W2 counters G immediately |
| HGW  | H, G, W1     | H → G → W1      | Single W1 handles both deltas; must fire after both H and G |

### maxEndMs calculation
```js
// Before: weakenTime + BATCH_PADDING_MS * (numOps - 2) + (batches - 1) * batchPeriod
// After:  weakenTime + (batches - 1) * batchPeriod
const endMs = weakenTime + (batches - 1) * batchPeriod;
```

## Ordering Improvement

The current approach lands H 200ms before W1, which is correct for HWGW (H raises security, W1 counters it). The shotgun preserves this for HWGW (H → W1 → G → W2). For HGW, the current code uses H → W1 → G — which is subtly wrong: W1 fires before G, so it overcorrects from `min + hackDelta` down toward min and gets partially clamped, leaving G's security increase uncountered. Security drifts up by `growDelta` per batch until the drift check triggers a re-prep. The shotgun fixes HGW by using H → G → W1, where the single weaken fires last and correctly neutralizes both increases.

## Compatibility with Future Option C

Each batch occupies exactly one 200ms slot at `weakenTime + i * 200ms`. A continuous slot-registry manager (Option C) just needs to track which of those slots are already booked. No worker interface changes are needed for that upgrade.

## Constraints

- `Math.max(0, weakenTime - hackTime)` and `Math.max(0, weakenTime - growTime)` guard against negative values if op times exceed weakenTime (impossible in practice, but defensive).
- `batchPeriod` change also affects the `endMs` calculation in `main()` — that inline calculation must be updated alongside `stackBatches`.
- `numOps` in both `stackBatches` and the `main()` dispatch loop is only used for `batchPeriod` and `endMs` — both of which change to no longer need it. Remove `numOps` from both sites.
- `sync.js` does not need updating (no new files).
- Prep workers (`dispatchPrep`) pass `delay=0` today and are unaffected — prep calls weaken/grow with no timing constraints, and `additionalMsec=0` is the default.
