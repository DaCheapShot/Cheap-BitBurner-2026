import { CHARGE_GB, RELAUNCH_RATIO, BOOSTER_TYPE } from "./config.js";

/**
 * Stanek's Gift decisions - pure, 0 GB. Every function takes plain data the
 * pass read through rpc and returns plain data; nothing here touches ns.
 *
 * NAME TAX: the gift API bills `giftWidth`, `placeFragment`, `getFragment` and
 * the rest by bare name anywhere in the import closure, so nothing here is
 * named after one. `width`, `height`, `cells` and `layout` are free.
 */

/** Bounding box of `shape` turned by `rotation` - Fragment.width/height. */
const boxW = (shape, rotation) => (rotation % 2 === 0 ? shape[0].length : shape.length);
const boxH = (shape, rotation) => (rotation % 2 === 0 ? shape.length : shape[0].length);

/**
 * Is (x, y) of the rotated box filled? A transcription of Fragment.fullAt -
 * the game places and collides by THIS, so a re-derived rotation that turned
 * the other way would lay out a board the game then refuses.
 */
export function fullAt(shape, x, y, rotation) {
  const w = boxW(shape, rotation);
  const h = boxH(shape, rotation);
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  let [sx, sy, mx, my] = [0, 0, 1, 1];
  if (rotation === 1) [sx, sy, mx, my] = [w - 1, 0, -1, 1];
  else if (rotation === 2) [sx, sy, mx, my] = [w - 1, h - 1, -1, -1];
  else if (rotation === 3) [sx, sy, mx, my] = [0, h - 1, 1, -1];
  let [qx, qy] = [sx + mx * x, sy + my * y];
  if (rotation % 2 === 1) [qx, qy] = [qy, qx];
  return shape[qy][qx];
}

/** The filled cells of `shape` at `rotation`, [x, y] relative to the box, row by row. */
export function cells(shape, rotation) {
  const out = [];
  for (let y = 0; y < boxH(shape, rotation); y++) {
    for (let x = 0; x < boxW(shape, rotation); x++) if (fullAt(shape, x, y, rotation)) out.push([x, y]);
  }
  return out;
}

/**
 * Every distinct orientation of `shape`, each as cells relative to its FIRST
 * cell in reading order (so the packer can pin that cell), plus where the box
 * root sits relative to it. An O piece has one orientation, an I two.
 */
function orientations(shape) {
  const seen = new Set();
  const out = [];
  for (let rotation = 0; rotation < 4; rotation++) {
    const c = cells(shape, rotation);
    const [ax, ay] = c[0];
    const rel = c.map(([x, y]) => [x - ax, y - ay]);
    const key = JSON.stringify(rel);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rotation, rel, rootDx: -ax, rootDy: -ay });
  }
  return out;
}

/**
 * Exactly these pieces on a w x h board, or null. Depth-first over cells in
 * reading order: the first empty cell is either the first cell of some unplaced
 * piece, or left empty - and empties are capped at the board's spare area, which
 * is what keeps the search small (30 cells, 6 pieces, 6 spare in BN13.1).
 *
 * With `each`, it ENUMERATES instead: every packing goes to each(packing) and
 * the search goes on, until `nodes` search steps are spent or each() returns
 * true. The return value is then meaningless.
 */
function pack(w, h, pieces, busy = new Array(w * h).fill(false), each = null, nodes = Infinity) {
  const taken = [...busy];
  const spare = taken.filter((t) => !t).length - pieces.reduce((n, p) => n + p.size, 0);
  if (spare < 0) return null;
  const used = new Array(pieces.length).fill(false);
  const out = [];
  let steps = 0;

  const dfs = (pos, left, placed) => {
    if (++steps > nodes) return true;
    if (placed === pieces.length) return each ? each(out.slice()) === true : true;
    while (pos < w * h && taken[pos]) pos++;
    if (pos >= w * h) return false;
    const x = pos % w;
    const y = Math.floor(pos / w);
    for (let i = 0; i < pieces.length; i++) {
      if (used[i]) continue;
      for (const o of pieces[i].orients) {
        const at = o.rel.map(([dx, dy]) => [x + dx, y + dy]);
        if (!at.every(([cx, cy]) => cx >= 0 && cy >= 0 && cx < w && cy < h && !taken[cy * w + cx])) continue;
        for (const [cx, cy] of at) taken[cy * w + cx] = true;
        used[i] = true;
        out.push({ x: x + o.rootDx, y: y + o.rootDy, rotation: o.rotation, id: pieces[i].id });
        if (dfs(pos + 1, left, placed + 1)) return true;
        out.pop();
        used[i] = false;
        for (const [cx, cy] of at) taken[cy * w + cx] = false;
      }
    }
    if (left > 0) {
      taken[pos] = true;
      if (dfs(pos + 1, left - 1, placed)) return true;
      taken[pos] = false;
    }
    return false;
  };
  return dfs(0, spare, 0) ? out : null;
}

