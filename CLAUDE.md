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
run scripts/boot.js                     # root -> deploy -> cloud -> continuous batcher
run scripts/boot.js --shotgun           # the volley batcher instead (adds calibrate)
run scripts/boot.js --target omega-net  # pin the manager's target instead of auto-picking
run scripts/boot.js --targets 5         # continuous only; the shotgun ignores it
run scripts/boot.js --once --no-cloud
run scripts/boot.js --no-formulas       # force the analyze build
```

**Boot chooses between TWO batchers**, and the choice is a flag, not a marker - retype it if
you restart boot. `scripts/continuous/` is the default and the better earner. `--shotgun` runs
`scripts/manager.js`. Within either, boot re-picks the formulas or analyze build every tick,
because Formulas.exe can be bought or lost at any time. Calibration is a shotgun-only step:
`scripts/continuous/lib/mathAnalyze.js` deliberately keeps no cache and never reads
`/data/calib.json`, so running `calibrate.js` for it is a 6.20 GB transient buying nothing.

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
run scripts/sharemode.js                # share status: power, pool, what each fraction buys
run scripts/sharemode.js on             # trade SHARE_FRACTION of the pool for faction rep
run scripts/sharemode.js off            # every share thread exits within 10s
run scripts/sharemode.js 0.5            # retune live, no restart
node tests/run.mjs                      # run the test suite
```

**Only one process may own the RAM pool and the report port.** `port.read()` removes the
message and `Server.pending` is per-process memory, so a second owner steals reports and
over-commits the same RAM. There are **four** manager files — `manager.js`,
`manager-formulas.js`, `continuous/manager.js`, `continuous/manager-formulas.js` — and all four
are alternatives, not services. Only one may run. Do not run `prep.js` alongside any of them —
prep runs *inside* the manager. `boot.js` enforces this by killing every rival before it starts
the one it wants (duplicates of the same file: lowest PID wins).

The continuous side guards itself too: `findRivals` in `continuous/core.js` **aborts** rather
than starting beside any of the four, and does not kill the rival — which system runs is the
user's decision. That is why boot has to clear the others first: a survivor does not make the
incoming manager degrade, it makes it exit, and boot would restart it into the same wall once a
minute forever.

A swap between the two systems must also clear **both** worker sets. They use different files
(`scripts/hack.js` against `scripts/continuous/hack.js`), so a kill list covering only the
incoming system's leaves the outgoing one's batches running network-wide.

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

**A worker's imports must be deployed with it.** Bitburner resolves imports on the server a
script *starts* on, and `RamCalculations.ts` returns `ImportError: "<module>" does not exist on
server: <host>` when one is missing — so `exec` cannot price the script and returns a bare `0`,
**the same value it returns when the script itself is absent**. `hack.js` / `grow.js` /
`weaken.js` import nothing, so this never arose until `share.js` imported `config.js`: share ran
on home, the one host that has `config.js`, and returned 0 on all 68 others while `fileExists`
correctly insisted the worker was there. `WORKER_DEPS` carries the imports and
`tests/ram.test.mjs` asserts `DEPLOY_LIST` is closed under them.

**Adding a worker file needs no manual deploy, and must not.** `deploy.js` runs only when
`root.js` roots something new — adding a file roots nothing, so the trigger never fires and the
file sits on home while the whole fleet runs without it. The only symptom is `exec` returning a
bare `0` somewhere far away. So `deploy.js` writes `DEPLOY_MANIFEST` recording *which* files it
broadcast, and `boot.js` re-runs it whenever that differs from `DEPLOY_LIST`.

The manifest records the **file list, not a timestamp**, and that is the point. If the copy of
`deploy.js` inside the game is older than the one on disk, it broadcasts the older list, boot
sees the mismatch survive a deploy, and says so — naming filesync as the cause. A timestamp would
look like success every time. This is the only detector in the repo for a stale in-game file,
which is its most expensive recurring failure: a manager running `main`-era code, a `SyntaxError`
for an export that existed on disk, and `share.js` reaching one host out of 69 twice.

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

