import { STATUS_FILE, HISTORY_FILE, HISTORY_KEEP, REP_WANT_MARKER, SLEEVE_FACTION_MARKER, AUG_STATS_FILE } from "./config.js";
import { assign, sameTask, parseWant, describeAction, describeTask, planAugs, planCovenant } from "./plan.js";
import { rpc } from "scripts/rpc.js";
import { SETTINGS_FILE, setting } from "scripts/settings.js";

/**
 * The sleeve supervisor: ONE pass, then exit. boot.js runs it every tick.
 *
 * WHY A TRANSIENT. Sleeve work is continuous and self-sustaining - a crime
 * loops, faction work accrues - so nothing needs deciding more than once a
 * minute, and there is no state worth keeping warm between passes. Resident,
 * this would hold 2.60 GB for ever to buy a log window; as a transient it holds
 * nothing between ticks. It is the contracts.js shape.
 *
 * WHY EVERY CALL IS AN RPC BODY. Every ns.sleeve function is 4.00 GB
 * (RamCostConstants.SleeveBase), so reading and acting in one process is ~40 GB.
 * Split one call per body, each is 5.60-6.60 and the pass peaks at 2.60 + 6.60.
 *
 * NO SF10 CHECK HERE. boot asks once at launch (getResetInfo, through rpc) and
 * never runs this without the Sleeve API - Source-Files only change when a
 * BitNode ends. Run by hand without it, the first body's throw is a WARN line.
 *
 * NOTHING GOES TO THE TERMINAL - the user's rule. ns.print dies with the log
 * window a moment after exit, so STATUS_FILE is overwritten every pass with a
 * line per sleeve, a changed task marked with what it was.
 *
 * KARMA FOLLOWS THE GANG SWITCH. Karma buys nothing but a gang, so the rung is
 * on only while `gang.enabled` is on and boot was not started with --no-gang
 * (boot passes the same flag through).
 *
 * Usage:  run scripts/sleeve/sleeve.js      (boot does this; --no-sleeve opts out)
 *         cat /data/sleeves.txt
 *
 * RAM: 1.60 base + run 1.00 = 2.60 GB
 */

// ------------------------------------------------------------------ bodies ---
//
// Plain template literals: rpc() rejects interpolation, and tests/rpc.test.mjs
// parses every one. tests/ram.test.mjs prices every one.

/**
 * How many sleeves, and can a gang be founded at all (BN2 or SF2) - karma is
 * worth nothing otherwise. ownedSF is a Map, which JSON turns into {}, so it is
 * collapsed here, inside the transient: sing's READ has the same line.
 */
const COUNT = `
const reset = ns.getResetInfo();
return {
  n: ns.sleeve.getNumSleeves(), canGang: reset.currentNode === 2 || reset.ownedSF.has(2),
  node: reset.currentNode, sf10: reset.ownedSF.get(10) ?? 0,
};
`;

/**
 * Each sleeve's shock, sync, skills, exp, mults and city, and the player's
 * karma. With Formulas.exe, also the exact gym exp/s per stat at GYM
 * (gymGains is per 200 ms cycle, so x 5) - it carries the node's gym
 * multiplier, which nothing else here can see. ns.formulas is 0 GB.
 */
const READ = `
const owned = ns.fileExists("Formulas.exe", "home");
const gains = (s, type, key) => ns.formulas.work.gymGains(s, type, "Powerhouse Gym")[key] * 5;
const sleeves = [];
for (let i = 0; i < args[0]; i++) {
  const s = ns.sleeve.getSleeve(i);
  sleeves.push({ shock: s.shock, sync: s.sync, memory: s.memory, skills: s.skills, exp: s.exp, mults: s.mults, city: s.city,
    gym: owned ? { strength: gains(s, "str", "strExp"), defense: gains(s, "def", "defExp"),
      dexterity: gains(s, "dex", "dexExp"), agility: gains(s, "agi", "agiExp") } : null });
}
const p = ns.getPlayer();
return { sleeves, player: { karma: p.karma, skills: p.skills, money: p.money, factions: p.factions }, inGang: ns.gang.inGang() };
`;

/**
 * What each sleeve is doing. APICopy carries nextCompletion, a Promise, which
 * JSON turns into {} - so only the fields sameTask reads cross.
 */
const TASKS = `
const out = [];
for (let i = 0; i < args[0]; i++) {
  const t = ns.sleeve.getTask(i);
  out.push(t && { type: t.type, crimeType: t.crimeType, factionName: t.factionName,
    factionWorkType: t.factionWorkType, companyName: t.companyName, classType: t.classType, location: t.location });
}
return out;
`;

