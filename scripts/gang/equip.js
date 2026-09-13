import { planPurchases, equipBudget, eligibleItems } from "./math.js";
import { readMarker } from "./marker.js";

/**
 * Equipment: augmentations always, gear only once the ascension churn stops.
 *
 * ascend() reapplies augmentations and discards everything else, so a Weapon
 * bought the tick before an ascension is money set on fire while an
 * Augmentation is permanent. planPurchases enforces that split by phase, and
 * spends cheapest-item-first across the whole gang rather than emptying the
 * budget on one member's wishlist.
 *
 * Skipped: ns.gang.getEquipmentStats (2.00 GB). Cheapest-first inside a budget
 * is close enough to a scored choice, and this is already the most expensive of
 * the four transients. Add it if gear selection ever looks visibly wrong.
 *
 * RAM: 1.60 base + getMemberNames 1.00 + getMemberInformation 2.00
 *      + getEquipmentCost 2.00 + getEquipmentType 2.00 + purchaseEquipment 4.00
 *      + getServerMoneyAvailable 0.10 = 12.70 GB
 * (getEquipmentNames is 0 GB.)
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const state = readMarker(ns);
  if (!state) {
    ns.print("no gang marker yet - skipping equipment pass");
    return;
  }

  const members = ns.gang.getMemberNames().map((n) => ns.gang.getMemberInformation(n));
  const items = ns.gang.getEquipmentNames().map((n) => ({
    name: n,
    cost: ns.gang.getEquipmentCost(n),
    type: ns.gang.getEquipmentType(n),
  }));

  const budget = equipBudget(ns.getServerMoneyAvailable("home"));
  const buys = planPurchases(members, items, state.phase, budget);

  // A pass that buys nothing MUST say why. The first version printed only when
  // it bought something, so "the phase excludes gear", "the gang already owns
  // everything", "the budget is too small" and "no marker" all looked the same
  // from the log: a blank. That cost a live round trip to diagnose, which is
  // the whole thing this repo's logging rules exist to stop.
  if (buys.length === 0) {
    const eligible = eligibleItems(items, state.phase);
    const cheapest = eligible.length ? eligible[0].cost : 0;
    let why;
    if (!eligible.length) {
      why = "no item is eligible - see BUY_GEAR_PHASES, augmentations only outside it";
    } else if (cheapest > budget) {
      why = `cheapest eligible is $${cheapest.toExponential(2)}, over budget`;
    } else {
      why = "the gang already owns every eligible item it can afford";
    }
    ns.print(
      `nothing bought in ${state.phase}: ${eligible.length}/${items.length} items eligible, ` +
        `budget $${budget.toExponential(2)} - ${why}`,
    );
    return;
  }

  let bought = 0;
  let spent = 0;
  for (const b of buys) {
    // The plan is priced against a snapshot; the game is the authority on
    // whether the money is still there. A false here means something else
    // spent it between the snapshot and now, which is normal with cloud.js
    // buying servers - stop rather than grind through a failing list.
    if (!ns.gang.purchaseEquipment(b.member, b.item)) break;
    bought++;
    spent += b.cost;
  }

  if (bought === 0) {
    // Planned buys that all failed at the till. purchaseEquipment is the
    // authority on the money, so this means it moved between plan and buy -
    // normal with cloud.js buying servers, but it must not read as silence.
    ns.print(`purchaseEquipment refused all ${buys.length} planned buys - money moved since the plan`);
  } else {
    ns.print(`bought ${bought} of ${buys.length} planned for $${spent.toExponential(2)} (${state.phase})`);
  }
}
