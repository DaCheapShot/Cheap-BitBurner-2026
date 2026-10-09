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
 */
function pack(w, h, pieces) {
  const spare = w * h - pieces.reduce((n, p) => n + p.size, 0);
  if (spare < 0) return null;
  const taken = new Array(w * h).fill(false);
  const used = new Array(pieces.length).fill(false);
  const out = [];

  const dfs = (pos, left, placed) => {
    if (placed === pieces.length) return true;
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
 * ponytail: no boosters, and drops from the END of the order rather than
 * searching subsets - add both when a board has room to spare.
 *
 * @param {number} w gift width
 * @param {number} h gift height
 * @param {{id: number, shape: boolean[][], type: number}[]} defs fragmentDefinitions()
 * @param {number[]} order fragment ids, most wanted first
 */
export function layout(w, h, defs, order) {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const pieces = order
    .map((id) => byId.get(id))
    .filter((d) => d && d.type !== BOOSTER_TYPE)
    .map((d) => ({ id: d.id, size: cells(d.shape, 0).length, orients: orientations(d.shape) }));
  for (let k = pieces.length; k > 0; k--) {
    const got = pack(w, h, pieces.slice(0, k));
    if (got) return got;
  }
  return [];
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
