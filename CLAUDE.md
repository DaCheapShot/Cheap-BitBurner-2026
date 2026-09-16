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
run scripts/boot.js --shotgun           # the volley batcher instead
run scripts/boot.js --target omega-net  # pin the manager's target instead of auto-picking
run scripts/boot.js --targets 5         # continuous only; the shotgun ignores it
run scripts/boot.js --once --no-cloud
run scripts/boot.js --no-formulas       # force the *Analyze math path
```

**Boot chooses between TWO batchers**, and the choice is a flag, not a marker - retype it if
you restart boot. `scripts/continuous/` is the default and the better earner. `--shotgun` runs
`scripts/manager.js`. Neither has a formulas BUILD: each manager's math module uses
Formulas.exe when owned, and the continuous one re-checks every rescan, so buying the program
upgrades the running process. There is no calibration step any more: the per-thread security
constants are measured by one `rpc.js` call at manager startup - see `rpc.js` below.

Individual pieces, useful when diagnosing:

```
run scripts/root.js                     # open ports + NUKE everything reachable
run scripts/deploy.js                   # scp workers home -> every rooted host
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
run scripts/gang/gang.js --create "Slum Snakes"  # found the gang, once, by hand
run scripts/gang/gang.js                # the gang supervisor (boot starts it too)
run scripts/ramreport.js                # game's RAM for every .js -> /data/ram-report.txt
node tests/run.mjs                      # run the test suite
```

**Only one process may own the RAM pool and the report port.** `port.read()` removes the
message and `Server.pending` is per-process memory, so a second owner steals reports and
over-commits the same RAM. There are **two** manager files — `manager.js` and
`continuous/manager.js` — and they are alternatives, not services. Only one may run. (It was
four: each system's formulas/analyze pair collapsed into one file when its math module took
both backends. The retired `manager-formulas.js` files are still killed as rivals — filesync
never deletes from the game, so a stale copy can still be running.) Do not run `prep.js` alongside any of them —
prep runs *inside* the manager. `boot.js` enforces this by killing every rival before it starts
the one it wants (duplicates of the same file: lowest PID wins).

The continuous side guards itself too: `findRivals` in `continuous/core.js` **aborts** rather
than starting beside any other manager, and does not kill the rival — which system runs is the
user's decision. That is why boot has to clear the others first: a survivor does not make the
incoming manager degrade, it makes it exit, and boot would restart it into the same wall once a
minute forever.

A swap between the two systems must also clear the outgoing system's workers. Both batchers exec
the **same** `scripts/{hack,grow,weaken}.js` and tell reports apart by the port in argv, so one
kill list covers either. They were separate files once, and a list covering only the incoming
system's left the outgoing one's batches running network-wide.

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

- `config.js` is genuinely free to import: it has no `ns` call and mentions
  `hack`/`grow`/`weaken` only as object keys.
  Keep it that way — one billed `ns` call in `config.js` taxes every script in the repo.
- `verify.js` has no `ns` call either but still costs **0.25 GB** to import, because it reads
  `.hack` and `.grow` off result objects. Nothing to fix; know it before budgeting.
- `ram.js` deliberately touches only four cheap functions and **no analyze functions**.
- Constants that are linear in threads are measured once, at startup, by a single `rpc.js` call
  in `mathAnalyze.prepare()`. This keeps `weakenAnalyze`, `hackAnalyzeSecurity` and
  `growthAnalyzeSecurity` (1 GB each) out of the manager for the 1.00 GB `ns.run` costs.
  `calibrate.js`, `calib.js` and `/data/calib.json` did the same job with a cached file and a
  6.20 GB recurring transient, and are gone.
- **`growthAnalyze` is exactly logarithmic in its multiplier**, which is why one reading per
  snapshot replaces every call. `ServerHelpers.ts`: `numCycleForGrowth(server, growth) =
  Math.log(growth) / calculateServerGrowthLog(...)` - the divisor does not depend on `growth`,
  and nothing rounds or clamps. So `snapshot()` fetches `growthLogK` once and
  `growThreadsToRestore` answers any multiplier from it locally, with the number a live call
  would have given at that security. This is the identity `calibrate.js` used, measured per
  snapshot instead of cached per session - so there is no drifted-host case left to guard.
- `hackAnalyze` still moves with hacking level, and reacting to that is the point - it is read
  in `snapshot()`, so it is exactly as live as the snapshot the planner is working from.
- **The whole analyze backend now costs 1.00 GB, all of it `ns.run`.** Every `*Analyze` name
  appears only inside an `rpc` body, which is a string literal to the calculator. Two round
  trips per cycle buy that, not seven: `snapshot()` bundles the four `getServer*` fields, the
  three op times, `hackAnalyze` and `growthLogK` into one call, and `maxMoneyOfAll` asks about
  the whole rooted network in another. Everything downstream reads the snapshot and stays
  **synchronous**, which is what kept this from cascading `async` through `managerCore` and
  `prepper`.
- **One module holds BOTH backends for 1.00 GB**, where analyze alone cost 2.55 and formulas
  2.50. `ns.formulas.*` was always 0 GB — what cost 2.50 was `getServer` and `getPlayer`, the
  two reads that fetch the objects to hand it. Those objects survive JSON: `helpers.server()`
  checks only that 14 plain data keys are present, and `helpers.person()` likewise, so
  `snapshot()` fetches them through `rpc` and the formulas calls run resident on the
  round-tripped objects.

Worker scripts pay their cost **per thread**, so `hack.js` / `grow.js` / `weaken.js` contain
nothing beyond one op and one port write. `share.js` follows the same rule and pays the most for
breaking it: `ns.share` is 2.40 GB, so the worker costs **4.00 GB per thread** and one stray
import of `ram.js` would add 0.35 GB to every one of tens of thousands of them.

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
- **A body may `import` the repo's 0 GB pure modules** (`config.js`, `verify.js`, `gang/math.js`);
  `rpc.js` hoists the import lines out of `main`, where they would be a syntax error. That is what
  keeps logic out of strings — a body stays a few `ns` calls around a real import.
- **Every quiet failure is made loud.** `ns.run` returns a bare 0 for BOTH "no free RAM on home"
  and "does not compile", so the throw names the file and both causes. The body's own throw is
  caught inside the transient and returned as a value, because a transient that dies takes its log
  window with it a few hundred ms later. A
  timed-out call clears its port first, so a late reply is never read as the next call's answer.
  A second call while one is in flight throws: the game's own concurrency check does NOT catch
  that, `nextWrite()` not being a blocking netscript call.

**It only helps RESIDENT scripts.** `cloud.js`, `root.js` and `deploy.js` already hold their
RAM for under a second, so routing them through here saves nothing
and adds 1.00 GB each. Never for the workers — they are charged per thread and they ARE the call.

**It is invisible to `ramOf()`**, which blanks string literals. `tests/rpc.test.mjs` extracts every
body in `scripts/` and parses it, which recovers the syntax check but not the RAM accounting; a
body's RAM is only ever charged to a transient, so the exposure is a runtime `ns.run` → 0, never a
manager that will not start. Bodies must be plain template literals — an interpolated one is
rejected, because no check can read it and it would mint a file per distinct value.

### Two math backends, one module

`scripts/math.js` holds both and picks per PROCESS, in `prepare()`: formulas when the program
is owned, analyze otherwise, and analyze always under `--no-formulas`, which it reads straight
off `ns.args`. Buying Formulas mid-run no longer needs a manager swap.

**This used to be forbidden**, and the rule that forbade it was right at the time: a script
reachable from both paid for both, so there were twin math modules, twin managers, twin preps,
a `tests/isolation.test.mjs` to keep them apart and a swap in `boot.js` between the files. All
of that is deleted. What changed is that neither backend costs anything resident any more —
see the `rpc.js` section above.

`growThreadsToRestore(snap, from, to, atSecurity)` is where the two paths differ. Formulas
honours `atSecurity` by cloning the server object; analyze cannot, because `growthLogK` was
measured at the snapshot's security. That asymmetry is deliberate and tested — do not "fix" it
into an equivalence. It is now a difference between two MODES of one module rather than two
files, which makes it easier to tidy away by accident, so `tests/math.test.mjs` pins it with
two separate module instances.

**`scripts/continuous/lib/math.js` did the same for the continuous tree**, with one difference
forced by the stream: its hot path cannot go through `rpc.js`. `dispatch()` snapshots every
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
| `verify.js` | landing analysis — the definition of "landed correctly" | 0.25 |
| `ram.js` | `Server` + `ServerPool`: reservations, placement | 0.35 |
| `rpc.js` | run a body in a throwaway script, get its value back | 1.00 |
| `prepper.js` | prep as a module (manager runs it in-process) | 2.40 |
| `math.js` | both math backends, reached entirely through `rpc.js` | 1.00 |
| `managerCore.js` | the volley loop + share top-up, math-free | 2.80 |
| `manager.js` | entry: core + math (the only shotgun entry) | 5.40 |
| `prep.js` | entry: prepper + math | 5.00 |
| `boot.js` | supervisor, picks the batcher | 3.50 |
| `root.js` | port openers + NUKE | 2.15 |
| `cloud.js` | buys/upgrades servers, capped at 10% of cash | 5.75 |
| `deploy.js` | scp workers home → every rooted host | 2.50 |
| `share.js` | one `ns.share()` loop | 4.00 **per thread** |
| `sharemode.js` | the share toggle | 4.20 (game: 2.45 - `ramOf` counts every name in an imported module; the game counts only the names imported) |
| `continuous/manager.js` | entry: continuous core + `lib/math.js`, both backends | 11.55 |
| `gang/config.js` | gang tunables, paths, STAT_KEYS | 0 |
| `gang/math.js` | the game's gain formulas + every gang decision | 0 |
| `gang/gang.js` | entry: resident supervisor; every gang call is an rpc body | 2.60 |
| ↳ tick body | transient: recruit, tasks, wanted governor | 11.60 |
| ↳ war body | transient: clash engage/disengage | 11.60 |
| ↳ ascend body | transient: ascension decisions | 8.60 |
| ↳ equip body | transient: equipment buying | 14.70 |

The continuous manager is the entry that has to fit a fresh BitNode's 32 GB home alongside
`boot.js` and `cloud.js`, and `tests/ram.test.mjs` holds it under 16 GB for that reason. It
carries 3.00 GB of live *Analyze reads the shotgun routes through `rpc.js` (a stream cannot),
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

`capacity.js` (8.15) is the surviving diagnostic. It ranks targets by real throughput, which
the manager does not do — `pickTarget` chooses the richest *hackable* server, not the most
profitable one. `prep.js` is a manual entry point to
logic the supervisor otherwise drives.

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

**Self-contained in LOGIC, shared in CONTRACTS.** The rule this replaced banned imports across
the trees outright; what it was protecting is RAM, and `tests/ram.test.mjs` guards that directly.
What crosses now, and nothing else:

- `continuous/config.js` re-exports the contracts from `scripts/config.js` — the share protocol,
  the worker paths, `HOME_RESERVE_GB`, `PORT_CAPACITY`. Values a second party reads without
  knowing which batcher is up. **Tuning stays local**, including values that match today
  (`GROW_MARGIN`, `SPACER_MS`, the tolerances): coupling those would retune both batchers at once.
- **One set of batch workers.** The two trees' copies were identical code, and each system
  passes its own report port as an argument.
- `managerCore.js` imports `shareCensus` / `planShare` / `topUpShare` from
  `continuous/lib/share.js`. The copies had become identical; `serviceShare` stays per batcher.
- `scripts/rpc.js` may be imported from here.

It keeps its own deploy (a bought server never fires `deploy.js`'s trigger), its own math
backends and its own report port (3, not 1 — a killed shotgun leaves reports in flight for a
whole window, and on a shared port they would be credited to batch ids that never existed here).

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
`sharemode.js` — and the same code: the shotgun imports its census, planner and top-up from
here. Every rule in it is one the shotgun learned expensively: proportional placement, both passes planned before anything execs,
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
- **A manager swap must clear the network.** When boot switches managers the outgoing one's
  batches keep running — hundreds of batches holding the
  RAM the replacement needs and still working a target nobody owns. `killOrphanWorkers` runs
  only when no manager of ANY system survives; doing it on every manager kill would
  destroy the volley of the survivor `killDuplicates` just kept. Switching BATCHERS is a manager
  swap too; both systems run the same worker files, so one kill list covers it. Nothing is lost by killing them:
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

**Format at the CALL SITE, not inside a 0 GB pure module.** `config.js`, `verify.js`,
`gang/math.js` and the like have no `ns` and must keep it that way; threading one in to format a
string is the wrong trade. Return the number, let the script that has `ns` print it — that is why
gang.js's rpc bodies return numbers and gang.js formats them.

**ponytail: five hand-rolled copies survive, four of them with a known ceiling.**
`capacity.js:70`, `cloud.js:63`, `managerCore.js:96` and `prepper.js:72` each carry
`[[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]]` and print an unbounded mantissa past $1e15;
`continuous/lib/fmt.js` has the full list and is correct but still a copy. They predate this rule
and are left alone because converting them means threading `ns` through their callers. Replace one
with `ns.format.number` when you are already editing that file — do not add a sixth.
`tests/ram.test.mjs` fails on any new copy.

Commit messages lead with the reasoning and the measured numbers behind a change, not a file
list.
