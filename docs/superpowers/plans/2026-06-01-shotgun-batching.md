# Shotgun Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace delay-based HWGW timing with `additionalMsec`-based shotgun batching to achieve 4× batch density in RAM-abundant late-game scenarios.

**Architecture:** All three workers drop their `sleep(delay)` pattern and instead take a single `additionalMsec` argument passed directly to their NS call. `stackBatches` in `manager.js` folds batch stagger and duration padding into one `additionalMsec` value per worker, reducing `batchPeriod` from 800ms to 200ms. Dispatch order is mode-dependent: HWGW uses H→W1→G→W2 and HGW uses H→G→W1, so each weaken fires after its paired operation(s) have raised security.

**Tech Stack:** Bitburner NetscriptJS (game-native). No build step, no test runner — verification is in-game via `manager.log.txt` and live monitoring.

---

### Task 1: Update all three worker scripts

**Files:**
- Modify: `hack.js`
- Modify: `grow.js`
- Modify: `weaken.js`

- [ ] **Step 1: Rewrite hack.js**

Replace the entire file:

```js
/**
 * hack.js — steal money from a target server, then exit.
 * RAM: 1.60 GB base + 0.10 GB (ns.hack) = 1.70 GB per thread.
 *
 * Args:
 *   ns.args[0] {string} target          — hostname to hack (required)
 *   ns.args[1] {number} additionalMsec  — ms to add to operation duration (default 0)
 */
/** @param {NS} ns */
export async function main(ns) {
  const target         = /** @type {string} */ (ns.args[0]);
  const additionalMsec = /** @type {number} */ (ns.args[1] ?? 0);
  await ns.hack(target, { additionalMsec });
}
```

- [ ] **Step 2: Rewrite grow.js**

Replace the entire file:

```js
/**
 * grow.js — increase money on a target server, then exit.
 * RAM: 1.60 GB base + 0.15 GB (ns.grow) = 1.75 GB per thread.
 *
 * Args:
 *   ns.args[0] {string} target          — hostname to grow (required)
 *   ns.args[1] {number} additionalMsec  — ms to add to operation duration (default 0)
 */
/** @param {NS} ns */
export async function main(ns) {
  const target         = /** @type {string} */ (ns.args[0]);
  const additionalMsec = /** @type {number} */ (ns.args[1] ?? 0);
  await ns.grow(target, { additionalMsec });
}
```

- [ ] **Step 3: Rewrite weaken.js**

Replace the entire file:

```js
/**
 * weaken.js — reduce security on a target server, then exit.
 * RAM: 1.60 GB base + 0.15 GB (ns.weaken) = 1.75 GB per thread.
 *
 * Args:
 *   ns.args[0] {string} target          — hostname to weaken (required)
 *   ns.args[1] {number} additionalMsec  — ms to add to operation duration (default 0)
 */
/** @param {NS} ns */
export async function main(ns) {
  const target         = /** @type {string} */ (ns.args[0]);
  const additionalMsec = /** @type {number} */ (ns.args[1] ?? 0);
  await ns.weaken(target, { additionalMsec });
}
```

- [ ] **Step 4: Commit**

```bash
git add hack.js grow.js weaken.js
git commit -m "feat: replace sleep+delay with additionalMsec in all workers"
```

---

### Task 2: Rewrite stackBatches timing and dispatch order

**Files:**
- Modify: `manager.js` lines 409–468 (`stackBatches` function body)

- [ ] **Step 1: Remove numOps, update batchPeriod**

In `stackBatches`, around line 413, find:

```js
const numOps      = formulasAvailable ? 3 : 4;
const batchPeriod = BATCH_PADDING_MS * numOps;
```

Replace with:

```js
const batchPeriod = BATCH_PADDING_MS;
```

- [ ] **Step 2: Replace delay variables and allocate calls in the dispatch loop**

Inside the `for (let i = 0; i < N; i++)` loop (around lines 452–465), find the block:

```js
    const hackDelay    = Math.max(0, weakenTime - hackTime - BATCH_PADDING_MS + offset);
    const weaken1Delay = offset;
    const growDelay    = Math.max(0, weakenTime - growTime + BATCH_PADDING_MS + offset);
    const weaken2Delay = BATCH_PADDING_MS * 2 + offset;

    ramMgr.allocate(ns, "hack.js",   plan.hackT,    [target, hackDelay,    "farm", i]);
    ramMgr.allocate(ns, "weaken.js", plan.weaken1T, [target, weaken1Delay, "farm", i]);
    ramMgr.allocate(ns, "grow.js",   plan.growT,    [target, growDelay,    "farm", i]);
    if (plan.weaken2T > 0) {
      ramMgr.allocate(ns, "weaken.js", plan.weaken2T, [target, weaken2Delay, "farm", i]);
    }
```

Replace with:

```js
    const batchOffset  = i * batchPeriod;
    const hackAddlMs   = Math.max(0, weakenTime - hackTime) + batchOffset;
    const growAddlMs   = Math.max(0, weakenTime - growTime) + batchOffset;
    const weakenAddlMs = batchOffset;

    if (formulasAvailable) {
      // HGW: H → G → W1 — single weaken fires last, after both ops raised security
      ramMgr.allocate(ns, "hack.js",   plan.hackT,    [target, hackAddlMs]);
      ramMgr.allocate(ns, "grow.js",   plan.growT,    [target, growAddlMs]);
      ramMgr.allocate(ns, "weaken.js", plan.weaken1T, [target, weakenAddlMs]);
    } else {
      // HWGW: H → W1 → G → W2 — each weaken immediately follows its paired op
      ramMgr.allocate(ns, "hack.js",   plan.hackT,    [target, hackAddlMs]);
      ramMgr.allocate(ns, "weaken.js", plan.weaken1T, [target, weakenAddlMs]);
      ramMgr.allocate(ns, "grow.js",   plan.growT,    [target, growAddlMs]);
      ramMgr.allocate(ns, "weaken.js", plan.weaken2T, [target, weakenAddlMs]);
    }
```

