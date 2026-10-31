import { assert, loadScripts } from "./harness.mjs";
import { makeNs } from "./mockNs.mjs";

const near = (a, b, tol = 0.002) => Math.abs(a - b) < tol;

/** mulberry32, so a simulated match is the same every time. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const empty = (size) => Array(size).fill(".".repeat(size));

/** The game log with the stop sentinel's own line taken out: only a real failure is left. */
const failures = (ns) => ns.read("/data/go.log.txt").split("\n").filter((l) => l.includes("game failed") && !l.includes("test over"));

/**
 * The game's side of ns.go, on board.js's rules. `reply` picks white's move from
 * the grid; null passes. Throws where netscriptGoImplementation throws: makeMove
 * refuses an illegal point, resetBoardState the secret opponent without the pill.
 */
function mockGo(b, { reply = () => null, pill = false, stats = {}, board = null, history = [], toMove = "Black", opp = "Netburners" } = {}) {
  const g = {
    rows: board ?? empty(7), history, toMove, opp, passes: 0, prev: null, resets: [],
    moves: [],
  };
  const whiteTurn = () => {
    if (g.toMove === "None") return { type: "gameOver", x: null, y: null };
    const grid = b.toGrid(g.rows);
    const m = reply(grid, g.history);
    if (!m) {
      g.passes++;
      g.prev = null;
      if (g.passes >= 2) { g.toMove = "None"; return { type: "gameOver", x: null, y: null }; }
      g.toMove = "Black";
      return { type: "pass", x: null, y: null };
    }
    g.history = [g.rows, ...g.history];
    g.rows = b.fromGrid(b.tryStone(grid, m.x, m.y, "O").grid);
    g.passes = 0;
    g.prev = [m.x, m.y];
    g.toMove = "Black";
    return { type: "move", x: m.x, y: m.y };
  };
  const api = {
    getCurrentPlayer: () => g.toMove,
    getOpponent: () => g.opp,
    getBoardState: () => g.rows,
    getMoveHistory: () => g.history,
    getGameState: () => {
      const t = b.tally(b.toGrid(g.rows));
      return { blackScore: t.X, whiteScore: t.O + 1.5, komi: 1.5, previousMove: g.prev };
    },
    makeMove: async (x, y) => {
      if (g.toMove !== "Black") throw new Error("It is not your turn to play");
      const tried = b.tryStone(b.toGrid(g.rows), x, y, "X");
      if (!tried) throw new Error(`Invalid move: ${x} ${y}`);
      g.moves.push([x, y]);
      g.history = [g.rows, ...g.history];
      g.rows = b.fromGrid(tried.grid);
      g.passes = 0;
      g.toMove = "White";
      return whiteTurn();
    },
    passTurn: async () => {
      g.passes++;
      g.prev = null;
      if (g.passes >= 2) { g.toMove = "None"; return { type: "gameOver", x: null, y: null }; }
      g.toMove = "White";
      return whiteTurn();
    },
    opponentNextTurn: async () => whiteTurn(),
    resetBoardState: (name, size) => {
      if (name === "????????????" && !pill) throw new Error("this opponent has not yet been discovered");
      g.resets.push([name, size]);
      Object.assign(g, { rows: empty(size), history: [], toMove: "Black", opp: name, passes: 0, prev: null });
      return g.rows;
    },
    analysis: { getStats: () => stats },
  };
  return { g, api };
}

/** Drive go.js for `games` games: ns.sleep rejects once they are done, which exits main's loop. */
async function drive(s, opts = {}, games = 1) {
  const b = s["go/board"];
  const ns = makeNs({ args: opts.args ?? [] });
  const { g, api } = mockGo(b, opts);
  ns.go = api;
  ns.args = opts.args ?? [];
  ns.run = () => 0; // the ENV body fails, the one-WARN path; GoPower then defaults
  let played = 0;
  ns.sleep = async () => {
    if (++played >= games) throw new Error("test over");
  };
  await s["go/go"].main(ns).catch((e) => {
    if (!String(e).includes("test over")) throw e;
  });
  return { g, ns };
}

