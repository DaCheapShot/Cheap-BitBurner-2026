import { CHARGE_WORKER, CHARGE_GB, STATUS_FILE, FRAGMENT_ORDER, FRAGMENT_NAMES, BOOSTER_TYPE } from "./config.js";
import { layout, chargePlan } from "./plan.js";
import { rpc } from "scripts/rpc.js";
import { SETTINGS_FILE, setting } from "scripts/settings.js";
import { HOME_RESERVE_GB, STANEK_RESERVE_FILE } from "scripts/config.js";

/**
 * Stanek's Gift: ONE pass, then exit. boot.js runs it every tick, and only
 * where the gift can exist - BitNode 13 or Source-File 13, asked once by boot.
 *
 * Each pass:
 *   1. read the board; if the gift is not installed, accept it. acceptGift
 *      refuses once ANY aug but NeuroFlux is installed or queued, so this has to
 *      win the race with sing's first aug batch - boot runs it before sing. And
 *      outside BN13 the first install without the gift BANS the Church for the
 *      node (Prestige.ts), so there is no second chance there either.
 *   2. an EMPTY board is laid out (plan.js layout) and placed. A board with
 *      anything on it is left alone - a hand layout is never overwritten. An
 *      install keeps the board and clears the charges; a new BitNode clears both.
 *   3. the charge worker: one process on home, sized at stanek.fraction of home,
 *      restarted when it could run RELAUNCH_RATIO x its threads. Then
 *      STANEK_RESERVE_FILE tells the continuous manager how much of home to
 *      leave free for it next rescan.
 *
 * NOTHING GOES TO THE TERMINAL. STATUS_FILE is overwritten every pass, and boot
 * copies it into its own log when it changes.
 *
 * Usage:  run scripts/stanek/stanek.js     (boot does this; --no-stanek opts out)
 *         cat /data/stanek.txt
 *
 * RAM: 1.60 base + run 1.00 + kill 0.50 + ps 0.20 + getServerMaxRam 0.05
 *      + getServerUsedRam 0.05 = 3.40 GB
 */

// ------------------------------------------------------------------ bodies ---
//
// Plain template literals: rpc() rejects interpolation, and tests/rpc.test.mjs
// parses every one. tests/ram.test.mjs prices every one.

/** True once the gift is installed and the Church joined - also when it already was. */
const ACCEPT = `return ns.stanek.acceptGift();`;

/**
 * The board and the fragment shapes. Throws "Stanek's Gift is not installed"
 * before ACCEPT. Only plain fields cross: chargedEffect is the multiplier the
 * fragment gives now, boosters included.
 */
const READ = `
const defs = ns.stanek.fragmentDefinitions().map((d) => ({ id: d.id, shape: d.shape, type: d.type }));
const placed = ns.stanek.activeFragments().map((f) => ({
  id: f.id, x: f.x, y: f.y, type: f.type,
  highestCharge: f.highestCharge, numCharge: f.numCharge, effect: f.chargedEffect,
}));
return { w: ns.stanek.giftWidth(), h: ns.stanek.giftHeight(), defs, placed };
`;

/** [[x, y, rotation, id], ...] -> how many the game accepted. */
const PLACE = `
let n = 0;
for (const [x, y, r, id] of JSON.parse(args[0])) {
  try { if (ns.stanek.placeFragment(x, y, r, id)) n++; } catch (e) {}
}
return n;
`;

// -------------------------------------------------------------------- main ---

