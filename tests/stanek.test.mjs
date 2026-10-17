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
// Fragment.ts ids 101-107, the other boosters: 5 cells, limit 99, type 18.
const BOOSTERS = [
  [[X, X, X, X], [X, _, _, _]], [[_, X, X, X], [X, X, _, _]], [[X, X, X, _], [_, _, X, X]],
  [[_, X, X], [_, X, _], [X, X, _]], [[_, _, X], [_, X, X], [X, X, _]],
  [[X, _, _], [X, X, X], [X, _, _]], [[_, X, _], [X, X, X], [_, X, _]],
].map((shape, k) => ({ id: 101 + k, shape, type: 18 }));
const DEFS = [
  { id: 0, shape: SHAPES.S, type: 6 }, { id: 1, shape: SHAPES.Z, type: 6 },
  { id: 5, shape: SHAPES.T, type: 3 }, { id: 6, shape: SHAPES.I, type: 4 },
  { id: 7, shape: SHAPES.J, type: 5 }, { id: 25, shape: SHAPES.J, type: 14 },
  { id: 12, shape: SHAPES.L, type: 8 }, { id: 100, shape: SHAPES.B100, type: 18 },
  { id: 20, shape: SHAPES.I, type: 10 }, { id: 27, shape: SHAPES.J, type: 16 }, { id: 28, shape: SHAPES.L, type: 17 },
  ...BOOSTERS,
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
    clearGift: () => { need(); state.calls.push("clear"); state.placed = []; },
    placeFragment: (x, y, rotation, id) => {
      need();
      state.calls.push("place");
      // Fragment.limit: 1, boosters 99.
      if (DEFS.find((f) => f.id === id)?.type !== 18 && state.placed.some((p) => p.id === id)) return false;
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

/**
 * One stanek.js pass. `store` carries /data files between passes, as boot's
 * ticks do. `workers` lists every charge worker on the network afterwards, with
 * its host.
 */
async function pass(mods, { gift, store = {}, hosts = { home: 1024, "cloud-0": 256 }, procs = [], used = {} } = {}) {
  const ns = makeNs({ files: store, hosts, extra: { stanek: gift.api } });
  // The mock's exec does not charge RAM; `used` stands in for the manager's batches.
  const usedRam = ns.getServerUsedRam;
  ns.getServerUsedRam = (h) => used[h] ?? usedRam(h);
  for (const p of procs) ns.exec("scripts/stanek/charge.js", p.host, p.threads, ...p.args);
  await mods["stanek/stanek"].main(ns);
  const workers = Object.keys(hosts).flatMap((h) => ns.ps(h)).filter((p) => p.filename === "scripts/stanek/charge.js");
  return { ns, store, workers, status: store["/data/stanek.txt"] ?? "" };
}

const reserveOf = (r) => JSON.parse(r.store["/data/stanek-reserve.txt"] || "null");

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

  "chargePlan: the whole host up to maxGb, held to its free RAM, restarted only on a real gain": async () => {
    const { chargePlan } = (await loadScripts())["stanek/plan"];
    const base = { hostMax: 1024, hostUsed: 0, heldHere: 0, heldThreads: 0, maxGb: 65536 };
    let p = chargePlan(base);
    assert(p.want === 512 && p.threads === 512 && p.act, `fresh: ${JSON.stringify(p)}`);
    // 128 TB host, 64 TB cap: half of it.
    p = chargePlan({ ...base, hostMax: 131072 });
    assert(p.want === 32768 && p.threads === 32768, `capped: ${JSON.stringify(p)}`);
    // The manager has not drained the host yet: only what is free.
    p = chargePlan({ ...base, hostUsed: 1024 - 20 });
    assert(p.threads === 10 && p.act, `squeezed: ${JSON.stringify(p)}`);
    // Running 100 here; the kill would hand back 200 GB. 14 more GB free is 107 < 150.
    p = chargePlan({ ...base, hostUsed: 1024 - 14, heldHere: 100, heldThreads: 100 });
    assert(p.threads === 107 && !p.act, `small gain: ${JSON.stringify(p)}`);
    // A worker on ANOTHER host frees nothing here: the move waits for room.
    p = chargePlan({ ...base, hostUsed: 1024 - 200, heldThreads: 100 });
    assert(p.threads === 100 && !p.act, `move waits: ${JSON.stringify(p)}`);
    p = chargePlan({ ...base, hostUsed: 1024 - 300, heldThreads: 100 });
    assert(p.threads === 150 && p.act, `move goes: ${JSON.stringify(p)}`);
    // stanek.maxGb lowered under what runs: shrink.
    p = chargePlan({ ...base, maxGb: 256, heldHere: 512, heldThreads: 512 });
    assert(p.want === 128 && p.act, `shrink: ${JSON.stringify(p)}`);
  },

  "pickHost: the largest, kept until another would be 1.5x its capped size": async () => {
    const { pickHost } = (await loadScripts())["stanek/plan"];
    const hs = (o) => Object.entries(o).map(([host, maxRam]) => ({ host, maxRam }));
    assert(pickHost(hs({ a: 64, b: 256 }), null, 65536) === "b", "largest");
    assert(pickHost(hs({ b: 256, a: 256 }), null, 65536) === "a", "ties to the lower name");
    assert(pickHost(hs({ a: 256, b: 300 }), "a", 65536) === "a", "a small gain does not move it");
    assert(pickHost(hs({ a: 256, b: 384 }), "a", 65536) === "b", "1.5x does");
    // Both past the cap: equal once capped, so the worker stays.
    assert(pickHost(hs({ a: 131072, b: 1048576 }), "a", 65536) === "a", "capped hosts are equal");
    assert(pickHost(hs({ a: 1 }), null, 65536) === null, "nothing can hold one thread");
    assert(pickHost([], null, 65536) === null, "no host");
  },

  // The manager reads this every rescan; a mangled file must reserve nothing.
  "stanekReserve: the host, and want minus held there; nothing for what it cannot read": async () => {
    const { stanekReserve } = (await loadScripts())["config"];
    const r = (t) => JSON.stringify(stanekReserve(t));
    assert(r('{"host":"c","want":256,"held":64}') === '{"host":"c","gb":192}', "want - held");
    // gb 0, host kept: boot needs it to find the worker it is switching off.
    assert(r('{"host":"c","want":256,"held":256}') === '{"host":"c","gb":0}', "a full worker holds its own RAM");
    assert(r('{"host":"c","want":64,"held":128}') === '{"host":"c","gb":0}', "never negative");
    for (const t of ["", "garbage", "[]", '{"want":256}', '{"host":"","want":256}', null]) {
      assert(r(t) === '{"host":null,"gb":0}', `${JSON.stringify(t)} must reserve nothing`);
    }
  },

  // --------------------------------------------------------------- a pass ---

  "a fresh node: accept, lay out the empty board, start one worker off home, publish the reserve": async () => {
    const mods = await loadScripts();
    const gift = giftApi();
    const r = await pass(mods, { gift });
    assert(gift.installed, "the gift must be accepted");
    assert(gift.placed.length === 7, `placed ${gift.placed.length}`);
    assert(r.workers.length === 1 && r.workers[0].host === "cloud-0" && r.workers[0].threads === 128,
      `workers ${JSON.stringify(r.workers)}`);
    // Boosters cannot be charged - the game throws on one.
    const roots = gift.placed.filter((p) => p.id < 100).flatMap((p) => [p.x, p.y]).map(String).join(",");
    assert(r.workers[0].args.map(String).join(",") === roots, "the worker must charge every placed root");
    assert(JSON.stringify(reserveOf(r)) === JSON.stringify({ host: "cloud-0", want: 256, held: 256 }),
      JSON.stringify(reserveOf(r)));
    assert(r.status.includes("accepted"), r.status);
  },

  // The cores stay with the batcher: a huge home is never chosen.
  "never home, however large; and nothing at all while home is the only host": async () => {
    const mods = await loadScripts();
    let r = await pass(mods, { gift: giftApi(), hosts: { home: 2 ** 20, n00dles: 4 } });
    assert(r.workers.length === 1 && r.workers[0].host === "n00dles" && r.workers[0].threads === 2,
      `workers ${JSON.stringify(r.workers)}`);
    r = await pass(mods, { gift: giftApi(), hosts: { home: 2 ** 20 } });
    assert(r.workers.length === 0, "no worker on home");
    assert((r.store["/data/stanek-reserve.txt"] ?? "") === "", "nothing reserved");
    assert(r.status.includes("waiting"), r.status);
  },

  // The live BN13 start: foodnstuff full of batches, the worker silently at 0.
  "a host the manager still fills: no worker, the whole host reserved, and the status says why": async () => {
    const mods = await loadScripts();
    const r = await pass(mods, { gift: giftApi(), used: { "cloud-0": 255 } });
    assert(r.workers.length === 0, `workers ${JSON.stringify(r.workers)}`);
    assert(JSON.stringify(reserveOf(r)) === JSON.stringify({ host: "cloud-0", want: 256, held: 0 }),
      JSON.stringify(reserveOf(r)));
    assert(r.status.includes("waiting for the manager to drain cloud-0"), r.status);
  },

  "the whole host up to 64 TB": async () => {
    const mods = await loadScripts();
    const r = await pass(mods, { gift: giftApi(), hosts: { home: 1024, "cloud-0": 131072 } });
    assert(r.workers[0].threads === 32768, `threads ${r.workers[0].threads}`);
    assert(reserveOf(r).want === 65536, JSON.stringify(reserveOf(r)));
  },

  // A bigger cloud server: the worker moves, once, and nothing is left behind.
  "a much larger host appears: the worker moves to it": async () => {
    const mods = await loadScripts();
    const gift = giftApi();
    const first = await pass(mods, { gift });
    const w = first.workers[0];
    const procs = [{ host: "cloud-0", threads: w.threads, args: w.args }];
    let r = await pass(mods, { gift, store: { ...first.store }, hosts: { home: 1024, "cloud-0": 256, "cloud-1": 300 }, procs });
    assert(r.workers.length === 1 && r.workers[0].host === "cloud-0", `a small gain moved it: ${JSON.stringify(r.workers)}`);
    r = await pass(mods, { gift, store: { ...first.store }, hosts: { home: 1024, "cloud-0": 256, "cloud-1": 1024 }, procs });
    assert(r.workers.length === 1 && r.workers[0].host === "cloud-1" && r.workers[0].threads === 512,
      `workers ${JSON.stringify(r.workers)}`);
    assert(reserveOf(r).host === "cloud-1", JSON.stringify(reserveOf(r)));
  },

  // acceptGift refuses once any aug but NeuroFlux is installed or queued, and
  // nothing else in the API works without it - so the pass stops, and says why.
  "an aug already owned: the gift is refused, nothing runs, nothing is reserved": async () => {
    const mods = await loadScripts();
    const gift = giftApi({ augs: true });
    const r = await pass(mods, { gift, store: { "/data/stanek-reserve.txt": '{"host":"cloud-0","want":256,"held":0}' } });
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
    const r = await pass(mods, { gift, store: first.store, procs: [{ host: "cloud-0", threads: w.threads, args: w.args }] });
    assert(!gift.calls.includes("accept") && !gift.calls.includes("place"), `calls ${gift.calls}`);
    assert(r.workers.length === 1 && r.workers[0].pid === 1, "the running worker is kept, not restarted");
  },

  "stanek.relayout off: a hand board is not touched at all": async () => {
    const mods = await loadScripts();
    const gift = giftApi({ installed: true, placed: [{ x: 2, y: 2, rotation: 1, id: 12 }] });
    const r = await pass(mods, { gift, store: { "/data/settings.txt": '{"stanek.relayout":0}' } });
    assert(!gift.calls.includes("place") && !gift.calls.includes("clear"), `calls ${gift.calls}`);
    assert(r.workers[0].args.map(String).join(",") === "2,2", `charges ${r.workers[0].args}`);
  },

  // The live BN13.1 board before boosters: six core + the hacknet filler. A
  // booster on the Hacking pieces scores higher, so the board is replaced.
  "a laid-out board that scores lower is cleared and relaid, once": async () => {
    const mods = await loadScripts();
    const { layout, fill } = mods["stanek/plan"];
    const { FRAGMENT_ORDER, FILL_ORDER } = mods["stanek/config"];
    const old = layout(6, 5, DEFS, FRAGMENT_ORDER);
    const placed = [...old, ...fill(6, 5, DEFS, old, FILL_ORDER)];
    assert(placed.length === 7, `fixture: ${JSON.stringify(placed)}`);
    const gift = giftApi({ installed: true, placed });
    const first = await pass(mods, { gift });
    assert(gift.calls.includes("clear"), `calls ${gift.calls}`);
    const ids = gift.placed.map((p) => p.id);
    assert(FRAGMENT_ORDER.every((id) => ids.includes(id)) && ids.some((id) => id >= 100), `relaid: ${ids}`);
    const roots = gift.placed.filter((p) => p.id < 100).flatMap((p) => [p.x, p.y]).map(String).join(",");
    assert(first.workers.length === 1 && first.workers[0].args.map(String).join(",") === roots,
      `worker ${JSON.stringify(first.workers)}`);
    assert(first.status.includes("relaying"), first.status);
    // Next tick: the board is the best one and remembered - no search, no place.
    gift.calls.length = 0;
    const w = first.workers[0];
    await pass(mods, { gift, store: { ...first.store }, procs: [{ host: w.host, threads: w.threads, args: w.args }] });
    assert(!gift.calls.includes("place") && !gift.calls.includes("clear"), `second pass: ${gift.calls}`);
  },

  "scoreBoard: all core first, then booster weight touched, then fillers": async () => {
    const mods = await loadScripts();
    const { scoreBoard, layout, fill } = mods["stanek/plan"];
    const { FRAGMENT_ORDER, FILL_ORDER, BOOST_WEIGHTS, BOOST_MIN_TOUCH } = mods["stanek/config"];
    const s = (p) => scoreBoard(6, 5, DEFS, p, FRAGMENT_ORDER, BOOST_WEIGHTS);
    const plain = layout(6, 5, DEFS, FRAGMENT_ORDER);
    const filled = [...plain, ...fill(6, 5, DEFS, plain, FILL_ORDER)];
    const boosted = layout(6, 5, DEFS, FRAGMENT_ORDER, { weights: BOOST_WEIGHTS, minTouch: BOOST_MIN_TOUCH, nodes: 5e4 });
    assert(s(boosted) > s(filled) && s(filled) > s(plain), `${s(boosted)} ${s(filled)} ${s(plain)}`);
    assert(s(plain.slice(1)) < s(plain), "a missing core piece must cost more than any booster");
    assert(s(boosted) % 1e6 >= 13e3, `booster score ${s(boosted)}`);
  },

  // Six tetrominoes leave 6 cells on BN13.1's 6x5 and 12 on BN13.2's 6x6:
  // one booster, then two, each touching 2+ of the six - the user's rule.
  "a fresh board: all six, then boosters that touch 2+ of them": async () => {
    const mods = await loadScripts();
    const { FRAGMENT_ORDER } = mods["stanek/config"];
    for (const [w, h, n] of [[6, 5, 1], [6, 6, 2]]) {
      const gift = giftApi({ w, h });
      await pass(mods, { gift });
      const ids = gift.placed.map((p) => p.id);
      assert(FRAGMENT_ORDER.every((id) => ids.includes(id)), `${w}x${h} core missing: ${ids}`);
      const boosters = gift.placed.filter((p) => p.id >= 100);
      assert(boosters.length === n, `${w}x${h} boosters: ${ids}`);
      const all = covered(gift.placed);
      assert(new Set(all.map(String)).size === all.length, `${w}x${h} overlap`);
      const core = gift.placed.filter((p) => FRAGMENT_ORDER.includes(p.id));
      for (const b of boosters) {
        const mine = covered([b]);
        const touched = core.filter((c) => covered([c]).some(([x, y]) =>
          mine.some(([bx, by]) => Math.abs(bx - x) + Math.abs(by - y) === 1)));
        assert(touched.length >= 2, `${w}x${h} booster ${JSON.stringify(b)} touches ${touched.length}`);
      }
    }
  },

  // One core piece can never give a booster its second neighbour.
  "layout: no booster that touches fewer than BOOST_MIN_TOUCH pieces": async () => {
    const mods = await loadScripts();
    const { layout } = mods["stanek/plan"];
    const boost = { weights: { 6: 2 }, minTouch: 2, nodes: 1e4 };
    const got = layout(4, 4, DEFS, [6], boost);
    assert(got.length === 1 && got[0].id === 6, `got ${JSON.stringify(got)}`);
  },

  "fill never places a booster": async () => {
    const { fill } = (await loadScripts())["stanek/plan"];
    assert(fill(6, 6, DEFS, [], [100, 101]).length === 0, "booster from fill");
  },

  // The steady state again: a full board places nothing on the next pass.
  "a full board: no place call": async () => {
    const mods = await loadScripts();
    const gift = giftApi();
    const first = await pass(mods, { gift });
    gift.calls.length = 0;
    await pass(mods, { gift, store: { ...first.store } });
    assert(!gift.calls.includes("place"), `calls ${gift.calls}`);
  },

  "fill: first that fits, skips what is on the board, never two in one spot": async () => {
    const { fill } = (await loadScripts())["stanek/plan"];
    // 3x2: an I fits in no rotation, the L does.
    let got = fill(3, 2, DEFS, [], [20, 28, 27]);
    assert(got.length === 1 && got[0].id === 28, `got ${JSON.stringify(got)}`);
    // 4x2, id 20 already along the top: 20 is skipped, the L cannot fit the 4x1
    // row left, and the other I (6) can.
    got = fill(4, 2, DEFS, [{ id: 20, x: 0, y: 0, rotation: 0 }], [20, 28, 6]);
    assert(got.length === 1 && got[0].id === 6 && got[0].y === 1, `got ${JSON.stringify(got)}`);
    const all = covered([{ id: 20, x: 0, y: 0, rotation: 0 }, ...got]);
    assert(new Set(all.map(String)).size === all.length, "overlap");
  },

  // No terminal output - the sleeve pass's rule. boot carries the status.
  "the pass prints nothing to the terminal": async () => {
    const mods = await loadScripts();
    const r = await pass(mods, { gift: giftApi() });
    assert(!r.ns._log.some((l) => l.startsWith("[T] ")), "tprint from stanek.js");
  },
};
