import { MONEY_TOLERANCE, SEC_TOLERANCE } from "scripts/continuous/config";
import { makeCoreBonus } from "scripts/continuous/lib/cores";
import { rpc } from "scripts/rpc";

/**
 * The continuous batcher's thread math, both backends, in one module.
 *
 * There used to be two - mathAnalyze.js and mathFormulas.js - each bound to its
 * own entry point (manager.js, manager-formulas.js), a test keeping them apart,
 * and a swap in boot.js between the files whenever Formulas.exe was bought or
 * lost. Reaching both from one script used to cost both backends in full.
 *
 * What changed is that the expensive half of each was CONSTANTS. The three
 * security-per-thread figures and the core-bonus table are measured once, in a
 * single rpc.js call, so weakenAnalyze, hackAnalyzeSecurity and
 * growthAnalyzeSecurity (3.00 GB) are string literals to the RAM calculator.
 * What stays resident is only what has to be LIVE:
 *
 *   analyze:   hackAnalyze, hackAnalyzeChance, growthAnalyze   3.00
 *              getHackTime / getGrowTime / getWeakenTime       0.15
 *   formulas:  getPlayer                                       0.50
 *   both:      getServer (already paid by lib/cores.js)        2.00
 *              ns.run, through rpc.js                          1.00
 *
 * The hot path can NOT go through rpc: stream.dispatch() snapshots on every
 * cadence tick and the launch loop reads op times per op, and an rpc round trip
 * spawns a script and waits for its reply.
 *
 * The backend is re-chosen by refresh(), which core.js calls every rescan, so
 * buying Formulas.exe upgrades a running manager in place. Each snapshot records
 * which backend took it (a formulas snapshot carries `player`), and every
 * function answers from the snapshot rather than from module state - so a
 * switch between a snapshot and its use cannot mix the two.
 */

let useFormulas = false;
let consts = null;

/** Core counts the table covers. Foreign servers reach 15; home is bought up. */
const CORE_TABLE = 64;

/** "formulas" or "analyze" - what refresh() last chose. For the log. */
export function backend() {
  return useFormulas ? "formulas" : "analyze";
}

/**
 * Detected by CALLING a formula, not by fileExists: ns.formulas.* throws at
 * call time when the program is missing, so this is the same test the hot path
 * would fail. 0 GB. --no-formulas is read straight off ns.args, which is how
 * boot forwards it.
 *
 * @returns {boolean} true when the backend changed
 */
export function refresh(ns) {
  const was = useFormulas;
  useFormulas = false;
  if (!ns.args.map(String).includes("--no-formulas")) {
    try {
      useFormulas = ns.formulas.hacking.weakenEffect(1, 1) > 0;
    } catch {
      useFormulas = false;
    }
  }
  return useFormulas !== was;
}

/**
 * Pick a backend and measure the constants. Called once, at startup.
 *
 * NO HOST ARGUMENT on either *AnalyzeSecurity - load-bearing. With a host, both
 * cap their result by the threads needed to reach max money. A PREPPED target
 * sits AT max money, so growthAnalyzeSecurity(g, host) returns ~0 and weaken-2
 * gets sized at 1 thread instead of the ~51 needed; the uncancelled security
 * then compounds batch over batch. The cap is wrong for a batch anyway: by the
 * time grow lands, hack has taken its cut, so every grow thread fires.
 *
 * Measured for BOTH backends. The formulas API exposes no fortify-per-thread
 * getter, and this repo's rule is that game constants come from the API - a
 * wrong fortify constant does not fail loudly, it drifts a target off baseline
 * over minutes. weakenAnalyze(1, c) and formulas' weakenEffect(1, c) are the
 * same game function, so one table serves both.
 */
export async function prepare(ns) {
  refresh(ns);
  let got;
  try {
    got = await rpc(ns, `
      const weaken = [];
      for (let c = 1; c <= 64; c++) weaken.push(ns.weakenAnalyze(1, c));
      return { weaken, hackSec: ns.hackAnalyzeSecurity(1), growSec: ns.growthAnalyzeSecurity(1) };
    `);
  } catch (e) {
    return { ok: false, error: `could not measure the security constants: ${e.message ?? e}` };
  }

  // A transient that returned a shape this does not recognise must stop the
  // manager here, not propagate an undefined into thread math as NaN - a NaN
  // defeats every comparison it meets, including the ones that end loops.
  const table = got?.weaken;
  if (!Array.isArray(table) || table.length !== CORE_TABLE || !table.every((w) => w > 0)
      || !(got.hackSec > 0) || !(got.growSec > 0)) {
    return { ok: false, error: `constants came back unusable: ${JSON.stringify(got)}` };
  }

  consts = {
    weaken: table[0],
    hackSec: got.hackSec,
    growSec: got.growSec,
    // Weaken is linear in threads, so the table answers any thread count.
    coreBonus: makeCoreBonus((t, c) => t * table[Math.min(c, CORE_TABLE) - 1]),
  };
  return { ok: true };
}

