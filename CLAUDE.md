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
- **`ns.formatNumber()` does not exist either.** Formatting lives in an **`ns.format` namespace**:
  `ns.format.number(n, fractionalDigits = 3, suffixStart = 1000, isInteger = false)`,
  `ns.format.ram`, `ns.format.percent`, `ns.format.time` — the cost table entry is literally
  `const format = { number: 0, ram: 0, percent: 0, time: 0 }`, so all four are **0 GB**. Prefer
  them to anything hand-rolled: they are the functions the UI itself calls, so a figure in a log
  reads the same as the one on screen, and they honour the player's Numeric Display settings,
  which a local formatter cannot.

## Running things

Everything runs from the in-game terminal. `boot.js` is the entry point and supervises the rest:

```
run scripts/boot.js                     # root -> deploy -> cloud -> continuous batcher
run scripts/boot.js --target omega-net  # pin the manager's target instead of auto-picking
run scripts/boot.js --targets 5         # cap how many targets the manager runs
run scripts/boot.js --once --no-cloud
run scripts/boot.js --no-formulas       # force the *Analyze math path
run scripts/boot.js --no-contracts      # do not solve coding contracts
run scripts/boot.js --no-sing           # do not run the singularity supervisor
run scripts/boot.js --no-hacknet        # do not buy hacknet nodes or spend hashes
```

**There is one batcher**, `scripts/continuous/`. A second, the volley-firing "shotgun"
(`scripts/manager.js` and its `managerCore`/`prepper`/`math`/`verify`/`ram`/`prep`/`capacity`
modules), was removed as the worse earner; its lessons survive in the comments that cite it.
There is no formulas BUILD: the manager's math module uses Formulas.exe when owned and
re-checks every rescan, so buying the program upgrades the running process. There is no calibration step any more: the per-thread security
constants are measured by one `rpc.js` call at manager startup - see `rpc.js` below.

Individual pieces, useful when diagnosing:

```
run scripts/root.js                     # open ports + NUKE everything reachable
run scripts/deploy.js                   # scp workers home -> every rooted host
run scripts/continuous/servers.js       # per-target state + the steal the calculator would pick
run scripts/connectme.js CSEC           # print the connect chain to a host
run scripts/connectme.js --factions     # routes + backdoor status for faction servers
run scripts/sharemode.js                # share status: power, pool, what each fraction buys
run scripts/sharemode.js on             # trade SHARE_FRACTION of the pool for faction rep
run scripts/sharemode.js off            # every share thread exits within 10s
run scripts/sharemode.js 0.5            # retune live, no restart
run scripts/gang/gang.js --create "Slum Snakes"  # found the gang, once, by hand
run scripts/gang/gang.js                # the gang supervisor (boot starts it too)
run scripts/contracts/contracts.js      # one contract sweep (boot runs it every tick)
run scripts/sing/sing.js                # the singularity supervisor (boot starts it too)
run scripts/contracts/contracts.js --dummy   # mint one contract of every type and solve it
run scripts/contracts/contracts.js --forget  # clear the skip list, after fixing a solver
run scripts/hacknet/hacknet.js --dry-run     # plan a hacknet buy and print it, buy nothing
run scripts/hacknet/hashes.js --dry-run      # plan a hash spend and print it, spend nothing
run scripts/ramreport.js                # game's RAM for every .js -> /data/ram-report.txt
node tests/run.mjs                      # run the test suite
```

**Only one process may own the RAM pool and the report port.** `port.read()` removes the
message and `Server.pending` is per-process memory, so a second owner steals reports and
over-commits the same RAM. `continuous/manager.js` is the only manager file, but **retired
managers are still rivals**: `manager.js` (the shotgun) and both `manager-formulas.js` files are
gone from disk, and filesync never deletes from the game, so a stale copy can still be running.
`boot.js` kills every one before starting the manager (`RETIRED_MANAGERS`; duplicates of the
manager itself: lowest PID wins).

The manager guards itself too: `findRivals` in `continuous/core.js` **aborts** rather than
starting beside any other manager, and does not kill the rival. That is why boot has to clear
them first: a survivor does not make the incoming manager degrade, it makes it exit, and boot
would restart it into the same wall once a minute forever.

Killing a retired manager must also clear its workers. The shotgun exec'd the **same**
`scripts/{hack,grow,weaken}.js` (reports told apart by the port in argv), so `killOrphanWorkers`'
one list covers its in-flight batches. Port 1, its report port, is left unused for the same
reason.

`continuous/servers.js` is safe to run beside the manager: it launches nothing and never touches
the port.

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

A clean `node --check` is not a runtime check. The retired shotgun shipped two runtime
`ReferenceError`s past one — a call site updated without its import, and a `const` in a verbose
block shadowing an outer name so an earlier read hit the temporal dead zone. A shadowing lint was
tried and rejected: matching on indentation flags 14 benign redeclarations across `scripts/`
because it cannot tell a nested block from a different function.

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
its 48.00 GB — enough that it would not start on a fresh BitNode's 32 GB home. String and template literals are free (`Literal` nodes), and so are non-computed
object keys (`{ hack: 1.70 }`), because acorn-walk's `Property` visitor only walks a computed
key. `tests/ram.test.mjs` models all of this and has a guard test naming the expensive
collisions; it is the only thing standing between this repo and a 25 GB variable.

- `config.js` is genuinely free to import: it has no `ns` call and mentions
  `hack`/`grow`/`weaken` only as object keys.
  Keep it that way — one billed `ns` call in `config.js` taxes every script in the repo.
- `continuous/lib/server.js` (the pool) deliberately touches only four cheap functions and
  **no analyze functions**.
- Constants that are linear in threads are measured once, at startup, by a single `rpc.js` call
  in `math.prepare()`. This keeps `weakenAnalyze`, `hackAnalyzeSecurity` and
  `growthAnalyzeSecurity` (1 GB each) out of the manager for the 1.00 GB `ns.run` costs.
  `calibrate.js`, `calib.js` and `/data/calib.json` did the same job with a cached file and a
  6.20 GB recurring transient, and are gone.
- `ns.formulas.*` is 0 GB — what costs is `getServer` and `getPlayer`, the two reads that fetch
  the objects to hand it. Those objects survive JSON (`helpers.server()` checks only that 14
  plain data keys are present, `helpers.person()` likewise), which is what lets a caller fetch
  them through `rpc` when it does not need them hot.

Worker scripts pay their cost **per thread**, so `hack.js` / `grow.js` / `weaken.js` contain
nothing beyond one op and one port write. `share.js` follows the same rule and pays the most for
breaking it: `ns.share` is 2.40 GB, so the worker costs **4.00 GB per thread** and one stray
import of the pool module would add 0.35 GB to every one of tens of thousands of them.

### Escaping the name tax: `rpc.js`

The bill is on NAMES reachable through STATIC imports, and `RamCalculations.ts` walks only
`ImportDeclaration` — so a script GENERATED at runtime is invisible to it. `rpc.js` writes one,
runs it, and reads the value back off a port. The caller pays `ns.run` (1.00) and nothing else;
the body's cost is charged to the transient, for as long as the transient lives.

```js
const c = await rpc(ns, `return { w: ns.weakenAnalyze(1) };`);
const n = await rpc(ns, `return ns.getServerMaxMoney(args[0]);`, host);
```

Four things about it are load-bearing:

- **The filename is a hash of the body.** `Script.ts:39` returns early from `set content` when the
  code is unchanged, so an identical body is written once, never re-compiled and never re-priced.
  The reply port arrives as ARGUMENT ZERO rather than being baked into the text — baked in, the
  source would depend on the caller's pid and every restart would mint a new file, so the litter
  would grow without bound.
- **Each caller replies on `RPC_PORT_BASE + ns.pid`.** Ports 1–4 are taken, and a shared reply
  port would let two resident callers read each other's answers — a wrong number, silently. Any
  positive integer is a legal port (`NumNetscriptPorts` is `Number.MAX_SAFE_INTEGER`), so keying
  by pid is free and cannot collide.
- **A body may `import` the repo's 0 GB pure modules** (`config.js`, `gang/math.js`);
  `rpc.js` hoists the import lines out of `main`, where they would be a syntax error. That is what
  keeps logic out of strings — a body stays a few `ns` calls around a real import.
- **Every quiet failure is made loud.** `ns.run` returns a bare 0 for BOTH "no free RAM on home"
  and "does not compile", so the throw names the file and both causes. The body's own throw is
  caught inside the transient and returned as a value, because a transient that dies takes its log
  window with it a few hundred ms later. A
  timed-out call clears its port first, so a late reply is never read as the next call's answer.
  A second call while one is in flight throws: the game's own concurrency check does NOT catch
  that, `nextWrite()` not being a blocking netscript call. **The guard is a Set of pids, never one
  flag**: the game hands every importer of `rpc.js` the SAME module instance
  (`NetscriptJSEvaluator.ts` `compile`: `if (script.mod) return script.mod.module`), so module
  state is shared by gang, sing and contracts. As a boolean it refused any overlap between
  processes, and sing's pre-install SWEEP - which awaits `contracts.js`, itself a caller - could
  never sweep. Test mocks load one module for one process, which is why nothing caught it.

**It only helps RESIDENT scripts.** `cloud.js`, `root.js` and `deploy.js` already hold their
RAM for under a second, so routing them through here saves nothing
and adds 1.00 GB each. Never for the workers — they are charged per thread and they ARE the call.

