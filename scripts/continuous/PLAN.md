# Continuous (streaming) multi-target HWGW batcher

> ## Status
>
> **All five phases built. 218 tests pass (`node tests/run.mjs`, 106 of them in `continuous`).**
> Phases 1-4 verified in game. Phase 5's desync pause / re-prep / resume confirmed in game.
> Adaptive steal and the 3-target limit are the newest changes and have not had a long run yet.
>
> **Run it:** `run scripts/continuous/manager.js --minutes 30 --verbose`
> (`manager-formulas.js` when Formulas.exe is owned - cheaper AND more precise.)
> Flags: `--targets N` `--steal F` `--fixed-steal` `--target host` `--prep-only` `--minutes N` `--verbose`
>
> ### What it does now
>
> - **3 targets max** (`MAX_TARGETS`), admitted on money-per-GB-second against a RAM budget.
> - **Steal starts at the 0.95 ceiling and descends** on measured evidence. `over = stolen/take - 1`
>   carries both signals because money clamps at maxMoney: positive is level-drift, negative is a
>   drain. Also backs off on bad batches and on the pool refusing to seat a batch.
> - **Prep runs concurrently with streaming**, never as a phase before it. A candidate that would
>   displace a running stream is priced as if prepped (`pricePotential`) and prepped FIRST.
> - **The target set is re-evaluated every `RESCAN_MS`** - new roots, rising hacking level, a
>   growing pool, targets finishing prep.
> - Displaced streams are **drained, not killed** (`ns.hack` credits on landing).
>
> ### Known gaps
>
> - **Formulas.exe swap is boot.js's job**, by decision - a running manager never re-checks.
> - `capacity.js` still reports the Phase 1 model (nominal batch, no adaptive steal).
> - **Spacer/cadence is untouched.** `SPACER_MS` 100 gives `CADENCE_MS` 400. Measured jitter was
>   avg 10ms / max 29ms, so spacer 50 would double depth and double income with a 1.7x margin
>   instead of 3.4x. Deliberately left for a run where it is the only variable changed.
> - The pool is mostly idle by design at 3 targets: depth is capped by `weakenTime / cadence` and
>   steal by the ceiling, so a fully-fed target cannot absorb another byte. Spending the rest
>   needs a smaller cadence or more targets.
>
> ### Measured
>
> 10-minute single-target run at 10% steal: 1255 batches, 1255 ok, 0 bad, 94% hit rate,
> $114m/s, jitter avg 10ms / max 29ms, depth pinned at the cadence limit of 199. Used 47 TB of
> an 11,284 TB pool - which is what drove everything since.
>
> NS signatures and fork-source excerpts here were verified on 2026-09-07 against
> `NetScriptDefinitions.d.ts` and `DaCheapShot/bitburner-src@stable`; re-check if the game
> version has moved. This file is documentation only - `.md` is not in `filesync.json`'s
> `allowedFiletypes`, so it never reaches the game.

## Context

The existing batcher in `scripts/` is a **shotgun**: each cycle it measures free RAM, sizes one
volley of hundreds of HWGW batches, fires them all, then blocks until the whole volley lands
before recomputing. Between the last landing and the next volley the pool is idle, and the whole
volley is sized against one snapshot — so a batch landing late in the weaken window was sized for
a hacking level that no longer applies (`MAX_STEAL_FRACTION` in `scripts/config.js:54` exists
because of exactly that drift; a measured volley at 98.28% steal drained $17.68b to $166.11k).

This builds a **streaming** batcher instead: batches are dispatched one cadence-interval apart so
their landings interleave into an uninterrupted stream, each batch's timing and thread counts are
re-derived at its own dispatch, and several prepped targets draw from one shared RAM pool at once.
Self-correcting by construction — a rising hacking level changes the next dispatch, not a volley
already in the air.

Decisions taken with the user:

- Lives in `scripts/continuous/` → **`/scripts/continuous/`** in game (`filesync.json` has
  `scriptsFolder: "."`, so the disk path is preserved verbatim). Imports are
  `import { ServerPool } from "scripts/continuous/lib/server"`.
- **Nothing in `scripts/` is edited**, and nothing under `scripts/continuous/` imports from it.
  Some logic is deliberately re-derived rather than reused — that duplication is the price of the
  hard constraint, not an oversight.