`tests/volley.test.mjs` executes a whole `run()` cycle against a mock that applies each op to a
simulated server. It is the only test that RUNS the manager rather than calling its parts, and it
exists because two runtime `ReferenceError`s reached the live game past a clean `node --check` —
a call site updated without its import, and a `const` in the verbose block shadowing an outer name
so an earlier read of it hit the temporal dead zone. Both were on the `--verbose` path. A
shadowing lint was tried and rejected: matching on indentation flags 14 benign redeclarations
across `scripts/` because it cannot tell a nested block from a different function.

## RAM is the design constraint

Bitburner charges a script for **every `ns.*` function reachable through its imports**, whether
called or not. Consequences that shape the whole codebase:

**It bills NAMES, not call sites.** This is the expensive half of the rule and it is not
obvious from the docs. `src/Script/RamCalculations.ts`: `addRef` does `s.add(name)` — the
comment there reads *"For builtins like hack."* — and the `MemberExpression` visitor walks
`node.object` **and** `node.property`. `findFunc` then searches the cost table recursively by
bare name, so a namespaced function is charged by its last segment. So a local variable, a
parameter, a loop counter or a property read costs the same as calling the function it is named
after, anywhere in the import closure:

| written | charged |
|---|---|
| `function nextSteal(steal, window, …)` | 25.00 GB — `window` resolves to `RamCostConstants.Dom` |
| `for (let attempt = 0; …)` | 10.00 GB — `ns.codingcontract.attempt` |
| `const share = serviceShare(…)` | 2.40 GB — `ns.share` |
| `export async function run(ns, math)` | 1.00 GB — `ns.run` |
| `const probe = (hack) => …` | 0.20 GB — this fork's `ns.dnet.probe` |
| `times.hack`, `ram.grow`, `threads.weaken1` | 0.40 GB — the three worker ops |

Those five lines were real, and together they cost `continuous/manager-formulas.js` 39.00 of
its 48.00 GB — enough that it would not start on a fresh BitNode's 32 GB home while the shotgun
ran fine. String and template literals are free (`Literal` nodes), and so are non-computed
object keys (`{ hack: 1.70 }`), because acorn-walk's `Property` visitor only walks a computed
key. `tests/ram.test.mjs` models all of this and has a guard test naming the expensive
collisions; it is the only thing standing between this repo and a 25 GB variable.

- `config.js` and `calib.js` are genuinely free to import: `config.js` has no `ns` call and
  mentions `hack`/`grow`/`weaken` only as object keys, `calib.js` uses only `ns.read` at 0 GB.
  Keep it that way — one billed `ns` call in `config.js` taxes every script in the repo.
- `verify.js` has no `ns` call either but still costs **0.25 GB** to import, because it reads
  `.hack` and `.grow` off result objects. Nothing to fix; know it before budgeting.
- `ram.js` deliberately touches only four cheap functions and **no analyze functions**.
- Constants that are linear in threads are measured once by `calibrate.js`, cached to
  `/data/calib.json`, and read back through `calib.js` at 0 GB. This replaces `weakenAnalyze`,
  `hackAnalyzeSecurity` and `growthAnalyzeSecurity` (1 GB each).
- `growthAnalyze` stays live: it reads security at call time, so it cannot be cached. For the
  same reason `calib.js` refuses to answer growth questions for a drifted host.
- `hackAnalyze` stays live: it moves with hacking level, and reacting to that is the point.

Worker scripts pay their cost **per thread**, so `hack.js` / `grow.js` / `weaken.js` contain
nothing beyond one op and one port write. `share.js` follows the same rule and pays the most for
breaking it: `ns.share` is 2.40 GB, so the worker costs **4.00 GB per thread** and one stray
import of `ram.js` would add 0.35 GB to every one of tens of thousands of them.

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

