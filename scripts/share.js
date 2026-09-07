import { SHARE_MARKER, shareFractionFrom } from "./config.js";

/**
 * Share worker: donate this process's RAM to faction reputation until told to stop.
 *
 * ns.share() adds this script's thread count to the game's global shareThreads
 * accumulator, waits ShareBonusTime (10s), then subtracts it again - so sharing
 * continuously means calling it in a loop, and a share worker is a long-lived
 * process rather than a one-shot op like hack/grow/weaken.
 *
 * That loop is also the OFF switch. The marker is re-read between calls, so
 * `sharemode.js off` retires every share thread on the network within 10
 * seconds with no ns.kill anywhere, and the manager never has to track which
 * processes it started in order to stop them. The check runs BEFORE the first
 * share, so a missing marker means off.
 *
 * RAM: 1.60 base + 2.40 share = 4.00 GB PER THREAD - more than twice a grow
 * thread. Per-thread cost is why this file holds one op and nothing else, the
 * same rule the HWGW workers follow. ns.read is 0 GB and config.js has no ns
 * calls, so neither adds anything.
 *
 * Launched by the manager, never by hand - see managerCore.topUpShare. The
 * manager owns the RAM pool, and anything else exec-ing into it races the
 * volley it has already planned.
 */

/** @param {NS} ns */
export async function main(ns) {
  while (shareFractionFrom(ns.read(SHARE_MARKER)) > 0) {
    await ns.share();
  }
}