/**
 * The board to place: [{x, y, rotation, id}] as placeFragment takes them, for
 * the longest prefix of `order` that fits. Boosters and ids the game does not
 * define are skipped.
 *
 * BOOSTERS, only when the WHOLE order fits (the user's rule: never a booster
 * at the price of an important piece). Each packing the search finds - up to
 * `boost.nodes` steps - gets boosters greedily (`boostersFor`), and the best
 * score wins; ties keep fewer boosters, then the first found.
 *
 * ponytail: budgeted enumeration + greedy boosters, not a joint optimum; a
 * short board drops from the END of the order rather than searching subsets.
 * Upgrade path: boosters inside the DFS.
 *
 * @param {number} w gift width
 * @param {number} h gift height
 * @param {{id: number, shape: boolean[][], type: number}[]} defs fragmentDefinitions()
 * @param {number[]} order fragment ids, most wanted first
 * @param {{weights: object, minTouch: number, nodes: number}} [boost] omitted: no boosters
 */
export function layout(w, h, defs, order, boost = null) {
  const pieces = piecesOf(defs, order);
  if (boost && pieces.length) {
    const spots = boosterSpots(w, h, defs);
    let best = null;
    pack(w, h, pieces, undefined, (core) => {
      const got = boostersFor(w, h, defs, core, spots, boost.weights, boost.minTouch);
      if (!best || got.score > best.score || (got.score === best.score && got.list.length < best.list.length)) {
        best = { score: got.score, list: [...core, ...got.list] };
      }
    }, boost.nodes);
    if (best) return best.list;
  }
  for (let k = pieces.length; k > 0; k--) {
    const got = pack(w, h, pieces.slice(0, k));
    if (got) return got;
  }
  return [];
}

/**
 * Every in-bounds placement of every booster shape, priced once per layout:
 * its cells and the cells edge-adjacent to it, as board indices.
 */
function boosterSpots(w, h, defs) {
  const spots = [];
  for (const d of defs) {
    if (d.type !== BOOSTER_TYPE) continue;
    const seen = new Set();
    for (let rotation = 0; rotation < 4; rotation++) {
      const c = cells(d.shape, rotation);
      const key = JSON.stringify(c);
      if (seen.has(key)) continue;
      seen.add(key);
      for (let y = 0; y + boxH(d.shape, rotation) <= h; y++) {
        for (let x = 0; x + boxW(d.shape, rotation) <= w; x++) {
          const own = c.map(([cx, cy]) => (y + cy) * w + x + cx);
          const mine = new Set(own);
          const near = new Set();
          for (const i of own) {
            const [ix, iy] = [i % w, Math.floor(i / w)];
            for (const [nx, ny] of [[ix - 1, iy], [ix + 1, iy], [ix, iy - 1], [ix, iy + 1]]) {
              const n = ny * w + nx;
              if (nx >= 0 && ny >= 0 && nx < w && ny < h && !mine.has(n)) near.add(n);
            }
          }
          spots.push({ x, y, rotation, id: d.id, own, near: [...near] });
        }
      }
    }
  }
  return spots;
}

/**
 * Boosters for one packing, greedily: the spot whose touched pieces weigh the
 * most, among spots touching at least `minTouch` weighted pieces, until none
 * qualifies. A booster multiplies the power of each DISTINCT non-booster it
 * touches by 1.1 (StaneksGift.effect), so a piece touched by two counts twice.
 * Fewer than minTouch and the cells are worth more to a FILL_ORDER piece.
 *
 * @returns {{score: number, list: {x, y, rotation, id}[]}}
 */
function boostersFor(w, h, defs, core, spots, weights, minTouch) {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const owner = new Array(w * h).fill(-1);
  core.forEach((p, k) => {
    for (const [cx, cy] of cells(byId.get(p.id).shape, p.rotation)) owner[(p.y + cy) * w + p.x + cx] = k;
  });
  const list = [];
  let score = 0;
  for (;;) {
    let best = null;
    for (const s of spots) {
      if (s.own.some((i) => owner[i] !== -1)) continue;
      const touched = new Set();
      for (const n of s.near) if (owner[n] >= 0 && (weights[core[owner[n]].id] ?? 0) > 0) touched.add(owner[n]);
      if (touched.size < minTouch) continue;
      let gain = 0;
      for (const k of touched) gain += weights[core[k].id];
      if (!best || gain > best.gain) best = { s, gain };
    }
    if (!best) return { score, list };
    for (const i of best.s.own) owner[i] = -2;
    list.push({ x: best.s.x, y: best.s.y, rotation: best.s.rotation, id: best.s.id });
    score += best.gain;
  }
}