Costs below are what the GAME charges, identifier collisions included — module rows are the
marginal cost of importing them, entry rows the script's whole total. Every figure comes from
`ramOf()` in `tests/ram.test.mjs`, which reproduces the game's own breakdown; check against the
editor's RAM panel when one moves.

| module | role | cost |
|---|---|---|
| `config.js` | every tunable, shared so nothing drifts | 0 |
| `calib.js` | reads `/data/calib.json` | 0 |
| `verify.js` | landing analysis — the definition of "landed correctly" | 0.25 |
| `ram.js` | `Server` + `ServerPool`: reservations, placement | 0.35 |
| `prepper.js` | prep as a module (manager runs it in-process) | 2.40 |
| `mathAnalyze.js` | math interface via *Analyze + calibration cache | 2.55 |
| `mathFormulas.js` | math interface via `ns.formulas` | 2.50 |
| `managerCore.js` | the volley loop + share top-up, math-free | 2.80 |
| `manager.js` | entry: core + mathAnalyze (always works) | 6.95 |
| `manager-formulas.js` | entry: core + mathFormulas | 6.90 |
| `prep.js` | entry: prepper + mathAnalyze | 6.55 |
| `prep-formulas.js` | entry: prepper + mathFormulas | 6.50 |
| `boot.js` | supervisor, picks the batcher | 3.60 |
| `root.js` | port openers + NUKE | 2.15 |
| `cloud.js` | buys/upgrades servers, capped at 10% of cash | 5.75 |
| `deploy.js` | scp workers home → every rooted host | 2.50 |
| `share.js` | one `ns.share()` loop | 4.00 **per thread** |
| `sharemode.js` | the share toggle | 4.20 |
| `continuous/manager.js` | entry: continuous core + its mathAnalyze | 13.35 |
| `continuous/manager-formulas.js` | entry: continuous core + its mathFormulas | 9.40 |

The continuous entries are the two that have to fit a fresh BitNode's 32 GB home alongside
`boot.js` and `cloud.js`, and `tests/ram.test.mjs` holds them under 16 GB for that reason. The
analyze build carries 3.00 GB of *Analyze functions the shotgun caches away through
`calibrate.js`, and 2.00 GB for the `ns.getServer` in `continuous/lib/cores.js`; porting the
calibration pair into that folder is the next 5 GB if one is ever needed.

`connectme.js` (3.85) prints the terminal `connect` chain to a host. It trims the
chain wherever `src/Terminal/commands/connect.ts` permits a direct jump - that is,
to any host with `backdoorInstalled` or `purchasedByPlayer` - which is the only
reason it pays for `getServer`. `--factions` reports the four servers whose backdoor
ALONE grants an invite, sourced from `haveBackdooredServer` in
`src/Faction/FactionInfo.tsx` and pinned by a test, plus `w0r1d_d43m0n` for the route -
it grants no faction. `fulcrumassets` is excluded: Fulcrum also requires employment
and company rep, so its backdoor never invites on its own. `w0r1d_d43m0n` is off the
network until The Red Pill is installed (`Prestige.ts` links it to `The-Cave` there),
so unreachable rows are dropped rather than reported as an error.

`capacity.js` (8.15) is the surviving diagnostic. It ranks targets by real throughput, which
the manager does not do — `pickTarget` chooses the richest *hackable* server, not the most
profitable one. `prep.js` / `prep-formulas.js` and `calibrate.js` are manual entry points to
logic the supervisor otherwise drives. `scan.js` predates the batcher.

### Prep, and why it fans out

A prep wave is sized by **need, not capacity**. Growing past max money does nothing and
weakening below minimum security does nothing, so `planPrepWave` asks for exactly the threads
required and no more. One target therefore cannot use more than a sliver of the pool: a server
carrying 50 excess security wants `50 / 0.05 = 1000` weaken threads, about 1.75TB of a 3267TB
pool — while the manager blocks on that wave for a whole weaken window earning nothing.

