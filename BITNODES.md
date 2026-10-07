# BitNode plan

Which BitNode to enter next, and why. **Update the "Owned" table every time a node is destroyed**,
then move the finished entry out of the queue. Paste the in-game list
(`ns.singularity.getOwnedSourceFiles()` shape, `[{"n":1,"lvl":3},...]`) under "Last snapshot".

SF descriptions below are from this fork's `src/BitNode/BitNode.tsx` (stable), not vanilla.

## Owned Source-Files

| SF | Level | Max | Status |
|---|---|---|---|
| 1 Source Genesis | 3 | 3 | done |
| 2 Rise of the Underworld | 3 | 3 | done |
| 4 The Singularity | 3 | 3 | done |
| 5 Artificial Intelligence | 3 | 3 | done |
| 9 Hacktocracy | 2 | 3 | one level left |
| 10 Digital Carbon | 3 | 3 | done |
| 3, 6, 7, 8, 11, 12, 13, 14, 15 | 0 | | not started |

Last snapshot (2026-10-07):
`[{"n":1,"lvl":3},{"n":5,"lvl":3},{"n":2,"lvl":3},{"n":4,"lvl":3},{"n":9,"lvl":2},{"n":10,"lvl":3}]`

## Queue

The rule behind the order: **nodes the repo already automates first**, each one making the next
cheaper; nodes that need a new subsystem written come after, one subsystem at a time.

| # | Node | Repo ready? | Why now |
|---|---|---|---|
| 1 | **BN8.1** Ghost of Wall Street | yes - `stocks/` built for it, batcher BN8-aware | TIX + WSE in every later node; +12% hacking growth. Tooling was just written and is untested live - this run is its proof. |
| 2 | **BN11.1** The Big Crash | yes - plain hacking node | Aug price ladder -4% per level (sing buys in 10-aug batches, so this compounds) and +32% company rep/salary - `WORK_ORDER` is mostly 400k company grinds. |
| 3 | **BN9.3** Hacktocracy | yes - `hacknet/` | Finishes SF9: a highly upgraded hacknet server on entering each new node. Cheap, low value - can slip anywhere. |
| 4 | **BN12.1** The Recursion | yes - plain hacking node | Repeatable, harder each level. Vanilla SF12 starts each node with NeuroFlux levels - verify the fork's effect before farming it. |
| 5 | **BN6.1** Like Tears in Rain | **no** - needs a Bladeburner subsystem | Bladeburner access + combat stat mults. Destroyable by hacking too, but slowly. Build `scripts/bladeburner/` first. |
| 6 | **BN7.1** Bladeburners 2079 | reuses #5 | Bladeburner API outside BN7; 7.3 gives Blade's Simulacrum (bladeburner while working). Then take 6 and 7 to level 3. |
| 7 | **BN13.1** They're lunatics | **no** - needs a Stanek charge script | Stanek's Gift in other nodes. Note SF7.3: Gift must be accepted BEFORE joining Bladeburner. |
| 8 | **BN15.1** Secrets of the Dark Net | **no** - fork-specific darknet, needs new scripts | TOR + DarkscapeNavigator at start everywhere; 15.2/15.3 make charisma boost rep. The Red Pill is not in Daedalus here - sing's `RED_PILL` path will not work as-is. |
| 9 | **BN3.1** Corporatocracy | **no** - corporation automation is a large project | Corp API everywhere; a running corp is the biggest money engine in the game. Highest payoff, highest build cost. |
| 10 | **BN14.1** IPvGO Subnet Takeover | **no** - needs a Go player | Node Power stat mults, favor from win streaks. Lowest priority. |

After the queue: SF8.2 (shorts outside BN8 - `stocks/` already uses them where allowed) and SF11
to 3, then more BN12 levels.

## Per-node notes

Fill these in during a run - what broke, what had to be tuned, how long it took.

- **BN8**: hacking pays $0 (`ScriptHackMoneyGain` 0); stocks are the only income, the batcher runs
  for EXP. Starts with $250m, WSE, TIX. `run scripts/set.js stocks.cash 1` lets the whole net
  worth sit in stocks.
  - **Cloud off at the start**: `run scripts/set.js cloud.enabled off`. Hacking pays $0, so a
    server only buys EXP and push strength, and every dollar comes out of the trading stake. Turn
    it back on near $1t net worth.
  - The trader ranks stocks the batcher can push ahead once `run scripts/set.js stocks.pushBonus 2` is set (default 1 = off), and the
    manager aims at the biggest held positions' servers (up to 3). `cat /data/stocks-pushable.txt`
    lists the reachable companies.
