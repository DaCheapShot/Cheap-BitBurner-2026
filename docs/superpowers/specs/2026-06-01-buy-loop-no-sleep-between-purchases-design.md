# buy.js — Loop Without Sleep Between Purchases

## Problem

The current `buy.js` always sleeps 10 seconds after every buy/upgrade attempt, even when the purchase succeeded and budget is still available. This means money sits idle between fast consecutive purchases.

## Goal

Keep purchasing/upgrading in a tight loop with no delay between successful actions. Only sleep 10 seconds when nothing was affordable (budget exhausted or all servers maxed).

## Design

**Change:** Add a `didSomething` boolean at the top of the `while(true)` loop, set it to `true` on any successful buy or upgrade, and move `await ns.sleep(SLEEP_MS)` to only execute when `didSomething` is `false`.

**Behavior:**
- Successful buy → loop again immediately
- Successful upgrade → loop again immediately
- Nothing affordable within 10% budget → sleep 10s, then retry
- All servers at max RAM → `break` (unchanged)

**Budget rule unchanged:** Still caps each individual purchase at 10% of current cash (`BUDGET_PCT = 0.10`). The budget is re-evaluated each iteration using fresh `ns.getPlayer().money`, so the cap naturally tightens as money is spent.

## Scope

Single file: `buy.js`. No new functions, no structural changes outside the main loop body.
