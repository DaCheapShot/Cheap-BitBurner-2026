/**
 * Hacking exp per second, sampled every N seconds, printed to a tail window.
 *
 *   run scripts/expwatch.js        # 60 s samples
 *   run scripts/expwatch.js 30
 *
 * Leave it running and switch what the player is doing (crime, a class, faction
 * work) between samples: each line is the rate over the last window only, so the
 * line after a switch mixes both and the one after that is clean. The batcher's
 * exp is in every line - a sample with the player idle is its share alone.
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const seconds = Number(ns.args[0]) || 60;
  ns.disableLog("ALL");
  ns.ui.openTail();
  let last = ns.getPlayer().exp.hacking;
  ns.print(`sampling hacking exp every ${seconds}s`);
  for (;;) {
    await ns.sleep(seconds * 1000);
    const p = ns.getPlayer();
    const rate = (p.exp.hacking - last) / seconds;
    last = p.exp.hacking;
    ns.print(`${new Date().toLocaleTimeString()}  ${ns.format.number(rate, 2)} exp/s  ` +
      `(level ${p.skills.hacking})`);
  }
}
