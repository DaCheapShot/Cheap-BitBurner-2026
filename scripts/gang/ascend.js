import { shouldAscend, ascensionFactor } from "./math.js";
import { readMarker } from "./marker.js";
import { report } from "./report.js";
import { ASCEND_MULT_THRESHOLD } from "./config.js";

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
    report(ns, "ascend", "no gang marker yet - tick.js has not run, skipping");
    return;
  }

  let respect = state.respect;
  const done = [];
  let best = 0;
  let blocked = 0;

  for (const name of ns.gang.getMemberNames()) {
    const result = ns.gang.getAscensionResult(name);
    if (!result) continue;
    const factor = ascensionFactor(result);
    if (factor > best) best = factor;

    if (shouldAscend(result, { ...state, respect })) {
      ns.gang.ascendMember(name);
      // Respect is spent as we go, so the guard for the NEXT member has to see
      // what this one cost. Re-reading the gang would be 2.00 GB for a number
      // we already hold.
      respect = Math.max(1, respect - (result.respect ?? 0));
      done.push(`${name} x${factor.toFixed(2)}`);
    } else if (factor >= ASCEND_MULT_THRESHOLD) {
      // Cleared the multiplier bar and was refused anyway, which can only be
      // the respect guard. Counted separately because "ready but held" and
      // "not ready" are different answers to "why is nobody ascending", and a
      // log that merges them sends you looking at the wrong threshold.
      blocked++;
    }
  }

  if (done.length) {
    report(ns, "ascend", `${done.length} ascended (${done.join(", ")}) | respect now ${ns.format.number(respect, 0, 1000, true)}`);
  } else if (blocked) {
    report(ns, "ascend",
      `${blocked} ready at x${best.toFixed(2)} but HELD - ascending would drop respect ` +
        `under the ${ns.format.number(state.nextRecruitAt, 0, 1000, true)} needed for the next recruit`);
  } else {
    report(ns, "ascend", `none ready - best x${best.toFixed(2)}, need x${ASCEND_MULT_THRESHOLD.toFixed(2)}`);
  }
}
