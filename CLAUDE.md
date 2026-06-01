# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bitburner automation scripts — JavaScript files that run inside the Bitburner game's NetscriptJS environment. The game exposes an `ns` (NetScript) API object passed to every script's `export async function main(ns)` entry point. Scripts are deployed and executed from within the game, not from the command line.

There is no build step, test runner, or linter. Files are edited here and synced into the game via `sync.js`.

## Deploying changes

From inside Bitburner's terminal:
```
run sync.js
```
`sync.js` fetches all scripts from the GitHub repo (`DaCheapShot/Cheap-BitBurner-2026`, `main` branch) via `ns.wget` and overwrites local game files. After syncing, restart any running scripts to pick up the changes.

**When creating a new script:** always add it to the `FILES` array in `sync.js`, or it will never be downloadable by the game.

## Running the system

Full automation stack startup (in-game terminal):
```
run root.js        # crack & nuke all reachable servers
run manager.js     # start the orchestrator (runs indefinitely)
```

Debug mode:
```
run manager.js --debug
```

## Architecture

The scripts form a two-layer system:

**Orchestration layer** (runs on `home`, permanent RAM cost):
- `manager.js` — main loop; re-roots servers every 60s, deploys workers to new hosts, scores and selects top 5 targets, dispatches HWGW batches. Logs to `manager.log.txt`. Also launches `buy.js` and calls `contracts.js` each cycle.
- `buy.js` — separate loop; spends ≤10% of cash per action to buy/upgrade purchased servers (prefixed `cheap`).
- `root.js` — one-shot; BFS scans network, applies available port crackers, nukes newly accessible servers. Exits immediately (frees ~4.25 GB).
- `contracts.js` — one-shot each manager cycle; BFS scans for `.cct` files, solves them using `solvers.js`, writes results to `contracts/solved/` or skip markers to `contracts/failed/`.

**Worker layer** (spawned on demand across all rooted hosts):
- `hack.js`, `grow.js`, `weaken.js` — single-action workers that sleep a delay then call their NS function and exit. Args: `[target, delayMs]`.
- `deploy.js` — copies the three workers from `home` to a target host via `ns.scp`, then exits.

**Utility:**
- `solvers.js` — pure JS algorithm library (no NS calls); exports `SOLVERS` map keyed by exact contract type string. Imported by `contracts.js`.
- `connect.js` — BFS path finder; prints the `connect` chain to reach a server from home.
- `sync.js` — downloads all scripts from GitHub into the game.

## HWGW batch design

`manager.js` implements Hack-Weaken-Grow-Weaken batching:
- **Prep phase**: weaken to `minDifficulty` + grow to `maxMoney` before any hacking starts.
- **Farm phase**: dispatch interleaved H/W1/G/W2 threads with timing delays so all four operations complete in the correct order (W1 first, H second, G third, W2 last, each 200ms apart).
- **Drift check**: if a farming target drops below 90% money or rises 5+ sec above min, it's demoted back to prep.
- `RamManager` class tracks free RAM per host across the cycle and distributes threads across all rooted servers with available RAM.

## Key constants in manager.js

| Constant | Default | Purpose |
|---|---|---|
| `HACK_STEAL_PCT` | 0.50 | Fraction of maxMoney stolen per batch |
| `TOP_TARGETS` | 5 | Max parallel targets |
| `BATCH_PADDING_MS` | 200 | Gap between HWGW completion events |
| `HOME_RESERVE_GB` | 32 | Minimum GB reserved on home |
| `HOME_RESERVE_PCT` | 0.10 | Percentage reserved on home |

## NS API constraints

- Every `ns.*` function call consumes RAM permanently while the script runs — see the RAM breakdown in `manager.js`'s header comment.
- `ns.scp` is not used in `manager.js` to avoid adding 0.60 GB to its permanent footprint; `deploy.js` handles it instead.
- `ns.ls` returns files from a specific host; filter results with `.endsWith(".cct")` as it can return directories too.
- Server names can contain dots (e.g., `I.I.I.I`) — use `@` as separator in marker filenames, not `.`.