`prepGroup` spends the remainder prepping the next targets down `rankTargets`, up to
`PREP_FANOUT`. Two rules make it safe, and both look arbitrary:

- **The primary is launched before any extra is planned.** Its placements are already reserved,
  so extras can only ever be sized against leftovers. Reordering this would let an extra take RAM
  the primary wanted, making prep of the one server we are blocked on slower.
- **An extra whose weaken window exceeds the primary's is skipped.** Every placement releases
  together at the end of the cycle, so a slower wave would hold the cycle open past the
  primary's landing. The primary is the richest target and usually the slowest, so this rejects
  few candidates.

Fanning out is safe in a way a speculative volley would not be: grow and weaken can only move a
server *toward* prepped. There is no partial-failure mode that loses money the way a batch that
hacks but fails to grow does.

`launchPrepWave` and `awaitWaves` are split for the same reason: `port.read()` REMOVES the
message, so two drain loops on one port destroy each other's reports. There is one drain for all
in-flight waves, matching on batch id.

Volley cycles are deliberately left alone — a volley already consumes nearly the whole pool.

### The volley loop

Each cycle: measure free RAM across the rooted network → pick a steal fraction → compute how
many complete Hack-Weaken-Grow-Weaken batches fit in RAM *and* inside one weaken window →
launch the whole volley at once → drain reports while it lands → recompute and fire again.
Recomputing every cycle is the design, not overhead: it self-corrects as hacking level, op
times and RAM change.

### Share mode

`ns.share()` converts RAM into a multiplier on faction reputation gain. Off by default; it
matters mid-to-late in a BitNode, when money has stopped being the constraint and rep has not.

**The bonus is logarithmic.** From `src/NetworkShare/Share.ts`, `calculateShareBonus` is
`1 + ln(shareThreads) / 25`, so every **doubling** of share RAM adds a flat `ln 2 / 25 = 2.77`
points however much is already running. Hack income is roughly *linear* in RAM. On a 3267 TB
pool at 4.00 GB per thread:

| share RAM | threads | bonus |
|---|---|---|
| 10% | 83.6k | ×1.453 |
| 25% (`SHARE_FRACTION`) | 209k | ×1.490 |
| 50% | 418k | ×1.518 |
| 100% | 837k | ×1.546 |

The last three quarters of the pool buy 5.6 points and cost three quarters of the income. That
curve is the whole reason share takes a capped fraction rather than "whatever is spare".

**Three pieces**, and the split is not arbitrary:

- `sharemode.js` writes a **fraction** to `/data/share.txt` *and* publishes it on `SHARE_PORT`.
  A fraction rather than an on/off flag so the amount is retunable from the terminal — putting it
  in `config.js` would mean waiting on the filesync extension, the least reliable link here.
- `share.js` loops `while (Number(gate.peek()) > 0) await ns.share()`. `ns.share` resolves after
  10 s, so sharing continuously means looping — and that loop is also the **off switch**. Workers
  peek the gate between calls and retire themselves, so `off` clears the network in under 10 s
  with no `ns.kill` anywhere, and works even when no manager is running.

  **The setting reaches workers on a PORT, never a file.** `ns.read` resolves against the server
  the calling script runs on (`NetscriptFunctions.ts`: `const server = ctx.workerScript.getServer()`),
  so a worker reading `/data/share.txt` — which exists on home alone — gets `""`, treats it as
  off, and exits milliseconds after `exec` handed it a perfectly valid pid. The manager counted
  66 hosts sharing while 65 had already quit. Ports are shared across every host; files are not.
  `peek`, not `read`: `read` removes the message, so the first worker to wake would consume the
  setting and stop all the others.

  It also **imports nothing**, like the batch workers, taking the port number as `ns.args[0]`.

  Two claims that look alike and are not: `exec` returned non-zero, and the worker is still
  running. Only the second one matters, and only `shareCensus` measures it.