function piecesOf(defs, ids) {
  const byId = new Map(defs.map((d) => [d.id, d]));
  return ids
    .map((id) => byId.get(id))
    .filter((d) => d && d.type !== BOOSTER_TYPE)
    .map((d) => ({ id: d.id, size: cells(d.shape, 0).length, orients: orientations(d.shape) }));
}

/**
 * More fragments for a board that already has some: each id of `ids` not on it
 * yet, in order, goes into the free cells if it fits there, and is skipped if
 * not - so the order reads "first that fits". Add-only: nothing placed is
 * moved, which is what lets this run on a hand layout too.
 *
 * ponytail: greedy, one piece at a time against the cells left - a repack of
 * the whole board could fit a piece this misses. Add when a board shows it.
 *
 * @param {{id: number, x: number, y: number, rotation: number}[]} placed on the board now
 * @returns {{x, y, rotation, id}[]} the new pieces only
 */
export function fill(w, h, defs, placed, ids) {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const busy = new Array(w * h).fill(false);
  const mark = (p) => {
    for (const [cx, cy] of cells(byId.get(p.id).shape, p.rotation)) {
      const x = p.x + cx;
      const y = p.y + cy;
      if (x >= 0 && y >= 0 && x < w && y < h) busy[y * w + x] = true;
    }
  };
  // A hand-placed id this fork does not define is skipped, not guessed at:
  // its cells stay "free" here and the game refuses an overlapping place.
  for (const p of placed) if (byId.has(p.id)) mark(p);
  const have = new Set(placed.map((p) => p.id));
  const out = [];
  for (const piece of piecesOf(defs, ids.filter((id) => !have.has(id)))) {
    const got = pack(w, h, [piece], busy);
    if (!got) continue;
    out.push(got[0]);
    mark(got[0]);
  }
  return out;
}

/**
 * The host for the charge worker: the largest (ties to the lower name), but the
 * one already running it is kept until the largest would give RELAUNCH_RATIO
 * times its capped size. That is the same bar chargePlan restarts on, and it
 * has to be: switch on a smaller gain and the reserve drains a host the worker
 * never moves to, for good. It also stops two 1 PB servers trading the worker.
 * Moving costs nothing earned: highestCharge and numCharge live in the game.
 *
 * @param {{host: string, maxRam: number}[]} hosts rooted, home and hacknet already out
 * @param {string|null} current where the worker runs now
 * @returns {string|null}
 */
export function pickHost(hosts, current, maxGb) {
  const fit = hosts.filter((h) => h.maxRam >= CHARGE_GB);
  if (!fit.length) return null;
  const best = fit.reduce((a, b) => (b.maxRam > a.maxRam || (b.maxRam === a.maxRam && b.host < a.host) ? b : a));
  const capped = (h) => Math.min(h.maxRam, maxGb);
  const here = fit.find((h) => h.host === current);
  return here && capped(here) * RELAUNCH_RATIO > capped(best) ? here.host : best.host;
}

/**
 * How many threads the charge worker should run, and whether to (re)start it.
 *
 * `want` is the whole host up to `maxGb`. What can actually START is less until
 * the manager has drained the host down to the reserve: its free RAM, plus what
 * a worker already ON it would hand back on kill. A worker elsewhere frees
 * nothing here, so a move waits until the new host has room for more.
 *
 * Restart when there is none and one fits, when it could run RELAUNCH_RATIO
 * times its threads, or when it holds more than is wanted now (stanek.maxGb
 * lowered). `threads` 0 with `act` means kill and start nothing.
 */
export function chargePlan({ hostMax, hostUsed, heldHere, heldThreads, maxGb }) {
  const want = Math.max(0, Math.floor(Math.min(hostMax, maxGb) / CHARGE_GB));
  const room = hostMax - hostUsed + heldHere * CHARGE_GB;
  const threads = Math.max(0, Math.min(want, Math.floor(room / CHARGE_GB)));
  const act = heldThreads > want ||
    (heldThreads === 0 ? threads > 0 : threads >= RELAUNCH_RATIO * heldThreads);
  return { want, threads, act };
}
