import { CONGRUITY } from "./config.js";
import { graftCandidates, graftGain } from "./plan.js";
import { rpc } from "scripts/rpc.js";
import { SETTINGS_FILE, setting } from "scripts/settings.js";

/**
 * Print the top grafts, in the order sing takes them: Congruity first while
 * there is entropy to clear, then graftCandidates' order - best tier-1 gain net
 * of entropy, among the graftable augs no joined faction sells. Same pool and
 * same filter as sing, so row 1 is sing's next graft once cash allows.
 *
 * Every call is in an rpc body, as in sing.js: the whole surface together is
 * ~25 GB. Peak is STATS at 11.60 (BitNode 4 prices - singularity names cost
 * 16/4/1x by SF4 level elsewhere, exactly as sing's bodies do).
 *
 * Usage:  run scripts/sing/grafts.js [count=20]
 *
 * RAM: 1.60 base + run 1.00 = 2.60 GB
 */

/** Every graftable aug and its graft price. 1.60 + 5.00 + 3.75. */
const LIST = `
const out = {};
for (const a of ns.grafting.getGraftableAugmentations()) out[a] = ns.grafting.getAugmentationGraftPrice(a);
return out;
`;

/** Tier-1 multipliers and prerequisites per aug. 1.60 + 5.00 + 5.00. */
const STATS = `
import { PRIORITY_MULTS } from "/scripts/sing/config.js";
const mults = {};
const prereqs = {};
for (const a of args) {
  const m = ns.singularity.getAugmentationStats(a);
  mults[a] = {};
  for (const k of PRIORITY_MULTS) if (m[k] !== undefined && m[k] !== 1) mults[a][k] = m[k];
  prereqs[a] = ns.singularity.getAugmentationPrereq(a);
}
return { mults, prereqs };
`;

/** The player and everything owned or queued. 1.60 + 0.50 + 5.00. */
const OWNED = `
const p = ns.getPlayer();
return { money: p.money, entropy: p.entropy, factions: p.factions, owned: ns.singularity.getOwnedAugmentations(true) };
`;

/** What each joined faction sells - a graft is only for augs none of them does. 6.60. */
const SHOPS = `
const augsOf = {};
for (const f of args) augsOf[f] = ns.singularity.getAugmentationsFromFaction(f);
return augsOf;
`;

/** Graft time at the current Intelligence, unfocused penalty not included. 1.60 + 3.75. */
const TIME = `
const out = {};
for (const a of args) out[a] = ns.grafting.getAugmentationGraftTime(a);
return out;
`;

/** @param {NS} ns */
export async function main(ns) {
  const count = Number(ns.args[0] ?? 20);
  const money$ = (v) => `$${ns.format.number(v, 2)}`;
  let price;
  try {
    price = await rpc(ns, LIST);
  } catch (e) {
    ns.tprint(`grafts: ${e.message ?? e} - grafting needs BitNode 10 or Source-File 10`);
    return;
  }
  const augs = Object.keys(price);
  const { mults, prereqs } = await rpc(ns, STATS, ...augs);
  const me = await rpc(ns, OWNED);
  const augsOf = await rpc(ns, SHOPS, ...me.factions);
  const cands = graftCandidates({ mults, owned: me.owned, prereqs, augsOf, factions: me.factions });
  const rows = [];
  if (me.entropy > 0 && CONGRUITY in price) rows.push({ aug: CONGRUITY, gain: 0 });
  rows.push(...cands);
  const top = rows.slice(0, count);
  const time = top.length ? await rpc(ns, TIME, ...top.map((r) => r.aug)) : {};
  const frac = setting(ns.read(SETTINGS_FILE), "sing.graftCash");

  const lines = [`grafts: top ${top.length} of ${rows.length} worth it - entropy ${me.entropy}, ` +
    `cash ${money$(me.money)}, sing grafts at <= ${ns.format.percent(frac, 0)} of cash (sing.graftCash)`];
  top.forEach((r, i) => {
    const p = price[r.aug];
    const why = r.aug === CONGRUITY ? `clears entropy ${me.entropy}` : `x${ns.format.number(r.gain, 3)} tier-1`;
    const fits = r.aug === CONGRUITY ? p <= me.money : p <= me.money * frac;
    lines.push(`${String(i + 1).padStart(3)}. ${r.aug.padEnd(44)} ${why.padEnd(20)} ` +
      `${money$(p).padStart(10)}  ${ns.format.time(time[r.aug] ?? 0).padEnd(28)} ${fits ? "affordable" : "over budget"}`);
  });
  // What the filter cut, so a short list says why it is short.
  const good = augs.filter((a) => a !== CONGRUITY && graftGain(mults[a] ?? {}) > 1);
  const blocked = good.filter((a) => (prereqs[a] ?? []).some((q) => !me.owned.includes(q))).length;
  lines.push(`       ${augs.length} graftable, ${good.length} above the 1.175 bar - of those, ${blocked} wait on a ` +
    `prerequisite and ${good.length - blocked - cands.length} are sold by a joined faction - rep work gets those`);
  ns.tprint(lines.join("\n"));
}
