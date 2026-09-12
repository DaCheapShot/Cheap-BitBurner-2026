/**
 * Found the gang. Hand-run once, like sharemode.js.
 *
 * Not automated, and not in boot: creating a gang is irreversible for the
 * BitNode and picks which faction you will be earning reputation for. That is
 * a decision, not a step.
 *
 * ns.gang.createGang returns false when the requirements are not met - karma
 * at or below GangConstants.GangKarmaRequirement = -54000, and membership in
 * the faction - so there is nothing worth pre-checking. It just says no.
 *
 * COMBAT GANGS: Slum Snakes, Tetrads, The Syndicate, The Dark Army,
 * Speakers for the Dead. NiteSec and The Black Hand are hacking gangs, which
 * the rest of this subsystem refuses to manage (see tick.js).
 *
 * Usage:  run scripts/gang/create.js "Slum Snakes"
 *
 * RAM: 1.60 base + createGang 1.00 = 2.60 GB  (inGang is 0 GB)
 */

/** @param {NS} ns */
export async function main(ns) {
  const faction = String(ns.args[0] ?? "");
  if (!faction) {
    ns.tprint('usage: run scripts/gang/create.js "Slum Snakes"');
    return;
  }

  if (ns.gang.inGang()) {
    ns.tprint("already in a gang - run scripts/gang/gang.js, or just let boot.js start it.");
    return;
  }

  if (!ns.gang.createGang(faction)) {
    ns.tprint(
      `ERROR: could not found a gang with ${faction}. Needs karma <= -54000 and membership ` +
        `in that faction.`,
    );
    return;
  }

  ns.tprint(`gang founded with ${faction}. boot.js will start the supervisor on its next tick.`);
}
