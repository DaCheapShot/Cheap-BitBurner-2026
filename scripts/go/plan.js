import {
  OPPONENTS, SIZES, WORLD, WORLD_SIZE, NORMAL_WEIGHTS, NODE_WEIGHTS, EWMA_RATE,
  PRIOR_SCORE_SHARE, PRIOR_WIN, PRIOR_SECONDS_PER_POINT, SEARCH_MAX_SIZE, CHEAT_MAX_OPTIONS,
} from "./config.js";
import { toGrid, fromGrid, other, around, groupAt, allGroups, legalMoves, regions, tally, tryStone } from "./board.js";

/**
 * Every IPvGO decision, pure and 0 GB: which game to play next (chooseArm) and
 * which point to take in it (chooseMove). The player is always black: only the
 * No AI board lets a script play white.
 */

// ------------------------------------------------------------- which game ---

/** The effect of `nodePower` on one opponent's stat: CalculateEffect in effects/effect.ts. */
export function goEffect(nodePower, power, goPower, sf14) {
  const n = nodePower + 1;
  return 1 + Math.log(n) * n ** 0.3 * 0.002 * power * goPower * (sf14 > 0 ? 2 : 1);
}

/**
 * Node power back out of getStats().bonusPercent, the only place the API shows
 * it. Read rather than counted, so an install's zeroing and a hand-played game
 * are both simply right. Bisected in log space: the effect has no inverse.
 */
export function nodePowerFrom(bonusPercent, power, goPower, sf14) {
  if (!(bonusPercent > 0)) return 0;
  const want = 1 + bonusPercent / 100;
  let lo = 0;
  let hi = 50;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (goEffect(Math.expm1(mid), power, goPower, sf14) < want) lo = mid;
    else hi = mid;
  }
  return Math.expm1(lo);
}

/** getDifficultyMultiplier: and 5x5 Illuminati pays four times its own komi's rate. */
export function difficulty(komi, size) {
  return size === 5 && komi === OPPONENTS.Illuminati.komi ? 8 : (komi + 0.5) * 0.25;
}

/** getWinstreakMultiplier, for a win landing on `streak` (negative is a dry run). */
export function winMult(streak) {
  if (streak < 0) return 1 + 0.5 * Math.min(-streak, 8);
  return 1 + 0.25 * Math.min(streak + 1, 8);
}

/** A loss still pays node power, at x0.5 - why no game here is ever wasted time. */
export const LOSS_MULT = 0.5;

/** The weight table for a node: NORMAL_WEIGHTS with that node's overrides on top. */
export const weightsFor = (node) => ({ ...NORMAL_WEIGHTS, ...NODE_WEIGHTS[node] });

export const armKey = (opp, size) => `${opp}|${size}`;

/** Fold one finished game into an arm's averages. `secs` is null for a resumed game. */
export function learn(entry, game) {
  const n = (entry?.n ?? 0) + 1;
  const rate = Math.max(1 / n, EWMA_RATE);
  const mix = (was, now) => (was === undefined ? now : was + (now - was) * rate);
  return {
    n,
    score: mix(entry?.score, game.score),
    win: mix(entry?.win, game.win ? 1 : 0),
    secs: game.secs === null ? entry?.secs : mix(entry?.secs, game.secs),
  };
}

/**
 * The arm with the most weighted log-bonus per second:
 *
 *   weight * [ ln f(p + g) - ln f(p) ] / seconds
 *
 * Log, because bonuses multiply. The difference, because the effect curve is
 * steeply concave: a game's value falls as that opponent's power rises, so
 * spreading across opponents needs no rule of its own - 30k power on three
 * opponents is 2.16 log-points against 0.97 on one. Seconds, because the AIs
 * differ: Illuminati awaits far more per move than Netburners.
 *
 * Nothing here knows 5x5 Illuminati is the jackpot; the difficulty table and the
 * measured score do. An untried arm carries a generous prior so it gets a game.
 *
 * @param {{node:number, goPower:number, sf14:number, stats:object, arms:object, gone:Set<string>}} s
 * @returns {{opp:string, size:number, value:number}|null}
 */
