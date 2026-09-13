import { planPurchases, equipBudget, eligibleItems } from "./math.js";
import { readMarker } from "./marker.js";
import { report } from "./report.js";

/**
 * Equipment: augmentations always, gear only once the ascension churn stops.
 *
 * ascend() reapplies augmentations and discards everything else, so a Weapon
 * bought the tick before an ascension is money set on fire while an
 * Augmentation is permanent. planPurchases enforces that split by phase, and
 * spends cheapest-item-first across the whole gang rather than emptying the
 * budget on one member's wishlist.
 *
 * getEquipmentStats (2.00 GB) is here for ONE job: telling a hack-only item
 * from a combat one. Every Rootkit and three of the augmentations raise
 * hacking and nothing else, and no combat task weights hacking above zero, so
 * cheapest-first would otherwise buy a $5m NUKE Rootkit ahead of a $12m Katana
 * the gang can actually use. isHackingItem in math.js reads the stats; the sort
 * in eligibleItems sinks those to the back of the queue rather than dropping
 * them, because once the combat wishlist is bought out the budget has nothing
 * better to do with the money.
 *
 * It is still NOT used to score gear against gear. Cheapest-first inside a
 * budget is close enough for that, and this is the most expensive of the four
 * transients.
 *
 * RAM: 1.60 base + getMemberNames 1.00 + getMemberInformation 2.00
 *      + getEquipmentCost 2.00 + getEquipmentType 2.00 + getEquipmentStats 2.00
 *      + purchaseEquipment 4.00 + getServerMoneyAvailable 0.10 = 14.70 GB
 * (getEquipmentNames is 0 GB.)
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const state = readMarker(ns);
  if (!state) {
    report(ns, "equip", "no gang marker yet - tick.js has not run, skipping");
    return;
  }

  const members = ns.gang.getMemberNames().map((n) => ns.gang.getMemberInformation(n));
  const items = ns.gang.getEquipmentNames().map((n) => ({
    name: n,
    cost: ns.gang.getEquipmentCost(n),
    type: ns.gang.getEquipmentType(n),
    stats: ns.gang.getEquipmentStats(n),
  }));

  const budget = equipBudget(ns.getServerMoneyAvailable("home"));
  const buys = planPurchases(members, items, state.phase, budget, state.isHacking);

  // A pass that buys nothing MUST say why. The first version printed only when
  // it bought something, so "the phase excludes gear", "the gang already owns
  // everything", "the budget is too small" and "no marker" all looked the same
  // from the log: a blank. That cost a live round trip to diagnose, which is
  // the whole thing this repo's logging rules exist to stop.
  if (buys.length === 0) {
    const eligible = eligibleItems(items, state.phase, state.isHacking);
    // Min over the list, not eligible[0]. The shortlist is no longer sorted by
    // cost alone - hack-only items sink to the back whatever they cost - so the
    // first entry is the cheapest USEFUL item, and reporting it as "the
    // cheapest" would name a figure the budget may in fact clear.
    const cheapest = eligible.length ? Math.min(...eligible.map((i) => i.cost)) : 0;
    let why;
    if (!eligible.length) {
      why = "no item is eligible - see BUY_GEAR_PHASES, augmentations only outside it";
    } else if (cheapest > budget) {
      why = `cheapest eligible is $${ns.format.number(cheapest, 2)}, over budget`;
    } else {
      why = "the gang already owns every eligible item it can afford";
    }
    report(ns, "equip",
      `nothing bought in ${state.phase}: ${eligible.length}/${items.length} items eligible, ` +
        `budget $${ns.format.number(budget, 2)} - ${why}`);
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
    report(ns, "equip", `refused all ${buys.length} planned buys - money moved since the plan`);
  } else {
    report(ns, "equip", `bought ${bought} of ${buys.length} planned for $${ns.format.number(spent, 2)} (${state.phase})`);
  }
}
