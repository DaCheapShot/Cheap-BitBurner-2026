# Share Mode Design

**Date:** 2026-06-01
**Status:** Approved

## Problem

Late-game players accumulate money faster than they can spend it. The bottleneck becomes faction reputation. Bitburner's `ns.share()` multiplies faction rep gain proportionally to the number of threads running it. Idle RAM should be convertible to rep gain without stopping HWGW farming.

## Goal

Reserve ~20% of total available RAM each cycle for share threads when share mode is enabled. HWGW farming continues on the remaining ~80%. Share mode is off by default and can be toggled at runtime without restarting `manager.js`.

---

## New Files

### `share.js`

A time-bounded worker that calls `ns.share()` in a loop until a deadline expires, then exits cleanly.

```
run share.js <durationMs>
```

- Takes one arg: `durationMs` — how long to run before exiting
- Loops `await ns.share()` until `Date.now() >= startTime + durationMs`
- RAM cost: 2.4 GB per thread (the cost of `ns.share()`)
- Matches the lifecycle of hack/grow/weaken workers: spawned fresh each cycle, expires before the next cycle starts

### `ctrl.js`

Runtime config writer. Reads the current config from port 1, merges one key change, writes it back, and prints the full resulting config.

```
run ctrl.js status          # print current config, no change
run ctrl.js share on        # enable share mode
run ctrl.js share off       # disable share mode
```

- Uses a read-modify-write cycle so the port never accumulates more than one item
- "on"/"true" → `true`; "off"/"false" → `false`
- Prints the full config after every run for visibility

---

## Config Port Protocol

- **Port:** 1
- **Format:** JSON string, e.g. `{"share": false}`
- **Empty port:** Bitburner returns the string `"NULL"` when a port has no items. Manager treats this as all-off (same as `{}`).
- **Manager behavior:** peeks port 1 once per cycle — never consumes it. Config persists across cycles.
- **ctrl.js behavior:** reads (consuming the item), parses, merges the change, writes back. Port stays at 0 or 1 items, never overflows.
- **On manager restart:** port retains its last-written value, but manager defaults share to off if the port is empty (first run or after a game reset). To restore share after a restart: `run ctrl.js share on`.
- **Extensibility:** future features add a new key to the JSON. No new ports, no new plumbing in ctrl.js.

---

## RAM Allocation in manager.js

### New constants

| Constant | Value | Purpose |
|---|---|---|
| `CONFIG_PORT` | `1` | NS port number for runtime config |
| `SHARE_RAM_PCT` | `0.20` | Fraction of free RAM reserved for share each cycle |

`SCRIPT_RAM["share.js"]` is added to the existing map and populated via `ns.getScriptRam("share.js")` at startup.

### New RamManager method: `setAsideForShare(pct, shareRam)`

Computes the exact number of share threads that fit within `pct` of current free RAM, deducts their RAM from the snapshot (in host order, same as `allocate()`), and returns the thread count.

```
shareThreads = floor(totalFree() * pct / shareRam)
deduct shareThreads * shareRam from snapshot (greedy, host order)
return shareThreads
```

Key properties:
- Only reserves RAM in exact multiples of `shareRam` (2.4 GB) — no fractional waste
- Hosts with less than 2.4 GB free are skipped entirely; they lose nothing from the HWGW budget
- The deducted RAM is exactly what will be used — no over-reservation

### Per-cycle flow (share enabled)

```
1. ramMgr.refresh()
2. shareThreads = ramMgr.setAsideForShare(SHARE_RAM_PCT, SCRIPT_RAM["share.js"])
   → snapshot now reflects ~80% free for HWGW
3. HWGW dispatch (prep + farm) runs normally against the reduced snapshot
4. sleepMs = max(CYCLE_SLEEP_MS, maxEndMs + 1000)
5. ramMgr.allocate(ns, "share.js", shareThreads, [sleepMs])
   → share threads launched with exact cycle duration; expire before next cycle
6. await ns.sleep(sleepMs)
```

When share is disabled, steps 2 and 5 are skipped entirely — no behavioral change to HWGW.

### RAM cost to manager.js

`ns.getScriptRam("share.js")` adds 0 GB — already covered by the existing call pattern. `ns.exec()` is already reserved.

`ns.getPortHandle()` is a new NS function added to manager.js. Its RAM cost must be verified in-game (`ns.getScriptRam("manager.js")` before and after adding the call). Add the verified cost to manager's header comment alongside the other NS function costs.

---

## Behavior Notes

- **Diminishing returns:** `ns.share()` has diminishing returns at high thread counts. 20% is intentionally conservative. The fraction can be tuned via `SHARE_RAM_PCT` in the source.
- **Share threads expire cleanly:** because share.js is time-bounded to `sleepMs`, all threads from the previous cycle have exited by the time `ramMgr.refresh()` runs. No accumulation, no stale processes.
- **HWGW takes priority:** `setAsideForShare` runs after `refresh()` but before any HWGW allocation. If the system is RAM-constrained, HWGW gets its full 80% share; only the 20% reservation is affected.
- **Logging:** manager logs the share thread count and reserved GB each cycle at `info` level when share is enabled.
