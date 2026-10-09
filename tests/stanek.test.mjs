import { loadScripts, assert } from "./harness.mjs";
import { makeNs } from "./mockNs.mjs";

/**
 * Stanek's Gift. RAM pins live in tests/ram.test.mjs; this is behaviour: the
 * layout math in stanek/plan.js, the reserve parser the manager reads, and
 * whole stanek.js passes against a fake ns.stanek that refuses and collides the
 * way src/CotMG does - with every rpc body really executed by the mock's run.
 */

const _ = false;
const X = true;
// src/CotMG/data/Shapes.ts and Fragment.ts, as BN13.1 defines them.
const SHAPES = {
  S: [[_, X, X], [X, X, _]], Z: [[X, X, _], [_, X, X]], T: [[X, X, X], [_, X, _]],
  I: [[X, X, X, X]], J: [[X, _, _], [X, X, X]], L: [[_, _, X], [X, X, X]],
  B100: [[_, X, X], [X, X, _], [_, X, _]],
};
const DEFS = [
  { id: 0, shape: SHAPES.S, type: 6 }, { id: 1, shape: SHAPES.Z, type: 6 },
  { id: 5, shape: SHAPES.T, type: 3 }, { id: 6, shape: SHAPES.I, type: 4 },
  { id: 7, shape: SHAPES.J, type: 5 }, { id: 25, shape: SHAPES.J, type: 14 },
  { id: 12, shape: SHAPES.L, type: 8 }, { id: 100, shape: SHAPES.B100, type: 18 },
];

/**
 * Rotation, derived a second time and differently: the game's fullAt reads
 * rotation k as k quarter-turns CLOCKWISE (rotation 1: shape[w-1-x][y]).
 * Turning the matrix here, rather than reusing plan.js's fullAt, is what makes
 * this a check on the transcription and not a copy of it.
 */
const turn = (m) => m[0].map((_c, x) => m.map((row) => row[x]).reverse());
function filled(shape, rotation) {
  let m = shape;
  for (let k = 0; k < rotation; k++) m = turn(m);
  const out = [];
  m.forEach((row, y) => row.forEach((v, x) => v && out.push([x, y])));
  return out;
}

/** Board cells a placement covers, from the independent rotation above. */
function covered(placements, defs = DEFS) {
  const out = [];
  for (const p of placements) {
    const d = defs.find((f) => f.id === p.id);
    for (const [x, y] of filled(d.shape, p.rotation)) out.push([p.x + x, p.y + y]);
  }
  return out;
}

/**
 * A fake ns.stanek. Throws until accepted, as checkStanekAPIAccess does;
 * acceptGift refuses while any non-NeuroFlux aug is owned
 * (canAcceptStaneksGift) but still answers true once the gift is in; place
 * refuses out of bounds, over the limit and on collision (StaneksGift.canPlace).
 */
function giftApi({ installed = false, augs = false, w = 6, h = 5, placed = [] } = {}) {
  const state = { installed, placed: placed.map((p) => ({ highestCharge: 0, numCharge: 0, ...p })), calls: [] };
  const need = () => { if (!state.installed) throw new Error("stanek.giftWidth: Stanek's Gift is not installed"); };
  const occupied = () => new Set(covered(state.placed).map(([x, y]) => `${x},${y}`));
  state.api = {
    acceptGift: () => { state.calls.push("accept"); if (!augs) state.installed = true; return state.installed; },
    giftWidth: () => (need(), w),
    giftHeight: () => (need(), h),
    fragmentDefinitions: () => (need(), DEFS.map((d) => ({ ...d }))),
    activeFragments: () => (need(), state.placed.map((p) => {
      const d = DEFS.find((f) => f.id === p.id);
      return { ...p, type: d.type, chargedEffect: 1 + Math.log(p.highestCharge + 1) / 60 };
    })),
    placeFragment: (x, y, rotation, id) => {
      need();
      state.calls.push("place");
      if (state.placed.some((p) => p.id === id)) return false;
      const p = { x, y, rotation, id };
      const busy = occupied();
      const cellsOf = covered([p]);
      if (cellsOf.some(([cx, cy]) => cx < 0 || cy < 0 || cx >= w || cy >= h || busy.has(`${cx},${cy}`))) return false;
      state.placed.push({ ...p, highestCharge: 0, numCharge: 0 });
      return true;
    },
  };
  return state;
}

