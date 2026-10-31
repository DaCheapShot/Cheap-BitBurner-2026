/**
 * The rules of IPvGO. Pure, 0 GB. Transcribed from the fork's src/Go/
 * boardState/boardState.ts, boardAnalysis/boardAnalysis.ts and boardAnalysis/
 * scoring.ts; a local rules engine is what keeps the analysis API out of the
 * player - getChains, getLiberties and getControlledEmptyNodes are 16.00 GB each
 * and getValidMoves 8.00.
 *
 * NAMES ARE BILLED, and this file is where it would hurt most: a helper called
 * getLiberties costs 16.00 GB exactly as the API does. tests/ram.test.mjs pins
 * this module at the base.
 *
 * A board is what getBoardState returns: an array of column strings, so
 * rows[x][y], with "X" black, "O" white, "." empty and "#" offline. Functions
 * here take the split form, a grid, so a move can be tried without rebuilding
 * strings.
 */

export const toGrid = (rows) => rows.map((col) => col.split(""));
export const fromGrid = (grid) => grid.map((col) => col.join(""));
export const other = (color) => (color === "X" ? "O" : "X");

const STEPS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const key = (x, y) => x * 32 + y;

/** The points next to (x, y) that are on the board; offline ones included. */
export function around(grid, x, y) {
  const out = [];
  for (const [dx, dy] of STEPS) {
    const c = grid[x + dx]?.[y + dy];
    if (c !== undefined) out.push({ x: x + dx, y: y + dy, c });
  }
  return out;
}

/**
 * The connected points of one colour from (x, y), and what borders them.
 * Works for empty regions too, where `edge` is the stones around the region.
 * @returns {{color: string, cells: {x:number,y:number}[], libs: {x:number,y:number}[], edge: Set<string>}}
 */
export function groupAt(grid, x, y) {
  const color = grid[x][y];
  const seen = new Set([key(x, y)]);
  const libSeen = new Set();
  const cells = [];
  const libs = [];
  const edge = new Set();
  const todo = [{ x, y }];
  while (todo.length) {
    const p = todo.pop();
    cells.push(p);
    for (const n of around(grid, p.x, p.y)) {
      if (n.c === color) {
        if (!seen.has(key(n.x, n.y))) {
          seen.add(key(n.x, n.y));
          todo.push({ x: n.x, y: n.y });
        }
      } else if (n.c === ".") {
        if (!libSeen.has(key(n.x, n.y))) {
          libSeen.add(key(n.x, n.y));
          libs.push({ x: n.x, y: n.y });
        }
      } else if (n.c !== "#") {
        edge.add(n.c);
      }
    }
  }
  return { color, cells, libs, edge };
}

/** Every group of stones and every empty region, once each. Offline nodes are in none. */
export function allGroups(grid) {
  const seen = new Set();
  const out = [];
  for (let x = 0; x < grid.length; x++) {
    for (let y = 0; y < grid[x].length; y++) {
      if (grid[x][y] === "#" || seen.has(key(x, y))) continue;
      const g = groupAt(grid, x, y);
      for (const p of g.cells) seen.add(key(p.x, p.y));
      out.push(g);
    }
  }
  return out;
}

/**
 * Put a stone down and take what it captures. Enemy groups first, as
 * findAllCapturedChains does, so a move that captures is never suicide.
 * @returns the new grid and the stones taken, or null if the move is suicide or
 *   the point is not empty. Never touches the grid it is given.
 */
export function tryStone(grid, x, y, color) {
  if (grid[x]?.[y] !== ".") return null;
  const next = grid.map((col) => col.slice());
  next[x][y] = color;
  let taken = 0;
  for (const n of around(next, x, y)) {
    // Read the grid, not n.c: a capture on an earlier pass of this loop may have
    // already emptied this point, and an empty region must not be "captured".
    if (next[n.x][n.y] !== other(color)) continue;
    const g = groupAt(next, n.x, n.y);
    if (g.libs.length > 0) continue;
    taken += g.cells.length;
    for (const p of g.cells) next[p.x][p.y] = ".";
  }
  if (groupAt(next, x, y).libs.length === 0) return null;
  return { grid: next, taken };
}

/**
 * Every legal move. `history` is getMoveHistory(): the game refuses a repeat of
 * ANY prior board (evaluateIfMoveIsValid searches all of previousBoards, whatever
 * its comment says), so this checks all of them too.
 * @returns {{x:number, y:number, grid:string[][], taken:number}[]}
 */
export function legalMoves(grid, color, history = []) {
  const seen = new Set(history.map((rows) => rows.join("")));
  const out = [];
  for (let x = 0; x < grid.length; x++) {
    for (let y = 0; y < grid[x].length; y++) {
      const tried = tryStone(grid, x, y, color);
      if (tried && !seen.has(fromGrid(tried.grid).join(""))) out.push({ x, y, ...tried });
    }
  }
  return out;
}

/**
 * Who owns each empty region: the colour of every stone around it, or nobody if
 * both or neither touch it. checkTerritoryOwnership also refuses a region of more
 * than size^2 - 3 points: a board with a stone or two on it scores no territory.
 * @returns {{cells: {x:number,y:number}[], owner: "X"|"O"|null}[]}
 */
export function regions(grid) {
  const limit = grid.length ** 2 - 3;
  return allGroups(grid)
    .filter((g) => g.color === ".")
    .map((g) => ({
      cells: g.cells,
      owner: g.edge.size === 1 && g.cells.length <= limit ? [...g.edge][0] : null,
    }));
}

/** The game's score before komi: stones plus territory. */
export function tally(grid) {
  const out = { X: 0, O: 0 };
  for (const col of grid) for (const c of col) if (c === "X" || c === "O") out[c]++;
  for (const r of regions(grid)) if (r.owner) out[r.owner] += r.cells.length;
  return out;
}