export function chooseArm({ node, goPower, sf14, stats, arms, gone }) {
  const weights = weightsFor(node);
  let best = null;
  for (const [opp, o] of Object.entries(OPPONENTS)) {
    const weight = weights[o.stat];
    if (!(weight > 0)) continue;
    const p = nodePowerFrom(stats[opp]?.bonusPercent ?? 0, o.power, goPower, sf14);
    const streak = stats[opp]?.winStreak ?? 0;
    for (const size of opp === WORLD ? [WORLD_SIZE] : SIZES) {
      if (gone.has(armKey(opp, size))) continue;
      const seen = arms[armKey(opp, size)];
      const points = size * size;
      const score = seen?.score ?? points * PRIOR_SCORE_SHARE;
      const win = seen?.win ?? PRIOR_WIN;
      const secs = Math.max(seen?.secs ?? points * PRIOR_SECONDS_PER_POINT, 1);
      // No dry-run bonus on a guess: PRIOR_WIN x5 pulled every loss straight back
      // to the same opponent's next untried board.
      const mult = winMult(seen ? streak : Math.max(streak, 0));
      const paid = score * difficulty(o.komi, size) * (win * mult + (1 - win) * LOSS_MULT);
      const gain = Math.log(goEffect(p + paid, o.power, goPower, sf14) / goEffect(p, o.power, goPower, sf14));
      const value = (weight * gain) / secs;
      if (!best || value > best.value) best = { opp, size, value };
    }
  }
  return best;
}

// ------------------------------------------------------------- which point ---

/** How far a stone's influence reaches, and what a fully-held open point is worth. */
const REACH = 3;
const INFLUENCE = 0.7;
/** An enemy region this small cannot hold a living group, so playing in it is a gift. */
const INVADE_MIN = 6;
/** Moves past points x this are two bots trading dead stones: stop adding to it. */
const LENGTH_CAP = 3;

/** Mine minus theirs at the end if the board stayed as it is, open points by influence. */
function standing(grid, me) {
  const t = tally(grid);
  let v = t[me] - t[other(me)];
  for (const r of regions(grid)) {
    if (r.owner) continue;
    for (const p of r.cells) {
      let pull = 0;
      for (let dx = -REACH; dx <= REACH; dx++) {
        const rest = REACH - Math.abs(dx);
        for (let dy = -rest; dy <= rest; dy++) {
          const c = grid[p.x + dx]?.[p.y + dy];
          if (c === me) pull += 2 ** -(Math.abs(dx) + Math.abs(dy));
          else if (c === other(me)) pull -= 2 ** -(Math.abs(dx) + Math.abs(dy));
        }
      }
      v += Math.max(-1, Math.min(1, pull)) * INFLUENCE;
    }
  }
  return v;
}

/** How many groups of `color` touch two regions they own: the two-eyes rule. */
function liveCount(grid, color) {
  const groups = allGroups(grid).filter((g) => g.color === color);
  const ids = new Map();
  groups.forEach((g, i) => g.cells.forEach((p) => ids.set(`${p.x},${p.y}`, i)));
  const eyes = groups.map(() => 0);
  for (const r of regions(grid)) {
    if (r.owner !== color) continue;
    const touching = new Set();
    for (const p of r.cells) {
      for (const n of around(grid, p.x, p.y)) if (n.c === color) touching.add(ids.get(`${n.x},${n.y}`));
    }
    for (const i of touching) eyes[i]++;
  }
  return eyes.filter((e) => e >= 2).length;
}

/** Does a stone on `m` touch a white group now down to one liberty? */
function threatens(m, foe) {
  return around(m.grid, m.x, m.y).some((n) => n.c === foe && groupAt(m.grid, n.x, n.y).libs.length === 1);
}

/** What the stones next to a move look like after it: the one-ply tactics. */
function tactics(m, me) {
  const foe = other(me);
  const mine = groupAt(m.grid, m.x, m.y);
  if (mine.libs.length === 1 && !m.taken) return null; // self-atari
  let v = mine.libs.length === 2 ? -0.5 : 0;
  for (const n of around(m.grid, m.x, m.y)) {
    if (n.c !== foe) continue;
    const g = groupAt(m.grid, n.x, n.y);
    if (g.libs.length === 1) v += 0.5 * Math.min(g.cells.length, 3);
  }
  return v;
}

/**
 * The move, or null to pass.
 *
 * In order: take stones; save a group in atari; make a group live, or stop white
 * doing it; otherwise the move that raises the standing most. A one-ply heuristic
 * on purpose: the faction AIs do not read ahead either, and a game pays even
 * when lost.
 *
 * ponytail: no search. Under about 50% wins on the arms worth playing in
 * /data/go.txt, add MCTS for boards up to 7x7, where the 5x5 Illuminati payout is.
 *
 * @param {string[]} rows getBoardState()
 * @param {string[][]} history getMoveHistory()
 * @param {{komi:number, opponentPassed:boolean}} s
 * @returns {{x:number, y:number}|null}
 */
