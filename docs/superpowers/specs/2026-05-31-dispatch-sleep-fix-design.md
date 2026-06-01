# Dispatch Sleep Fix Design
**Date:** 2026-05-31
**Version:** Bitburner 3.0.1
**Status:** Approved

---

## Problem

`manager.js` sleeps for `max(CYCLE_SLEEP_MS, maxWeakenTime + 1000)` at the end of each cycle. `maxWeakenTime` is updated unconditionally after calling `dispatchPrep` or `dispatchFarm`, even when RAM exhaustion caused zero threads to be placed. This causes unnecessarily long sleeps (up to the full weaken time of a slow target) when no workers are actually running for that target.

---

## Fix

Three targeted changes to `manager.js`:

### 1. `allocate()` returns placed thread count

Add `return threads - remaining;` at the end of `RamManager.allocate()`. The value is already computed; this just surfaces it to callers.

### 2. Dispatch functions return bool

`dispatchPrep` and `dispatchFarm` sum the return values of their `allocate()` calls and return `true` if any threads were placed (total > 0).

### 3. Main loop gates `maxWeakenTime` on dispatch return

```js
if (dispatchPrep(ns, target, server, ramMgr)) {
  maxWeakenTime = Math.max(maxWeakenTime, weakenTime);
}
// same for dispatchFarm
```

`maxWeakenTime` only grows when at least one worker thread is actually running for a target. A target with zero RAM placed is ignored for sleep purposes.

---

## Behavior

- **Partial dispatch** (e.g. weaken1 runs, grow can't fit): `allocate()` returns > 0 for the weaken call → dispatch returns `true` → `weakenTime` included. Correct — the weaken script IS running and must finish before the next cycle redispatches.
- **Zero dispatch** (no RAM at all): all `allocate()` calls return 0 → dispatch returns `false` → `weakenTime` excluded. Cycle sleeps only as long as other targets' workers require.
- **No changes to canFit pre-flight checks, RamManager state, or any other logic.**
