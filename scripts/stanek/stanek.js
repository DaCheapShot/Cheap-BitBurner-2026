import { CHARGE_WORKER, CHARGE_GB, STATUS_FILE, FRAGMENT_ORDER, FILL_ORDER, FRAGMENT_NAMES, BOOSTER_TYPE,
         BOOST_WEIGHTS, BOOST_MIN_TOUCH, BOOST_SEARCH_NODES } from "./config.js";
import { layout, fill, chargePlan, pickHost } from "./plan.js";
import { rpc } from "scripts/rpc.js";
import { SETTINGS_FILE, setting } from "scripts/settings.js";
import { HACKNET_HOST_PREFIX, STANEK_RESERVE_FILE } from "scripts/config.js";

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
 *   2. an EMPTY board is laid out (plan.js layout: FRAGMENT_ORDER, then boosters
 *      where they touch 2+ of those pieces) and placed; then free cells
 *      take the first FILL_ORDER fragment that fits (plan.js fill) - on any
 *      board, hand layouts included. Add-only: nothing placed is ever moved or
 *      removed. An install keeps the board and clears the charges; a new
 *      BitNode clears both.
 *   3. the charge worker: one process on the largest host that is not home
 *      (pickHost - the cores stay with the batcher, see config.js), taking the
 *      whole of it up to stanek.maxGb, restarted when it could run
 *      RELAUNCH_RATIO x its threads. Then STANEK_RESERVE_FILE tells the
 *      continuous manager which host to leave free for it, and how much.
 *
 * NOTHING GOES TO THE TERMINAL. STATUS_FILE is overwritten every pass, and boot
 * copies it into its own log when it changes.
 *
 * Usage:  run scripts/stanek/stanek.js     (boot does this; --no-stanek opts out)
 *         cat /data/stanek.txt
 *
 * RAM: 1.60 base + run 1.00 (rpc) + exec 1.30 + scp 0.60 + kill 0.50 + ps 0.20
 *      + scan 0.20 + hasRootAccess 0.05 + getServerMaxRam 0.05
 *      + getServerUsedRam 0.05 = 5.55 GB
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
  id: f.id, x: f.x, y: f.y, rotation: f.rotation, type: f.type,
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

/**
 * Every rooted host but home and the hacknet, with its RAM and any charge
 * workers on it. The walk is boot's, copied for the same reason boot copies it:
 * importing the pool's would bill names this file does not use.
 */