const normPath = (p) => String(p).replace(/^\/+/, "");

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const lines = [];
  const finish = () => {
    for (const l of lines) ns.print(l);
    ns.write(STATUS_FILE, lines.join("\n") + "\n", "w");
  };
  const reserve = (wantGb, heldGb) => {
    const text = wantGb > 0 ? JSON.stringify({ want: wantGb, held: heldGb }) : "";
    if (ns.read(STANEK_RESERVE_FILE) !== text) ns.write(STANEK_RESERVE_FILE, text, "w");
  };
  const read = async () => {
    try { return await rpc(ns, READ); } catch (e) { return { error: String(e?.message ?? e) }; }
  };

  let board = await read();
  if (board.error?.includes("not installed")) {
    let ok = false;
    try { ok = await rpc(ns, ACCEPT); } catch (e) { lines.push(`WARN: accept failed - ${String(e?.message ?? e)}`); }
    if (!ok) {
      lines.push("gift not accepted - acceptGift refuses once any aug but NeuroFlux is installed or queued");
      reserve(0, 0);
      return finish();
    }
    lines.push("accepted Stanek's Gift - joined the Church of the Machine God");
    board = await read();
  }
  // No RAM for the body, most likely. The reserve is left as it is: one missed
  // pass must not hand the worker's RAM to the manager and take it back next tick.
  if (board.error) {
    lines.push(`WARN: could not read the gift - ${board.error}`);
    return finish();
  }

  if (!board.placed.length) {
    const want = layout(board.w, board.h, board.defs, FRAGMENT_ORDER);
    let n = 0;
    try { n = await rpc(ns, PLACE, JSON.stringify(want.map((p) => [p.x, p.y, p.rotation, p.id]))); }
    catch (e) { lines.push(`WARN: place failed - ${String(e?.message ?? e)}`); }
    lines.push(`placed ${n} of ${want.length} fragments on the empty ${board.w}x${board.h} board`);
    board = await read();
    if (board.error) {
      lines.push(`WARN: could not re-read the gift - ${board.error}`);
      return finish();
    }
  }

  // Boosters cannot be charged - chargeFragment throws on one.
  const roots = board.placed.filter((f) => f.type !== BOOSTER_TYPE);
  const argv = roots.flatMap((f) => [f.x, f.y]);
  const workers = ns.ps("home").filter((p) => normPath(p.filename) === normPath(CHARGE_WORKER));
  const heldThreads = workers.reduce((n, p) => n + p.threads, 0);
  // A board changed by hand, or a stray second copy: the worker charging the
  // wrong roots throws on the first missing one and dies anyway.
  const stale = workers.length > 1 ||
    (workers.length === 1 && workers[0].args.map(String).join(",") !== argv.map(String).join(","));
  const plan = chargePlan({
    homeMax: ns.getServerMaxRam("home"), used: ns.getServerUsedRam("home"), heldThreads,
    fraction: setting(ns.read(SETTINGS_FILE), "stanek.fraction"), keepGb: HOME_RESERVE_GB,
  });

  let held = heldThreads;
  if (!roots.length || plan.act || stale) {
    // Kill and run with NO await between: the manager is another script, and
    // it cannot be scheduled in the middle of a synchronous stretch, so the RAM
    // the kill frees cannot be dispatched into before the run takes it.
    for (const p of workers) ns.kill(p.pid);
    held = 0;
    if (roots.length && plan.threads > 0) {
      if (ns.run(CHARGE_WORKER, plan.threads, ...argv)) held = plan.threads;
      else lines.push(`WARN: could not start the charge worker at ${plan.threads} threads`);
    }
  }
  reserve(plan.want * CHARGE_GB, held * CHARGE_GB);

  const gb = (t) => ns.format.ram(t * CHARGE_GB);
  lines.push(`board ${board.w}x${board.h}, ${roots.length} fragment(s) charging; ` +
    `worker (${held} of ${plan.want} threads, ${gb(held)} of ${gb(plan.want)})`);
  for (const f of board.placed) {
    const name = FRAGMENT_NAMES[f.id] ?? `#${f.id}`;
    lines.push(`  ${name} @${f.x},${f.y} (${f.type === BOOSTER_TYPE ? "booster" :
      `+${ns.format.percent(f.effect - 1, 1)}, highest ${ns.format.number(f.highestCharge, 1)}, ` +
      `num ${ns.format.number(f.numCharge, 1)}`})`);
  }
  finish();
}