- Its **own thing**: either the shotgun runs or this runs, never both. Own report port, plus a
  startup guard that refuses to launch while `scripts/manager.js` or `scripts/manager-formulas.js`
  is alive. It does not kill them — that stays the user's call.
- It **scp's its own workers**, because `deploy.js` broadcasts only `DEPLOY_LIST` from
  `scripts/config.js` and that file is off-limits. Without this every `exec` off home returns a
  bare `0` (CLAUDE.md documents this exact failure costing two live runs).
- Tests go in one new file, `tests/continuous.test.mjs`, run by the existing
  `node tests/run.mjs continuous`. It cannot use `tests/harness.mjs`'s `loadScripts()` — that is
  flat (`readdirSync`, no recursion, `tests/harness.mjs:17`) and its rewrite regex only matches
  `from "./name.js"` — so the test file does its own temp-dir copy + rewrite for the subfolder.

## NS API — verified against `NetScriptDefinitions.d.ts`

Confirmed before designing, not from memory:

| call | line | note |
|---|---|---|
| `hack/grow/weaken(host?, opts?: BasicHGWOptions)` | 7161/7207/7234 | `opts = {threads?, stock?, additionalMsec?}` (:402) |
| `hackAnalyze(host)` | 7295 | fraction stolen **per thread** |
| `hackAnalyzeSecurity(threads, host?)` | 7309 | **omit host** — with it, threads are capped to max-money |
| `growthAnalyze(host, multiplier, cores?)` | 7358 | multiplicative part only; evaluated at *current* security |
| `growthAnalyzeSecurity(threads, host?, cores?)` | 7372 | **omit host**, same capping trap |
| `weakenAnalyze(threads, cores?)` | 7247 | returns the security decrease |
| `getHackTime/getGrowTime/getWeakenTime(host?)` | 8676/8689/8702 | 0.05 GB each |
| `formulas.hacking.hackPercent(server, player)` | 6221 | per thread |
| `formulas.hacking.growThreads(server, player, targetMoney, cores?)` | 6257 | **handles the additive `+$1/thread`** — `growthAnalyze` does not |
| `formulas.hacking.weakenEffect(threads, cores?)` | 6304 | depends only on threads+cores |
| `ns.getServer(host?)` | 8196 | **2 GB** — the only source of `cpuCores` |
| `formulas.hacking.hackTime/growTime/weakenTime(server, player)` | 6280/6287/6294 | |
| `NetscriptPort` | 1176 | `write, tryWrite, nextWrite, read, peek, full, empty, clear` — all 0 GB |
| `ns.exec(script, host, threadOrOptions, ...args)` | 7923 | 1.3 GB, returns pid or `0` |
| `ns.scp(files, destination, source?)` | 8065 | 0.6 GB |

Two things the docs settle that matter to the design:

- **No `ServerConstants` is exposed** — `ServerFortifyAmount`/`ServerWeakenAmount` appear nowhere
  in the workspace. 0.002/0.004/0.05 exist only as prose in JSDoc, so security-per-thread is read
  from the analyze/formulas functions, never hardcoded.
- `growThreads` (formulas) accounts for the additive term and rounds up; `growthAnalyze` (analyze)
  gives only the multiplicative part. That asymmetry is real and is preserved, matching the
  existing repo's deliberate non-equivalence of its two backends.

Read from the fork's source, because the cores model depends on it and the docs only hint at it
(`src/Server/ServerHelpers.ts`, `src/Server/formulas/grow.ts`):

```ts
getCoreBonus(cores)  =  1 + (cores - 1) / 16          // ONE formula, shared by grow and weaken

getWeakenEffect(threads, cores)
  = ServerWeakenAmount * threads * coreBonus * currentNodeMults.ServerWeakenRate

calculateServerGrowthLog(server, threads, p, cores)
  = adjGrowthLog * serverGrowthPercentageAdjusted * p.mults.hacking_grow * coreBonus * threads
```

Also from `initForeignServers` in the same file:

```ts
server.cpuCores = getRandomIntInclusive(Math.ceil(layer / 2), layer);
```