**It is invisible to `ramOf()`**, which blanks string literals. `tests/rpc.test.mjs` extracts every
body in `scripts/` and parses it, which recovers the syntax check but not the RAM accounting; a
body's RAM is only ever charged to a transient, so the exposure is a runtime `ns.run` → 0, never a
manager that will not start. Bodies must be plain template literals — an interpolated one is
rejected, because no check can read it and it would mint a file per distinct value.

### Two math backends, one module

`scripts/continuous/lib/math.js` holds both and picks per PROCESS: formulas when the program is
owned, analyze otherwise, and analyze always under `--no-formulas`, which it reads straight off
`ns.args`. Buying Formulas mid-run needs no manager swap.

**This used to be forbidden**, and the rule that forbade it was right at the time: a script
reachable from both paid for both, so there were twin math modules, twin managers, a
`tests/isolation.test.mjs` to keep them apart and a swap in `boot.js` between the files. All of
that is deleted.

`growThreadsToRestore(snap, from, to, atSecurity)` is where the two paths differ. Formulas
honours `atSecurity` by cloning the server object; analyze cannot, because its growth reading
was taken at the snapshot's security. That asymmetry is deliberate and tested
(`tests/continuous.test.mjs`) — do not "fix" it into an equivalence.

Its hot path cannot go through `rpc.js`, because it is a stream. `dispatch()` snapshots every
cadence tick and the launch loop reads op times per op, so `hackAnalyze`, `hackAnalyzeChance`,
`growthAnalyze` and the op-time getters stay resident. Only the constants — the three security
figures and a 64-entry core-bonus table from `weakenAnalyze(1, c)` — go through one rpc call.
That is 11.55 GB for both backends, against 13.35 (analyze) and 9.40 (formulas) as two files.
A snapshot carries `player` only when formulas took it, and every function branches on the
snapshot, so `refresh()` switching the module between a snapshot and its use cannot mix paths.

## Architecture

Layers, bottom up:

Costs below are what the GAME charges, identifier collisions included — module rows are the
marginal cost of importing them, entry rows the script's whole total. Every figure comes from
`ramOf()` in `tests/ram.test.mjs`, which reproduces the game's own breakdown; check against the
editor's RAM panel when one moves.

| module | role | cost |
|---|---|---|
| `config.js` | every tunable, shared so nothing drifts | 0 |
| `rpc.js` | run a body in a throwaway script, get its value back | 1.00 |
| `boot.js` | supervisor, kills retired managers | 3.50 |
| `root.js` | port openers + NUKE | 2.15 |
| `cloud.js` | buys/upgrades servers, capped at 10% of cash | 5.75 |
| `deploy.js` | scp workers home → every rooted host | 2.50 |
| `share.js` | one `ns.share()` loop | 4.00 **per thread** |
| `sharemode.js` | the share toggle, on the manager's own `ServerPool` | 2.25 |
| `continuous/lib/server.js` | `Server` + `ServerPool`: reservations, placement | 0.35 |
| `continuous/manager.js` | entry: continuous core + `lib/math.js`, both backends | 11.55 || `gang/config.js` | gang tunables, paths, STAT_KEYS | 0 |
| `gang/math.js` | the game's gain formulas + every gang decision | 0 |
| `gang/gang.js` | entry: resident supervisor; every gang call is an rpc body | 2.60 |
| ↳ tick body | transient: recruit, tasks, wanted governor | 11.60 |
| ↳ war body | transient: clash engage/disengage | 11.60 |
| ↳ ascend body | transient: ascension decisions | 8.60 |
| ↳ equip body | transient: equipment buying | 14.70 |
| `contracts/config.js` | contract tunables, the gate, paths | 0 |
| `contracts/solvers.js` | all 30 contract solvers, pure | 0 |
| `contracts/contracts.js` | entry: ONE sweep then exits; boot runs it per tick | 4.10 |
| ↳ find body | transient: every .cct with its type and data | 12.00 |
| ↳ submit body | transient: `attempt` and nothing else | 11.60 |
| ↳ dummy body | transient: `--dummy` self-test minting | 3.60 |
| `sing/config.js` | singularity tunables, `SING_SERVICE`, `WORK_ORDER`, `CITY_GROUPS` | 0 |
| `sing/plan.js` | `chooseAction` + `sameAsCurrent` — every decision, pure | 0 |
| `sing/sing.js` | entry: resident supervisor; every singularity call is an rpc body | 2.60 |
| ↳ twenty-eight bodies | transients: read, upgrade, cores, tor, progs, invites, join, travel, apply, gym, crime, faction, company, owned, faction augs, prereq, aug info, aug stats, buy, favor, favor gain, donate, bitnode mults, sweep, install, crime stats, crime chance, backdoors | 2.35–6.60 |
| `sing/backdoor.js` | one fire-and-forget backdoor; many run at once | 5.60 each |
| `hacknet/config.js` | hacknet tunables, the two service paths, the hash price | 0 |
| `hacknet/math.js` | cost ladders, gain ratios, both plans - pure | 0 |
| `hacknet/hacknet.js` | entry: ONE money sweep then exits; boot runs it every other tick | 5.45 |
| `hacknet/hashes.js` | entry: ONE hash sweep then exits; a no-op outside BitNode 9 | 6.60 |

The continuous manager is the entry that has to fit a fresh BitNode's 32 GB home alongside
`boot.js` and `cloud.js`, and `tests/ram.test.mjs` holds it under 16 GB for that reason. It
carries 3.00 GB of live *Analyze reads a non-streaming caller could route through `rpc.js`,
and 2.00 GB for `ns.getServer`, shared by `continuous/lib/cores.js` and the snapshot.

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
- The manager's `serviceShare` (`continuous/lib/share.js`) tops the thread count up once per
  rescan, **before the RAM budget is computed** — so the RAM share took is simply gone from what
  the calculator sees. The top-up is idempotent.

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
pool. `topUpShare` checks `fileExists` per host (0.10 GB) and reports **`noFile` and `refused` as separate causes**.

Keeping them apart is the point, and merging them cost two live runs. The first version blamed a
busy pool when the file was missing; the second told the user to run `deploy.js` on a fleet where
`deploy.js` had already copied the worker to all 68 hosts, because the same list was collecting
`exec` failures too. **A diagnostic that names the wrong cause is worse than none — it gets
acted on.** A refusal now prints what was asked against what the pool believed was free, so the
next log diagnoses itself instead of costing another round trip.

### The continuous batcher (`scripts/continuous/`)

The only batcher. It replaced the retired shotgun's volley with a **stream**: batches are
dispatched at a cadence and each op is `exec`ed just in time for its own landing, so an op holds
RAM for its own duration rather than for the whole weaken window. Measured at $947m/s average on
a live save with `bad 0` and 10–11 ms of jitter against a 100 ms spacer.

**Self-contained in LOGIC, shared in CONTRACTS.** What crosses between `scripts/continuous/` and
`scripts/`, and nothing else:

- `continuous/config.js` re-exports the contracts from `scripts/config.js` — the share protocol,
  the worker paths, `HOME_RESERVE_GB`, `PORT_CAPACITY`. Values a second party (`sharemode.js`,
  `share.js`, `boot.js`, the hacknet) reads. **Tuning stays local** to `continuous/config.js`.
- **The batch workers** `scripts/{hack,grow,weaken}.js`, taking the report port as an argument.
- `scripts/rpc.js` may be imported from here, and `sharemode.js` imports `lib/server.js`.

