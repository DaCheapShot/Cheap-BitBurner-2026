# HWGW Batch Stacking + HGW Mode + Dynamic Steal% Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-batch-per-target farm loop in `manager.js` with a RAM-filling batch stacker that uses HWGW when `Formulas.exe` is absent and HGW when it is present, with steal% dynamically chosen per target based on available RAM.

**Architecture:** Two new helper functions — `calcBatchPlan` (calculates thread counts + RAM cost for one batch) and `stackBatches` (finds the best steal% and dispatches N complete batches) — replace the guts of `dispatchFarm`, which becomes a thin caller. The existing `RamManager`, `dispatchPrep`, scoring, and drift logic are untouched.

**Tech Stack:** BitBurner NetscriptJS (ES6 JS, no build tooling, no test runner — verification is done in-game via `manager.log.txt` and `ps` in the terminal)

---

## Task 1: Replace `HACK_STEAL_PCT` with steal% range constants

**Files:**
- Modify: `manager.js:32-34`

- [ ] **Step 1: Replace the constant block**

In `manager.js`, replace lines 32–34:
```js
// Fraction of moneyMax to steal per farm batch.
// 50% is a reliable default: high income, and grow can restore it in one batch.
const HACK_STEAL_PCT = 0.50;
```
with:
```js
// Steal% range for dynamic RAM-driven selection. stackBatches tries from MAX
// down to MIN in STEP increments, picking the highest that lets ≥1 full batch fit.
const STEAL_PCT_MAX  = 0.95;
const STEAL_PCT_MIN  = 0.10;
const STEAL_PCT_STEP = 0.05;
```

- [ ] **Step 2: Verify the file still has no reference to `HACK_STEAL_PCT`**

Search `manager.js` for `HACK_STEAL_PCT` — it must not appear. (The old constant was only used in `dispatchFarm`, which we'll replace in Task 4. At this point `dispatchFarm` will reference a name that no longer exists, but the script won't be run until all tasks are done.)

- [ ] **Step 3: Commit**

```
git add manager.js
git commit -m "refactor: replace HACK_STEAL_PCT with STEAL_PCT_MAX/MIN/STEP range constants"
```

---

## Task 2: Add `calcBatchPlan` helper

**Files:**
- Modify: `manager.js` — insert after `dispatchPrep` (currently ends at ~line 307), before `dispatchFarm`

- [ ] **Step 1: Insert the function**

Insert the following block between `dispatchPrep` and `dispatchFarm` (after the closing `}` of `dispatchPrep`, before `function dispatchFarm`):

```js
// ─── Batch planning ──────────────────────────────────────────────────────────

/**
 * Calculate thread counts and total RAM for one batch.
 *
 * HWGW (formulasAvailable=false): 4 scripts — hack, weaken1, grow, weaken2.
 *   weaken1 covers hack's security delta; weaken2 covers grow's.
 * HGW  (formulasAvailable=true):  3 scripts — hack, weaken1, grow.
 *   weaken1 covers both hack and grow security deltas combined. weaken2T=0.
 *
 * @param {NS} ns
 * @param {string} target
 * @param {object} server  — ns.getServer(target) result
 * @param {number} stealPct — fraction of moneyMax to steal (0.10–0.95)
 * @param {boolean} formulasAvailable
 * @returns {{ hackT: number, weaken1T: number, growT: number, weaken2T: number, totalRam: number }}
 */
function calcBatchPlan(ns, target, server, stealPct, formulasAvailable) {
  const hackT = Math.max(1, Math.floor(ns.hackAnalyzeThreads(target, server.moneyMax * stealPct)));
  const growT = Math.max(1, Math.ceil(ns.growthAnalyze(target, 1 / (1 - stealPct))));

  const hackSecDelta = hackT * 0.002;
  const growSecDelta = growT * 0.004;

  const weaken1T = formulasAvailable
    ? Math.max(1, Math.ceil((hackSecDelta + growSecDelta) / 0.05))
    : Math.max(1, Math.ceil(hackSecDelta / 0.05));
  const weaken2T = formulasAvailable
    ? 0
    : Math.max(1, Math.ceil(growSecDelta / 0.05));

  const totalRam = hackT    * SCRIPT_RAM["hack.js"]
                 + weaken1T * SCRIPT_RAM["weaken.js"]
                 + growT    * SCRIPT_RAM["grow.js"]
                 + weaken2T * SCRIPT_RAM["weaken.js"];

  return { hackT, weaken1T, growT, weaken2T, totalRam };
}
```

- [ ] **Step 2: Commit**

```
git add manager.js
git commit -m "feat: add calcBatchPlan — pure batch thread/RAM calculator (HWGW + HGW modes)"
```

---

## Task 3: Add `stackBatches` function