// The action bodies: one setTo* each, batched as JSON [[sleeve, ...args]], and
// caught PER SLEEVE - the faction and company setters throw when another
// sleeve holds the job, and one throw must not lose the rest of the batch.
// Each returns the sleeves that did not start, with why.

const RECOVER = `
const failed = [];
for (const [i] of JSON.parse(args[0])) {
  try { if (!ns.sleeve.setToShockRecovery(i)) failed.push([i, "refused"]); }
  catch (e) { failed.push([i, String(e?.message ?? e)]); }
}
return failed;
`;

const SYNC = `
const failed = [];
for (const [i] of JSON.parse(args[0])) {
  try { if (!ns.sleeve.setToSynchronize(i)) failed.push([i, "refused"]); }
  catch (e) { failed.push([i, String(e?.message ?? e)]); }
}
return failed;
`;

const CRIME = `
const failed = [];
for (const [i, crime] of JSON.parse(args[0])) {
  try { if (!ns.sleeve.setToCommitCrime(i, crime)) failed.push([i, "refused"]); }
  catch (e) { failed.push([i, String(e?.message ?? e)]); }
}
return failed;
`;

/** Only where the sleeve stands - setToGymWorkout returns false in any other city. */
const GYM = `
const failed = [];
for (const [i, gym, stat] of JSON.parse(args[0])) {
  try { if (!ns.sleeve.setToGymWorkout(i, gym, stat)) failed.push([i, "refused"]); }
  catch (e) { failed.push([i, String(e?.message ?? e)]); }
}
return failed;
`;

const FACTION = `
const failed = [];
for (const [i, faction, type] of JSON.parse(args[0])) {
  try { if (!ns.sleeve.setToFactionWork(i, faction, type)) failed.push([i, "refused"]); }
  catch (e) { failed.push([i, String(e?.message ?? e)]); }
}
return failed;
`;

const COMPANY = `
const failed = [];
for (const [i, company] of JSON.parse(args[0])) {
  try { if (!ns.sleeve.setToCompanyWork(i, company)) failed.push([i, "refused"]); }
  catch (e) { failed.push([i, String(e?.message ?? e)]); }
}
return failed;
`;

// The aug bodies. getSleevePurchasableAugs lists what a sleeve may buy NOW -
// joined factions, the player's rep over each aug's requirement, and only augs
// with a multiplier a sleeve can use - with the flat base price.

const AVAIL = `
const out = {};
for (const i of JSON.parse(args[0])) out[i] = ns.sleeve.getSleevePurchasableAugs(i);
return out;
`;

/** In plan order. The game refuses at shock > 0 or short cash; the rest go on. */
const BUY = `
const bought = [];
for (const [i, name] of JSON.parse(args[0])) {
  try { if (ns.sleeve.purchaseSleeveAug(i, name)) bought.push([i, name]); } catch (e) {}
}
return bought;
`;

/**
 * What each aug multiplies, for the tiers. Singularity: 5.00 at SF4.3 or in
 * BN4, x4 at SF4.2 and x16 at SF4.1 (SF4Cost), where it will not fit and the
 * pass buys cheapest-first instead. Cached in AUG_STATS_FILE - stats are fixed.
 */
const STATS = `
const out = {};
for (const a of JSON.parse(args[0])) out[a] = ns.singularity.getAugmentationStats(a);
return out;
`;

// The Covenant's two sales, BN10 only - both permanent. Prices are formulas
// the planner computes, so only the purchases are bodies.

const BUY_SLEEVE = `return ns.sleeve.purchaseSleeve();`;

const MEMORY = `
const out = [];
for (const [i, n] of JSON.parse(args[0])) {
  try { out.push([i, ns.sleeve.upgradeMemory(i, n).success]); } catch (e) { out.push([i, false]); }
}
return out;
`;

/**
 * In this order, and it matters: the game refuses a faction or company that
 * ANOTHER sleeve is working, so every sleeve leaving one must have left before
 * any sleeve is put on one.
 */
const ACTS = [
  ["recover", RECOVER, () => []],
  ["sync", SYNC, () => []],
  ["crime", CRIME, (a) => [a.crime]],
  ["gym", GYM, (a) => [a.gym, a.stat]],
  ["faction", FACTION, (a) => [a.faction, a.type]],
  ["company", COMPANY, (a) => [a.company]],
];