It keeps its own deploy (a bought server never fires `deploy.js`'s trigger) and its own report
port (3, not 1 — a killed shotgun leaves reports in flight for a whole window, and on a shared
port they would be credited to batch ids that never existed here).

Both test loaders mirror the whole of `scripts/` through `mirrorScripts` in `tests/harness.mjs`,
which rewrites both import spellings (`"./x.js"` and `"scripts/x"`). A cross-tree import will not
load in a test otherwise.

**A re-export must spell its source `"scripts/<path>.js"`.** The module loader resolves
`export … from` like an import, but `RamCalculations.ts` does not: its `ExportNamedDeclaration`
branch looks the raw specifier up in the server's script map, whose keys carry the extension and
no leading slash. `from "scripts/config"` ran fine and failed the RAM check with `Import Error
"scripts/config" does not exist on server: home`, so the continuous manager would not start. A
test in `tests/ram.test.mjs` checks every re-export's spelling.

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

**A stream owns its SLICE, not its cadence.** `chooseSteal` returns both together, sized at the
fraction *it* chose - but the controller runs at its own fraction and ramps toward that optimum in
`STEAL_STEP_UP` steps, each gated on `STEAL_MIN_SAMPLES` clean batches. Handing the stream the
cadence paces it for a batch it is not sending: a live run sat at 3.2% against a 29% optimum on a
17.6s cadence priced for 29%, held depth 9, and left 17.25 TB of an already-committed pool idle at
a ninth of the income the slice was carved out for. It was self-sustaining too - the ramp needs 8
landings per step, so a cadence too slow for the batch starves the evidence that would correct it
(141s per step, ~13 minutes to climb back). So rescan calls `setSlice`, and `stream.pace` re-derives
the cadence at every dispatch from the batch it just planned, where the fraction, the hacking level
and the drift budget are all already in hand for free.

**Both `pace` and `chooseSteal` price RAM as the dispatch GATE charges it** (`heldFromDispatch`),
not as the game holds it. The gate refuses against `freeRam - queuedRam`, so a batch is charged
whole from dispatch until it lands, `W * (1 + anchorSwing) + MIN_LEAD_MS` - and the swing reaches
its 0.25 cap at high steal. Pricing one weaken window (`heldAllAtOnce`, on the theory that it
over-stated JIT) under-stated that by up to 25%: a live swap sized phantasy at 44% for 89.8 TB
of an 85% budget, the pipeline hit no room at depth 112, and the steal fell to 0.5%.

Two things turned that into a collapse, and both are fixed separately because any real squeeze
reaches them. **No-room evidence is ignored for one pipeline turnover after a step**
(`noRoomFrom`): the pool is still full of old-size batches, so each refusal re-fired the back-off
on "1/1 dispatches found no room", nine steps in seconds. **The security ceiling is sized for the
largest batch in flight** (`floorSec`, mirroring `floorSteal`): a step to 3.4% cut it to 7.62 while
44% grows landed at 8.48, and the stream stopped itself for re-prep.

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
`sharemode.js`. Every rule in it is one the retired shotgun learned expensively: proportional
placement, both passes planned before anything execs,
`noFile` and `refused` kept apart, and nothing routed through `pool.allocate` (a reservation is
released at cycle end and a share worker is not, so the same bytes would be subtracted twice).
It is called once per rescan and **before the RAM budget is computed** — a budget taken first
prices RAM share is about to take, and the calculator then commits a fraction it cannot place.

Its log mirrors to `/data/continuous.log.txt`. That file is written to the GAME's filesystem and
filesync only pushes the other way, so getting it onto disk means `download /data/continuous.log.txt`
from the terminal.

### The gang subsystem (`scripts/gang/`)

Self-contained like `continuous/`: it imports only `scripts/rpc.js` from outside, and `scripts/`
reads exactly one 0 GB path constant out of it (`boot.js` imports `GANG_SERVICE`). It shares no RAM pool, no
port and no file with the batcher, so the two cannot interfere.

**There is no tick to detect.** `ns.gang.nextUpdate()` is **0 GB** and resolves on the next gang
update, returning the ms of gang time processed. The gang tick is **2 s** (`minCyclesToProcess =
2000 / MilliPerCycle`), up to 5 s per update while bonus time drains (`maxCyclesToProcess`), and
territory/power update separately every `CyclesPerTerritoryAndPowerUpdate = 100` cycles. Watching
stats change to infer a timer measures the same thing worse and drifts.

**A supervisor plus rpc bodies, because the gang API is priced off `GangApiBase = 4`.** The
surface this needs is ~37 GB held together, which would not start on a fresh BitNode's 32 GB home
beside `boot.js`, `cloud.js` and a continuous manager. So `gang.js` holds **no gang call at all**
(1.60 + `run` = 2.60): every one lives in one of four template-literal bodies (tick, war, ascend,
equip) run through `rpc()`, each billed to its own transient for as long as it runs. Each body
**reads and acts in one process**, so no decision is split across a boundary, and every decision is
a call into `gang/math.js`. The bodies are awaited one at a time — that is the whole RAM argument;
together they would stack to ~46 GB — and `rpc()` throws on overlap anyway.

**Body imports are spelled `"/scripts/gang/math.js"`, with the leading slash.** The game resolves
it root-absolute like the bare form, but the test harness's import rewriter and `ram.test`'s
import-follower both match only `"scripts/..."` — and both scan template literals as text. The bare
spelling had the harness rewrite the import lines inside the body strings to paths relative to
`gang.js`, which then failed to resolve from the transient. The slash also keeps a body's imports
from being billed to `gang.js` in the RAM model, which is correct: they are the transient's.

**This replaced four transient files, a report port, a marker file and a test that every path in
every transient reported before returning.** All of that existed because a transient's `ns.print`
dies with its log window and a thrown transient was indistinguishable from an idle one. `rpc()`
closes both: a body's return value comes back directly, and its throw is caught inside the
transient and re-thrown in `gang.js` naming the error, which logs it as a `WARN` and carries on.
State that used to cross in `/data/gang.txt` now crosses as a JSON argument: the tick body returns
it, and ascend and equip receive it. **`respectForNextRecruit` is `Infinity` at a full roster and JSON
has no `Infinity`**, so it crosses as `-1` and the ascend body turns it back — the same number that
killed ascend and equip once already when it went through a file.

Figures go through `ns.format.number` / `.percent` / `.time` in `gang.js` — the game's own
formatters at 0 GB. A hand-rolled one produced `$5.43e+7` in a live log, which is not a money
format; a test bans `toExponential`, `ns.formatNumber` and `(x * 100).toFixed` across the subtree.

**The log says something on every pass, including the passes that did nothing.** The war line
reports every run, not only on a change: "why are we not taking territory" — the question actually
asked — is answered by "standing down, worst win chance 41%", and a log that only spoke on a
transition had no answer. A pass that buys no gear says why.

**Two identifier collisions cost real GB here**, both of them fields the API hands you:

- `GangMemberInfo.hack` (also `GangTaskStats`, `GangMemberAscension`) — `m.hack` is 0.10 GB in the
  file that writes it *and* in every importer. `STAT_KEYS` + `m[k]` is why `gang/math.js` is 0 GB.
- `GangGenInfo.respectForNextRecruit` is also a **1.00 GB `ns.gang` function**. The tick body reads it
  as `info["respectForNextRecruit"]`; a computed key is a Literal and costs nothing.

Two tests in `tests/gang.test.mjs` pin both, because neither has a symptom short of the game
refusing to start the script.

**Every decision lives in `gang/math.js`**, which is a line-for-line port of
`src/Gang/formulas/formulas.ts` plus the planning on top. Reproduced rather than called through
`ns.formulas.gang` because that needs Formulas.exe and takes `GangMember` objects the API never
hands out — only `GangMemberInfo`. `tests/gang.test.mjs` transcribes the same formulas a second
time, flat, rather than reusing the module's helpers.

Things that look arbitrary in there and aren't:

- **A task below its difficulty pays exactly zero**, not a little — every formula subtracts a
  multiple of `difficulty` from the weighted stat sum and returns 0 if that goes non-positive.
  That is the entire reason `TRAIN_STAT_FLOOR` exists; "assign the best task" without it parks the
  opening roster on nothing.
- **`GANG_SOFTCAP` cancels out of ranking.** It appears only in the gain exponent and `pow` is
  monotonic, so task order is the same for any positive exponent. Worth knowing before paying
  4.00 GB and a Source-File for `ns.getBitNodeMultipliers`.
- **The wanted governor is sized, not guessed.** Vigilante Justice has `baseWanted: -0.001`, so its
  contribution is a computable negative; the governor flips the worst offenders until *net* wanted
  gain is non-positive and no further. It runs **last** in `planTasks` because it needs the real
  total, which is not known until everyone else is placed. No hysteresis, deliberately: flipping
  drops wanted, which releases them, and a limit cycle around the floor is the right steady state.
- **It triggers on HEADROOM, never on the raw wanted penalty.** `Gang.ts` clamps `this.wanted` to
  **1**, and skips the whole wanted block entirely at exactly 1 with negative gain — so penance
  there is not merely wasted, it is ignored. But the penalty is `respect / (respect + wanted)`, so
  a fresh gang at 5 respect reads **0.833** with wanted already on that clamp and nothing to fix.
  The first version gated on that number and deadlocked a live gang: it posted vigilantes,
  vigilantes earn no respect, and respect is the only term that could lift the penalty. The gate is
  now `wantedHeadroom` — the penalty over the penalty attainable at wanted 1 — which is exactly 1
  at the clamp, so the governor stands down there by construction rather than by a special case.
- **`phaseFor` keys TRAIN on "no member is ready"**, not "some member is training" — otherwise one
  freshly ascended member drags eleven earners back to the training yard.
- **Earners rank on respect ONLY in RESPECT; TERRITORY and MONEY rank on money.** TERRITORY used
  to rank on respect, which for combat stats picks Terrorism every time (`baseRespect` 0.01 vs
  Human Trafficking's 0.004, respect territory exponent 2 vs 1.5) - and Terrorism has **no
  `baseMoney`**. A live gang sat at 12 members, 6 on warfare and 6 on Terrorism, earning $0, and
  since territory only moves once the war is winnable, TERRITORY can last indefinitely. Respect
  does not stop: Human Trafficking is the money pick and still returns about a tenth of
  Terrorism's respect. At a full roster respect buys the equipment discount (`getDiscount`, linear
  in `respect / 5e6`) and faction rep, **not income** - money depends on respect only through the
  wanted penalty, which is already ~99.8% of achievable once respect dwarfs wanted.
- **Territory warfare takes the WEAKEST earners** (same power, least forgone income), and
  `warDecision` engages on the **minimum** win chance across rivals, with hysteresis. A clash is
  drawn against one gang at a time, so five safe matchups do not make a sixth safe, and losing one
  kills a member.
- **Ascension is refused when it would cost the next recruit.** `result.respect` is respect *lost*,
  and respect is what gates recruiting; under a full roster a recruit beats a multiplier on one
  member. The ascend body decrements its own running total rather than re-reading the gang.
- **Gear is bought in every phase, TRAIN included, though `ascend()` reapplies only augs.** It
  used to wait out TRAIN as money the next ascension burns, which had it backwards: member stats
  include the equipment multipliers, so gear lifts trainees over `TRAIN_STAT_FLOOR` sooner, and
  that floor is the only thing ending TRAIN. The purchase is lost at ascension; the phases it bought
  are not. The planner takes no phase at all. Purchases are planned **item-major**, cheapest
  first: member-major lets the first member empty the budget on its own wishlist.
- **Hack-only items are a separate TIER, opened only when every member owns the combat list.**
  Every Rootkit and three augmentations (BitWire, Neuralstimulator, DataJack) carry
  `mults: { hack: x }` and nothing else, and no combat task weights hacking above zero - so
  cheapest-first handed a $5m NUKE Rootkit priority over a $12m Katana. `isHackingItem` decides
  that from `getEquipmentStats`, not from a list of names, because the upgrade roster is exactly
  the kind of thing a fork edits and a stale list would go on mis-sorting with no symptom. It is
  the only thing that 2.00 GB buys; gear is still not scored against gear.

  **Ordering alone was not enough, and the gap is easy to miss.** The planner skips an item it
  cannot afford and moves to the next, so with hack items merely sorted last a $20m budget bought
  a $12m Katana, skipped a $25m Liquid Body Armor and spent the $8m remainder on the Rootkit
  anyway. `considerItems` is the gate, and it is the only implementation of it - `planPurchases`
  calls it twice against the same mutating `owned` map so a sweep big enough to finish the combat
  list opens the tier in that sweep rather than ~30 s later, and the equip body re-derives the log's
  shortlist through it so a zero-buy line cannot name a cause the planner did not use. The price
  is idle cash in the window `cloud.js` is bidding for it; the budget is re-priced every sweep, so
  the money is offered elsewhere rather than lost.

  The mirrored rule for a hacking gang is deliberately NOT implemented - the tick body refuses those
  outright, so nothing writes `isHacking` true; the marker carries the flag anyway so the gate is
  right on the day that changes rather than silently backwards.
- **A pass that buys nothing must say WHY.** The equip transient originally printed only when it bought
  something, so "the gang already owns everything", "the budget is too
  small" and "no marker yet" were all one blank line. `eligibleItems` is exported so the log
  re-derives the shortlist through the same function the planner used, rather than a copy that can
  drift and name a cause that isn't the real one.
- **`EQUIP_BUDGET_FRACTION` is per SWEEP, and a sweep is every ~30 s.** It reads far tamer than it
  is, and `cloud.js` is bidding for the same cash capped at 10% — set it high and the server fleet,
  which is the batcher's whole growth path, stops growing.

**Which config changes need a restart.** `gang.js` is the only long-lived process, so it is the
only one holding stale constants: `TICK_EVERY`, `WAR_EVERY`, `ASCEND_EVERY`, `EQUIP_EVERY`, and the
`ASCEND_MULT_THRESHOLD` its log line quotes, are frozen at the value it started with. **Everything else is read inside an rpc
body and takes effect on that body's next run** — `Script.ts` cascades
`invalidateModule()` to every dependent, so writing `config.js` re-compiles `math.js` and every
generated transient that imports it, and the next `ns.run` picks up the new value with no restart.

`boot.js` gates the service on `ns.gang.inGang()` (0 GB) rather than starting it blind — without a
gang the supervisor exits at once and `ensureService` would relaunch it every tick forever, the
same trap `CLOUD_DONE_MARKER` closes for cloud. `--no-gang` opts out. A bare `gang` identifier
costs nothing: `findFunc` matches a key only when its value is a function or a number, so it
descends into the namespace and finds no leaf of that name.

### The contract solver (`scripts/contracts/`)

Self-contained like `gang/`: it imports only `scripts/rpc.js` from outside, and `scripts/`
reads exactly one 0 GB path constant out of it (`boot.js` imports `CONTRACTS_SERVICE`).

**The gate is about REPUTATION, and the reason is not obvious from the API.** The reward
*faction* is chosen when a contract is ATTEMPTED, not when it is generated.
`ContractGenerator.getRandomReward` stores a bare type (`{ type: 0|1|2|3 }`) and `Contract.ts`
says so out loud — *"the reward is actually processed outside of this file"*.
`PlayerObjectGeneralMethods.gainCodingContractReward` resolves it on attempt: both
`FactionReputation` and `FactionReputationAll` filter `Player.factions` by `offerHackingWork`
and **recurse into `Money` when that list is empty**; `CompanyReputation` needs `Player.jobs`
and otherwise coin-flips into those two, which fall back the same way. Three of the four
reward types pay rep, so solving before a faction is joined converts all of them to cash.
Contracts never expire, so the wait costs nothing WITHIN an aug cycle - they simply pile up.

**Across an install they are destroyed.** `Prestige.ts` calls `prestigeAllServers()` on both
`prestigeAugmentation` and `prestigeSourceFile`, and `initForeignServers` then builds fresh
ones - so every unsolved contract on the network goes with them, and a backlog at install
time is lost reputation. This is the second reason the per-tick cadence beats the ten-minute
one it replaced: nothing is ever more than a minute old, so there is no backlog to lose. A
hand-run `run scripts/contracts/contracts.js` before installing is still free insurance.

Hence **both halves of the gate**: 10 minutes past `max(lastAugReset, lastNodeReset)` *and*
at least one joined faction. The clock alone is not enough — ten minutes into a BitNode the
faction list is usually still empty. The `max()` is not decoration either: entering a BitNode
sets `lastNodeReset` and an install sets `lastAugReset`, and reading only one lets a fresh
node inherit an old timestamp and sweep immediately.

**It is a TRANSIENT, not a service, and that is the opposite of `gang/`.**
`boot.js` runs it once per tick with `runToCompletion`, the way it runs `root.js` and
`deploy.js`, so **nothing is held between sweeps**. It was a resident service first and that
was the wrong trade: 4.10 GB pinned forever to re-read a clock that only matters once every
ten minutes. A shut gate now costs 4.10 GB for about 300 ms and zero in between.

**So the gate lives in `contracts.js`, not in the FIND body.** A shut gate is the common case
for the first ten minutes and must not cost a 12.00 GB transient once a minute to discover.
`getResetInfo` (1.00) and `getPlayer` (0.50) resident here is what makes a per-minute cadence
affordable — it is why the entry is 4.10 and not 2.60.

**Everything that must outlive a run is a file**, because a transient forgets and its
`ns.print` log window dies with it:

- `/data/contracts-refused.txt` — the skip list. This **had** to become a file. An in-memory
  set was fine for a service; at once a minute a deterministic wrong answer spends all ten of
  a contract's tries inside ten minutes, and "Array Jumping Game" allows exactly **one**, so
  it would be destroyed on the very next run. `--forget` clears it, which is what to run after
  fixing a solver — entries are otherwise skipped for the life of the BitNode.
- `/data/contracts-gate.txt` — the last gate message, so it is said **once** rather than every
  tick. Clearing it when the gate opens is load-bearing: an install shuts the gate again, and
  without the clear the reason would never be repeated.

**A supervisor plus rpc bodies, because `ns.codingcontract` is priced off
`CodingContractBase = 10`.** `attempt` is 10, `getContractType` and `getData` 5 each,
`getContract` 15. Reading and attempting in one process is ~22 GB with the network walk,
which will not start on a fresh BitNode's 32 GB home beside `boot.js`, `cloud.js` and a
continuous manager. Split across FIND (13.50) and SUBMIT (11.60) the peak is 13.50, and
`contracts.js` holds no contract call at all (1.60 + `run` = 2.60). The solving happens
*between* the two, resident, because it is pure arithmetic — `solvers.js` is 0 GB.

**`ns.getPlayer()` cannot answer the clock.** It carries `totalPlaytime`, not
`playtimeSinceLastAug`, so the gate reads `ns.getResetInfo()` (1.00 GB) for the timestamps
and `getPlayer` (0.50) for the faction list. Both live in the FIND body, so the resident
process pays for neither.

**Square Root's data is a `bigint`, and `JSON.stringify` throws on one.** `SquareRoot.ts`'s
`getData` returns `BigInt`, and `rpc.js` returns every value through `JSON.stringify` — so
an unconverted Square Root contract does not merely fail itself, it takes the whole sweep
down and every other contract on the network goes unsolved with it. The FIND body stringifies
before returning, the solver takes and returns a decimal string, and `attempt` accepts that
because `convertAnswer` is `BigInt(ans)`. `tests/contracts.test.mjs` pins the collateral
damage, not just the conversion.

**A contract that vanishes between the read and the attempt is not an error.** `attempt()`
THROWS with "Cannot find contract" when the file is gone, and the SUBMIT body catches it PER
JOB - per batch, one throw would lose every other answer in the same call. Two sweeps
overlapping is the ordinary cause - a hand-run beside boot's own tick. It is counted separately from a wrong answer: nothing is broken, so it neither goes
in the skip list nor shouts at the terminal.

**Two lines reach the TERMINAL, and only two:** a solved contract with its reward, and a wrong
answer. Both are rare - a handful per ten minutes at most - while the sweep summary is mostly
"0 solved" and would be spam. The reward string is reprinted verbatim from `attempt()`, which
returns `gainCodingContractReward`'s own text, so money in it comes from the game's
`formatMoney` and reads the same as the UI.

**A wrong answer is never retried.** The solvers are deterministic, so a second attempt
spends another try on the same wrong answer until
`NetscriptFunctions/CodingContract.ts` removes the contract at `getMaxNumTries()` — and
"Array Jumping Game" allows exactly **one** try. A refusal goes in an in-memory skip set. For
the same reason a type with no solver, or a solver that threw, is reported as unsolved and
never attempted: `solve()` returns `null` rather than a guess.

**`solvers.js` is a transcription, not a re-derivation.** The game checks the answer against
ITS algorithm, not against the problem statement, and four types diverge from what the
statement implies: "Largest Rectangle" accepts any rectangle of the optimal *area*, "Shortest
Path" any path of the optimal *length*, "Compression III" any encoding no longer than its
own, and "Array Jumping Game II" answers **0**, not Infinity, when the end is unreachable.
`tests/contracts.test.mjs` uses the examples printed in the game's own descriptions so the
fixtures check the transcription rather than a second copy of the same reasoning.

**One contract name is not ASCII, and the key is written as `è` for two reasons.**
`Encryption II: Vigenère Cipher` is the only type in `CodingContractName` carrying a
non-ASCII character. The first version folded it to `Vigenere`, so `SOLVERS[type]` missed,
`solve()` answered `null`, and the contract read as permanently unsolved **with no error
anywhere** - the log simply listed it under "unsolved" forever. A live `--dummy` run scored
29 of 30 and is what found it.

The suite did not, and that is the more useful half of the story: `tests/contracts.test.mjs`
carried the SAME fold in its own type list, so "every contract type this fork defines has a
solver" compared a typo against itself and passed. The fixture now builds the name from an
escape, and asserts the folded spelling is **not** a key as well - "add both spellings" would
satisfy the first assert while leaving unanswered which one the game actually sends. Planting
the fold back now reddens three tests.

Writing it as an escape rather than a literal also keeps `solvers.js` **pure ASCII**, so
neither hop into the game can re-encode it. CLAUDE.md already names the filesync extension as
the least reliable link here, and `ns.scp` is the second.

**It is also where the identifier tax is most likely to land.** Thirty algorithms want to
call things `window` (25.00 GB), `run` (1.00 — RLE run lengths), `attempt` (10.00) and
`getData` (5.00). The `BANNED` guard in `tests/ram.test.mjs` covers six names; what actually
protects this file is the pin holding `ramOf("contracts/solvers")` at exactly `BASE`, which
covers every name in the cost table. It has already caught one: a local named `scan` in
`contracts.js` cost 0.20 GB and pushed the entry to 2.80.

**`--dummy` is the real verification.** `ns.codingcontract.createDummyContract` (2.00 GB)
mints one contract of every type `getContractTypes()` reports — asked, not hardcoded, so a
fork that adds a type is caught by the self-test instead of silently skipped by it. Dummy
contracts carry a **null reward** (`generateDummyContract` passes `null`), so nothing is
spent and a wrong solver destroys only a dummy. `--dummy` ignores the gate, since the point
is to run it before the gate ever opens.

**`runToCompletion`, not `ensureService`, and the `inGang()` trap does not apply.** That trap
is about a *service* that exits immediately and gets relaunched forever; this is a transient
that is *supposed* to exit, so there is nothing to gate on. boot checks `isUp` first anyway —
not for duplicates but for **stacking**: a hand-run `--dummy` can still be going, and a second
sweep on top of it would have both attempting the same contracts. It runs last in the tick
because `runToCompletion` blocks. `--no-contracts` opts out.

### The singularity subsystem (`scripts/sing/`)

BitNode 4 automation: home RAM and cores, TOR and darkweb programs, faction invites, travel to collect Tian
Di Hui's and the chosen city group's, and the player's own work (company and faction rep; gym and
Homicide only for an opted-in gang; a money crime when there is nothing else). Self-contained
like `gang/`: it imports only `scripts/rpc.js` and re-exports one 0 GB constant from
`scripts/config.js` (`SHARE_HOLD_MARKER`), and `boot.js` reads one path constant out of it.

