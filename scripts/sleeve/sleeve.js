import { STATUS_FILE, REP_WANT_MARKER, SLEEVE_FACTION_MARKER } from "./config.js";
import { assign, sameTask, parseWant, describeAction, describeTask } from "./plan.js";
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
return { n: ns.sleeve.getNumSleeves(), canGang: reset.currentNode === 2 || reset.ownedSF.has(2) };
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
  sleeves.push({ shock: s.shock, sync: s.sync, skills: s.skills, exp: s.exp, mults: s.mults, city: s.city,
    gym: owned ? { strength: gains(s, "str", "strExp"), defense: gains(s, "def", "defExp"),
      dexterity: gains(s, "dex", "dexExp"), agility: gains(s, "agi", "agiExp") } : null });
}
const p = ns.getPlayer();
return { sleeves, player: { karma: p.karma, skills: p.skills }, inGang: ns.gang.inGang() };
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
  const finish = (onFaction) => {
    // The log too, not just the file: it survives exit under "Recently killed"
    // in Active Scripts, and a hand-run with a tail shows it live.
    for (const l of lines) ns.print(l);
    ns.write(STATUS_FILE, lines.join("\n") + "\n", "w");
    const mark = onFaction ? "faction" : "";
    if (ns.read(SLEEVE_FACTION_MARKER) !== mark) ns.write(SLEEVE_FACTION_MARKER, mark, "w");
  };
  const call = async (tag, body, ...args) => {
    try {
      return await rpc(ns, body, ...args);
    } catch (e) {
      lines.push(`WARN: ${tag} failed - ${String(e?.message ?? e)}`);
      return null;
    }
  };

  const count = await call("count", COUNT);
  if (!count) return finish(false);
  if (!count.n) {
    lines.push("no sleeves");
    return finish(false);
  }
  const read = await call("read", READ, count.n);
  const tasks = read && await call("tasks", TASKS, count.n);
  // Never act on half a picture: an assignment from stale tasks can put two
  // sleeves on one faction, which the game refuses.
  if (!tasks) return finish(ns.read(SLEEVE_FACTION_MARKER) === "faction");

  const actions = assign({
    sleeves: read.sleeves, tasks, player: read.player,
    want: parseWant(ns.read(REP_WANT_MARKER)),
    karma: setting(ns.read(SETTINGS_FILE), "gang.enabled") === 1 && !ns.args.includes("--no-gang"),
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
    if (failed.has(i)) lines.push(`sleeve ${i}: could not start ${describeAction(a)} - ${failed.get(i)}`);
    else lines.push(`sleeve ${i}: ${describeAction(a)} (${state}) - ${a.why}${was}`);
  });
  finish(actions.some((a, i) => a.kind === "faction" && !failed.has(i)));
}
