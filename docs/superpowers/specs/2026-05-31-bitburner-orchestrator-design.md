# Bitburner Orchestrator Design
**Date:** 2026-05-31  
**Version:** Bitburner 3.0.1  
**Status:** Approved

---

## Overview

A RAM-efficient orchestrator that automatically discovers servers, roots them, and runs staged Hack-Weaken-Grow-Weaken (HWGW) batch farming across multiple targets simultaneously. Designed to scale from early BN1 through late game without modification.

---

## File Structure

```
/
├── manager.js    # Continuous orchestration loop (runs on home)
├── root.js       # One-shot helper: scan + crack + nuke all reachable servers
├── deploy.js     # One-shot helper: scp worker scripts to a single host
├── hack.js       # Worker: ns.hack() only — 1.6 + 0.10 GB/thread
├── grow.js       # Worker: ns.grow() only — 1.6 + 0.15 GB/thread
└── weaken.js     # Worker: ns.weaken() only — 1.6 + 0.15 GB/thread
```

---

## RAM Strategy

The core principle: **every NS function used in a script is permanently reserved for that script's lifetime.**

- Workers use exactly one NS function each — minimum possible RAM per thread.
- `root.js` and `deploy.js` are launched as short-lived helpers; their RAM is freed when they exit.
- `manager.js` only permanently reserves functions it needs every cycle.

### Manager permanent RAM reservation
| Function | Cost | Purpose |
|---|---|---|
| `ns.scan()` | 0.2 GB | Network discovery each cycle |
| `ns.exec()` | 1.3 GB | Launch all workers and helpers |
| `ns.getServer()` | 2.0 GB | All server state in one call |
| `ns.getHackTime()` | ~0.05 GB | Batch timing |
| `ns.getGrowTime()` | ~0.05 GB | Batch timing |
| `ns.getWeakenTime()` | ~0.05 GB | Batch timing |
| `ns.growthAnalyze()` | ~1.0 GB | Grow thread calculation |
| `ns.hackAnalyzeThreads()` | ~1.0 GB | Hack thread calculation |
| `ns.hackAnalyzeChance()` | ~1.0 GB | Target scoring |
| `ns.getPurchasedServers()` | ~0.05 GB | Execution host discovery |
| `ns.getHackingLevel()` | ~0.05 GB | Target eligibility check |
| `ns.sleep()` | 0 GB | Loop delay |
| `ns.print()` | 0 GB | Logging |

### Helpers (temporary RAM only)
| Script | Key Functions | Approximate RAM |
|---|---|---|
| `root.js` | `scan`, `fileExists`, `brutessh`, `ftpcrack`, `relaysmtp`, `httpworm`, `sqlinject`, `nuke` | ~2.5 GB |
| `deploy.js` | `scp` | ~2.2 GB |

---

## Worker Scripts

All workers accept two arguments: `target` (hostname) and `delay` (milliseconds, optional).  
They sleep the delay, execute their action once, then exit. `sleep` costs 0 GB.

```
hack.js    args: [target, delay?]  →  sleep(delay) → ns.hack(target)
grow.js    args: [target, delay?]  →  sleep(delay) → ns.grow(target)
weaken.js  args: [target, delay?]  →  sleep(delay) → ns.weaken(target)
```

---

## Manager Architecture

### Main loop (every cycle)

1. Launch `root.js` if 60 seconds have passed since last root attempt
2. BFS scan from home → build full server list
3. Find newly rooted hosts not yet deployed → launch `deploy.js` for each
4. Build execution host list (all rooted servers + purchased servers with free RAM)
5. Score all hackable targets, pick top 5
6. For each target: determine phase (prep or farm), calculate threads, dispatch batch
7. Sleep until next cycle: `max(2000ms, weakenTime + 1000ms)` if farming, else 2000ms

### Target eligibility (hackable)
- `server.hasAdminRights === true`
- `server.requiredHackingSkill <= ns.getHackingLevel()`
- `server.moneyMax > 0`
- Not a purchased server, not home

### Target scoring
```
score = server.moneyMax × ns.hackAnalyzeChance(target) / ns.getWeakenTime(target)
```
Higher money, higher hack chance, and lower weaken time = better target.

### Target state machine
```
unrooted → rooted → prepping → farming
                       ↑           |
                       └───────────┘  (drift detected: re-prep)
```

Drift condition (demote farm → prep):
- `moneyAvailable < moneyMax × 0.90`, OR
- `hackDifficulty > minDifficulty + 5`

---

## Phase 1: Prep

Goal: bring target to `minDifficulty` and `moneyMax` before starting batches.