**Many small bodies, not a few fat ones.** `sing.js` holds no singularity call (2.60), and
`rpc()` allows one call in flight per process - so the free RAM the subsystem needs is the
**max** over its bodies, never the sum. `commitCrime` alone is 5.00, so the CRIME body at
**6.60** is the floor of that max, and every other body is held at or under it: work was one
12.70 body (stop, focus, gym, crime, faction together) and joining was 7.60 until each was
split. Splitting *below* 6.60 lowers nothing and costs a round trip, which is why UPGRADE (6.25)
and READ stay whole - READ sits exactly ON the ceiling since `getCompanyRep` joined it, so the
next read it needs is a second body, not a bigger one. `tests/ram.test.mjs` prices every body
through `bodiesOf()` - the only place a body is priced before the game does it - and pins all
twenty-eight.

The split also retired two calls outright: `gymWorkout`, `commitCrime` and `workForFaction` all
take `focus` as an argument, so `setFocus` is never needed, and starting work finishes the
previous work, so `stopAction` is not either.

**Always on, and it PARKS rather than exits.** Singularity has no 0 GB availability check -
`getResetInfo` is 1.00 and boot is pinned at 3.50 - so boot cannot gate it the way it gates the
gang on `inGang()`. Without Source-File 4 outside BN4, every call throws `checkSingularityAccess`'s
"requires Source-File 4"; `sing.js` matches that **message** and sleeps forever. Exiting would
have `ensureService` relaunch it every tick, and matching the message rather than "the first call
failed" is what keeps a no-RAM blip at startup from idling it for the whole BitNode. The cost of
always-on where it cannot work is 2.60 GB; `--no-sing` reclaims it.