**Foreign servers in this fork have 1–15 cores, not 1.** That is what makes cores worth paying
`getServer`'s 2 GB for — a grow thread on a 9-core box does the work of 1.5 threads.

## Files

All new, all under `scripts/continuous/`:

```
config.js               0 GB    every tunable (no ns calls, ever)
lib/plan.js             0 GB    pure timing + thread math + landing analysis
lib/server.js           0.35    Server + ServerPool (scan, getServerMaxRam,
                                getServerUsedRam, hasRootAccess — nothing else)
lib/cores.js            2.0     ns.getServer(host).cpuCores — kept OUT of lib/server.js
                                so the pool stays cheap for anything not sizing threads
lib/mathAnalyze.js      ~2.5    backend: *Analyze + timing getters
lib/mathFormulas.js     ~2.5    backend: ns.formulas.hacking.*
core.js                 ~2.5    the stream loop, target ranking, prep — math-free
manager.js              entry:  core + mathAnalyze     (always works)
manager-formulas.js     entry:  core + mathFormulas
capacity.js             Phase 1 harness — allocates and releases in-process only
hack.js grow.js weaken.js       workers: one op, one port write, zero imports
```

`lib/mathAnalyze.js` and `lib/mathFormulas.js` must never be reachable from the same entry point —
Bitburner charges for every `ns` function reachable through imports, so touching both buys ~2.5 GB
of nothing. `tests/continuous.test.mjs` walks the import closure to enforce it.

`config.js` and `lib/plan.js` contain **no `ns` calls at all**, so they are free to import
everywhere. One billed call added to either taxes every file in the folder.

## The math

### Timing — anchor on weaken, derive the rest

`W = weakenTime`, `G = growTime`, `H = hackTime`, spacer `s = SPACER_MS`. For a batch anchored at
absolute time `t`:

```
land.H  = t + W - s        opTime.H  = H
land.W1 = t + W            opTime.W1 = W
land.G  = t + W + s        opTime.G  = G
land.W2 = t + W + 2s       opTime.W2 = W
```

All four `exec` at the same instant; separation comes only from `additionalMsec`:

```js
const delay = Math.max(0, land - Date.now() - opTime[op]);   // recomputed per exec
```

Recomputed **per `exec` call**, not once per batch — a dispatch is several `exec`s spanning real
wall time, and one delay computed up front is correct only for the first. Never sleep between the
ops of a batch: a sleep-then-op recomputes its duration from the security level at wake-up and
lands somewhere else.

### Streaming cadence

Batch `n` is anchored at `t0 + n * cadence`. `cadence >= 4 * s` or consecutive batches interleave
into each other's H→W2 window. In-flight depth is therefore:

```
inFlight ≈ ceil(W / cadence)          capped by RAM and by MAX_IN_FLIGHT
```

`W` is re-read at every dispatch, so as hacking level rises and `W` shrinks the depth shrinks with
it — the stream self-corrects rather than being resized by a supervisor.

**The rising-level hazard is the reverse of the shotgun's.** A shrinking `W` makes a *new* batch's
landings arrive earlier than an already-in-flight older batch's, which can put a foreign hack
inside an older batch's H→G gap. Anchors are therefore monotonic: a new anchor is
`max(t0 + n*cadence, lastAnchor + cadence)` and never earlier than the previous batch's `land.W2`
minus the window — computed in `lib/plan.js:nextAnchor`, and the one thing the desync detector is
watching for.

### Threads

```
hackThreads  = floor(steal / fracPerThread)          fracPerThread = hackAnalyze | hackPercent
actualSteal  = hackThreads * fracPerThread           (recomputed — floor loses some)
weaken1      = ceil(hackThreads * secPerHack  / weakenPerThread)
growThreads  = restore (1-actualSteal)*maxMoney -> maxMoney, times GROW_MARGIN
weaken2      = ceil(growThreads  * secPerGrow  / weakenPerThread)
```

`secPerHack = hackAnalyzeSecurity(1)` and `secPerGrow = growthAnalyzeSecurity(1)` — **called
without a host argument**. With one, they cap by threads-to-max-money, so on a prepped target
`growthAnalyzeSecurity` returns ~0 and weaken-2 is sized at 1 thread instead of ~51.

