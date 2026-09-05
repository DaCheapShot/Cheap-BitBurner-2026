# Formulas.exe integration — design

**Status:** approved, ready for implementation planning
**Date:** 2026-09-05

## Problem

Thread math currently rests on the `*Analyze` API and a cached calibration file.
Two known inaccuracies come from that:

- `growthAnalyze` reads the target's security **at call time**. Prep sizes a grow
  wave while security is still high, so the wave is mis-sized for the state it
  will actually land in. This is why prep takes extra cycles.
- `growthAnalyze` models growth as purely multiplicative and ignores the additive
  +$1/thread. `GROW_MARGIN = 1.05` exists to paper over the error.

`ns.formulas.hacking` answers both exactly. `growThreads(server, player,
targetMoney, cores)` takes a **server object**, so it can be asked about a
hypothetical state rather than the current one.

The obstacle is that Formulas.exe is not always owned. It is lost on every
augment install and only becomes permanent after a specific BitNode is completed
to level 3, which is not happening soon. **The no-Formulas path is a regular
recurring operating mode, not an edge case.**

## Constraint that shapes everything

Bitburner charges a script for every `ns.*` function reachable through its
imports, called or not. A single script containing both a formulas path and an
analyze path pays for both — roughly 2.5 GB of permanent waste. The two
implementations must therefore never be reachable from the same entry point.

## Verified API facts

From `src/Netscript/RamCostGenerator.ts` in this fork:

| function | RAM |
|---|---|
| every `ns.formulas.*` (incl. `hacking.*`, `mockServer`, `mockPlayer`) | **0 GB** |
| `getServer` | 2.00 |
| `getPlayer` | 0.50 |
| `hackAnalyze` / `growthAnalyze` / `weakenAnalyze` | 1.00 each |
| `getServerMoneyAvailable` / `SecurityLevel` / `MinSecurityLevel` / `MaxMoney` | 0.10 each |
| `getHackTime` / `getGrowTime` / `getWeakenTime` | 0.05 each |
| `fileExists` | 0.10 |

Relevant `HackingFormulas` members: `hackPercent`, `hackChance`, `hackExp`,
`growPercent`, `growThreads`, `growAmount`, `hackTime`, `growTime`, `weakenTime`,
`weakenEffect`.

Net effect on the manager: **adds** `getServer` + `getPlayer` (2.50), **drops**
four `getServer*` (0.40), `hackAnalyze` (1.00), `growthAnalyze` (1.00) and the
three time functions (0.15) = 2.55. Formulas is RAM-neutral, and exact.

## Approach: twin entry points with injected math

Rejected alternatives:

- **`dynamicImport` + `ramOverride`** — one manager, math loaded at runtime.
  `dynamicImport` does not adjust RAM; `ramOverride` must be called manually and
  the docs state it "can fail if adjusting upward would require more RAM than is
  available on the server". That is a new way for a long-lived process to die,
  and it still needs a restart to switch, so it saves files rather than logic.
- **Exactness via a refreshed cache** — a Formulas-powered script writes JSON
  that the unchanged manager reads at 0 GB. Cheaper (~4.9 GB) but caches
  `hackPercent` and op times, which move with every level-up. That contradicts
  the manager's core principle of recomputing per cycle, and staleness in this
  exact area has already caused a bug (the growth-base drift guard).

### The math interface

```
snapshot(ns, host)              -> target state plus whatever the impl needs
hackFractionPerThread(snap)     -> fraction of CURRENT money one hack thread takes
securityPerHackThread(snap)
securityPerGrowThread(snap)
securityPerWeakenThread(snap)
growThreadsToRestore(snap, fromMoney, toMoney, atSecurity)
opTimes(snap)                   -> { hack, grow, weaken }
```

Two decisions carry the design:

**`snapshot` owns reading the target.** The core stops calling the four
`getServer*` functions itself. The formulas build gets those fields free from the
`getServer` object it already holds; only the analyze build pays 0.40. This is
what makes the swap RAM-neutral:

Manager totals, itemised (current build is 6.15 GB):

| component | formulas | analyze |
|---|---|---|
| base | 1.60 | 1.60 |
| `ram.js` (scan, maxRam, usedRam, hasRootAccess) | 0.35 | 0.35 |
| `exec` | 1.30 | 1.30 |
| `getScriptRam` | 0.10 | 0.10 |
| `fileExists` (worker-file filter) | 0.10 | 0.10 |
| `getServerRequiredHackingLevel` + `getHackingLevel` (pickTarget) | 0.15 | 0.15 |
| target reads (4x `getServer*`) | — from `getServer` | 0.40 |
| op times (3x) | — from formulas | 0.10 |
| `getHackTime` | — from formulas | 0.05 |
| `hackAnalyze` | — | 1.00 |
| `growthAnalyze` | — | 1.00 |
| `getServer` + `getPlayer` | 2.50 | — |
| **total** | **6.10** | **6.15** (unchanged) |

