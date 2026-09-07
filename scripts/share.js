/**
 * Share worker: donate this process's RAM to faction reputation until told to stop.
 *
 * ns.share() adds this script's thread count to the game's global shareThreads
 * accumulator, waits ShareBonusTime (10s), then subtracts it again - so sharing
 * continuously means calling it in a loop, and a share worker is a long-lived
 * process rather than a one-shot op like hack/grow/weaken.
 *
 * That loop is also the OFF switch. The gate port is re-read between calls, so
 * setting it to 0 retires every share thread on the network within 10 seconds
 * with no ns.kill anywhere, and the manager never has to track which processes
 * it started in order to stop them. The check runs BEFORE the first share, so an
 * empty port means off.
 *
 * IT MUST BE A PORT, NOT A FILE, and this script used to read a file. ns.read
 * resolves against the server the script is RUNNING on, so /data/share.txt - a
 * file that exists on home alone - read as "" on every purchased server, parsed
 * as off, and this worker exited within milliseconds. exec had already returned
 * a pid, so the manager counted 66 hosts sharing while 65 had quit. Ports are
 * global to every host; files are not.
 *
 * IMPORTS NOTHING, like hack.js / grow.js / weaken.js, and takes the port number
 * as an argument instead. A worker's imports have to exist on every host it runs
 * on - Bitburner resolves them on the server it starts on and RamCalculations.ts
 * returns ImportError otherwise, which exec reports as a bare 0, exactly as if
 * the script itself were missing. Importing config.js for one constant cost a
 * live run diagnosing that. Nothing here needs to be shared with another module.
 *
 * RAM: 1.60 base + 2.40 share = 4.00 GB PER THREAD - more than twice a grow
 * thread. Per-thread cost is why this file holds one op and nothing else, the
 * same rule the batch workers follow. Port reads are 0 GB.
 *
 * argv: [0] gate port number
 *
 * Launched by the manager, never by hand - see managerCore.topUpShare. The
 * manager owns the RAM pool, and anything else exec-ing into it races the volley
 * it has already planned.
 */

/** @param {NS} ns */
export async function main(ns) {
  const gate = ns.getPortHandle(Number(ns.args[0]));
  // peek, not read: read() REMOVES the message, so the first worker to wake
  // would consume the setting and every other worker would see an empty port and
  // stop. A setting is peeked; a queue is read.
  while (Number(gate.peek()) > 0) {
    await ns.share();
  }
}
