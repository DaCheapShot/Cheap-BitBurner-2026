# buy.js Loop Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove sleep between successful purchases in `buy.js` so it buys/upgrades in a tight loop, only sleeping 10s when the budget is exhausted.

**Architecture:** Add a `didSomething` boolean to the main loop. Set it `true` on any successful buy or upgrade. Sleep only when `didSomething` is `false` at the end of the loop body.

**Tech Stack:** Bitburner NetscriptJS (no build step, no test runner, no linter — verify by running in-game)

---

## File Map

| File | Change |
|------|--------|
| `buy.js` | Restructure main loop — add `didSomething` flag, conditionalize sleep |

---

### Task 1: Restructure the main loop in buy.js

**Files:**
- Modify: `buy.js:14-58`

- [ ] **Step 1: Add `didSomething` flag and conditionalize sleep**

Replace the entire `while (true)` block (lines 14–58) with:

```js
  while (true) {
    const money  = ns.getPlayer().money;
    const budget = money * BUDGET_PCT;
    const owned  = ns.cloud.getServerNames();
    const limit  = ns.cloud.getServerLimit();
    let didSomething = false;

    if (owned.length < limit) {
      // Open slot — buy the highest-RAM server we can afford within budget.
      const ram = bestAffordableTier(ns, RAM_TIERS, budget);
      if (ram > 0) {
        const cost     = ns.cloud.getServerCost(ram);
        const hostname = ns.cloud.purchaseServer(PREFIX, ram);
        if (hostname !== "") {
          ns.print(`BOUGHT ${hostname} (${ns.format.ram(ram)}) for ${ns.format.number(cost)}`);
          didSomething = true;
        }
      } else {
        ns.print(`Waiting — cheapest server > budget (${ns.format.number(budget)})`);
      }
    } else {
      // All slots filled — upgrade the weakest server if affordable.
      const target = weakestServer(ns, owned);
      if (target !== null) {
        const curRam  = ns.getServerMaxRam(target);
        const nextRam = curRam * 2;

        if (nextRam > 1048576) {
          // Every server is at max RAM; nothing left to do.
          ns.print("All servers at max RAM (2^20 GB). buy.js done.");
          break;
        }

        const cost = ns.cloud.getServerUpgradeCost(target, nextRam);
        if (cost > 0 && cost <= budget) {
          const ok = ns.cloud.upgradeServer(target, nextRam);
          if (ok) {
            ns.print(`UPGRADED ${target}: ${ns.format.ram(curRam)} → ${ns.format.ram(nextRam)} for ${ns.format.number(cost)}`);
            didSomething = true;
          }
        } else {
          ns.print(`Waiting — upgrade ${target} → ${ns.format.ram(nextRam)} costs ${ns.format.number(cost)} (budget: ${ns.format.number(budget)})`);
        }
      }
    }

    if (!didSomething) await ns.sleep(SLEEP_MS);
  }
```

- [ ] **Step 2: Verify in-game**

In Bitburner terminal:
```
run buy.js
```
Expected: script logs a burst of `BOUGHT` or `UPGRADED` lines in rapid succession when affordable servers exist, then a `Waiting —` line followed by 10s of silence before the next attempt.

- [ ] **Step 3: Commit**

```bash
git add buy.js
git commit -m "feat: burst-buy until budget exhausted, then sleep 10s"
```
