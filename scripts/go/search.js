import { SEARCH_UCB } from "./config.js";

/**
 * Monte Carlo tree search for small boards. Pure, 0 GB, and in SLICES.
 *
 * WHY. The one-ply heuristic won 6 of 28 live games: it never considers the
 * reply, and Daedalus and Illuminati punish that. On boards up to SEARCH_MAX_SIZE
 * a playout is short enough for search to see the reply and the one after.
 *
 * WHY SLICES. The game runs every script on one thread, and the batcher execs
 * each op just in time on a 25 ms tick against a 100 ms spacer. A one-second
 * blocking search would stall every dispatch on the network and reorder batches.
 * So startSearch does nothing on its own; go.js calls step(SLICE_MS) and yields.
 *
 * Its own flat board, not board.js: tryStone copies the grid per move, which is
 * right for a dozen tries and about a hundred times too slow for a playout.
 *
 * Scoring is the game's, stones plus territory, with its one rule left out: the
 * size^2 - 3 limit on a region cannot apply to a finished playout.
 *
 * ponytail: no RAVE and no tree reuse between moves. Add RAVE first if a live
 * win rate is still poor, since it helps most at low playout counts.
 */

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const OFFLINE = 3;

/**
 * The value of a playout to black. Mostly the win: the streak pays up to x3. The
 * rest is points, because they are what a game pays when it cannot be won.
 */
const WIN_SHARE = 0.9;