function survey(ns) {
  const seen = new Set(["home"]);
  const queue = ["home"];
  for (let i = 0; i < queue.length; i++) {
    for (const h of ns.scan(queue[i])) if (!seen.has(h)) { seen.add(h); queue.push(h); }
  }
  const hosts = [];
  const workers = [];
  for (const host of queue) {
    for (const p of ns.ps(host)) if (normPath(p.filename) === normPath(CHARGE_WORKER)) workers.push({ ...p, host });
    if (host === "home" || host.startsWith(HACKNET_HOST_PREFIX) || !ns.hasRootAccess(host)) continue;
    hosts.push({ host, maxRam: ns.getServerMaxRam(host) });
  }
  return { hosts, workers };
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const lines = [];
  const finish = () => {
    for (const l of lines) ns.print(l);
    ns.write(STATUS_FILE, lines.join("\n") + "\n", "w");
  };
  const reserve = (host, wantGb, heldGb) => {
    const text = host && wantGb > 0 ? JSON.stringify({ host, want: wantGb, held: heldGb }) : "";
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
      reserve(null, 0, 0);
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

  // An empty board is laid out whole; then any free cells take the first of
  // FILL_ORDER (or a missing FRAGMENT_ORDER piece) that fits. Add-only: a
  // fragment already on the board is never moved.
  const base = board.placed.length ? [] : layout(board.w, board.h, board.defs, FRAGMENT_ORDER,
    { weights: BOOST_WEIGHTS, minTouch: BOOST_MIN_TOUCH, nodes: BOOST_SEARCH_NODES });
  const want = [...base, ...fill(board.w, board.h, board.defs, [...board.placed, ...base], [...FRAGMENT_ORDER, ...FILL_ORDER])];
  if (want.length) {
    let n = 0;
    try { n = await rpc(ns, PLACE, JSON.stringify(want.map((p) => [p.x, p.y, p.rotation, p.id]))); }
    catch (e) { lines.push(`WARN: place failed - ${String(e?.message ?? e)}`); }
    lines.push(`placed ${n} of ${want.length} fragments on the ${board.placed.length ? "" : "empty "}${board.w}x${board.h} board`);
    board = await read();
    if (board.error) {
      lines.push(`WARN: could not re-read the gift - ${board.error}`);
      return finish();
    }
  }

  // Boosters cannot be charged - chargeFragment throws on one.
  const roots = board.placed.filter((f) => f.type !== BOOSTER_TYPE);
  const argv = roots.flatMap((f) => [f.x, f.y]);
  const { hosts, workers } = survey(ns);
  const heldThreads = workers.reduce((n, p) => n + p.threads, 0);
  const maxGb = setting(ns.read(SETTINGS_FILE), "stanek.maxGb");
  const host = pickHost(hosts, workers.length === 1 ? workers[0].host : null, maxGb);
  if (!host) {
    lines.push("no rooted host but home to charge on yet - waiting");
    reserve(null, 0, 0);
    return finish();
  }
  const heldHere = workers.filter((p) => p.host === host).reduce((n, p) => n + p.threads, 0);
  // A board changed by hand, or a stray second copy: the worker charging the
  // wrong roots throws on the first missing one and dies anyway.
  const stale = workers.length > 1 ||
    (workers.length === 1 && workers[0].args.map(String).join(",") !== argv.map(String).join(","));
  const hostMax = ns.getServerMaxRam(host);
  const hostUsed = ns.getServerUsedRam(host);
  const plan = chargePlan({ hostMax, hostUsed, heldHere, heldThreads, maxGb });

  let held = heldHere;
  let where = workers.length === 1 ? workers[0].host : host;
  if (!roots.length || plan.act || stale) {
    // Kill and exec with NO await between: the manager is another script, and
    // it cannot be scheduled in the middle of a synchronous stretch, so the RAM
    // the kill frees cannot be dispatched into before the exec takes it. scp
    // first, every time: a cloud server bought or a host rooted since has no copy.
    for (const p of workers) ns.kill(p.pid);
    held = 0;
    where = host;
    if (roots.length && plan.threads > 0) {
      ns.scp(CHARGE_WORKER, host, "home");
      if (ns.exec(CHARGE_WORKER, host, plan.threads, ...argv)) held = plan.threads;
      else lines.push(`WARN: could not start the charge worker on ${host} at ${plan.threads} threads`);
    }
  } else if (where !== host) {
    held = 0;
  }
  reserve(host, plan.want * CHARGE_GB, held * CHARGE_GB);

  const gb = (t) => ns.format.ram(t * CHARGE_GB);
  const running = workers.length && !plan.act && !stale ? heldThreads : held;
  lines.push(`board ${board.w}x${board.h}, ${roots.length} fragment(s) charging; worker on ${where}` +
    (where !== host ? `, moving to ${host}` : "") +
    ` (${running} threads, ${gb(running)}; wants ${plan.want}, ${gb(plan.want)})`);
  // The worker starts only in RAM the manager has let go of, and its batches on
  // the host still have to land first - a full host is the normal first minutes.
  if (running === 0 && plan.want > 0 && roots.length) {
    lines.push(`  waiting for the manager to drain ${host}: ` +
      `${ns.format.ram(Math.max(0, hostMax - hostUsed))} free of ${ns.format.ram(hostMax)}`);
  }
  for (const f of board.placed) {
    const name = FRAGMENT_NAMES[f.id] ?? `#${f.id}`;
    lines.push(`  ${name} @${f.x},${f.y} (${f.type === BOOSTER_TYPE ? "booster" :
      `+${ns.format.percent(f.effect - 1, 1)}, highest ${ns.format.number(f.highestCharge, 1)}, ` +
      `num ${ns.format.number(f.numCharge, 1)}`})`);
  }
  finish();
}