**`growThreadsToRestore` takes explicit `fromMoney` and `atSecurity`** instead of
reading current state.

- *Formulas*: clone the server object, set `moneyAvailable = fromMoney` and
  `hackDifficulty = atSecurity`, call `growThreads(server, player, toMoney)`.
  Exact, including the additive growth term.
- *Analyze*: can only call `growthAnalyze(host, toMoney / fromMoney)`, which uses
  **current** security regardless of `atSecurity`.

The analyze build is therefore honestly approximate, and the signature says so.
That asymmetry is today's prep bug; the formulas build does not have it.

**Explicitly out of scope:** CPU cores (both impls assume 1 core, which
over-provisions weaken and grow — the safe direction) and `hackChance`. Neither
signature precludes adding them later.

## File layout

```
managerCore.js        current manager.js minus all math (imports ram, config, verify, prepper)
mathFormulas.js       interface via ns.formulas + getServer + getPlayer
mathAnalyze.js        interface via hackAnalyze/growthAnalyze + calib.js
manager.js            entry: core + mathAnalyze          <- always works, default
manager-formulas.js   entry: core + mathFormulas
prepper.js            math-agnostic; receives the math module as a parameter
prep.js               entry: prepper + mathAnalyze
prep-formulas.js      entry: prepper + mathFormulas
capacity.js           untouched
calib.js, calibrate.js  now used only by mathAnalyze
```

`prepper.js` stops calling `growthAnalyze` and reading `calib` directly. Keeping
`managerCore` and `prepper` math-free is what lets each entry pay for exactly one
implementation.

**Naming.** Bare `manager.js` is the **analyze** build: it works in every BitNode
from minute one, so the familiar name never fails, and Formulas is the explicit
upgrade. Cost of that choice: hand-running `manager.js` while owning Formulas
silently uses worse math. Mitigation — the analyze build checks `fileExists` at
startup and prints that `manager-formulas.js` is available. This is **free**:
`fileExists` is already charged to that build through `buildWorkerPool` in
`prepper.js`, and RAM is billed per function reachable, not per call site.

## boot.js changes

- `fileExists("Formulas.exe", "home")` check (3.30 -> 3.40 GB).
- Picks the matching manager entry.
- Writes `/data/formulas.txt` so other scripts can read status at 0 GB.
- **Treats the pair as one service.** `killDuplicates` currently dedupes by
  filename and would happily leave an analyze manager and a formulas manager
  running together, each believing it owns the RAM pool and the report port. It
  must know the two are alternatives: kill the wrong one, start the right one.
  This is the only genuinely new piece of boot logic.
- **Skips `calibrate.js` when running the formulas build.** The cache exists only
  to feed `mathAnalyze`. Drops a recurring 6.20 GB transient and the 6-hour
  refresh.
- `--no-formulas` forces the analyze build even when the program is owned.

## Error handling

| failure | behaviour |
|---|---|
| `manager-formulas.js` run without the program | `ns.formulas.*` throws; `snapshot()` catches and exits naming `manager.js`, instead of dying mid-cycle |
| the two impls drift apart | contract test below; analyze build stays the default so it is exercised constantly rather than only after augment installs |
| `/data/formulas.txt` stale | only boot writes it and boot re-checks each tick, so it self-heals within a tick; advisory only, nothing corrupting depends on it |
| formulas math misbehaves in production | `boot.js --no-formulas` |

Known accepted cost: while Formulas is owned, `calibrate.js`, `calib.js` and
`/data/calib.json` are dead weight — still maintained, exercised only after each
augment install. That is the price of a permanent dual path.

## Verification

1. **Contract test** — both impls against the same mock `ns`; identical shape,
   finite positive results for identical inputs. Catches interface drift.
2. **The divergence that matters** — `growThreadsToRestore(..., atSecurity)` with
   security above minimum. Formulas must return more threads than at min
   security; analyze returns the same number either way. Asserting the asymmetry
   pins the known limitation so it is not later "fixed" into a false equivalence.
3. **Plan equivalence** — feed `managerCore` a stub math module and confirm the
   volley plan is identical regardless of which impl produced the numbers. Proves
   the core is genuinely math-free.
4. **In-game sign-off** — `manager.js --dry-run` vs `manager-formulas.js
   --dry-run` on the same prepped target, thread counts compared side by side,
   then `--once` on each. A passing simulation has disagreed with reality in this
   codebase before; the mocks are necessary, not sufficient.

The side-by-side comparison is written as a throwaway during implementation, not
kept as a script — its job ends when the two paths are confirmed to agree.

## Success criteria

- Each entry point's RAM is within 0.1 GB of the figures above.
- Prep of a drifted target takes no more cycles under formulas than under
  analyze, and fewer when security starts high.
- A volley planned by the formulas build lands in order with jitter under
  `SPACER_MS` and leaves the target on baseline — the same bar the analyze build
  already meets.
- Buying Formulas.exe mid-session causes boot to swap the manager within one
  tick, with exactly one manager running before and after.