/**
 * The server as it stands. getServer for both backends: lib/cores.js already
 * pays its 2.00 GB, and it replaces four 0.10 GB getServer* reads.
 */
export function snapshot(ns, host) {
  const server = ns.getServer(host);
  const maxMoney = server.moneyMax ?? 0;
  const money = server.moneyAvailable ?? 0;
  const minSec = server.minDifficulty ?? 1;
  const sec = server.hackDifficulty ?? minSec;

  return {
    ns,
    host,
    // Kept so the formulas can answer hypotheticals - "how many grow threads AT
    // this security" - which the analyze backend cannot ask at all.
    server,
    // Present only on a formulas snapshot, and THAT is the backend marker.
    player: useFormulas ? ns.getPlayer() : undefined,
    maxMoney,
    money,
    minSec,
    sec,
    moneyOk: maxMoney > 0 && money >= maxMoney * MONEY_TOLERANCE,
    secOk: sec <= minSec + SEC_TOLERANCE,
  };
}

/**
 * Fraction of the server's CURRENT money one hack thread takes.
 *
 * Analyze: deliberately not hackAnalyzeThreads, which takes an absolute amount
 * and returns -1 whenever it exceeds the money on the server - so it fails on
 * every unprepped target. Stays live: it moves with hacking level, and reacting
 * to that is the point of re-deriving each batch at dispatch.
 */
export function hackFractionPerThread(snap) {
  if (!snap.ns) return 0;
  return snap.player
    ? snap.ns.formulas.hacking.hackPercent(snap.server, snap.player)
    : snap.ns.hackAnalyze(snap.host);
}

export function hackChance(snap) {
  if (!snap.ns) return 0;
  return snap.player
    ? snap.ns.formulas.hacking.hackChance(snap.server, snap.player)
    : snap.ns.hackAnalyzeChance(snap.host);
}

/** Security added per hack thread. Constant; no core bonus applies. */
export const securityPerHackThread = () => consts.hackSec;

/**
 * Security added per grow thread. Constant, and no core bonus applies.
 *
 * That asymmetry is real. From processSingleServerGrowth in the fork's
 * ServerHelpers.ts, grow fortifies by `2 * ServerFortifyAmount * usedCycles`
 * with usedCycles clamped to the CALL's own thread count - so grow's security
 * cost tracks RAW threads while its money effect tracks core-weighted ones.
 * The weaken that cancels a grow is therefore sized from the grow's RAW placed
 * threads, which is exact. Sizing it off the effective count would over-weaken:
 * safe, since weaken clamps at minimum security, but on an 8-core host ~44%
 * more weaken threads than the grow can justify.
 */
export const securityPerGrowThread = () => consts.growSec;

/** Security removed per weaken thread ON A SINGLE CORE. */
export const weakenPerThread = () => consts.weaken;

/** Multiplier a host's cores apply to grow and weaken. Measured, not assumed. */
export const coreBonusFor = (cores) => consts.coreBonus(cores);

/**
 * Threads to grow `fromMoney` up to `toMoney`, as if run on ONE core.
 *
 * `atSecurity` is HONOURED by formulas and IGNORED by analyze, deliberately.
 * growthAnalyze reads the server's security at call time and offers no way to
 * ask "what if security were X"; formulas answers for a cloned server. What
 * decides a grow's effect is the state when it FINISHES, and in a batch grow
 * lands after a weaken has pulled security back down. Do not "fix" the two into
 * equivalence - a test pins the difference.
 *
 * Analyze over-estimates slightly: growthAnalyze covers only the multiplicative
 * term and ignores grow's additive $1 per thread. Over-supply is the safe
 * direction, since the game clamps money at moneyMax.
 */
export function growThreadsToRestore(snap, fromMoney, toMoney, atSecurity) {
  if (!(toMoney > fromMoney)) return 0;

  if (snap.player) {
    const server = {
      ...snap.server,
      moneyAvailable: Math.max(fromMoney, 0),
      hackDifficulty: atSecurity ?? snap.sec,
    };
    return snap.ns.formulas.hacking.growThreads(server, snap.player, toMoney, 1);
  }

  // A server at $0 gives an infinite multiplier. Grow's additive term rescues
  // it in the game; pretending it holds $1 gives a finite, generous count.
  const mult = toMoney / Math.max(fromMoney, 1);
  if (!(mult > 1)) return 0;
  return Math.ceil(snap.ns.growthAnalyze(snap.host, mult, 1));
}

/**
 * Op durations. Formulas reads them off the SNAPSHOT's server, so a caller can
 * price a hypothetical by handing in a modified snapshot (pricePotential does);
 * analyze can only ever answer for the live server.
 */
export function opTimes(snap) {
  if (snap.player) {
    const f = snap.ns.formulas.hacking;
    return {
      hack: f.hackTime(snap.server, snap.player),
      grow: f.growTime(snap.server, snap.player),
      weaken: f.weakenTime(snap.server, snap.player),
    };
  }
  return {
    hack: snap.ns.getHackTime(snap.host),
    grow: snap.ns.getGrowTime(snap.host),
    weaken: snap.ns.getWeakenTime(snap.host),
  };
}
