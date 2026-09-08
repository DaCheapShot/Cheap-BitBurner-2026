import { ServerPool } from "scripts/continuous/lib/server";
import { SPACER_MS, STEAL_FRACTION } from "scripts/continuous/config";

/**
 * Target discovery and ranking.
 *
 * Adds beyond what lib/server.js already pays for:
 *
 *   ns.getServerRequiredHackingLevel  0.10
 *   ns.getHackingLevel                0.05
 *
 * Everything else comes through the math backend, so this module works
 * unchanged on either.
 */

/** Prepped means at max money AND at minimum security. Both, always. */
export const isPrepped = (snap) => snap.moneyOk && snap.secOk;

/**
 * Every host worth considering: rooted, holds money, and within reach.
 *
 * The hacking-level check is not cosmetic - below the requirement hackAnalyze
 * returns 0, so a target that fails it would rank as infinitely bad rather than
 * simply unavailable, and would keep being re-evaluated forever.
 */
export function candidates(ns) {
  const level = ns.getHackingLevel();
  const out = [];

  for (const host of ServerPool.scanAll(ns)) {
    if (host === "home") continue;
    if (!ns.hasRootAccess(host)) continue;
    if (ns.getServerRequiredHackingLevel(host) > level) continue;
    if (ns.getServerMaxMoney(host) <= 0) continue;
    out.push(host);
  }
  return out;
}

/**
 * Money per second a fully-streamed target would yield.
 *
 * A stream lands one batch per cadence once it is up to depth, so throughput is
 * NOT divided by the weaken window the way a volley's is. What the weaken time
 * costs a stream is depth - how many batches must be in flight to keep the
 * cadence fed - and therefore RAM, not time. So the honest per-target score is
 * money per batch over the cadence, with the weaken time entering only as the
 * RAM multiplier it really is.
 *
 * Deliberately expressed per unit of RAM-time rather than as raw income: two
 * targets that earn the same per second are not equal if one needs twice the
 * in-flight depth to do it, and on a shared pool the cheaper one leaves room
 * for a second stream.
 *
 * hackChance matters and is easy to forget - a target with a 40% chance
 * silently earns 40% of its paper income, because a failed hack takes nothing
 * while its grow and weakens still run.
 */
export function scoreTarget(math, snap, steal = STEAL_FRACTION) {
  if (!(snap.maxMoney > 0)) return null;

  const perThread = math.hackFractionPerThread(snap);
  if (!(perThread > 0)) return null; // level too low, or no root

  const times = math.opTimes(snap);
  if (!(times.weaken > 0)) return null;

  const chance = math.hackChance(snap);
  const perBatch = snap.maxMoney * steal * chance;

  // Depth needed to keep the stream saturated, and therefore the RAM the
  // target ties up to earn `perBatch` every cadence.
  const cadence = 4 * SPACER_MS;
  const depth = Math.max(1, Math.ceil(times.weaken / cadence));

  return {
    host: snap.host,
    snap,
    perThread,
    chance,
    times,
    perBatch,
    depth,
    // What the target earns per second once streaming.
    moneyPerSec: perBatch / (cadence / 1000),
    // What it earns per second per unit of in-flight depth. This is the number
    // that decides who gets the pool when RAM is contended.
    moneyPerSecPerDepth: perBatch / (cadence / 1000) / depth,
  };
}

/**
 * Rank candidates, best first.
 *
 * Sorted on income per unit of depth, because the pool is shared. A target that
 * earns more in absolute terms but ties up three times the RAM is the wrong
 * first pick when a second stream could have run in that RAM.
 */
export function rankTargets(ns, math, opts = {}) {
  const { steal = STEAL_FRACTION, hosts = null } = opts;

  const scored = [];
  for (const host of hosts ?? candidates(ns)) {
    const snap = math.snapshot(ns, host);
    const score = scoreTarget(math, snap, steal);
    if (score) scored.push(score);
  }

  scored.sort((a, b) => b.moneyPerSecPerDepth - a.moneyPerSecPerDepth);
  return scored;
}