- `managerCore.js` tops the thread count up against the volley's own pool, before the volley is
  sized, then `refresh()`es — so the RAM share took is simply gone from what the volley sees.
  It does the same per prep cycle through `prepGroup`'s `onCycle` hook, because prep is when the
  pool is most idle and a prep can hold the manager for ten minutes, so deferring a toggle until
  prep finished would make the toggle look broken. The top-up is idempotent, so running it from
  both places costs nothing.

`shareCensus` reads `ns.ps` per host and is what makes a manager restart safe: share workers
outlive the process that started them, so a manager that did not count them would launch a
second full set on top — doubling the RAM share holds to buy 2.77 points of a logarithm.

Placement is **proportional**: every host gives the same fraction of *itself*, so share scales
the pool down uniformly instead of eating whole hosts. The first live run did the opposite — it
filled home first and to the brim — and on a 2 PB home that swallowed the pool's largest host for
a benefit that barely registers. `getCoreBonus` is `1 + (cores - 1) / 16`, and since the bonus is
`ln(threads)/25`, moving *every* share thread onto an 8-core home is worth `ln(1.4375)/25` =
**1.45 points**. Home still goes first so the rounding remainder lands where the cores are. A
second pass places whatever the first could not — hosts too small for their quota, or hosts that
cannot run the worker — because honouring the requested fraction matters more than the pool's
shape.

**`deploy.js` only runs when `root.js` roots something new, so adding a worker file never
triggers it.** The whole fleet can be missing `share.js`, and the first live run was: every
`exec` off home returned 0, share ran on one host out of the network, and the log blamed a busy
pool. `topUpShare` checks `fileExists` per host — free, since `prepper.js` already pays for it —
and reports **`noFile` and `refused` as separate causes**.

Keeping them apart is the point, and merging them cost two live runs. The first version blamed a
busy pool when the file was missing; the second told the user to run `deploy.js` on a fleet where
`deploy.js` had already copied the worker to all 68 hosts, because the same list was collecting
`exec` failures too. **A diagnostic that names the wrong cause is worse than none — it gets
acted on.** A refusal now prints what was asked against what the pool believed was free, so the
next log diagnoses itself instead of costing another round trip.

### The continuous batcher (`scripts/continuous/`)

The default. It replaces the volley with a **stream**: batches are dispatched at a cadence and
each op is `exec`ed just in time for its own landing, so an op holds RAM for its own duration
rather than for the whole weaken window. Measured at $947m/s average on a live save with `bad 0`
and 10–11 ms of jitter against a 100 ms spacer.

**Self-contained by rule.** It does not import from `scripts/`, and `scripts/` does not import
from it except for one 0 GB constant list (`boot.js` reads `continuous/config.js` for the worker
paths it has to be able to kill). It carries its own workers, its own deploy, its own math
backends and its own report port (3, not 1 — a killed shotgun leaves reports in flight for a
whole window, and on a shared port they would be credited to batch ids that never existed here).

**Just-in-time dispatch is legal because op duration is fixed at CALL time**, not at landing —
`NetscriptHelpers.tsx` resolves it when the op starts. So placing `G` a hundred seconds after
`W1` does not change where `G` lands, and the shotgun's "all four at once" rule does not apply.
What is still true, and is the thing that rule was really protecting, is that nothing may sleep
and *then* ask how long an op takes.

**The steal fraction is calculated, never configured.** `chooseSteal` sweeps hack-thread counts
log-spaced and takes the best income, subject to two separate bounds:

- **peak RAM**, `batchRam` — all four ops are live just before the anchor, so at depth ≤ 1 the
  mean is not the constraint and averaging over the cadence would over-commit by the depth
  factor;
- **mean RAM**, `batchRamSeconds / cadence` — Little's law, which binds instead once the pipeline
  is deep.

`--steal` still exists and pins the fraction, for controlled measurement only.