export function startSearch(rows, candidates, komi) {
  const n = rows.length;
  const size = n * n;
  const root = new Int8Array(size);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const c = rows[x][y];
      root[x * n + y] = c === "X" ? BLACK : c === "O" ? WHITE : c === "." ? EMPTY : OFFLINE;
    }
  }
  // Four slots per point, -1 where the edge or an offline node is.
  const links = new Int32Array(size * 4).fill(-1);
  for (let i = 0; i < size; i++) {
    if (root[i] === OFFLINE) continue;
    const x = Math.floor(i / n);
    const y = i % n;
    [[x, y + 1], [x + 1, y], [x, y - 1], [x - 1, y]].forEach(([a, b], k) => {
      if (a >= 0 && a < n && b >= 0 && b < n && root[a * n + b] !== OFFLINE) links[i * 4 + k] = a * n + b;
    });
  }

  const cells = new Int8Array(size);
  const stamp = new Int32Array(size);
  const stack = new Int32Array(size);
  let tick = 0;
  let lastLib = -1;

  /** Liberties of the group at i, stopping at 2: all a playout needs. Leaves one in lastLib. */
  function libsUpTo2(i) {
    const color = cells[i];
    tick++;
    let top = 0;
    let libs = 0;
    stack[top++] = i;
    stamp[i] = tick;
    while (top > 0) {
      const p = stack[--top];
      for (let k = 0; k < 4; k++) {
        const q = links[p * 4 + k];
        if (q < 0 || stamp[q] === tick) continue;
        const c = cells[q];
        if (c === EMPTY) {
          stamp[q] = tick;
          lastLib = q;
          if (++libs >= 2) return 2;
        } else if (c === color) {
          stamp[q] = tick;
          stack[top++] = q;
        }
      }
    }
    return libs;
  }

  function removeGroup(i) {
    const color = cells[i];
    let top = 0;
    stack[top++] = i;
    cells[i] = EMPTY;
    while (top > 0) {
      const p = stack[--top];
      for (let k = 0; k < 4; k++) {
        const q = links[p * 4 + k];
        if (q >= 0 && cells[q] === color) {
          cells[q] = EMPTY;
          stack[top++] = q;
        }
      }
    }
  }

  /** Legal, and not a point whose every neighbour is the mover's own: that is an eye. */
  function playable(i, color) {
    if (cells[i] !== EMPTY) return false;
    let open = false;
    let own = true;
    for (let k = 0; k < 4; k++) {
      const q = links[i * 4 + k];
      if (q < 0) continue;
      if (cells[q] === EMPTY) open = true;
      if (cells[q] !== color) own = false;
    }
    if (own) return false;
    if (open) return true;
    cells[i] = color;
    let ok = false;
    for (let k = 0; k < 4 && !ok; k++) {
      const q = links[i * 4 + k];
      if (q < 0) continue;
      const libs = libsUpTo2(q);
      ok = cells[q] === color ? libs >= 1 : libs === 0;
    }
    cells[i] = EMPTY;
    return ok;
  }

  function place(i, color) {
    cells[i] = color;
    for (let k = 0; k < 4; k++) {
      const q = links[i * 4 + k];
      if (q >= 0 && cells[q] === 3 - color && libsUpTo2(q) === 0) removeGroup(q);
    }
  }

  /** Capture or rescue beside the last move, which is what makes a playout mean anything. */
  function urgent(last, color) {
    if (last < 0) return -1;
    for (let k = 0; k < 4; k++) {
      const q = links[last * 4 + k];
      if (q >= 0 && cells[q] !== EMPTY && libsUpTo2(q) === 1 && playable(lastLib, color)) return lastLib;
    }
    return -1;
  }

  const open = new Int32Array(size);

  /** Finish the game at random from `cells`, with `color` to move; black's value of it. */
  function rollout(color, last) {
    let passes = 0;
    for (let step = 0; step < size * 3 && passes < 2; step++) {
      let pick = urgent(last, color);
      if (pick < 0) {
        let count = 0;
        for (let i = 0; i < size; i++) if (cells[i] === EMPTY) open[count++] = i;
        while (count > 0) {
          const j = Math.floor(Math.random() * count);
          if (playable(open[j], color)) {
            pick = open[j];
            break;
          }
          open[j] = open[--count];
        }
      }
      if (pick < 0) passes++;
      else {
        place(pick, color);
        passes = 0;
      }
      last = pick;
      color = 3 - color;
    }
    return worth();
  }

  function worth() {
    let black = 0;
    let white = 0;
    tick++;
    for (let i = 0; i < size; i++) {
      if (cells[i] === BLACK) black++;
      else if (cells[i] === WHITE) white++;
      else if (cells[i] === EMPTY && stamp[i] !== tick) {
        let top = 0;
        let area = 0;
        let edges = 0;
        stack[top++] = i;
        stamp[i] = tick;
        while (top > 0) {
          const p = stack[--top];
          area++;
          for (let k = 0; k < 4; k++) {
            const q = links[p * 4 + k];
            if (q < 0) continue;
            if (cells[q] === EMPTY) {
              if (stamp[q] !== tick) {
                stamp[q] = tick;
                stack[top++] = q;
              }
            } else edges |= cells[q];
          }
        }
        if (edges === BLACK) black += area;
        else if (edges === WHITE) white += area;
      }
    }
    return (black >= white + komi ? WIN_SHARE : 0) + ((1 - WIN_SHARE) * black) / Math.max(black + white, 1);
  }

  function movesFor(color) {
    const out = [];
    for (let i = 0; i < size; i++) if (playable(i, color)) out.push(i);
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  const top = { point: -1, visits: 0, value: 0, kids: [], todo: candidates.map((m) => m.x * n + m.y) };

  /** One descent, one expansion, one playout, one update. */
  function iterate() {
    cells.set(root);
    let node = top;
    let color = BLACK;
    let last = -1;
    const path = [top];
    for (;;) {
      if (node.todo === null) node.todo = movesFor(color);
      if (node.todo.length) {
        const point = node.todo.pop();
        const kid = { point, visits: 0, value: 0, kids: [], todo: null };
        node.kids.push(kid);
        place(point, color);
        last = point;
        color = 3 - color;
        path.push(kid);
        break;
      }
      if (!node.kids.length) break;
      const logN = Math.log(node.visits + 1);
      let best = null;
      let bestScore = -Infinity;
      for (const k of node.kids) {
        const mean = k.value / k.visits;
        const score = (color === BLACK ? mean : 1 - mean) + SEARCH_UCB * Math.sqrt(logN / k.visits);
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      }
      node = best;
      place(node.point, color);
      last = node.point;
      color = 3 - color;
      path.push(node);
    }
    const v = rollout(color, last);
    for (const p of path) {
      p.visits++;
      p.value += v;
    }
  }

  return {
    /** Search for about `ms`. Checked every playout: one is microseconds on these boards. */
    step(ms) {
      const end = Date.now() + ms;
      do iterate();
      while (Date.now() < end);
    },
    /** The most-visited move: steadier than the best mean on a few visits. */
    best() {
      let kid = null;
      for (const k of top.kids) if (!kid || k.visits > kid.visits) kid = k;
      return kid && { x: Math.floor(kid.point / n), y: kid.point % n };
    },
    get playouts() {
      return top.visits;
    },
  };
}