Steal fraction is capped. Even re-derived per dispatch, a batch is in the air for a whole `W`; the
headroom a late landing has is `((GROW_MARGIN-1)/GROW_MARGIN) * (1-steal)/steal` — 19% at 20%
steal, 0.25% at 95%. `MAX_STEAL_FRACTION` in the new `config.js` mirrors the existing 0.85.

### Cores

Grow and weaken are core-boosted; **hack is not**. Both boosted ops are exactly linear in

```
effectiveThreads = Σ threads_i * coreBonus(cores_i)
```

— weaken directly, grow inside the log — which is the fact that makes the whole thing tractable:
**a grow or weaken split across hosts with different core counts composes exactly**, so an op can
be sized once in effective threads and then placed anywhere.

`coreBonus` is **measured at runtime, never hardcoded**, per this repo's standing rule that
constants come from the API and not from memory:

```
coreBonus(c) = weakenAnalyze(1, c) / weakenAnalyze(1, 1)        // analyze backend
coreBonus(c) = weakenEffect(1, c)  / weakenEffect(1, 1)         // formulas backend
```

One measured ratio serves grow as well — the source above shows `getCoreBonus` is a single shared
function, so this is a verified fact rather than an assumption. Cores per host are static, so the
ratio is computed once per distinct core count and cached in-process.

**Sizing and placement are circular, and the loop is cut by placing greedily against effective
demand** rather than by picking a thread count first:

```js
let need = requiredEffectiveThreads;              // sized as if cores were 1
for (const host of hostsByCoresDesc) {            // best cores first
  const t = Math.min(host.threadsFor(ramPerThread), Math.ceil(need / coreBonus(host.cores)));
  need -= t * coreBonus(host.cores);
  ...
}
```

Raw threads placed can be far fewer than `requiredEffectiveThreads`, and that saving is the point.

**Placement is core-aware per op**: grow and weaken take hosts **highest-cores-first**, hack takes
them **lowest-cores-first**. Hack gains nothing from cores, so letting it squat on a 9-core box
wastes the only RAM that multiplies.

**Weaken-2 is sized from grow's RAW thread count, not its effective count.** From
`processSingleServerGrowth`: security is fortified by `2 * ServerFortifyAmount * usedCycles` where
`usedCycles` is clamped to the call's own `threads` — so grow's security cost tracks raw threads
and gets no core bonus. Cores cut the raw threads needed, which cuts the security gain with them.

Note the direction of the error if this were got wrong, because it is the opposite of what it
looks like: `coreBonus ≥ 1` always, so `raw ≤ effective`, and sizing weaken-2 off the effective
count would **over**-weaken — harmless, since weaken clamps at minimum security, but on an 8-core
host it buys ~44% more weaken threads than the grow can justify. Raw is used because it is exact,
not because effective is unsafe. When grow is split, each call fortifies on its own `usedCycles`
and the later calls compute less, so the raw-thread total is still an upper bound.

Op planning order within a dispatch is therefore hack → weaken-1 → **place grow** → weaken-2 from
the placed raw count. All four still `exec` at the same instant; only the planning is ordered.

### Landing analysis

`lib/plan.js` also holds the pure judgement, so it is testable in plain node:

- `jitter` = spread of drift *within* a batch. This, not absolute lateness, is the signal — the
  game lands whole batches tens of ms late together and a common offset cannot reorder anything.
- `orderOk` = the four ops arrived H, W1, G, W2.
- `intrusion` = a foreign batch's hack landed inside this batch's H→G gap. The streaming-specific
  failure; the shotgun cannot produce it the same way.

## Coordination