**The grow margin is derived from measured drift**, not flat. Drift is hack effectiveness rising
between dispatch and landing; the controller measures it two ways (from reports, and from the
trend in `hackFractionPerThread` over a weaken window) and sizes every batch for
`DRIFT_SAFETY ×` the worse. One consequence is worth knowing before touching the controller: in
steady state `worstOver / tolerance ≈ 1 / DRIFT_SAFETY`, whatever the fraction or the target — so
a climb threshold below that is one no healthy stream can ever meet.

**`MAX_TARGETS = 3`, but the count is chosen by INCOME, not capacity.** Running the most targets
that fit is only right when the budget is not the constraint. When it is, every extra target
narrows the slice for all of them and income is near-linear in the slice — a live run measured
phantasy alone at $2.84m/s against $1.96m/s for three. `rescan` prices 1..N and takes the best
total, so the count rises to 3 on its own as the pool grows.

**Prep runs concurrently with streaming**, one target at a time unless the pool genuinely has
leftovers. Four concurrent preps on a 1.6 TB pool reserved the whole of it and starved the only
live stream to 169 aborts in 170 batches.

**The prep count is decided at PLACEMENT, not by a RAM share.** `servicePreps` stops at the
first wave the pool could not cover in full — `placePrepWave` reports that as `shrunk` — so
extras only ever get leftovers. It has to be placement that decides, because prep need is set
by the target's excess security and money deficit, not by the pool, and one target's need
routinely exceeds the whole pool early in a BitNode. `PREP_CONCURRENCY` and `PREP_SPARE_SHARE`
survive as bounds on how many hosts are QUEUED; queuing reserves nothing. Both were written as
the RAM throttle and neither could be one: a ratio of shares cannot answer "does one target's
need fit", and at the start of a BitNode nothing is prepped, so nothing is admitted, `spent` is
0, `idle` is the whole budget and all four slots are granted on a 32 GB home exactly as readily
as on 26 PB — the 1.6 TB failure reached from the other end.

The gate is carried on the prep entry, not recomputed per tick, because a short wave is still
the constraint while it is in flight. Without that the split just moves from space into time:
one target holds a short wave, the next takes the crumbs, the first releases, the next holds.
Repairs are serviced before never-streamed targets — a stopped stream is a target already
admitted that earns nothing until it is back on baseline.

**Share works here too**, through `lib/share.js` — the same marker, the same port 2, the same
`sharemode.js`. It is a port of `managerCore`'s, not a rewrite, and every rule in it is one the
shotgun learned expensively: proportional placement, both passes planned before anything execs,
`noFile` and `refused` kept apart, and nothing routed through `pool.allocate` (a reservation is
released at cycle end and a share worker is not, so the same bytes would be subtracted twice).
It is called once per rescan and **before the RAM budget is computed** — a budget taken first
prices RAM share is about to take, and the calculator then commits a fraction it cannot place.

Its log mirrors to `/data/continuous.log.txt`. That file is written to the GAME's filesystem and
filesync only pushes the other way, so getting it onto disk means `download /data/continuous.log.txt`
from the terminal.

### Invariants that look arbitrary but aren't

Breaking any of these produces silent, compounding damage rather than an error:

- **All four ops of a batch `exec` at the same instant** — *in the shotgun*. Separation comes
  from `additionalMsec`, never from sleeping between launches: a sleep-then-op recomputes its
  duration from the security level at wake-up and lands somewhere else. The continuous batcher
  breaks this deliberately and is still correct — see its section below — but the reason is
  narrow, and anything that sleeps and *then* asks how long an op takes is wrong in both.
- **Recompute each worker's delay at its own `exec`.** A volley is hundreds of `exec` calls
  spanning real wall time; one delay computed up front is correct only for the first worker.
- **Call the security analyze functions WITHOUT a host argument.** With one, they cap by
  threads-to-max-money, so on a prepped target `growthAnalyzeSecurity` returns ~0 and weaken-2
  is sized at 1 thread instead of ~51.