export function chooseMove(rows, history, { komi, opponentPassed }) {
  const me = "X";
  const foe = "O";
  const grid = toGrid(rows);
  const moves = legalMoves(grid, me, history);
  if (!moves.length) return null;
  if (history.length > grid.length ** 2 * LENGTH_CAP) return null;

  const at = (m) => ({ x: m.x, y: m.y });
  const moveAt = new Map(moves.map((m) => [`${m.x},${m.y}`, m]));

  const taking = moves.filter((m) => m.taken > 0).sort((a, b) => b.taken - a.taken);
  if (taking.length) return at(taking[0]);

  const ours = allGroups(grid).filter((g) => g.color === me);
  for (const g of ours.filter((h) => h.libs.length === 1).sort((a, b) => b.cells.length - a.cells.length)) {
    const m = moveAt.get(`${g.libs[0].x},${g.libs[0].y}`);
    if (m && groupAt(m.grid, m.x, m.y).libs.length > 1) return at(m);
  }

  const alive = liveCount(grid, me);
  const living = moves.find((m) => tactics(m, me) !== null && liveCount(m.grid, me) > alive);
  if (living) return at(living);

  const foeAlive = liveCount(grid, foe);
  const theirs = legalMoves(grid, foe, history).filter((m) => liveCount(m.grid, foe) > foeAlive);
  if (theirs.length === 1) {
    const m = moveAt.get(`${theirs[0].x},${theirs[0].y}`);
    if (m && tactics(m, me) !== null) return at(m);
  }

  const owned = new Map();
  for (const r of regions(grid)) {
    if (r.owner) for (const p of r.cells) owned.set(`${p.x},${p.y}`, r);
  }
  const base = standing(grid, me);
  let best = null;
  let bestV = -Infinity;
  for (const m of moves) {
    const r = owned.get(`${m.x},${m.y}`);
    if (r?.owner === me && r.cells.length <= 2) continue; // own eye
    if (r?.owner === foe && r.cells.length < INVADE_MIN && !threatens(m, foe)) continue;
    const t = tactics(m, me);
    if (t === null) continue;
    const v = standing(m.grid, me) + t;
    if (v > bestV) {
      best = m;
      bestV = v;
    }
  }
  if (!best || bestV <= base) return null;

  // White passed and black is ahead: two passes bank the win, unless a move still
  // adds a whole point, because the points are what the game pays.
  const lead = tally(grid).X - tally(grid).O - komi;
  if (opponentPassed && lead > 0 && bestV - base < 1) return null;
  return at(best);
}

/**
 * What the search should look at, or null when it should not run and `quick`,
 * chooseMove's answer, stands: a board too big, a game past its length cap, or a
 * pass that banks a lead. Behind, a heuristic pass is NOT trusted: that is where
 * search finds the invasion a one-ply count cannot see.
 *
 * Own eyes are left out, but a capture from inside one is not.
 */
export function searchMoves(rows, history, { komi }, quick) {
  const grid = toGrid(rows);
  if (grid.length > SEARCH_MAX_SIZE) return null;
  if (history.length > grid.length ** 2 * LENGTH_CAP) return null;
  const t = tally(grid);
  if (quick === null && t.X - t.O - komi > 0) return null;
  const eyes = new Set();
  for (const r of regions(grid)) {
    if (r.owner === "X" && r.cells.length <= 2) for (const p of r.cells) eyes.add(`${p.x},${p.y}`);
  }
  const moves = legalMoves(grid, "X", history).filter((m) => m.taken > 0 || !eyes.has(`${m.x},${m.y}`));
  return moves.length > 1 ? moves : null;
}

// ------------------------------------------------------------------ cheats ---

/**
 * May this save call go.cheat? checkCheatApiAccess, to the letter: SF14.2, or
 * SF14.1 while inside BitNode 14. go.js asks before any cheat body exists, which
 * is what keeps a save without access at 10.60 GB: the body is never written.
 */
export const canCheat = (node, sf14) => sf14 >= 2 || (sf14 === 1 && node === 14);

/**
 * The boards a cheat could leave, white to move: the search's top two moves
 * together, and each white stone gone, weakest groups first. Removing a router
 * and placing one are the only cheats that win a race; destroyNode and
 * repairOfflineNode only reshape the board.
 *
 * @returns {{kind:"two"|"remove", points:number[], rows:string[]}[]}
 */
export function cheatOptions(rows, first, second) {
  const grid = toGrid(rows);
  const out = [];
  const one = tryStone(grid, first.x, first.y, "X");
  const both = one && tryStone(one.grid, second.x, second.y, "X");
  if (both) out.push({ kind: "two", points: [first.x, first.y, second.x, second.y], rows: fromGrid(both.grid) });
  const stones = allGroups(grid).filter((g) => g.color === "O").sort((a, b) => a.libs.length - b.libs.length)
    .flatMap((g) => g.cells).slice(0, CHEAT_MAX_OPTIONS);
  for (const p of stones) {
    const next = grid.map((col) => col.slice());
    next[p.x][p.y] = ".";
    out.push({ kind: "remove", points: [p.x, p.y], rows: fromGrid(next) });
  }
  return out;
}

/** A failed cheat skips the turn, so its value is the skip's, not the normal move's. */
export const cheatPays = (chance, option, skip, normal) => chance * option + (1 - chance) * skip > normal;