export const tests = {
  // ------------------------------------------------------------------ rules ---

  "a stone with no liberties left is taken": async () => {
    const { tryStone, toGrid, fromGrid } = (await loadScripts())["go/board"];
    const got = tryStone(toGrid(["XO...", ".X...", ".....", ".....", "....."]), 0, 2, "X");
    // Points are rows[x][y]: O at 0,1 has neighbours 0,0 and 1,1 and 0,2.
    assert(got.taken === 1, `took ${got?.taken}`);
    assert(fromGrid(got.grid)[0] === "X.X..", `board ${fromGrid(got.grid)[0]}`);
  },

  // The first version trusted the neighbour list it took before the loop, so a
  // second side of an already-captured group read as a group to take: an empty
  // region, "captured", with the whole board's points in `taken`.
  "two sides of one captured group count it once": async () => {
    const { tryStone, toGrid } = (await loadScripts())["go/board"];
    // One O group, wrapped around 1,1: it touches the move at 1,2 and at 2,1.
    const got = tryStone(toGrid(["..X..", "..OX.", "XOOX.", ".XX..", "....."]), 1, 1, "X");
    assert(got.taken === 3, `took ${got.taken}`);
  },

  "suicide is refused, unless the move captures": async () => {
    const { tryStone, toGrid } = (await loadScripts())["go/board"];
    assert(tryStone(toGrid([".O...", "O....", ".....", ".....", "....."]), 0, 0, "X") === null, "suicide allowed");
    const capture = tryStone(toGrid([".OX..", "OX...", "X....", ".....", "....."]), 0, 0, "X");
    assert(capture !== null && capture.taken === 2, `capture: ${capture?.taken}`);
  },

  "an offline node is not a liberty": async () => {
    const { tryStone, toGrid } = (await loadScripts())["go/board"];
    assert(tryStone(toGrid(["#O...", "O....", ".....", ".....", "....."]).map((c) => c), 0, 0, "X") === null, "played offline");
    assert(tryStone(toGrid([".#...", "#....", ".....", ".....", "....."]), 0, 0, "X") === null, "lives on offline nodes");
  },

  "a move recreating ANY earlier board is illegal": async () => {
    const { legalMoves, toGrid } = (await loadScripts())["go/board"];
    const now = ["X....", ".....", ".....", ".....", "....."];
    const older = ["X.X..", ".....", ".....", ".....", "....."];
    const moves = legalMoves(toGrid(now), "X", [["O....", ".....", ".....", ".....", "....."], older]);
    assert(!moves.some((m) => m.x === 0 && m.y === 2), "repeat offered");
    assert(moves.some((m) => m.x === 0 && m.y === 3), "ordinary move missing");
  },

  "the score is stones plus surrounded empties, as scoring.ts counts it": async () => {
    const { tally, toGrid } = (await loadScripts())["go/board"];
    // Black walls off column 0 and 1; white column 3; column 2 touches both.
    const t = tally(toGrid([".....", "XXXXX", ".....", "OOOOO", "....."]));
    assert(t.X === 10 && t.O === 10, `${t.X} ${t.O}`);
    const shared = tally(toGrid([".X.O.", ".X.O.", ".X.O.", ".X.O.", ".X.O."]));
    assert(shared.X === 10 && shared.O === 10, `${shared.X} ${shared.O}`);
  },

  // checkTerritoryOwnership: over size^2 - 3 points is nobody's.
  "a nearly empty board scores no territory": async () => {
    const { tally, toGrid } = (await loadScripts())["go/board"];
    const t = tally(toGrid([".....", "..X..", ".....", ".....", "....."]));
    assert(t.X === 1, `scored ${t.X}`);
  },

  // ---------------------------------------------------------- which game -----

  "the effect curve matches effects/effect.ts": async () => {
    const { goEffect } = (await loadScripts())["go/plan"];
    assert(near(goEffect(1000, 0.9, 4, 0), 1.395), `${goEffect(1000, 0.9, 4, 0)}`);
    assert(near(goEffect(10000, 0.9, 4, 0), 2.051), `${goEffect(10000, 0.9, 4, 0)}`);
    assert(near(goEffect(10000, 0.9, 1, 1), 1.526), `SF14 doubles: ${goEffect(10000, 0.9, 1, 1)}`);
  },

  "node power comes back out of bonusPercent": async () => {
    const { goEffect, nodePowerFrom } = (await loadScripts())["go/plan"];
    for (const p of [0, 3, 500, 123456]) {
      const pct = (goEffect(p, 1.1, 4, 2) - 1) * 100;
      assert(Math.abs(nodePowerFrom(pct, 1.1, 4, 2) - p) < 1e-3 * (p + 1), `${p}`);
    }
  },

  "difficulty is the komi rate, except 5x5 Illuminati": async () => {
    const { difficulty } = (await loadScripts())["go/plan"];
    assert(difficulty(5.5, 7) === 1.5, "Daedalus");
    assert(difficulty(7.5, 7) === 2, "Illuminati 7x7");
    assert(difficulty(7.5, 5) === 8, "Illuminati 5x5");
    assert(difficulty(5.5, 5) === 1.5, "Daedalus 5x5 is no jackpot");
  },

  "the streak pays x1.25 up to x3, and a dry run breaks at up to x5": async () => {
    const { winMult } = (await loadScripts())["go/plan"];
    assert(winMult(0) === 1.25, "first win");
    assert(winMult(20) === 3, "cap");
    assert(winMult(-3) === 2.5, "dry 3");
    assert(winMult(-30) === 5, "dry cap");
  },

  // Measured arms, so the only things separating them are power and weight.
  "the same arms measured: value falls with power, so play spreads": async () => {
    const { chooseArm, armKey, goEffect } = (await loadScripts())["go/plan"];
    const { OPPONENTS, SIZES } = (await loadScripts())["go/config"];
    const arms = {};
    for (const [opp] of Object.entries(OPPONENTS)) {
      for (const size of SIZES) arms[armKey(opp, size)] = { n: 9, score: 10, win: 0.5, secs: 60 };
    }
    const base = { node: 1, goPower: 1, sf14: 0, arms, gone: new Set(["????????????|19"]) };
    const first = chooseArm({ ...base, stats: {} });
    const pct = (goEffect(1e6, OPPONENTS[first.opp].power, 1, 0) - 1) * 100;
    const next = chooseArm({ ...base, stats: { [first.opp]: { bonusPercent: pct, winStreak: 0 } } });
    assert(next.opp !== first.opp, `stayed on ${first.opp}`);
  },

  "BN8 weighs Black Hand's hacking money at nothing": async () => {
    const { chooseArm } = (await loadScripts())["go/plan"];
    const got = chooseArm({ node: 8, goPower: 1, sf14: 0, stats: {}, arms: {}, gone: new Set(["Illuminati|5"]) });
    assert(got.opp !== "The Black Hand", got.opp);
    const { weightsFor } = (await loadScripts())["go/plan"];
    assert(weightsFor(8).money === 0 && weightsFor(1).money === 1, "weights");
  },

  // User's rule: BN14 plays to end the node, everywhere else for the normal stats.
  "BN14 prefers rep where another node would not": async () => {
    const { chooseArm, armKey } = (await loadScripts())["go/plan"];
    const { OPPONENTS, SIZES } = (await loadScripts())["go/config"];
    const arms = {};
    for (const size of SIZES) {
      for (const opp of Object.keys(OPPONENTS)) arms[armKey(opp, size)] = { n: 9, score: 10, win: 0.5, secs: 60 };
    }
    // Illuminati's 5x5 payout is real; take it off the table to compare rates.
    const gone = new Set(["????????????|19", "Illuminati|5"]);
    assert(chooseArm({ node: 14, goPower: 4, sf14: 0, stats: {}, arms, gone }).opp === "Daedalus", "BN14");
    const elsewhere = chooseArm({ node: 1, goPower: 1, sf14: 0, stats: {}, arms, gone });
    assert(elsewhere.opp !== "Netburners" && elsewhere.opp !== "Slum Snakes", elsewhere.opp);
  },

  "learn is a mean, then an EWMA, and a resumed game keeps the clock": async () => {
    const { learn } = (await loadScripts())["go/plan"];
    let e = learn(undefined, { score: 10, win: true, secs: 30 });
    e = learn(e, { score: 20, win: false, secs: null });
    assert(e.score === 15 && e.win === 0.5 && e.secs === 30 && e.n === 2, JSON.stringify(e));
  },

  // --------------------------------------------------------- which point ----

  "takes a capture ahead of everything": async () => {
    const { chooseMove } = (await loadScripts())["go/plan"];
    const m = chooseMove(["XO...", ".X...", ".....", ".....", "....."], [], { komi: 1.5, opponentPassed: false });
    assert(m.x === 0 && m.y === 2, JSON.stringify(m));
  },

  "saves a group in atari": async () => {
    const { chooseMove } = (await loadScripts())["go/plan"];
    const rows = [".....", "..O..", ".OX..", "..O..", "....."];
    const m = chooseMove(rows, [], { komi: 1.5, opponentPassed: false });
    assert(m.x === 2 && m.y === 3, JSON.stringify(m));
  },

  "never fills its own eye": async () => {
    const { chooseMove } = (await loadScripts())["go/plan"];
    const rows = [".XOOO", "XXOOO", "XXXXO", "X.XXO", "XXXOO"];
    assert(chooseMove(rows, [], { komi: 1.5, opponentPassed: false }) === null, "filled an eye");
  },

  "passes to bank a win once white has passed": async () => {
    const { chooseMove } = (await loadScripts())["go/plan"];
    const settled = [".X.O.", "XXXOO", ".XXO.", "XXXOO", ".XXO."];
    assert(chooseMove(settled, [], { komi: 0.5, opponentPassed: true }) === null, "played on");
  },

  // Not a strength claim about the faction AIs - /data/go.txt is that. This is
  // the floor: a player that cannot beat a random mover has a bug.
  "beats a capturing random mover on 5x5 and 7x7": async () => {
    const s = await loadScripts();
    const b = s["go/board"];
    const { chooseMove } = s["go/plan"];
    let wins = 0;
    const games = 12;
    for (let i = 0; i < games; i++) {
      const r = rng(i + 1);
      const size = i % 2 ? 5 : 7;
      let rows = empty(size);
      let history = [];
      let passes = 0;
      for (let t = 0; t < size * size * 4 && passes < 2; t++) {
        const m = chooseMove(rows, history, { komi: 1.5, opponentPassed: passes > 0 });
        if (m) {
          history = [rows, ...history];
          rows = b.fromGrid(b.tryStone(b.toGrid(rows), m.x, m.y, "X").grid);
          passes = 0;
        } else if (++passes >= 2) break;
        const opts = b.legalMoves(b.toGrid(rows), "O", history);
        const hits = opts.filter((o) => o.taken > 0);
        const pool = hits.length ? hits : opts;
        if (!pool.length) { passes++; continue; }
        const o = pool[Math.floor(r() * pool.length)];
        history = [rows, ...history];
        rows = b.fromGrid(o.grid);
        passes = 0;
      }
      const t = b.tally(b.toGrid(rows));
      if (t.X >= t.O + 1.5) wins++;
    }
    assert(wins >= 10, `won ${wins} of ${games}`);
  },

  // ----------------------------------------------------------------- go.js ---

  "a game in progress is resumed, never reset": async () => {
    const s = await loadScripts();
    const board = [".......", "...X...", ".......", ".......", ".......", ".......", "......."];
    const { g } = await drive(s, { board, history: [empty(7)], reply: () => null });
    // drive stops after the one game, so any reset here would have cost the streak.
    assert(g.resets.length === 0, `reset ${JSON.stringify(g.resets)}`);
    assert(g.toMove === "None", `ended on ${g.toMove}`);
  },

  "a turn left with white is waited out, then played": async () => {
    const s = await loadScripts();
    const { g } = await drive(s, { toMove: "White", history: [empty(7)], reply: () => null });
    assert(g.resets.length === 0 && g.toMove === "None", `${g.toMove} ${g.resets.length}`);
  },

  "nothing on the board is a fresh game, not a resume": async () => {
    const s = await loadScripts();
    const { g } = await drive(s, { history: [], reply: () => null });
    assert(g.resets.length >= 1, "played the default board");
  },

  // The enum value, not the name: resetBoardState takes twelve question marks.
  "the secret opponent's refusal drops the arm and play goes on": async () => {
    const s = await loadScripts();
    const { g, ns } = await drive(s, { reply: () => null }, 1);
    assert(g.resets.every(([name]) => name !== "????????????"), "reset the secret board without the pill");
    assert(failures(ns).length === 0, failures(ns).join());
  },

  "a finished game is logged, learned and reported": async () => {
    const s = await loadScripts();
    const { ns } = await drive(s, { reply: () => null });
    assert(/won|lost/.test(ns.read("/data/go.log.txt")), ns.read("/data/go.log.txt"));
    assert(Object.keys(JSON.parse(ns.read("/data/go-arms.txt"))).length >= 1, "no arm learned");
    assert(ns.read("/data/go.txt").startsWith("playing "), ns.read("/data/go.txt"));
  },

  "a turn taken by hand is not a failure": async () => {
    const s = await loadScripts();
    const b = s["go/board"];
    const ns = makeNs({});
    const { g, api } = mockGo(b, { reply: () => null, history: [empty(7)] });
    let once = true;
    const real = api.makeMove;
    api.makeMove = async (x, y) => {
      if (once) { once = false; throw new Error("It is not your turn to play"); }
      return real(x, y);
    };
    ns.go = api;
    ns.args = [];
    ns.run = () => 0;
    ns.sleep = async () => { throw new Error("test over"); };
    await s["go/go"].main(ns).catch((e) => { if (!String(e).includes("test over")) throw e; });
    assert(failures(ns).length === 0, failures(ns).join());
    assert(g.toMove === "None", g.toMove);
  },
};