- **Never size capacity as `freeRam / batchRam`.** Every host floors its own thread count, so
  the byte total overstates what can actually be placed. Simulate placement instead.
- **Judge timing on jitter (spread of drift within a batch), never absolute lateness.** The
  game lands whole batches tens of ms late together, which cannot reorder anything.
- **A manager swap must clear the network.** boot switches builds when Formulas.exe is gained
  or lost, and the outgoing manager's volley keeps running — hundreds of batches holding the
  RAM the replacement needs and still working a target nobody owns. `killOrphanWorkers` runs
  only when no manager of ANY of the four survives; doing it on every manager kill would
  destroy the volley of the survivor `killDuplicates` just kept. Switching BATCHERS is a manager
  swap too, and the kill list has to cover both systems' workers - they are different files. Nothing is lost by killing them:
  `ns.hack` credits money on landing, so a killed grow forfeits only the restore, which prep
  does anyway.
- **A full pool is transient, not a failure.** Prep waits it out (`POOL_WAIT_CYCLES`) rather
  than returning an error that stops the manager and has boot restart it into the same wall a
  tick later. Waiting cycles do not spend `maxCycles`.
- **Cap the auto-chosen steal fraction.** Thread counts are sized once per volley, then the
  batches land across the whole weaken window while hacking level climbs. A batch landing late
  steals more than planned, and its grow was sized for the smaller take, so it ends below where
  it started and compounds. In the shotgun the headroom is
  `((GROW_MARGIN - 1) / GROW_MARGIN) * (1 - steal) / steal` — 0.25% at 95% steal against 19% at
  20%. A measured volley at 98.28% drained $17.68b to $166.11k in one window. See
  `MAX_STEAL_FRACTION`. **That formula is the shotgun's**: the flat `GROW_MARGIN` in it is what
  makes the tolerance a property of the fraction alone. Continuous derives the margin from
  measured drift instead, so its tolerance moves with the target — do not carry the flat form
  across.
- **Share is launched by whoever owns the pool.** A share service running beside the manager
  would `exec` into RAM the manager had already planned a volley against, and the manager's
  `exec` would fail mid-volley — the same class of damage two managers cause. It would also
  find nothing free, since a volley normally holds 99%+ of the pool. So `managerCore` does it,
  before it builds the pool: share workers `exec` outside the reservation system and outlive the
  cycle, and the volley then sizes itself against what `getServerUsedRam` reports. Do NOT route
  them through `pool.allocate` — a reservation is released at cycle end, but the worker is not,
  so the pool would double-count RAM the game already reports as used.
- **Cap the share fraction.** `SHARE_MAX_FRACTION` is not decoration. At 100% the prep gate
  finds zero placeable threads, waits out `POOL_WAIT_CYCLES` (15 minutes), fails, and the
  manager stops — whereupon boot restarts it into the same wall a tick later. That is the
  manager-swap restart loop arrived at from a different direction, and a mistyped terminal
  argument is enough to trigger it. For the same reason, anything unparseable in the marker
  reads as **off**, never as a default: a `NaN` fraction compares false against every bound and
  would leave the RAM held with no way back but a kill.
- **`killOrphanWorkers` spares share workers.** They are deliberately not in `WORKER_LIST`.
  None of the reasoning behind that kill applies: they are tied to no target, they hold a
  bounded fraction rather than a whole volley's worth, and the incoming manager adopts them
  through `shareCensus`. Killing them would drop the bonus for a tick and buy nothing.
- **A batch is all-or-nothing.** One that hacks but fails to grow steals money and never
  returns it — worse than not firing.
- **Never volley an unprepped target**; all thread math assumes max money and min security.

## Conventions

Comments explain *why*, especially where a simpler-looking alternative is wrong — most of them
encode a bug that already happened. Keep that when editing; don't trim them to tidy up.

Commit messages lead with the reasoning and the measured numbers behind a change, not a file
list.