// -------------------------------------------------------------------- main ---

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const lines = [];
  // STATUS_FILE is a snapshot, rewritten every pass - so what HAPPENED between
  // two looks (a task change, a purchase, a refusal) also goes to HISTORY_FILE,
  // timestamped and kept. A line already in the last snapshot is not news: a
  // warning that repeats every pass is logged the pass it first appears.
  const before = new Set(ns.read(STATUS_FILE).split("\n"));
  const events = [];
  const say = {
    line: (l) => lines.push(l),
    event: (l) => {
      lines.push(l);
      if (!before.has(l)) events.push(l);
    },
  };
  const finish = (onFaction) => {
    // The log too, not just the file: it survives exit under "Recently killed"
    // in Active Scripts, and a hand-run with a tail shows it live.
    for (const l of lines) ns.print(l);
    ns.write(STATUS_FILE, lines.join("\n") + "\n", "w");
    if (events.length) {
      const stamp = new Date().toLocaleString();
      const kept = ns.read(HISTORY_FILE).split("\n").filter(Boolean);
      const all = [...kept, ...events.map((e) => `${stamp}  ${e}`)].slice(-HISTORY_KEEP);
      ns.write(HISTORY_FILE, all.join("\n") + "\n", "w");
    }
    const mark = onFaction ? "faction" : "";
    if (ns.read(SLEEVE_FACTION_MARKER) !== mark) ns.write(SLEEVE_FACTION_MARKER, mark, "w");
  };
  const call = async (tag, body, ...args) => {
    try {
      return await rpc(ns, body, ...args);
    } catch (e) {
      say.event(`WARN: ${tag} failed - ${String(e?.message ?? e)}`);
      return null;
    }
  };

  const count = await call("count", COUNT);
  if (!count) return finish(false);
  if (!count.n) {
    say.line("no sleeves");
    return finish(false);
  }
  const read = await call("read", READ, count.n);
  const tasks = read && await call("tasks", TASKS, count.n);
  // Never act on half a picture: an assignment from stale tasks can put two
  // sleeves on one faction, which the game refuses.
  if (!tasks) return finish(ns.read(SLEEVE_FACTION_MARKER) === "faction");

  const cfg = ns.read(SETTINGS_FILE);
  const actions = assign({
    sleeves: read.sleeves, tasks, player: read.player,
    want: parseWant(ns.read(REP_WANT_MARKER)),
    karma: setting(cfg, "gang.enabled") === 1 && !ns.args.includes("--no-gang"),
    canGang: count.canGang, inGang: read.inGang,
  });

  const failed = new Map();
  const changed = new Set();
  for (const [kind, body, argsOf] of ACTS) {
    const jobs = actions.map((a, i) => [i, a]).filter(([i, a]) => a.kind === kind && !sameTask(tasks[i], a));
    if (!jobs.length) continue;
    const refused = await call(kind, body, JSON.stringify(jobs.map(([i, a]) => [i, ...argsOf(a)])));
    for (const [i] of jobs) {
      const why = refused === null ? "the body failed" : refused.find(([j]) => j === i)?.[1];
      if (why) failed.set(i, why);
      else changed.add(i);
    }
  }

  actions.forEach((a, i) => {
    const s = read.sleeves[i];
    const state = `shock ${ns.format.number(s.shock, 1)}, sync ${ns.format.number(s.sync, 1)}`;
    const was = changed.has(i) ? ` [was ${describeTask(tasks[i])}]` : "";
    if (failed.has(i)) say.event(`sleeve ${i}: could not start ${describeAction(a)} - ${failed.get(i)}`);
    else (was ? say.event : say.line)(`sleeve ${i}: ${describeAction(a)} (${state}) - ${a.why}${was}`);
  });
  const spent = await buyAugs(ns, cfg, read, actions, say);
  await buyCovenant(ns, cfg, count, read, spent, say);
  finish(actions.some((a, i) => a.kind === "faction" && !failed.has(i)));
}

/**
 * The aug step: shock-0 sleeves only (the game refuses otherwise), budget from
 * the live sleeve.augCash, batches per planAugs. Its own try around every body:
 * a failed aug read must not cost the pass its status lines.
 */