**One `Player.currentWork` slot, and only the three action bodies touch it.** Every
work-starting call finishes whatever held it, so a work call anywhere else - a PROGS body
"helpfully" writing a program - cancels the faction session every fourth tick. A test bans the
starters everywhere except their own body. `createProgram` is not used at all: buying the program
is cheaper than the hours writing it takes. Only `PROGS_WANTED` is bought - the five port openers
and Formulas.exe: cheapest-first over the whole darkweb spent ~$2m on ServerProfiler, DeepscanV1
and AutoLink before FTPCrack's $1.5m.

**An action already running is never restarted.** `CrimeWork.process()` never returns true - it
loops `commit()` - so crime is continuous, and `new CrimeWork()` zeroes `unitCompleted`. Homicide
(3 s) restarted every 20 s tick loses about a seventh; any crime longer than the tick, restarted
every tick, completes **never** - with a log that happily says "crime" forever. READ returns
`getCurrentWork()`, `plan.js`'s `sameAsCurrent` compares, and an action body runs only on a
difference. Faction work survives a restart, which is why the naive version looks right until
crime matters.

**`getResetInfo().ownedSF` is a Map, and JSON turns a Map into `{}`** - the same class as the
gang's `Infinity` and the contracts' `bigint`. READ collapses it to `hasSF2` inside the
transient; a test asserts the body touches it only through `.has()`.

**A warning is logged once per body, not per tick**, and cleared on that body's next success.
"No free RAM on home" is the expected state for a fresh BitNode's first minutes, and a line a
tick about it buries the warning that matters. `HOME_RESERVE_GB` was left at 32 deliberately: the
worst overlap of awaited transients from three processes (contracts find 12.00 + gang equip
14.70 + CRIME 6.60) is 33.30, and the failure that 1.30 GB buys is one deduped WARN and a retry.

**The gang grind is opt-in, and LIVE.** `GRIND_GANG_KARMA` defaults off: -54000 karma is ~18000
successful homicides, ~15 hours even at 100% success, that earn no rep anywhere. The gym goes with
it - Homicide's success and the crime factions' combat bars are all the combat stats serve here.
The flag is read inside the READ body, not by `plan.js`: a body re-imports `config.js` every run,
so flipping it takes effect next tick, while anything the resident process imports (the cadences,
`WORK_ORDER`) is frozen until sing restarts. The tick is 20 s and every cadence is counted in
ticks, sized so upgrade and join run each minute and programs and promotions every two - change
the tick and re-derive them.

