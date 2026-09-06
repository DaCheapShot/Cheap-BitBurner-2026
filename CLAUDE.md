# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Netscript 2 (ES modules) scripts for **Bitburner**, running against a personal fork:
`DaCheapShot/bitburner-src`. Everything in `scripts/` executes inside the game, not on Node.

There is no build, no linter, and no `package.json`. Do not add one expecting it to run the
scripts. A test suite exists — run it with `node tests/run.mjs`.

## Verify the NS API before using it — always

**Before calling any `ns.*` function, confirm its exact signature, parameters, return type and
RAM cost against this fork's docs.** Do not rely on memory: signatures and RAM costs shift
between game versions, and this is a fork. Same rule for game constants (security change per
thread, time multipliers) — get them from the docs or from the relevant `ns.*Analyze` function
rather than hardcoding a remembered value.

The `bitburner-src` MCP server is configured in `.mcp.json`. Per-function docs:

```
https://raw.githubusercontent.com/DaCheapShot/bitburner-src/stable/markdown/bitburner.ns.<fn>.md
```

Game source (for behaviour the docs don't state) lives under `.../stable/src/`.

### Fork differences from vanilla Bitburner

- Purchased servers are under **`ns.cloud`** (`ns.cloud.purchaseServer`, `getServerNames`,
  `upgradeServer`, `getRamLimit`), not the vanilla top-level functions.
- **`ns.tail()` does not exist** — use `ns.ui.openTail()` (0 GB).

## Running things

Everything runs from the in-game terminal. `boot.js` is the entry point and supervises the rest:

```
run scripts/boot.js                     # root -> deploy -> calibrate -> cloud -> manager
run scripts/boot.js --target omega-net  # pin the manager's target instead of auto-picking
run scripts/boot.js --once --no-cloud
run scripts/boot.js --no-formulas       # force the analyze build
```

Individual pieces, useful when diagnosing:

```
run scripts/root.js                     # open ports + NUKE everything reachable
run scripts/deploy.js                   # scp workers home -> every rooted host
run scripts/calibrate.js                # write /data/calib.json (needs target at min security)
run scripts/capacity.js --steal 0.05    # RAM/target/batch-size analysis, launches nothing
run scripts/manager.js --dry-run        # plan a volley and print it
run scripts/manager.js --once --verbose # one volley, measured vs planned outcome
run scripts/prep.js --target <host>     # prep one target without the manager
run scripts/connectme.js CSEC           # print the connect chain to a host
run scripts/connectme.js --factions     # routes + backdoor status for faction servers
node tests/run.mjs                      # run the test suite
```

**Only one process may own the RAM pool and the report port.** `port.read()` removes the
message and `Server.pending` is per-process memory, so a second owner steals reports and
over-commits the same RAM. `manager.js` and `manager-formulas.js` are alternatives — only one
may run. Do not run `prep.js` alongside either — prep runs *inside* the manager via
`prepper.js`. `boot.js` enforces this by killing duplicate services (lowest PID wins).
`capacity.js` is safe to run beside the manager: it allocates and releases only within its own
process and never touches the port.

## Getting code into the game

Two hops, and both fail silently:

1. **disk → home**, by the VS Code Bitburner filesync extension (`filesync.json`). It pushes on
   save. `pushAllOnConnection: true` backfills on connect — edits made while disconnected are
   otherwise orphaned on disk forever.
2. **home → other hosts**, by `ns.scp` in `deploy.js`. `exec` requires the script to already
   exist on the target and returns a bare `0` otherwise.

A symptom of hop 1 failing is code that "obviously" ran but behaved like an older version.
`deploy.js` guards hop 2 by refusing to broadcast home's workers unless they carry result
reporting.

## Verification

Run the test suite with `node tests/run.mjs`. Filter by name: `node tests/run.mjs boot`, or list
all tests with no argument.

Scripts can't run outside the game, so the test suite uses mocks. Mocks must reproduce the
game's real semantics or they give false confidence:

- ports hold 50 entries and **discard the oldest** on overflow
- file paths are stored **without a leading slash**, so `ns.run("/scripts/x.js")` works but
  `ns.ps()` reports `scripts/x.js`

Several fixes in this repo's history exist because a live run disagreed with a passing
simulation. Tests check syntax, isolation (the two math backends never reach each other),
RAM accounting, and contract equivalence — but in-game runs are the real gate.

## RAM is the design constraint

Bitburner charges a script for **every `ns.*` function reachable through its imports**, whether
called or not. Consequences that shape the whole codebase:

- `config.js` and `verify.js` contain **no `ns` calls at all**; `calib.js` uses only `ns.read`,
  which is 0 GB. So all three are free to import. Keep it that way — adding one billed `ns`
  call to `config.js` taxes every script in the repo.
- `ram.js` deliberately touches only four cheap functions and **no analyze functions**.
- Constants that are linear in threads are measured once by `calibrate.js`, cached to
  `/data/calib.json`, and read back through `calib.js` at 0 GB. This replaces `weakenAnalyze`,
  `hackAnalyzeSecurity` and `growthAnalyzeSecurity` (1 GB each).
- `growthAnalyze` stays live: it reads security at call time, so it cannot be cached. For the
  same reason `calib.js` refuses to answer growth questions for a drifted host.
- `hackAnalyze` stays live: it moves with hacking level, and reacting to that is the point.

Worker scripts pay their cost **per thread**, so `hack.js` / `grow.js` / `weaken.js` contain
nothing beyond one op and one port write.

### Two math backends

`mathAnalyze.js` and `mathFormulas.js` implement the same interface. They must never be
reachable from the same entry point — Bitburner charges for every `ns` function reachable
through imports, so a script touching both pays ~2.5 GB it cannot use. `tests/isolation.test.mjs`
enforces this by walking the import closure; `tests/ram.test.mjs` asserts the resulting totals.

`growThreadsToRestore(snap, from, to, atSecurity)` is where they differ. Formulas honours
`atSecurity` by cloning the server object; analyze cannot, and always evaluates at current
security. That asymmetry is deliberate and tested — do not "fix" it into an equivalence.

## Architecture

Layers, bottom up:

| module | role | cost |
|---|---|---|
| `config.js` | every tunable, shared so nothing drifts | 0 |
| `calib.js` | reads `/data/calib.json` | 0 |
| `verify.js` | landing analysis — the definition of "landed correctly" | 0 |
| `ram.js` | `Server` + `ServerPool`: reservations, placement | 0.35 |
| `prepper.js` | prep as a module (manager runs it in-process) | 2.00 |
| `mathAnalyze.js` | math interface via *Analyze + calibration cache | 2.55 |
| `mathFormulas.js` | math interface via `ns.formulas` | 2.50 |
| `managerCore.js` | the volley loop, math-free | 2.00 |
| `manager.js` | entry: core + mathAnalyze (always works) | 6.15 |
| `manager-formulas.js` | entry: core + mathFormulas | 6.10 |
| `prep.js` | entry: prepper + mathAnalyze | 6.15 |
| `prep-formulas.js` | entry: prepper + mathFormulas | 6.10 |
| `boot.js` | supervisor | 3.40 |
| `root.js` | port openers + NUKE | 2.15 |
| `cloud.js` | buys/upgrades servers, capped at 10% of cash | 5.75 |

`connectme.js` (3.80) prints the terminal `connect` chain to a host. It trims the
chain wherever `src/Terminal/commands/connect.ts` permits a direct jump - that is,
to any host with `backdoorInstalled` or `purchasedByPlayer` - which is the only
reason it pays for `getServer`. `--factions` reports the five servers whose backdoor
grants an invite, sourced from `haveBackdooredServer` in `src/Faction/FactionInfo.tsx`
and pinned by a test - `w0r1d_d43m0n` is NOT one of them.

`capacity.js` (~7.75) is the surviving diagnostic. It ranks targets by real throughput, which
the manager does not do — `pickTarget` chooses the richest *hackable* server, not the most
profitable one. `prep.js` / `prep-formulas.js` and `calibrate.js` are manual entry points to
logic the supervisor otherwise drives. `scan.js` predates the batcher.

### The volley loop

Each cycle: measure free RAM across the rooted network → pick a steal fraction → compute how
many complete Hack-Weaken-Grow-Weaken batches fit in RAM *and* inside one weaken window →
launch the whole volley at once → drain reports while it lands → recompute and fire again.
Recomputing every cycle is the design, not overhead: it self-corrects as hacking level, op
times and RAM change.

### Invariants that look arbitrary but aren't

Breaking any of these produces silent, compounding damage rather than an error:

- **All four ops of a batch `exec` at the same instant.** Separation comes from
  `additionalMsec`, never from sleeping between launches — a sleep-then-op recomputes its
  duration from the security level at wake-up and lands somewhere else.
- **Recompute each worker's delay at its own `exec`.** A volley is hundreds of `exec` calls
  spanning real wall time; one delay computed up front is correct only for the first worker.
- **Call the security analyze functions WITHOUT a host argument.** With one, they cap by
  threads-to-max-money, so on a prepped target `growthAnalyzeSecurity` returns ~0 and weaken-2
  is sized at 1 thread instead of ~51.
- **Never size capacity as `freeRam / batchRam`.** Every host floors its own thread count, so
  the byte total overstates what can actually be placed. Simulate placement instead.
- **Judge timing on jitter (spread of drift within a batch), never absolute lateness.** The
  game lands whole batches tens of ms late together, which cannot reorder anything.
- **A batch is all-or-nothing.** One that hacks but fails to grow steals money and never
  returns it — worse than not firing.
- **Never volley an unprepped target**; all thread math assumes max money and min security.

## Conventions

Comments explain *why*, especially where a simpler-looking alternative is wrong — most of them
encode a bug that already happened. Keep that when editing; don't trim them to tidy up.

Commit messages lead with the reasoning and the measured numbers behind a change, not a file
list.
