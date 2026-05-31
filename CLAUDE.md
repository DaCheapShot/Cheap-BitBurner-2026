# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Bitburner 3.0.1 game scripts. There is no build system, no test runner, and no package manager. Scripts are authored here and synced into the game via `sync.js`. The game's JavaScript engine executes them directly.

## Deploying to the Game

All scripts are synced from GitHub to the game's home server:

```
# In the Bitburner terminal:
run sync.js
```

`sync.js` uses `ns.wget` to pull every file from the `main` branch of `https://github.com/DaCheapShot/Cheap-BitBurner-2026`. After editing files here, commit and push before running `sync.js` in-game.

Startup sequence after a fresh sync:
```
run root.js      # crack and nuke all reachable servers
run manager.js   # start the orchestrator (also launches buy.js automatically)
```

## Architecture

The orchestrator is split across two tiers — a persistent manager and short-lived helpers — specifically to minimize RAM locked on home permanently.

**Permanent RAM** (held for the life of manager.js, ~10.3 GB total):
- `manager.js` — main loop; scores targets, dispatches batches, tracks state

**Temporary RAM** (freed on script exit):
- `root.js` (~4.25 GB) — BFS scan + port cracking + nuke; launched by manager every 60s
- `deploy.js` (~2.2 GB) — `ns.scp` worker files to a new execution host; launched once per new host
- `hack.js` / `grow.js` / `weaken.js` (~1.7–1.75 GB/thread) — single-action workers

**Why this split matters:** Functions like `ns.scp`, `ns.brutessh`, `ns.nuke` would add permanent RAM to manager if called there. Keeping them in helper scripts costs RAM only while they run.

## HWGW Batch Logic

`manager.js` runs a state machine per target: **prep → farm**.

**Prep phase:** Brings a target to `minDifficulty` and `moneyMax` before farming starts. Launches weaken1 + grow + weaken2 simultaneously with `delay=0` (timing doesn't matter for prep).

**Farm phase (HWGW):** Each batch fires H/W1/G/W2 with staggered delays so they land in order 200ms apart:
```
Hack    → T + weakenTime - 200ms   (steals 50% moneyMax)
Weaken1 → T + weakenTime           (offsets hack's sec raise: 0.002/thread)
Grow    → T + weakenTime + 200ms   (restores 2× money)
Weaken2 → T + weakenTime + 400ms   (offsets grow's sec raise: 0.004/thread)
```
After each batch the target is back at minSec + maxMoney, so the next batch's thread math stays valid without re-prepping.

Thread math constants:
- `ns.weaken()` lowers security by **0.05** per thread
- `ns.hack()` raises security by **0.002** per thread
- `ns.grow()` raises security by **0.004** per thread

## Bitburner 3.0.1 API Notes

Things that differ from older versions or common misconceptions:

- **Purchased servers:** `ns.cloud.*` namespace — `ns.cloud.purchaseServer()`, `ns.cloud.upgradeServer()`, `ns.cloud.getServerNames()`, `ns.cloud.getServerLimit()`, `ns.cloud.getServerCost()`, `ns.cloud.getServerUpgradeCost()`. The old `ns.purchaseServer()` no longer exists.
- **Formatting:** `ns.format` only has `.number()`, `.percent()`, `.ram()`, `.time()`. There is no `.money()` method — use `.number()` for currency.
- **RAM cost of `ns.write`:** 1 GB. Manager uses it for file logging; this is already factored into manager's RAM budget.
- **`ns.wget`:** 0 GB RAM cost. Used in `sync.js`.
- **`ns.getScriptRam()`:** Always call this at runtime instead of hardcoding RAM values — they differ across versions.

## Logging

`manager.js` writes all output to `manager.log.txt` (in-game file, readable with `cat manager.log.txt`). The in-game log window shows only high-level lines by default.

```
run manager.js           # quiet log window; full detail in manager.log.txt
run manager.js --debug   # verbose output in both window and file
```

The logger is a module-level `log` object initialized in `main()` so helper functions can access it without extra parameters. It has three methods: `log.info()` (always visible), `log.debug()` (file-only unless `--debug`), `log.warn()` (always visible, prefixed `WARN:`).

## RAM Budget Discipline

Before adding any `ns.*` call to a long-running script, check its RAM cost in `markdown/bitburner.<function>.md`. Every new function permanently increases the script's RAM footprint for its entire lifetime. Prefer adding expensive functions to short-lived helpers (`root.js`, `deploy.js`) over manager.js.
