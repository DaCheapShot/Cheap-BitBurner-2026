# RamManager Design

**Date:** 2026-05-31  
**Status:** Approved

## Overview

Introduce a `RamManager` class inside `manager.js` that consolidates all RAM state and accounting into one place. Currently RAM management is split across `buildExecHosts()` (snapshot + deploy tracking), `fitAndExec()` (allocation + live check), and duplicated home-reserve logic in both. `RamManager` replaces both functions and owns the reserve constants.

## Goals

- Encapsulate all per-host RAM state in one object
- Eliminate duplicated home-reserve math
- Replace `deployRamUsed` local variable with immediate snapshot deduction
- Add pre-flight `canFit()` check for visibility before threads are committed
- No new `ns.*` calls (zero RAM impact on manager.js)

## Non-Goals

- Not a separate file — class lives in `manager.js`
- No batch prioritization or queuing — partial fit behavior is unchanged from today
- No change to HWGW logic, target scoring, or prep/farm state machine

## Data Model

```js
_hosts: Map<hostname, { maxRam: number, freeRam: number }>
```

Insertion-ordered Map. Home is inserted first so `allocate()` fills it with priority (same as today). Only hosts with `freeRam > 0` are included after `refresh()`.

## Constructor

```js
constructor({ homeReserveGb, homeReservePct })
```

`HOME_RESERVE_GB` and `HOME_RESERVE_PCT` module-level constants are passed in here. They remain as named constants for documentation but all reserve math lives inside the class.

## API

### `refresh(ns, allServers, deployedHosts)`

Replaces `buildExecHosts()`. Rebuilds the snapshot from live `ns.getServer()` reads each cycle.

- Clears `_hosts`
- Reads home server, computes `freeRam = maxRam - ramUsed - max(homeReserveGb, maxRam * homeReservePct)`, inserts home first
- For each server in `allServers`: skips if no admin rights or `maxRam < 2`
- If host is new (not in `deployedHosts`): launches `deploy.js`, adds to `deployedHosts`, immediately deducts `SCRIPT_RAM["deploy.js"]` from home's snapshot entry, skips host this cycle
- Otherwise: inserts host with `freeRam = maxRam - ramUsed`

The immediate deduction on deploy.js launch replaces the `deployRamUsed` accumulator variable in the old implementation.

### `allocate(ns, script, threads, args)`

Replaces `fitAndExec()`. Iterates `_hosts` in insertion order, distributes threads across hosts.

- For each host: reads live RAM via `ns.getServer()` as a safety net for RAM consumed after snapshot time
- Takes `effectiveFree = min(entry.freeRam, liveFree)` — whichever is tighter
- Calls `ns.exec()`, deducts from `entry.freeRam` on success
- Logs warn on exec failure or undeployed threads at end
- Behavior is identical to today's `fitAndExec` — partial fit, warn on shortfall

### `canFit(script, threads) → number`

Pre-flight read-only check. Returns the number of threads that could be placed given the current snapshot (no NS calls, no mutation). Callers compare against needed count to log a warning before dispatching.

One `canFit` call is made per `allocate()` call (i.e., per script per batch). Each logs independently if threads won't fully fit:

```js
// Usage in dispatchFarm / dispatchPrep (one check per allocate call):
const placeable = ramMgr.canFit("hack.js", hackThreads);
if (placeable < hackThreads)
  log.warn(`[farm] ${target}: only ${placeable}/${hackThreads} hack threads fit`);
ramMgr.allocate(ns, "hack.js", hackThreads, [target, hackDelay]);
```

### `totalFree() → number`

Sum of `freeRam` across all hosts. Used for the cycle log line.

### `hostCount() → number`

Number of hosts in the snapshot. Used for the cycle log line.

## Changes to manager.js

| Before | After |
|--------|-------|
| `buildExecHosts()` function | Removed |
| `fitAndExec()` function | Removed |
| `execHosts` variable per cycle | `ramMgr.refresh(...)` |
| `totalFreeRam` reduce | `ramMgr.totalFree()` |
| `fitAndExec(ns, execHosts, ...)` | `ramMgr.allocate(ns, ...)` |
| `dispatchPrep(ns, target, server, execHosts)` | `dispatchPrep(ns, target, server, ramMgr)` |
| `dispatchFarm(ns, target, server, execHosts, weakenTime)` | `dispatchFarm(ns, target, server, ramMgr, weakenTime)` |
| `HOME_RESERVE_*` math in two places | Constructor params; math only inside class |

`RamManager` class is added in the same location as the functions it replaces. One instance is created in `main()` and reused across all cycles.

## RAM Impact

Zero. A class definition and plain object operations have no `ns.*` calls and add no RAM to manager.js's permanent footprint.
