import { shouldAscend, ascensionFactor } from "./math.js";
import { readMarker } from "./marker.js";

/**
 * Ascension: the biggest single power lever in a gang, and the only one that
 * can go backwards.
 *
 * GangMember.ascend() adds the gained points, CLEARS every upgrade and then
 * reapplies only the augmentations, zeroes exp, and costs the gang respect. So
 * an ascension is a real trade - permanent multipliers against a re-train and a
 * respect bill - and shouldAscend in math.js refuses any that would drop the
 * gang back under its next recruit threshold while the roster is short.
 *
 * Deliberately does NOT call getMemberInformation (2.00 GB): the decision needs
 * the ascension result and three numbers from the marker, and nothing else.
 * getAscensionResult returns null when a member cannot ascend, so there is
 * nothing to pre-check either.
 *
 * RAM: 1.60 base + getMemberNames 1.00 + getAscensionResult 2.00
 *      + ascendMember 4.00 = 8.60 GB
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const state = readMarker(ns);
  if (!state) {
    // No tick has run yet, so there is no respect guard to check against.
    // Doing nothing is correct; guessing at the guard is not.
    ns.print("no gang marker yet - skipping ascension pass");
    return;
  }

  let respect = state.respect;
  let ascended = 0;

  for (const name of ns.gang.getMemberNames()) {
    const result = ns.gang.getAscensionResult(name);
    if (!shouldAscend(result, { ...state, respect })) continue;
    ns.gang.ascendMember(name);
    ascended++;
    // Respect is spent as we go, so the guard for the NEXT member has to see
    // what this one cost. Re-reading the gang would be 2.00 GB for a number we
    // already hold.
    respect = Math.max(1, respect - (result.respect ?? 0));
    ns.print(`ascended ${name} at x${ascensionFactor(result).toFixed(2)}, respect now ${Math.round(respect)}`);
  }

  if (ascended) ns.print(`${ascended} ascended this pass`);
}
