import { MONEY_TOLERANCE, SEC_TOLERANCE } from "./config.js";

/**
 * Math interface backed by ns.formulas.hacking.
 *
 * Exact where the analyze implementation can only approximate, because
 * formulas takes a SERVER OBJECT: we can hand it a hypothetical state instead
 * of whatever the server happens to be right now.
 *
 * RAM charged to whoever imports this:
 *   getServer 2.00 + getPlayer 0.50 = 2.50 GB
 * Every ns.formulas.* function is 0 GB, and the server object supplies money,
 * security and the three op times, so none of getServerMoneyAvailable,
 * getServerSecurityLevel, getServerMinSecurityLevel, getServerMaxMoney,
 * getHackTime, getGrowTime or getWeakenTime is needed here.
 */

export const NAME = "formulas";

/**
 * Confirm Formulas.exe is actually owned.
 *
 * ns.formulas.* throws when the program is missing, and it throws at CALL time,
 * not import time - so without this check the failure would surface mid-cycle
 * as a raw exception instead of at startup with a usable message.
 */
export function prepare(ns) {
  try {
    ns.formulas.hacking.weakenEffect(1);
    return { ok: true };
  } catch {
    return {
      ok: false,
      error:
        "Formulas.exe is not available on home. Run the *Analyze build instead - " +
        "scripts/manager.js or scripts/prep.js - which works without the program.",
    };
  }
}

export function snapshot(ns, host) {
  const server = ns.getServer(host);
  const player = ns.getPlayer();
  const maxMoney = server.moneyMax;
  const money = server.moneyAvailable;
  const minSec = server.minDifficulty;
  const sec = server.hackDifficulty;
  return {
    ns, host, server, player, maxMoney, money, minSec, sec,
    moneyOk: money >= maxMoney * MONEY_TOLERANCE,
    secOk: sec <= minSec + SEC_TOLERANCE,
  };
}

/** See mathAnalyze.maxMoneyOf. getServer is already charged here, so this is free. */
export function maxMoneyOf(ns, host) {
  return ns.getServer(host).moneyMax;
}

export function hackFractionPerThread(snap) {
  return snap.ns.formulas.hacking.hackPercent(snap.server, snap.player);
}

/**
 * Security per thread.
 *
 * These are fixed game constants, not formulas outputs - the formulas API has
 * no hackSecurity/growSecurity entry, only weakenEffect. They are the same
 * numbers calibrate.js measures, so both implementations agree by construction.
 */
export function securityPerHackThread() { return 0.002; }
export function securityPerGrowThread() { return 0.004; }

export function securityPerWeakenThread(snap) {
  // weakenEffect(1) rather than a literal: it is the one security constant the
  // formulas API exposes, and it tracks BitNode multipliers.
  return snap.ns.formulas.hacking.weakenEffect(1);
}

/**
 * Grow threads to take money from fromMoney to toMoney at a given security.
 *
 * EXACT. The server object is cloned and overwritten with the hypothetical
 * state, so this answers "what will grow need when it lands", not "what would
 * grow need if it ran right now". That distinction is the entire reason for
 * this module: prep sizes waves for a server whose security is about to change,
 * and a batch's grow runs after its hack has already taken the money.
 *
 * growThreads also models the additive +$1/thread term that growthAnalyze
 * ignores, which is what GROW_MARGIN was padding against.
 */
export function growThreadsToRestore(snap, fromMoney, toMoney, atSecurity) {
  const from = Math.max(fromMoney, 1);
  const to = Math.min(toMoney, snap.maxMoney);
  if (to <= from) return 0;

  const hypothetical = { ...snap.server, moneyAvailable: from, hackDifficulty: atSecurity };
  return snap.ns.formulas.hacking.growThreads(hypothetical, snap.player, to);
}

export function opTimes(snap) {
  const f = snap.ns.formulas.hacking;
  return {
    hack: f.hackTime(snap.server, snap.player),
    grow: f.growTime(snap.server, snap.player),
    weaken: f.weakenTime(snap.server, snap.player),
  };
}