async function buyAugs(ns, cfg, read, actions, say) {
  const budget = setting(cfg, "sleeve.augCash") * (read.player.money ?? 0);
  const ready = read.sleeves.map((s, i) => i).filter((i) => read.sleeves[i].shock <= 0);
  if (!(budget > 0) || !ready.length) return 0;
  const quiet = async (body, arg) => { try { return await rpc(ns, body, arg); } catch { return null; } };

  const avail = await quiet(AVAIL, JSON.stringify(ready));
  if (!avail) {
    say.event("augs: could not read what the sleeves may buy");
    return 0;
  }
  let stats = {};
  try { stats = JSON.parse(ns.read(AUG_STATS_FILE) || "{}"); } catch { stats = {}; }
  const unread = [...new Set(Object.values(avail).flat().map((a) => a.name))].filter((n) => !(n in stats));
  if (unread.length) {
    const got = await quiet(STATS, JSON.stringify(unread));
    if (got) {
      stats = { ...stats, ...got };
      ns.write(AUG_STATS_FILE, JSON.stringify(stats), "w");
    } else {
      say.line(`augs: ${unread.length} aug(s) unrated - no RAM or no SF4 for getAugmentationStats, cheapest first`);
    }
  }

  const plan = planAugs({
    sleeves: read.sleeves, actions, avail, stats, budget, minBatch: setting(cfg, "sleeve.augMin"),
  });
  let spent = 0;
  for (const b of plan.buys) {
    const got = (await quiet(BUY, JSON.stringify(b.names.map((n) => [b.i, n])))) ?? [];
    const names = got.map(([, n]) => n);
    spent += avail[b.i].filter((a) => names.includes(a.name)).reduce((t, a) => t + a.cost, 0);
    say.event(names.length
      ? `augs: sleeve ${b.i} bought ${names.length} ($${ns.format.number(b.cost, 2)}, exp wiped) - ${names.join(", ")}`
      : `augs: sleeve ${b.i} - the game refused all ${b.names.length} planned`);
  }
  for (const w of plan.waits) {
    say.line(`augs: sleeve ${w.i} waits - ${w.fit} of ${w.of} affordable at ` +
      `$${ns.format.number(budget, 2)}, batch min ${setting(cfg, "sleeve.augMin")}`);
  }
  return spent;
}

/**
 * The Covenant step: the next sleeve, then memory from the surplus above it -
 * planCovenant decides, against cash less what the aug step just spent.
 * Silent outside BN10 or before the faction is joined: nothing to say there.
 */
async function buyCovenant(ns, cfg, count, read, spent, say) {
  const frac = setting(cfg, "sleeve.covenantCash");
  const cash = (read.player.money ?? 0) - spent;
  const plan = planCovenant({
    sleeves: read.sleeves, sf10: count.sf10, node: count.node, factions: read.player.factions, cash, frac,
  });
  if (!plan || !(frac > 0)) return;
  const $ = (v) => `$${ns.format.number(v, 2)}`;
  if (plan.sleeve) {
    let r = null;
    try { r = await rpc(ns, BUY_SLEEVE); } catch (e) { r = { success: false, message: String(e?.message ?? e) }; }
    say.event(r?.success
      ? `covenant: bought sleeve ${read.sleeves.length} for ${$(plan.sleeve)} - it starts next pass`
      : `covenant: the game refused a ${$(plan.sleeve)} sleeve - ${r?.message ?? "no reply"}`);
  } else if (Number.isFinite(plan.next)) {
    // The wait goes to the history too, but only its stable half: cash moves
    // every pass, and an event is logged whenever its text is new.
    say.event(`covenant: next sleeve ${$(plan.next)}, buys at ${ns.format.percent(frac, 0)} of cash`);
    say.line(`covenant: cash ${$(cash)}, needs ${$(plan.next / frac)}`);
  } else {
    say.event("covenant: all five sleeves bought");
  }
  if (plan.memory.length) {
    let got = [];
    try { got = await rpc(ns, MEMORY, JSON.stringify(plan.memory.map((m) => [m.i, m.amount]))); } catch { got = []; }
    for (const m of plan.memory) {
      const ok = got.some(([i, yes]) => i === m.i && yes);
      const was = read.sleeves[m.i].memory ?? 1;
      say.event(ok
        ? `memory: sleeve ${m.i} +${m.amount} -> ${was + m.amount} for ${$(m.cost)}`
        : `memory: the game refused +${m.amount} for sleeve ${m.i}`);
    }
  } else if (Number.isFinite(plan.nextPoint)) {
    say.event(`memory: next point ${$(plan.nextPoint)}` +
      (Number.isFinite(plan.next) ? " (saving for the next sleeve)" : ""));
    say.line(`memory: surplus ${$(plan.surplus)}, spends ${ns.format.percent(frac, 0)} of it`);
  }
}