### Thread calculation
```
// Weaken to min security
weaken1Threads = ceil((server.hackDifficulty - server.minDifficulty) / 0.05)

// Grow to max money (each grow thread raises security by 0.004)
growMult       = server.moneyMax / max(server.moneyAvailable, 1)
growThreads    = ceil(ns.growthAnalyze(target, growMult))
weaken2Threads = ceil(growThreads × 0.004 / 0.05)
```

### Dispatch order
Launch all three simultaneously (no timing needed for prep — just need all to finish):
```
exec("weaken.js", host, weaken1Threads, target, 0)
exec("grow.js",   host, growThreads,    target, 0)
exec("weaken.js", host, weaken2Threads, target, 0)
```

---

## Phase 2: Farm (HWGW Batch)

Goal: continuously steal ~50% of maxMoney per batch while maintaining min security.

### Thread calculation
```
hackThreads  = floor(ns.hackAnalyzeThreads(target, 0.50))
weaken1      = ceil(hackThreads  × 0.002 / 0.05)   // compensate hack sec increase
growThreads  = ceil(ns.growthAnalyze(target, 2.0))  // restore ~2× (stolen 50%)
weaken2      = ceil(growThreads  × 0.004 / 0.05)   // compensate grow sec increase
```

### Timing (stagger so all finish in H→W1→G→W2 order, 200ms apart)
```
weakenTime = ns.getWeakenTime(target)
hackTime   = ns.getHackTime(target)
growTime   = ns.getGrowTime(target)

hackDelay    = weakenTime - hackTime - 300ms    // H finishes 300ms before W1
weaken1Delay = 0ms                              // W1 finishes at T+weakenTime
growDelay    = weakenTime - growTime + 200ms    // G finishes 200ms after W1
weaken2Delay = 400ms                            // W2 finishes 400ms after W1
```

### Dispatch
```
exec("hack.js",   host, hackThreads,  target, hackDelay)
exec("weaken.js", host, weaken1,      target, weaken1Delay)
exec("grow.js",   host, growThreads,  target, growDelay)
exec("weaken.js", host, weaken2,      target, weaken2Delay)
```

---

## Execution Host Management

### Host list
- All rooted servers (non-home, non-purchased) with `maxRam >= 2 GB`
- All purchased servers (`getPurchasedServers()`)
- Home server minus reserved RAM

### Home RAM reservation
`reserved = max(32 GB, homeMaxRam × 0.25)`  
Ensures manager and future scripts always have room to run.

### Thread splitting (`fitThreads`)
When a single host lacks enough free RAM for a full batch, `fitThreads` walks the host list and splits threads across multiple hosts until the full count is deployed or RAM is exhausted.

### Deployment tracking
Manager keeps an in-memory `Set<string>` of hosts that have already received worker scripts via `deploy.js`. New hosts added to the set after `deploy.js` is launched for them (not after it completes — safe because exec launch is fast and manager re-checks RAM next cycle).

---

## Helper Scripts

### `root.js`
1. BFS scan from home to discover all servers
2. For each unrooted server:
   - Count available crackers on home (`fileExists("brutessh.exe")` etc.)
   - Apply crackers in order
   - If `openPorts >= server.numOpenPortsRequired` → `ns.nuke(host)`
3. Print summary of newly rooted servers
4. Exit

Launched by manager at startup and every 60 seconds.

### `deploy.js`
1. Accepts one arg: `targetHost`
2. `ns.scp(["hack.js", "grow.js", "weaken.js"], targetHost, "home")`
3. Exit

Launched by manager whenever a new rooted host is discovered.

---

## Edge Cases

| Scenario | Handling |
|---|---|
| No eligible targets found | Log message, sleep 10s, retry |
| Not enough RAM for full batch | Deploy partial batch via `fitThreads`, log warning |
| Target drifts out of farm state | Demote to prep, re-run prep phase |
| Purchased servers present | Used as execution hosts, never as targets |
| BitNode reset | All state is in-memory, manager restarts cleanly |
| New cracker unlocked | `root.js` runs every 60s, will pick it up automatically |
| Low hack level early game | Score function naturally deprioritizes unreachable targets |

---

## Comments Policy

All scripts will be commented to explain **why**, not just what:
- Each major block explains its purpose and any non-obvious math
- RAM cost noted where relevant (especially workers)
- Timing math explained inline in the farm batch section
- Security/money constants (0.002, 0.004, 0.05) annotated with their source

---

## Out of Scope

- Hacknet node management
- Gang / corporation / bladeburner automation
- Stock market integration
- Formulas API usage (not assumed available early game)
- Purchased server auto-buying