/** One stanek.js pass. `store` carries /data files between passes, as boot's ticks do. */
async function pass(mods, { gift, store = {}, home = 1024, procs = [] } = {}) {
  const ns = makeNs({ files: store, hosts: { home }, extra: { stanek: gift.api } });
  for (const p of procs) ns.exec(p.file, "home", p.threads, ...p.args);
  await mods["stanek/stanek"].main(ns);
  const workers = ns.ps("home").filter((p) => p.filename === "scripts/stanek/charge.js");
  return { ns, store, workers, status: store["/data/stanek.txt"] ?? "" };
}

export const tests = {
  // ------------------------------------------------------------- the math ---

  "cells is Fragment.fullAt: rotation k turns the shape k quarters clockwise": async () => {
    const { cells } = (await loadScripts())["stanek/plan"];
    for (const [name, shape] of Object.entries(SHAPES)) {
      for (let r = 0; r < 4; r++) {
        const got = JSON.stringify(cells(shape, r).sort());
        const want = JSON.stringify(filled(shape, r).sort());
        assert(got === want, `${name} rotation ${r}: ${got} vs ${want}`);
      }
    }
  },

  // The BN13.1 board: 9 + StaneksGiftExtraSize 1 + SF13 0 = 10, so 6 wide, 5 tall.
  "layout fits all six hacking-first fragments on the BN13.1 board, legally": async () => {
    const mods = await loadScripts();
    const { layout } = mods["stanek/plan"];
    const { FRAGMENT_ORDER } = mods["stanek/config"];
    const got = layout(6, 5, DEFS, FRAGMENT_ORDER);
    assert(JSON.stringify(got.map((p) => p.id).sort((a, b) => a - b)) === JSON.stringify([...FRAGMENT_ORDER].sort((a, b) => a - b)),
      `placed ${got.map((p) => p.id)}`);
    const all = covered(got);
    assert(new Set(all.map(String)).size === all.length, "two fragments overlap");
    assert(all.every(([x, y]) => x >= 0 && y >= 0 && x < 6 && y < 5), "a fragment leaves the board");
  },

  // Drops from the END of the order: the most wanted fragments survive.
  "layout keeps the most wanted prefix when the board is short": async () => {
    const { layout } = (await loadScripts())["stanek/plan"];
    const got = layout(3, 2, DEFS, [0, 1, 5]);
    assert(got.length === 1 && got[0].id === 0, `got ${JSON.stringify(got)}`);
    assert(layout(2, 2, DEFS, [6]).length === 0, "an I does not fit a 2x2 board in any rotation");
  },

  "layout skips boosters and ids the game does not define": async () => {
    const { layout } = (await loadScripts())["stanek/plan"];
    const got = layout(6, 5, DEFS, [100, 999, 0]);
    assert(got.length === 1 && got[0].id === 0, `got ${JSON.stringify(got)}`);
  },

  "chargePlan: sized at the fraction, held to what home can spare, restarted only on a real gain": async () => {
    const { chargePlan } = (await loadScripts())["stanek/plan"];
    const base = { homeMax: 1024, used: 0, heldThreads: 0, fraction: 0.25, keepGb: 32 };
    let p = chargePlan(base);
    assert(p.want === 128 && p.threads === 128 && p.act, `fresh: ${JSON.stringify(p)}`);
    // The manager has not drained home yet: only what is free above the keep.
    p = chargePlan({ ...base, used: 1024 - 32 - 20 });
    assert(p.threads === 10 && p.act, `squeezed: ${JSON.stringify(p)}`);
    // Running 100; the kill would hand back 200 GB. 14 more GB free is 107 < 150.
    p = chargePlan({ ...base, used: 1024 - 32 - 14, heldThreads: 100 });
    assert(p.threads === 107 && !p.act, `small gain: ${JSON.stringify(p)}`);
    p = chargePlan({ ...base, heldThreads: 80 });
    assert(p.threads === 128 && p.act, `1.6x gain: ${JSON.stringify(p)}`);
    // stanek.fraction lowered under what runs: shrink.
    p = chargePlan({ ...base, fraction: 0.1, heldThreads: 128 });
    assert(p.want === 51 && p.act, `shrink: ${JSON.stringify(p)}`);
  },

  // The manager reads this every rescan; a mangled file must reserve nothing.
  "stanekReserveGb: want minus held, and 0 for anything it cannot read": async () => {
    const { stanekReserveGb } = (await loadScripts())["config"];
    assert(stanekReserveGb('{"want":256,"held":64}') === 192, "want - held");
    assert(stanekReserveGb('{"want":256,"held":256}') === 0, "a full worker holds its own RAM");
    assert(stanekReserveGb('{"want":64,"held":128}') === 0, "never negative");
    for (const t of ["", "garbage", "[]", '{"want":"x"}', null]) {
      assert(stanekReserveGb(t) === 0, `${JSON.stringify(t)} must reserve nothing`);
    }
  },

  // --------------------------------------------------------------- a pass ---

  "a fresh node: accept, lay out the empty board, start one worker, publish the reserve": async () => {
    const mods = await loadScripts();
    const gift = giftApi();
    const r = await pass(mods, { gift });
    assert(gift.installed, "the gift must be accepted");
    assert(gift.placed.length === 6, `placed ${gift.placed.length}`);
    assert(r.workers.length === 1 && r.workers[0].threads === 128, `workers ${JSON.stringify(r.workers)}`);
    const roots = gift.placed.flatMap((p) => [p.x, p.y]).map(String).join(",");
    assert(r.workers[0].args.map(String).join(",") === roots, "the worker must charge every placed root");
    assert(r.store["/data/stanek-reserve.txt"] === JSON.stringify({ want: 256, held: 256 }), r.store["/data/stanek-reserve.txt"]);
    assert(r.status.includes("accepted"), r.status);
  },

  // acceptGift refuses once any aug but NeuroFlux is installed or queued, and
  // nothing else in the API works without it - so the pass stops, and says why.
  "an aug already owned: the gift is refused, nothing runs, nothing is reserved": async () => {
    const mods = await loadScripts();
    const gift = giftApi({ augs: true });
    const r = await pass(mods, { gift, store: { "/data/stanek-reserve.txt": '{"want":256,"held":0}' } });
    assert(r.workers.length === 0, "no worker without the gift");
    assert(r.store["/data/stanek-reserve.txt"] === "", "the reserve must be released");
    assert(r.status.includes("not accepted"), r.status);
  },

  // The steady state: every boot tick, nothing changes.
  "an installed gift with its worker running: no accept, no place, no restart": async () => {
    const mods = await loadScripts();
    const gift = giftApi();
    const first = await pass(mods, { gift });
    gift.calls.length = 0;
    const w = first.workers[0];
    const r = await pass(mods, { gift, store: first.store, procs: [{ file: "scripts/stanek/charge.js", threads: w.threads, args: w.args }] });
    assert(!gift.calls.includes("accept") && !gift.calls.includes("place"), `calls ${gift.calls}`);
    assert(r.workers.length === 1 && r.workers[0].threads === 128, "the running worker is kept");
  },

  "a hand-placed board is never re-laid": async () => {
    const mods = await loadScripts();
    const gift = giftApi({ installed: true, placed: [{ x: 2, y: 2, rotation: 1, id: 12 }] });
    const r = await pass(mods, { gift });
    assert(!gift.calls.includes("place"), "must not place on a board that has fragments");
    assert(r.workers[0].args.map(String).join(",") === "2,2", `charges ${r.workers[0].args}`);
  },

  // Home was upgraded: the worker is restarted at the new size, once.
  "home grew: the worker restarts at the new size": async () => {
    const mods = await loadScripts();
    const gift = giftApi();
    const first = await pass(mods, { gift });
    const w = first.workers[0];
    const r = await pass(mods, { gift, store: first.store, home: 4096, procs: [{ file: "scripts/stanek/charge.js", threads: w.threads, args: w.args }] });
    assert(r.workers.length === 1 && r.workers[0].threads === 512, `workers ${JSON.stringify(r.workers)}`);
  },

  // No terminal output - the sleeve pass's rule. boot carries the status.
  "the pass prints nothing to the terminal": async () => {
    const mods = await loadScripts();
    const r = await pass(mods, { gift: giftApi() });
    assert(!r.ns._log.some((l) => l.startsWith("[T] ")), "tprint from stanek.js");
  },
};