**Files:**
- Modify: `manager.js` — insert immediately after `calcBatchPlan`, before `dispatchFarm`

- [ ] **Step 1: Insert the function**

Insert the following block immediately after the closing `}` of `calcBatchPlan`:

```js
/**
 * Find the highest steal% where ≥1 complete batch fits in free RAM, then
 * dispatch N batches with staggered offsets. All-or-nothing: if any script
 * can't be fully allocated mid-loop, stops before deploying a partial batch.
 *
 * Greedy allocation: caller must process targets best-first so the top target
 * claims RAM at the highest steal% before lower-priority targets search the remainder.
 *
 * @param {NS} ns
 * @param {string} target
 * @param {object} server
 * @param {RamManager} ramMgr
 * @param {number} weakenTime  — ms returned by ns.getWeakenTime(target)
 * @param {boolean} formulasAvailable
 * @returns {number} batches dispatched (0 if no steal% fit)
 */
function stackBatches(ns, target, server, ramMgr, weakenTime, formulasAvailable) {
  const hackTime    = ns.getHackTime(target);
  const growTime    = ns.getGrowTime(target);
  const numOps      = formulasAvailable ? 3 : 4;
  const batchPeriod = BATCH_PADDING_MS * numOps;

  // Find highest steal% where at least 1 complete batch fits
  let stealPct = 0;
  let plan     = null;
  let N        = 0;

  for (let pct = STEAL_PCT_MAX; pct >= STEAL_PCT_MIN - 1e-9; pct -= STEAL_PCT_STEP) {
    const candidate = calcBatchPlan(ns, target, server, pct, formulasAvailable);
    const fits      = Math.floor(ramMgr.totalFree() / candidate.totalRam);
    if (fits >= 1) { stealPct = pct; plan = candidate; N = fits; break; }
  }

  if (N === 0) {
    log.warn(`[farm] ${target}: no steal% fits even 1 batch — skipping`);
    return 0;
  }

  log.info(
    `[farm] ${target} | mode=${formulasAvailable ? "HGW" : "HWGW"} | ` +
    `steal=${(stealPct * 100).toFixed(0)}% | batches=${N} | ` +
    `h=${plan.hackT} w1=${plan.weaken1T} g=${plan.growT}` +
    (plan.weaken2T > 0 ? ` w2=${plan.weaken2T}` : "") +
    ` | RAM/batch=${plan.totalRam.toFixed(1)}GB`
  );

  let dispatched = 0;
  for (let i = 0; i < N; i++) {
    const offset = i * batchPeriod;

    // All-or-nothing gate: verify all scripts still fit before allocating.
    // RAM may have shifted since N was calculated (previous targets already allocated).
    const totalWeakenT = plan.weaken1T + plan.weaken2T;
    if (ramMgr.canFit("hack.js",   plan.hackT)    < plan.hackT    ||
        ramMgr.canFit("weaken.js", totalWeakenT)  < totalWeakenT  ||
        ramMgr.canFit("grow.js",   plan.growT)     < plan.growT) {
      log.warn(`[farm] ${target}: stopped at batch ${i}/${N} — RAM exhausted`);
      break;
    }

    const hackDelay    = Math.max(0, weakenTime - hackTime - BATCH_PADDING_MS + offset);
    const weaken1Delay = offset;
    const growDelay    = Math.max(0, weakenTime - growTime + BATCH_PADDING_MS + offset);
    const weaken2Delay = BATCH_PADDING_MS * 2 + offset;

    ramMgr.allocate(ns, "hack.js",   plan.hackT,    [target, hackDelay]);
    ramMgr.allocate(ns, "weaken.js", plan.weaken1T, [target, weaken1Delay]);
    ramMgr.allocate(ns, "grow.js",   plan.growT,    [target, growDelay]);
    if (plan.weaken2T > 0) {
      ramMgr.allocate(ns, "weaken.js", plan.weaken2T, [target, weaken2Delay]);
    }
    dispatched++;
  }

  return dispatched;
}
```

- [ ] **Step 2: Commit**

```
git add manager.js
git commit -m "feat: add stackBatches — RAM-filling batch stacker with dynamic steal% and all-or-nothing gate"
```

---

## Task 4: Replace `dispatchFarm` body and update `main()` loop

These two changes must be committed together because `dispatchFarm` changes its return type from `boolean` to `number`, and the callers in `main()` must be updated at the same time.

**Files:**
- Modify: `manager.js:309-357` (dispatchFarm)
- Modify: `manager.js:399-483` (main loop)

- [ ] **Step 1: Replace `dispatchFarm` with a thin caller**

Replace the entire `dispatchFarm` function (lines 309–357) with:

```js
function dispatchFarm(ns, target, server, ramMgr, weakenTime, formulasAvailable) {
  return stackBatches(ns, target, server, ramMgr, weakenTime, formulasAvailable);
}
```

- [ ] **Step 2: Add formulas detection to the main loop**

In `main()`, after the line `const allServers = scanNetwork(ns);` (currently inside `while (true)`, step 2), add:

```js
    // ── 2b. Detect Formulas.exe ───────────────────────────────────────────────
    const formulasAvailable = ns.fileExists("Formulas.exe", "home");
    log.debug(`[cycle] mode=${formulasAvailable ? "HGW" : "HWGW"}`);
```

- [ ] **Step 3: Replace `maxWeakenTime` tracking with `maxEndMs`**

In the `// ── 5. Dispatch batches ──` section, replace:

```js
    let maxWeakenTime = 0;
```

with:

```js
    let maxEndMs = 0;
```

- [ ] **Step 4: Update the prep branch sleep tracking**

Replace:

```js
          if (dispatchPrep(ns, target, server, ramMgr))
            maxWeakenTime = Math.max(maxWeakenTime, weakenTime);
```

with:

```js
          if (dispatchPrep(ns, target, server, ramMgr))
            maxEndMs = Math.max(maxEndMs, weakenTime);
```

- [ ] **Step 5: Update the farm branch call and sleep tracking**

Replace:

```js
      // Phase is "farm" — either it was already, or just promoted above.
      if (dispatchFarm(ns, target, server, ramMgr, weakenTime))
        maxWeakenTime = Math.max(maxWeakenTime, weakenTime);
```

with:

```js
      // Phase is "farm" — either it was already, or just promoted above.
      const batches = dispatchFarm(ns, target, server, ramMgr, weakenTime, formulasAvailable);
      if (batches > 0) {
        const numOps     = formulasAvailable ? 3 : 4;
        const batchPeriod = BATCH_PADDING_MS * numOps;
        // Last operation of the last batch finishes at:
        //   weakenTime + (numOps-2)*BATCH_PADDING_MS + (batches-1)*batchPeriod
        const endMs = weakenTime + BATCH_PADDING_MS * (numOps - 2) + (batches - 1) * batchPeriod;
        maxEndMs = Math.max(maxEndMs, endMs);
      }
```

- [ ] **Step 6: Update the sleep line**

Replace:

```js
    const sleepMs = Math.max(CYCLE_SLEEP_MS, maxWeakenTime + 1_000);
```

with:

```js
    const sleepMs = Math.max(CYCLE_SLEEP_MS, maxEndMs + 1_000);
```

- [ ] **Step 7: Commit**

```
git add manager.js
git commit -m "feat: wire stackBatches into dispatchFarm; track maxEndMs for multi-batch sleep"
```

---

## Task 5: Verify in-game

No code changes. This task confirms the system works end-to-end.

- [ ] **Step 1: Sync to game**

In the Bitburner terminal:
```
run sync.js
```
Expected: all 11 files show `✓`, 0 failed.

- [ ] **Step 2: Start the manager in debug mode**

```
run manager.js --debug
```
Expected: manager starts, log window shows `[init] debug mode ON`.

- [ ] **Step 3: Check mode detection**

In the Bitburner terminal, open `manager.log.txt` or watch the log window.
Expected line each cycle: `[cycle] mode=HWGW` (until Formulas.exe is purchased).

- [ ] **Step 4: Check batch stacking output**

Wait for the first farm dispatch. Expected log lines for each farming target:
```
[farm] <target> | mode=HWGW | steal=95% | batches=N | h=X w1=Y g=Z w2=W | RAM/batch=X.XGB
```
Confirm `batches` is greater than 1 if enough RAM exists. Confirm `steal=` shows the dynamically chosen value (should start at 95% for the best target if RAM is plentiful, drop for lower-priority targets).

- [ ] **Step 5: Check all-or-nothing gate works**

Watch for the warning line pattern (only visible if RAM is tight):
```
WARN: [farm] <target>: stopped at batch N/M — RAM exhausted
```
If this appears, confirm that `N` batches were dispatched (not N+partial). No partial batch should ever run.

- [ ] **Step 6: Check workers are actually running**

In the Bitburner terminal:
```
ps
```
Expected: multiple `hack.js`, `weaken.js`, `grow.js` processes visible, more than in the single-batch era.

- [ ] **Step 7: Confirm money is being earned and security stays bounded**

Wait 2–3 cycles. For each farming target, verify in the server list (or via `run connect.js <target>`) that:
- `moneyAvailable` is moving (being stolen and restored)
- `hackDifficulty` stays within `minDifficulty + DRIFT_SEC_CEILING` (no drift warnings)

If drift warnings appear (`WARN: [drift] ...`), the stagger math is wrong — escalate as a bug.