- [ ] **Step 3: Verify the all-or-nothing gate is intact**

Just before the dispatch block (around line 444), confirm this check is unchanged — no edits needed, just verify it reads:

```js
    const totalWeakenT = plan.weaken1T + plan.weaken2T;
    if (ramMgr.canFit("hack.js",   plan.hackT)   < plan.hackT   ||
        ramMgr.canFit("weaken.js", totalWeakenT) < totalWeakenT ||
        ramMgr.canFit("grow.js",   plan.growT)   < plan.growT) {
      log.warn(`[farm] ${target}: stopped at batch ${i}/${N} — RAM exhausted`);
      break;
    }
```

- [ ] **Step 4: Commit**

```bash
git add manager.js
git commit -m "feat: shotgun timing in stackBatches — 200ms batchPeriod, additionalMsec dispatch"
```

---

### Task 3: Update main() endMs calculation and dispatchPrep args

**Files:**
- Modify: `manager.js` lines 341–350 (`dispatchPrep`) and lines 605–612 (`main()` dispatch loop)

- [ ] **Step 1: Fix dispatchPrep allocate call args**

In `dispatchPrep` (around lines 341–350), find the three `ramMgr.allocate` calls:

```js
  let placed = ramMgr.allocate(ns, "weaken.js", weaken1Threads, [target, 0, "prep", 0]);

  const gFit = ramMgr.canFit("grow.js", growThreads);
  if (gFit < growThreads) log.warn(`[prep] ${target}: only ${gFit}/${growThreads} grow threads fit`);
  placed += ramMgr.allocate(ns, "grow.js", growThreads, [target, 0, "prep", 0]);

  const w2Fit = ramMgr.canFit("weaken.js", weaken2Threads);
  if (w2Fit < weaken2Threads) log.warn(`[prep] ${target}: only ${w2Fit}/${weaken2Threads} weaken2 threads fit`);
  placed += ramMgr.allocate(ns, "weaken.js", weaken2Threads, [target, 0, "prep", 0]);
```

Change `[target, 0, "prep", 0]` to `[target, 0]` in all three calls:

```js
  let placed = ramMgr.allocate(ns, "weaken.js", weaken1Threads, [target, 0]);

  const gFit = ramMgr.canFit("grow.js", growThreads);
  if (gFit < growThreads) log.warn(`[prep] ${target}: only ${gFit}/${growThreads} grow threads fit`);
  placed += ramMgr.allocate(ns, "grow.js", growThreads, [target, 0]);

  const w2Fit = ramMgr.canFit("weaken.js", weaken2Threads);
  if (w2Fit < weaken2Threads) log.warn(`[prep] ${target}: only ${w2Fit}/${weaken2Threads} weaken2 threads fit`);
  placed += ramMgr.allocate(ns, "weaken.js", weaken2Threads, [target, 0]);
```

- [ ] **Step 2: Fix endMs in main() dispatch loop**

In `main()`, inside the `for (const target of targets)` loop, after the `dispatchFarm` call (around lines 606–611), find:

```js
        const numOps      = formulasAvailable ? 3 : 4;
        const batchPeriod = BATCH_PADDING_MS * numOps;
        // Last operation of the last batch finishes at:
        //   weakenTime + (numOps-2)*BATCH_PADDING_MS + (batches-1)*batchPeriod
        const endMs = weakenTime + BATCH_PADDING_MS * (numOps - 2) + (batches - 1) * batchPeriod;
```

Replace with:

```js
        const endMs = weakenTime + (batches - 1) * BATCH_PADDING_MS;
```

- [ ] **Step 3: Commit**

```bash
git add manager.js
git commit -m "fix: update dispatchPrep args and endMs for shotgun batchPeriod"
```

---

### Task 4: In-game verification

- [ ] **Step 1: Sync files to game**

In the Bitburner in-game terminal:
```
run sync.js
```

- [ ] **Step 2: Start manager with debug logging**

Kill any running manager first, then:
```
run manager.js --debug
```

- [ ] **Step 3: Verify batch count increased**

Open `manager.log.txt`. Find `[farm]` lines. The `batches=N` value should be ~4× higher than before for the same target, assuming RAM is available. Example: if you previously saw `batches=25`, expect ~100 now (capped by available RAM).

- [ ] **Step 4: Monitor for security drift**

After one full `weakenTime` cycle completes, check `manager.log.txt` for any `[drift]` lines. There should be none. If drift appears immediately after the first farm cycle, the dispatch ordering has an issue — check that the `formulasAvailable` branch is selecting correctly.

- [ ] **Step 5: Confirm money is cycling**

After 2–3 cycles, verify the farm target's `moneyAvailable` is actively cycling between ~50% and 100% of `moneyMax` (or whatever your `HACK_STEAL_PCT` is set to). Absence of `[drift]` lines and visible money cycling confirms the shotgun is working correctly.