**Rep work follows `WORK_ORDER`, and a step is a faction OR a company.** Tian Di Hui first, for
the Neuroreceptor Management Implant, which it alone sells and which removes the 0.8
unfocused-work penalty. Then Bachman & Associates the **company**: its faction's augs raise rep gain, and
the invite needs employment there plus `CorpFactionRepRequirement` = 400k company rep. The step
is skipped below hacking 225 (intern `reqdHacking` 1 + Bachman's `jobStatReqOffset` 224) rather
than applied for every tick. Promotion is re-applying: `applyForJob` hands out the highest
position the player qualifies for and touches only `Player.jobs`, so APPLY runs every
`PROMOTE_EVERY` ticks mid-shift and is not an action body. Neither `applyToCompany` nor
`workForCompany` checks the city, so Bachman being in Aevum does not matter. After Bachman the
hacking factions run HIGHEST first (Daedalus, BitRunners, The Black Hand, NiteSec, CyberSec): the
higher shops largely cover the lower ones' augs, and each lower target drops as those are bought.
After the hacking factions come the six city factions (only joined ones apply), then every
megacorp as a company step followed by its faction: the same 400k bar, hired at 250 hacking for
ECorp, MegaCorp and NWO and 225 for the rest. A company step's `faction` defaults to its own
name. Fulcrum is the exception: its faction is Fulcrum Secret Technologies, which also wants
`fulcrumassets` backdoored. **Work runs in two tiers.** The AUGS pass rates every aug once per
process with AUG_STATS (`getAugmentationStats`, 6.60). An aug is tier 1 when it raises any
hacking multiplier or `faction_rep` / `company_rep`, or when it is named in `PRIORITY_AUGS`
(the Neuroreceptor implant, whose effect is not a multiplier). `chooseAction` walks the steps
against tier-1 targets first, and against every aug's targets only once no step has tier-1 work.
The goal is the hacking level `w0r1d_d43m0n` needs, and rep-gain augs speed up every later hour
of that.

**Nothing to work means a money crime, not idle.** After an install no faction is joined and the
company step waits on hacking 225, so the first stretch of every node had nothing to do - while TOR,
the programs, the Tian Di Hui trip and home RAM all wait on money. `bestCrime` takes the highest
`chance x money / time`, both read from the game (`getCrimeStats`, once per process - money already
carries the multipliers - and `getCrimeChance`, every idle tick, since odds move with every stat
point), so no crime table is transcribed. It picks only from `MONEY_CRIMES` - Shoplift, Mug, Deal
Drugs, Homicide, all 2-10 s - the user's rule: a switch or real work turning up restarts the crime
and forfeits the unit, which on Heist is 600 s. Crime was chosen over the university: the batcher already
out-earns a class in hacking exp, and crime also trains the combat stats. Only a failed read leaves
it truly idle.

**One city group per install, and travel collects its invites.** The six city factions are three
enemy groups (`FactionInfo.tsx`): Sector-12 + Aevum, Chongqing + New Tokyo + Ishima, and
Volhaven. Joining one locks out the others until the next install, which resets membership. So
`chooseCityGroup` picks one group per install, the one with the most tier-1 augs left and then
the most augs overall, with ties going to Sector-12's group. JOIN declines the other groups'
invites, and over enough installs every group's augs come within reach. A city invite needs the
player standing in that city with its cash (Sector-12 $15m up to Volhaven $50m). `chooseTravel`
walks the stops in order: Tian Di Hui (any of Chongqing, New Tokyo or Ishima, hacking 50, $1m),
then each unjoined city of the group with augs left. It goes to the first stop whose bar is met:
the bar alone where the player already stands, or the bar plus a fare out and back from anywhere
else. Standing there means waiting for the invite. This is also what collects Aevum's invite,
which the old Tian Di Hui-only trip never did. A flight skips that tick's work, because READ's
player still stands in the old city.

**Backdoors: the four faction servers first, then the whole network.** CyberSec, NiteSec, The Black
Hand and BitRunners invite on a backdoor alone (`BACKDOOR_HOSTS`, the four `connectme.js --factions`
reports), so they lead; every other server follows, at the user's request - it earns nothing else,
not even Intelligence (`installBackdoor` never calls `gainIntelligenceExp`; a *manual hack* does).
Every `BACKDOOR_EVERY` ticks the BACKDOORS body (4.15) BFSes from home - `connectme.js`'s walk,
copied because importing it bills its `getServer` and `tprint` - and returns what is left in that
order with each route, plus the targets of the `backdoor.js` copies already running (`ps`) and
home's free RAM. Skipped: home, anything `purchasedByPlayer` (direct-connect already; hacknet throws)
and `w0r1d_d43m0n`, whose backdoor ends the node and is the user's call - `backdoor.js` refuses it too.

**The install is a real file, fire-and-forget, and many run at once.** `installBackdoor` takes
`hackTime / 4`, far past rpc's 10 s, and a transient that returned early would take its pending
backdoor down with it - so `sing.js` `ns.run`s `scripts/sing/backdoor.js` (5.60, `BACKDOOR_GB`) per
server and waits for none. Parallel is safe because `installBackdoor` reads
`Player.getCurrentServer()` once, AT THE CALL (`Singularity.ts`), then only awaits a timer, and a
copy's connect hops and that call run with no `await` between them - nothing can move the terminal
in the middle. It walks the route hop by hop from home and a `finally` puts the terminal back on
home. Copies start while home keeps `BACKDOOR_KEEP_GB` (6.60, sing's largest body) free - which on a
32 GB home usually means none until the first upgrade. This is the one place sing holds RAM outside
the max-over-bodies rule, bounded by that keep. A failed copy leaves its server unbackdoored and the
next pass retries; once nothing is left the pass stops for the life of the process.

**Share follows faction work.** The share bonus is in the three faction formulas in
`src/PersonObjects/formulas/reputation.ts` and nowhere else - company work never reads it - so
share during the gym, crime or company work is batcher RAM spent on nothing. `sing.js` writes
`SHARE_HOLD_MARKER` on each change: `"hold"`, or `""` while faction work runs. The manager reads
share through `effectiveShareFraction(marker, hold)` in `scripts/config.js`, and the user's
fraction in `/data/share.txt` survives it. A missing or
empty hold file is no hold, so without sing share behaves exactly as before - and the two ways
sing can stop while holding both release it: a parked `sing.js` clears it, and so does
`boot.js --no-sing`.

Every invite outside the chosen city group is accepted: only the city factions have enemies in
this fork, so there is nothing else to deny.

**A faction is worked to the rep its unbought augs need, and no further.** Every `AUGS_EVERY`
ticks the aug pass reads what is owned (`getOwnedAugmentations(true)` - installed AND queued),
what each faction sells, and each unowned aug's rep and price; `repTargets` makes each faction's
target the dearest rep requirement left, and **0 when everything is bought, which skips it** -
the live bug this fixed was Tian Di Hui being farmed with every aug already purchased. NeuroFlux
never counts: nearly every faction sells it at an ever-rising level, so counting it would make
every target unreachable. A faction not read yet falls back to `FACTION_REP_TARGET`, and unknown
never reads as done. The company step uses its faction's target too, so Bachman is not worked for
an invite that would buy nothing.

**Augs are bought as a BATCH, or not at all** - the user's rule. `planAugBuys` takes every aug
that is rep-unlocked at a joined faction, **tier 1 first, then dearest first within each tier**
(each queued aug multiplies every later price by 1.9 - `getGenericAugmentationPriceMultiplier` -
so cheap-first pays the multiplier on the expensive ones), skipping any that do not fit or whose
prerequisite is neither owned nor earlier in the batch; then NeuroFlux levels fill, each x1.14
dearer in money AND rep. It returns the batch only when queued + batch reaches `MIN_AUG_BATCH`
(10) and cash covers all of it. 1.9 is the ceiling - Source-File 11 only lowers it - so the plan
over-states and can never buy a batch it cannot finish. Whatever is left then goes on home RAM
(UPGRADE, then CORES, at fraction 1): an install resets money and keeps home RAM and cores. CORES runs beside UPGRADE on every path, after it so RAM has first call, at `HOME_CORES_BUDGET_FRACTION` (0.10) on the cadence; it reads the core count off the price (`1e9 * 7.5^cores`) instead of a 2.00 GB `getServer`, which keeps it at 6.20. Shadows of Anarchy is never
bought from - its augs price off their own ladder. Each read is its own body: together they would
be 14.10 GB. What each faction sells and each aug's prerequisites are fixed for the node and kept
in memory; prices and the owned list are re-read every pass. READ now runs FIRST in the tick, so
the batch gets the cash before the normal 25% home upgrade can take it.

**A faction at 150 favor is not worked; its rep is BOUGHT with the batch.** Favor moves only at an
install (`Faction.prestigeAugmentation`: `addRepToFavor(favor, rep)`, where 150 favor is ~462k lifetime
rep), and at `getFavorToDonate()` the faction sells rep: `$ / 1e6 * mults.faction_rep * FactionWorkRepGain`
(`donation.ts`). The live bug: Bachman worked toward 375k with 150 favor already banked. `chooseAction`
skips a donatable faction - `canDonate`: favor at the bar AND a non-empty work-type list, which is
exactly the set `donateToFaction` accepts - and works it only when nothing else is left.
**Donating happens only as part of a batch that is bought** - the user's rule: money donated with no
batch behind it is money the batcher could have had. `planAugBuys` treats an aug short of rep at a
donatable seller as in reach, priced WITH the donation that reaches it, so the donation counts
against cash and against the batch rule like the aug does. A faction is lifted once, to the highest
rep the batch needs from it, one rep over so float rounding cannot leave it a hair short. `sing.js`
donates immediately before the buys, and a refused donation buys nothing - the buys behind it would
stop at its aug and leave a partial batch. After a batch the rep targets are recomputed at once, or a
faction whose last aug was just bought is worked for three more ticks. `FactionWorkRepGain` (BN4 0.75) is read
once per process by the BN_MULTS body - `getBitNodeMultipliers()` with no arguments defaults to exactly
what `initBitNodeMultipliers` installs. It needs Source-File 5; without it the body warns once and
nothing is donated, rather than donated at a guessed price.
Favor is its own FAVOR body (READ is full) and is read once per faction per process - an install
kills the process anyway.

**Once `MIN_AUG_BATCH` are queued, the queue is installed** - right after the batch that reached it,
or on the next pass if something stopped it. `installAugmentations("/scripts/boot.js")` kills every
script, sing included, and 500 ms after the reset runs boot with **no arguments and one thread**
(`Singularity.ts` `runAfterReset`) - so boot's defaults are what comes back up, and any flag typed by
hand is gone. The callback is skipped only when home lacks the RAM, which cannot happen: every
script was just killed. Boot's first pass ignores the cloud marker and re-roots and redeploys, the
same path as a hand `run scripts/boot.js` after a hand install. Before it: the SWEEP body runs one
contract sweep and waits it out (an install destroys every unsolved contract), then UPGRADE at
fraction 1, then CORES, take the cash the install would reset. SWEEP is split from INSTALL - together 7.70 - and
its body imports `CONTRACTS_SERVICE` from `contracts/config.js`, the one cross-subtree import in
sing/, 0 GB and billed to the transient. `AUTO_INSTALL` is read inside SWEEP, so it is LIVE like
`GRIND_GANG_KARMA`: off, the queue waits for a hand install. A sweep over rpc's 10 s times out, and
the install waits for the next pass rather than kill the sweep mid-attempt.

**Two installs skip `MIN_AUG_BATCH`, both the user's rule, both aimed at ending the node.** The
Red Pill (`RED_PILL`: 2.5m Daedalus rep, `moneyCost: 0`) is bought the pass it is in reach - by rep
or by donation - and installed as a queue of one; `owned.pill` retries an install that failed. Its
donation is reserved BEFORE the dearest-first loop, because at $0 it would otherwise be planned last
and a dear aug could take the cash its rep needed. And while `RED_PILL_FACTION` is below the donate
bar, the FAVOR_GAIN body (`getFactionFavorGain`, 2.35) asks whether an install now would carry it
over; if so, whatever fits is bought and installed at any size. ~462k lifetime rep is 150 favor,
so that install turns the remaining ~2m of the pill's rep from a grind into a donation. Nothing here
touches `w0r1d_d43m0n` - destroying the node stays the user's call.

### The hacknet subsystem (`scripts/hacknet/`)

One job either side of BitNode 9: buy hacknet units while they pay back, and — once the nodes are
hacknet SERVERS producing hashes instead of cash — spend the hashes on the batcher's own targets.
Self-contained like `gang/`: `hacknet/config.js` re-exports two 0 GB constants from
`scripts/config.js`, and `boot.js` reads three out of it.

**Both halves are TRANSIENTS, not services, and not rpc entries.** `boot.js` runs each once every
`HACKNET_EVERY` ticks with `runToCompletion` — the contracts shape, nothing held in between.
`rpc.js` is the obvious answer to 21 `ns.hacknet` names at 0.50 GB each and it is the wrong one:
an rpc entry sits at 2.60 GB **underneath** every body for the body's whole life, which only pays
for a RESIDENT caller. These sweeps live a few hundred milliseconds. Measured, two plain files
peak at 6.60 GB against 9.40 for an entry plus two bodies.

**The two files are split because RAM bills NAMES.** `hashes.js` carries seven hacknet names the
money sweep never needs (`numNodes` and `getNodeStats` are in both); folded together that 3.50 GB
would be charged for the whole pre-BitNode-9 game, where `hashCapacity()` is 0 and they can do
nothing. boot runs them **sequentially** and gates each on neither sweep being up, so the
subsystem's peak is the larger (6.60) and not the sum — which is what leaves `HOME_RESERVE_GB`'s
worst overlap unchanged at 33.30 GB. The gate has to name BOTH files: `runToCompletion` returns
true on its timeout without killing anything, so a wedged money sweep joined by a hash sweep would
put the subsystem at 12.05.

**No `get*UpgradeCost` call anywhere.** Five of them at 0.50 GB each, and every one is a pure
function of `(stat, count, costMult)`. `hacknet/math.js` transcribes the ladders from
`src/Hacknet/formulas/` at 0 GB and the four cost multipliers arrive in one
`ns.getHacknetMultipliers()` at 0.25 — the money sweep trades four cost functions (2.00) for that
one read and the hash sweep drops `getCacheUpgradeCost` (0.50), 2.25 GB across the two, and
testable besides. The same trade `gang/math.js` makes with the gain formulas.

**Every upgrade's effect is an independent multiplicative factor, so a gain is a RATIO on the
production the game already reports** — `p / unit.level` for a level, and so on. The player
multiplier and the BitNode multiplier appear in both the before and the after and cancel, which is
why nothing here reads `ns.getHacknetMultipliers().production`, `ns.formulas.hacknetNodes.*`
(Formulas.exe) or `ns.getBitNodeMultipliers` (4.00 GB).

**Buying is ranked on PAYBACK, never on price.** Cheapest-first takes whichever ladder happens to
sit low regardless of what it returns — on a node whose level has run far ahead of its RAM that is
the wrong rung every time. `PAYBACK_SECONDS` is also the whole off switch: marginal gain does not
move as the batcher grows, so paybacks blow out on their own and the sweep stops buying without
anyone deciding it should. `HACKNET_CASH_FRACTION` is priced ONCE per sweep, not per purchase —
per purchase it would ratchet down as cash fell, and the sweep would spend a different fraction
depending only on how many rungs it happened to take. `cloud.js` bids for the same wallet at 10%
and sing's aug batch wants all of it.

**A refused sweep names the NEAREST rung and its payback against the bar**, because the budget
figures alone read as "cannot afford" and the refusal is never about affordability. In BitNode 4
`HacknetNodeMoney` is 0.05, so a fresh node earns $0.075/s and the $500 level rung pays back in
1h51m against the 1h bar — the sweep is right to refuse it beside $1.12q of cash, and the old log
said only "nothing left inside the payback threshold", which reads as the opposite. Production of
exactly 0 (BitNode 8 sets that multiplier to 0) ranks nothing at all and gets its own reason
rather than blaming a threshold nothing was measured against.

**A hash is worth exactly $250k, forever, and that number decides everything on the BN9 side.**
`HashUpgradesMetadata.tsx` gives Sell for Money `value: 1e6` and BOTH `cost: 4` and
`costPerLevel: 4`; the rate is flat only because `HashUpgrade.getCost` early-returns on `cost`
when set — that field's own doc comment reads *"This property overrides the 'costPerLevel'
property"*. **The OVERFLOW is auto-sold at the same rate** (`processAllHacknetServerEarnings`
computes `wastedHashes / upgrade.cost * upgrade.value`), so every other upgrade has to beat the
sale price by `HASH_VALUE_MARGIN` before it is bought.

**Only the overflow, though, and that is why the sweep sells.** `storeHashes()` caps the balance
at capacity and pays out just the remainder, so everything at or *below* capacity sits — and a
hacknet server's capacity is `32 * 2^cache` (`HacknetServer.updateHashCapacity`), 64 hashes at
cache 1, **$16m parked per server** that nothing will ever collect while there is nothing to spend
on. That is the whole of a fresh BitNode 9's first prep, where `CloudServerLimit` is 0 and
`HomeComputerRamCost` is 5x, so cash is the binding constraint. So `planHashes` returns a `sell`
count on the two outcomes where **nothing is worth buying at any balance** — no targets published,
and nothing beats the sale price — and `hashes.js` takes it in one `spendHashes("Sell for Money")`
call, the cost being flat so there is no ladder to walk. The rate is identical to the auto-sale, so
this is the same money collected now rather than never, never a discount taken for liquidity.

**The two branches that must NOT sell are the ones where a purchase is merely out of reach**:
`waiting on hashes` (the store fills on its own in a minute or two) and the capacity-short branch
that buys cache. Both mean the balance is being *saved* toward something that beats the sale price,
and selling there funds the cache upgrade and then leaves nothing to fill the larger store with — a
loop that never buys the upgrade it planned. Tests pin both directions: disabling the sale reddens
one, extending it to the saving-up branch reddens the other.

**Only two hash upgrades are ever bought, and both reduce to one number: the factor by which the
batcher's income on that target moves.** Increase Maximum Money is a flat +2% below
`MONEY_SOFTCAP` and damped above it (`Server.changeMaximumMoney`). Reduce Minimum Security is
×0.98 floored at 1, and it is COMPUTED rather than skipped because three terms move together as
minimum security falls — hack chance and money per thread both scale `(100-d)/100`, op time scales
`2.5*R*d + 500` — giving `income ∝ (100-d)² / (2.5*R*d + 500)`. At `R=1000` that is +3.04% at
`d=20` and +2.04% at `d=3`, so on a high-minimum-security target it beats the flat +2%. The
grow-thread improvement is left out, so it UNDERSTATES, which is the safe direction for a spend.
Contracts, corporation and bladeburner upgrades are deliberately not bought. Income is divided by
the target count, because nothing here knows the per-target split and over-crediting one target is
the direction that buys upgrades which do not repay.

**The income read takes `Math.max` of BOTH elements of `ns.getTotalScriptIncome()`.** `[0]` sums
`onlineMoneyMade / onlineRunningTime` over scripts running RIGHT NOW, and the batcher is
just-in-time: `hack.js` credits its money and exits microseconds later, so `[0]` is dominated by
zeros and reads one to two orders of magnitude low. `[1]` is
`scriptProdSinceLastAug / (playtimeSinceLastAug/1000)`, a real $/s rate that averages in the
pre-ramp period and so understates. `[0]` alone put every candidate under the sale-price bar and
made the entire BN9 half silently do nothing, while the log blamed "nothing beats the sale price" —
a diagnostic naming the wrong cause. A test pins that both elements are consulted.

**One `spendHashes` call per (upgrade, target) pair, not per level.** Raising max money leaves the
target below its new maximum and lowering minimum security leaves it above its new floor —
`changeMinimumSecurity` moves `minDifficulty` only, never current security — so both put a
streaming target off baseline and cost a re-prep. The sweep pays that once.

**Capacity is distinguished from balance, and only one of them buys cache.** A hash store too
small to HOLD the bundle can never fill however long it waits, so that is the case that upgrades
the cache; too few hashes right now fills on its own in a minute or two. Eligibility is checked
BEFORE affordability for exactly that reason — "worth buying but out of reach" and "not worth
buying" need different answers.

**The targets come from a FILE the running manager publishes.** Both upgrades pay only on a server
the batcher is actually hitting, so the manager writes its list to `TARGETS_MARKER`
(`/data/targets.txt`) every rescan, and `boot.js` clears it on both paths where no manager
survives: a swap away from a retired manager that leaves none, and `--no-manager` with nothing
already up. That second clear is gated on liveness because `--no-manager` kills nothing —
unguarded it blanks the list a live manager owns until its next rescan. Missing or empty means
spend nothing, never a default.
A stale list is inert rather than lossy — `purchaseHashUpgrade` refunds an upgrade the game
refuses, which a foreign-only upgrade aimed at a purchased server is — but it is still hashes not
spent where they pay.

**Hacknet servers are filtered out of `ServerPool.scanAll` ITSELF** — not only at
pool admission, which is where the guard started and which was not enough. Two separate reasons,
and the second is the expensive one:

- A hacknet server filled with batch workers earns **literally zero hashes**:
  `calculateHashGainRate` multiplies by `ramRatio = 1 - ramUsed/maxRam`. That is what the pool
  guards protect, and they stay — `server.js` does it in BOTH `build()` and `sync()`, which admit
  hosts independently.
- **Most callers of the walk are not pools.** `continuous/lib/target.js` ranks targets off it,
  and the whole `getNormalServer` family **throws** on a
  hacknet server rather than returning a useless number — all 23 of `getServerRequiredHackingLevel`,
  `getServerMaxMoney`, the three op times, the analyze calls, `hack`/`grow`/`weaken`, `nuke` and
  every port opener (`NetscriptHelpers.tsx`). So a missing filter is not a bad ranking, it is a
  **dead manager**: `getServerRequiredHackingLevel: Cannot be executed on hacknet-server-0` killed
  the continuous manager at startup on the first BitNode 9 run, and boot restarted it into the same
  wall once a minute. The shotgun's prep carried the identical line and died the same way.

The filter is applied to the RESULT, not during the walk: nothing hangs off a hacknet server today,
but dropping one from the queue would silently orphan anything that ever did. `root.js` needs no
guard — hacknet servers report `hasRootAccess` true, so its walk counts them as already rooted and
never reaches `nuke`.

**The mock throws where the game throws, and that is why this bug shipped.** `tests/mockNs.mjs`
returned a default for `getServerRequiredHackingLevel` on a hacknet server, so an unfiltered
whole-network walk passed 507 tests. It now reproduces `getNormalServer`'s refusal for the whole
family — the rule *"mocks must reproduce the game's real semantics or they give false confidence"*
already existed; this is the case it was written for.

**The identifier tax lands hard here.** 21 `ns.hacknet` functions at 0.50 GB each, charged by bare
name anywhere in an entry's import closure — so `hacknet/math.js` spells its upgrade kinds as the
string literals `"level" | "ram" | "core" | "cache"` and never `upgradeLevel`, `numNodes` or
`hashCost`. `level`, `ram`, `cores`, `cache` and `production` are free and used freely. A local
named `share` in `planHashes` cost 2.40 GB as `ns.share` before it became `incomeShare`.

### Invariants that look arbitrary but aren't

Breaking any of these produces silent, compounding damage rather than an error:

- **Never sleep and *then* ask how long an op takes.** A sleep-then-op recomputes its duration
  from the security level at wake-up and lands somewhere else. The batcher execs each op just in
  time and is still correct — op duration is fixed at CALL time, see its section — but the
  reason is narrow.
- **Recompute each worker's delay at its own `exec`.** Launches span real wall time; one delay
  computed up front is correct only for the first worker.
- **Call the security analyze functions WITHOUT a host argument.** With one, they cap by
  threads-to-max-money, so on a prepped target `growthAnalyzeSecurity` returns ~0 and weaken-2
  is sized at 1 thread instead of ~51.
- **Never size capacity as `freeRam / batchRam`.** Every host floors its own thread count, so
  the byte total overstates what can actually be placed. Simulate placement instead.
- **Judge timing on jitter (spread of drift within a batch), never absolute lateness.** The
  game lands whole batches tens of ms late together, which cannot reorder anything.
- **A manager swap must clear the network.** When boot kills a retired manager its batches keep
  running — hundreds of batches holding the RAM the replacement needs and still working a target
  nobody owns. `killOrphanWorkers` runs only when no manager survives; doing it on every manager
  kill would destroy the batches of the survivor `killDuplicates` just kept. The retired shotgun
  ran the same worker files, so one kill list covers it. Nothing is lost by killing them:
  `ns.hack` credits money on landing, so a killed grow forfeits only the restore, which prep
  does anyway.
- **A full pool is transient, not a failure.** Prep waits it out (`POOL_WAIT_CYCLES`) rather
  than returning an error that stops the manager and has boot restart it into the same wall a
  tick later. Waiting cycles do not spend `maxCycles`.
- **Cap the steal fraction.** Batches land after they are sized, while hacking level climbs. A
  batch landing late steals more than planned, and its grow was sized for the smaller take, so it
  ends below where it started and compounds. A shotgun volley at 98.28% drained $17.68b to
  $166.11k in one window. The batcher derives its grow margin from measured drift and caps at
  `MAX_STEAL_FRACTION`; do not replace that with a flat margin, which makes the tolerance a
  property of the fraction alone.
- **Share is launched by whoever owns the pool.** A share service running beside the manager
  would `exec` into RAM the manager had already planned batches against, and the manager's
  `exec` would fail mid-batch — the same class of damage two managers cause. So the manager does
  it, before it prices the budget: share workers `exec` outside the reservation system and
  outlive the rescan, and the batches then size themselves against what `getServerUsedRam`
  reports. Do NOT route
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
  bounded fraction rather than a whole pipeline's worth, and the incoming manager adopts them
  through `shareCensus`. Killing them would drop the bonus for a tick and buy nothing.
- **A batch is all-or-nothing.** One that hacks but fails to grow steals money and never
  returns it — worse than not firing.
- **Never stream an unprepped target**; all thread math assumes max money and min security.

## Conventions

Comments explain *why*, especially where a simpler-looking alternative is wrong — most of them
encode a bug that already happened. Keep that when editing; don't trim them to tidy up.

### Printing numbers: use the game's formatters, never your own

**Any script that prints money, RAM, a percentage or a duration uses `ns.format.*`.** All four are
**0 GB** — the cost table entry is literally `const format = { number: 0, ram: 0, percent: 0,
time: 0 }` — so there is never a RAM argument for hand-rolling one.

```js
`$${ns.format.number(money, 2)}`                    // $54.30m, $2.22q
`${ns.format.number(respect, 2, 1000, true)}`       // 412, then 1.60m  (isInteger)
ns.format.percent(fraction, 1)                      // 12.4%   - takes 0.124, NOT 12.4
ns.format.ram(gb)                                   // honours the GB/GiB setting
ns.format.time(ms)
```

**`isInteger` suppresses decimals only BELOW `suffixStart`.** Once a suffix applies,
`formatNumber` uses `fractionalDigits` regardless — so `(n, 0, 1000, true)` prints 1.6m AND 2.05m
as `"2m"`. A live log read `respect 2m (next recruit at 2m)` while the gang was 450k short, which
is a report that states the opposite of the truth. Pass **2**, not 0: the flag still keeps small
counts clean (`412`, not `412.00`). A test bans a 0 there.

Three reasons this is not a style preference:

- **They are the functions the UI calls**, so a figure in a script log reads the same as the one
  on screen beside it. A local formatter disagrees with the game and you cannot tell which is right.
- **They honour the player's Numeric Display settings.** Nothing hand-rolled can.
- **You do not own the suffix list.** It runs `["", "k", "m", "b", "t", "q", "Q", "s", "S", "o",
  "n"]` and a copy that stops early does not error — the mantissa just grows without bound. A live
  report read `$2219301.35b` for what the game calls `$2.22q`.

**`ns.formatNumber()` and `ns.nFormat()` do not exist in this fork** — see Fork differences. Both
are `undefined` here, which is a `TypeError` at the call site and nowhere else.

**Format at the CALL SITE, not inside a 0 GB pure module.** `config.js`, `gang/math.js` and
the like have no `ns` and must keep it that way; threading one in to format a
string is the wrong trade. Return the number, let the script that has `ns` print it — that is why
gang.js's rpc bodies return numbers and gang.js formats them.

**ponytail: two hand-rolled copies survive, one with a known ceiling.** `cloud.js:63` carries
`[[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]]` and prints an unbounded mantissa past $1e15;
`continuous/lib/fmt.js` has the full list and is correct but still a copy. They predate this rule
and are left alone because converting them means threading `ns` through their callers. Replace one
with `ns.format.number` when you are already editing that file — do not add a third.
`tests/ram.test.mjs` fails on any new copy.

Commit messages lead with the reasoning and the measured numbers behind a change, not a file
list.
