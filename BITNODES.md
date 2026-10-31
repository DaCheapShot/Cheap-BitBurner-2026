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
| 8 Ghost of Wall Street | 2 | 3 | shorts everywhere; one level left |
| 9 Hacktocracy | 3 | 3 | done |
| 10 Digital Carbon | 3 | 3 | done |
| 11 The Big Crash | 3 | 3 | done - aug ladder 1.9 -> 1.767 (sing plans at it) |
| 12 The Recursion | 5 | none | repeatable, harder each level |
| 13 They're lunatics | 3 | 3 | done |
| 3, 6, 7, 14, 15 | 0 | | not started |

Last snapshot (2026-10-31):
`[{"n":1,"lvl":3},{"n":5,"lvl":3},{"n":2,"lvl":3},{"n":4,"lvl":3},{"n":9,"lvl":3},{"n":10,"lvl":3},{"n":8,"lvl":2},{"n":11,"lvl":3},{"n":13,"lvl":3},{"n":12,"lvl":5}]`

## Queue

The rule behind the order: **nodes the repo already automates first**, each one making the next
cheaper; nodes that need a new subsystem written come after, one subsystem at a time.

| # | Node | Repo ready? | Why now |
|---|---|---|---|
| 1 | **BN14.1** IPvGO Subnet Takeover | yes - `go/`, untested live | Node Power x2 everywhere, favor from win streaks. The user's pick for next (2026-10-31). |
| 2 | **BN6.1** Like Tears in Rain | **no** - needs a Bladeburner subsystem | Bladeburner access + combat stat mults. Destroyable by hacking too, but slowly. Build `scripts/bladeburner/` first. |
| 3 | **BN7.1** Bladeburners 2079 | reuses #2 | Bladeburner API outside BN7; 7.3 gives Blade's Simulacrum (bladeburner while working). Then take 6 and 7 to level 3. Note SF7.3: Stanek's Gift must be accepted BEFORE joining Bladeburner. |
| 4 | **BN15.1** Secrets of the Dark Net | **no** - fork-specific darknet, needs new scripts | TOR + DarkscapeNavigator at start everywhere; 15.2/15.3 make charisma boost rep. The Red Pill is not in Daedalus here - sing's `RED_PILL` path will not work as-is. |
| 5 | **BN3.1** Corporatocracy | **no** - corporation automation is a large project | Corp API everywhere; a running corp is the biggest money engine in the game. Highest payoff, highest build cost. |

After the queue: SF8.3 (cheap, `stocks/` ready) whenever a filler node is wanted, then more BN12
levels (vanilla SF12 starts each node with NeuroFlux levels - verify the fork's effect before farming
further).

## Per-node notes

Fill these in during a run - what broke, what had to be tuned, how long it took.

- **BN14**: GoPower x4, hacking level x0.4, hack speed x0.3, rep work x0.2, aug prices x1.5,
  daemon difficulty x5.
  - `go.js` runs on every node, so run it live here first: `cat /data/go.txt` shows wins per opponent.
    The heuristic alone won 6 of 28; boards up to 7x7 now use search. Win rate still under about 50%
    on the arms it favours means search needs work before BN14.
  - Weights are `NODE_WEIGHTS[14]` in `go/config.js`: tune them after the first cycle.

- **BN13**: hacking level x0.25, hack exp x0.1, gift power x2, board 6x5.
  - Boot accepts the gift on its **first tick**, ahead of sing. **Do not buy or install an aug by hand
    before that.** `acceptGift` refuses once any aug but NeuroFlux is owned or queued.
  - The charge worker takes the whole of the largest server that is not home, up to 64 TB
    (`run scripts/set.js stanek.maxGb <GB>`). Home's cores stay with the batcher. It waits until a
    rooted server besides home exists, then moves up as cloud buys bigger ones.
  - Check `cat /data/stanek.txt` for each fragment's effect. A live run should confirm the manager log
    shows no new "no room" back-offs once the reserve kicks in.

- **BN8**: hacking pays $0 (`ScriptHackMoneyGain` 0); stocks are the only income, the batcher runs
  for EXP. Starts with $250m, WSE, TIX. `run scripts/set.js stocks.cash 1` lets the whole net
  worth sit in stocks.
  - **Cloud off at the start**: `run scripts/set.js cloud.enabled off`. Hacking pays $0, so a
    server only buys EXP and push strength, and every dollar comes out of the trading stake. Turn
    it back on near $1t net worth.
  - The trader ranks stocks the batcher can push ahead once `run scripts/set.js stocks.pushBonus 2` is set (default 1 = off), and the
    manager aims at the biggest held positions' servers (up to 3). `cat /data/stocks-pushable.txt`
    lists the reachable companies.