Port `CONT_REPORT_PORT` (default 3 — distinct from the shotgun's 1, so a leftover message from a
killed volley can't land in this drain loop). Worker message, matching the existing shape so the
format stays familiar:

```js
ns.writePort(port, { b: batch, op, t: threads, p: planned, a: Date.now(), r: result });
```

One `writePort`, never retried — the port holds 50 and **discards the oldest** on overflow, so a
retry would evict someone else's report. Workers import nothing and take the port number as an
arg: `ns.read` resolves against the host the worker runs on, so a worker reading a file from home
gets `""`.

**RAM is freed by `pool.refresh()`, not by port reports.** The game charges a host's RAM at `exec`
and releases it when the worker exits, so `getServerUsedRam` is already authoritative. Reports
drive *health* — desync detection and stream statistics — and nothing else. This is the one place
the design departs from the brief, and it is the smaller mechanism: no reconciliation between a
`pending` ledger and reports that can be dropped by a full port.

That forces the pool's accounting model, which differs from `scripts/ram.js`:

```
reserve(...)  -> pending += gb     (dry-run placement, before exec)
commit(...)   -> pending -= gb     (after exec returns non-zero; the game now reports it)
release(...)  -> pending -= gb     (exec returned 0 — undo the reservation)
freeRam = maxRam - gameUsedRam - staticReserve - pending
```

`scripts/ram.js` can refresh freely because nothing is in flight at cycle start. Here workers are
*always* in flight, so a naive `refresh()` over a `pending` ledger would double-count every
launched batch. `commit` is what makes `refresh()` safe to call mid-stream.

## Multi-target

- **Discovery**: BFS `ns.scan` from home, keep `hasRootAccess && moneyMax > 0 &&
  requiredHackingSkill <= hackingLevel`.
- **Ranking**: money/sec ≈ `maxMoney * steal * hackChance / (weakenTime + 2*spacer)`, using
  `formulas.hacking.*` when Formulas.exe is present and `hackAnalyzeChance` + the timing getters
  otherwise. Top `MAX_TARGETS`.
- **Prep**: grow to max money, weaken to min security, before any stream starts against a target.
  An unprepped target is never streamed — all the thread math assumes max money and min security.
- **Contention**: one pool, in-flight slots allocated to targets in rank order. The richest target
  fills its depth first; lower-value targets take what remains, and a target that cannot place a
  full batch simply skips this cadence tick rather than dispatching a partial one. **A batch is
  all-or-nothing** — one that hacks but fails to grow steals money and never returns it, which is
  worse than not firing.
- **Desync**: `DESYNC_STRIKES` bad batches (out-of-order, intrusion, or measured money off
  baseline) pauses that target's stream, drains its in-flight batches, and re-preps it. Other
  targets keep streaming.

## Formulas.exe

`ns.fileExists("Formulas.exe", "home")` at startup and every `FORMULAS_RECHECK_MS`. Gained or lost
mid-run, `manager.js` and `manager-formulas.js` swap — and **a swap must clear the network first**:
the outgoing manager's in-flight batches would otherwise hold RAM the replacement needs while
working targets nobody owns. Killing them loses nothing: `ns.hack` credits money on landing, so a
killed grow forfeits only the restore, which prep does anyway.

## Config (`scripts/continuous/config.js`)

`STEAL_FRACTION`, `MAX_STEAL_FRACTION`, `SPACER_MS`, `CADENCE_MS`, `GROW_MARGIN`,
`HOME_RESERVE_GB`, `RAM_SAFETY_FRACTION`, `CONT_REPORT_PORT`, `MAX_TARGETS`, `MAX_IN_FLIGHT`,
`DESYNC_STRIKES`, `PREP_MAX_CYCLES`, `FORMULAS_RECHECK_MS`, `WORKER_FILES`, `BATCH_OPS`,
`OP_WORKER`. Same house style as `scripts/config.js`: banner sections, one JSDoc block per
constant explaining *why that number*.

## Build order — stop for user verification at each phase

### Phase 1 — pool + harness  ← build this now

Files: `config.js`, `lib/server.js`, `lib/cores.js`, `capacity.js`, and the pool half of
`tests/continuous.test.mjs`.

`Server`: `maxRam`, `usedRam` (from the game), `cores`, `staticReserve`, `pending`; `refresh()`,
`get freeRam()`, `threadsFor(ramPerThread)`, `reserveThreads`, `commit`, `releaseGb`,
`releaseAll()`. `ServerPool`: `build(ns, {homeReserve, includeHome, exclude, cores})`, `refresh()`,
`allocate(ramPerThread, threads, {contiguous, order})` → `{host, threads, gb, cores}[] | null`
(all-or-nothing, dry-run plan first, then reserve), `allocateEffective(ramPerThread,
effectiveThreads, coreBonus)` → the core-aware greedy fill above, `commit(placements)`,
`release(placements)`, totals.

`cores` is passed **into** `build` as a `{host: cpuCores}` map rather than read inside the pool,
which is what keeps `lib/server.js` at 0.35 GB; hosts absent from the map default to 1 core.
`lib/cores.js` builds that map with `ns.getServer` and re-reads only hosts it has not seen (cores
are static, but new cloud servers appear and home's cores can be bought).

**Never size capacity as `freeRam / batchRam`** — every host floors its own thread count, so the
byte total overstates what can actually be placed. `capacity.js` simulates placement.

`capacity.js` prints per-host cores and total/free/reserved, the pool's effective-thread capacity
for grow/weaken against its raw capacity (the cores dividend, in RAM saved), then, for a batch RAM
given by
`--batch-ram` (default from `ns.getScriptRam` on the workers × a nominal HWGW thread split), how
many complete batches place, and the cadence-implied depth `ceil(W/cadence)` for the current
top target. It allocates and releases only inside its own process and launches nothing.

Verify: `run scripts/continuous/capacity.js` in game, numbers sane against `scripts/capacity.js`'s
view of the same pool; `node tests/run.mjs continuous`.

### Phase 2 — workers + port

`hack.js`/`grow.js`/`weaken.js` + a `--selftest` flag on `capacity.js` that `exec`s a couple by
hand and prints the reports (batch id, planned vs actual, drift). Adds `scp`-to-every-rooted-host,
since without it every `exec` off home returns `0`.

Verify: manual `exec`s land, reports arrive with plausible drift, and a report arrives from a host
that is **not** home.

### Phase 3 — discovery, ranking, prep

`lib/mathAnalyze.js`, `lib/mathFormulas.js`, ranking + prep in `core.js`, both manager entries.
Runs prep only, streams nothing.

Verify: ranking order is defensible, top `MAX_TARGETS` reach max money / min security, and the
analyze and formulas builds agree on ranking (they will not agree exactly on grow threads — that
is expected, see the `growThreads` asymmetry above).

### Phase 4 — one continuous stream, one target

The dispatch loop against the single top target. Logs cadence, in-flight depth, jitter, order.

Verify: landings arrive in order at a steady cadence over several minutes with no idle gap, money
holds near max, jitter stays under `SPACER_MS`.

### Phase 5 — multi-target + desync

Slot allocation across `MAX_TARGETS`, intrusion detection, per-target pause-and-re-prep.

Verify: several targets stream at once from the one pool, a deliberately desynced target (drop its
money by hand) pauses and re-preps while the others keep streaming.

## Verification

- `node tests/run.mjs continuous` — pure math and pool logic. `lib/plan.js` and `config.js` have no
  `ns` calls, so they import into node directly; `lib/server.js` runs against a mock in the style
  of `tests/mockNs.mjs` (ports hold 50 and drop the oldest; `exec` strips the leading slash so
  `ns.ps` reports `scripts/continuous/hack.js`).
- Tests to write: timing derivation (H before W1 before G before W2, gaps == spacer);
  `nextAnchor` never lets a new batch's hack precede an older batch's grow; thread math cancels
  security exactly (weaken1 ≥ hack's gain, weaken2 ≥ grow's gain); `allocate` is all-or-nothing and
  its placements never exceed any host's free RAM; `commit` then `refresh` does not double-count;
  the two math backends are unreachable from one another (import-closure walk).
- Cores specifically: `allocateEffective` across a mixed-core mock pool delivers at least the
  requested effective threads and never over-fills a host; weaken-2 is sized off grow's raw thread
  count rather than its effective one, so a high-core pool does not spend ~44% more weaken RAM
  than the grow can justify;
  `coreBonus` is read from `weakenAnalyze`/`weakenEffect` and matches `1 + (cores-1)/16` for the
  mock, pinning the derivation without the code hardcoding it.
- **In-game runs are the real gate.** Several fixes in this repo's history exist because a live run
  disagreed with a passing simulation. Each phase stops for the user's in-game check.

No Python prototype: `lib/plan.js` is pure and runs under node directly, so the sanity-check and
the shipped implementation are the same code.
