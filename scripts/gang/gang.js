import { TICK_EVERY, ASCEND_EVERY, EQUIP_EVERY, WAR_EVERY, ASCEND_MULT_THRESHOLD } from "./config.js";
import { rpc } from "scripts/rpc.js";

/**
 * The gang supervisor: a cheap resident loop whose gang API calls all run in
 * rpc.js transients.
 *
 * WHY THIS SHAPE. ns.gang is priced off RamCostConstants.GangApiBase = 4, and
 * the whole surface this subsystem needs comes to about 37 GB. Held resident
 * that would not fit a fresh BitNode's 32 GB home beside boot.js, cloud.js and
 * the continuous manager. So every gang call lives in one of the four BODIES
 * below, each run through rpc(), which bills the body to a throwaway script for
 * as long as it runs. This file holds no gang call at all: 1.60 + ns.run 1.00.
 *
 * It used to be four transient FILES (tick, war, ascend, equip) plus a port to
 * report back on, a marker file to pass state between them, and a test that
 * every path in every transient reported before returning. rpc() does all of
 * that already: a body's return value comes back directly, and a body that
 * throws comes back as a throw naming the error - never as silence, which is
 * what the report-on-every-path rule existed to rule out.
 *
 * Each body READS AND ACTS in one process, so no decision is split across a
 * boundary. Every DECISION lives in gang/math.js, which the bodies import:
 * bodies are the API calls around it, and this file formats what they return.
 *
 * AWAITED, ONE AT A TIME - that is the RAM argument. rpc() refuses a second call
 * in flight anyway; fired together the bodies would stack to ~46 GB.
 *
 * THERE IS NO TICK TO DETECT. ns.gang.nextUpdate() (0 GB) resolves on the next
 * gang update and returns the ms of gang time processed - 2000 normally, up to
 * 5000 while bonus time drains. Cadences count updates, so they track bonus time.
 *
 * Usage:  run scripts/gang/gang.js
 *         run scripts/gang/gang.js --create "Slum Snakes"   (found the gang first)
 *         boot.js starts it as a service once ns.gang.inGang() is true.
 *
 * RAM: 1.60 base + run 1.00 = 2.60 GB
 * (nextUpdate, inGang and getBonusTime are 0 GB; config.js holds no ns call.)
 */

// ------------------------------------------------------------------ bodies ---
//
// Plain template literals: rpc() rejects interpolation, and tests/rpc.test.mjs
// parses every one. Each body is billed to its own transient, so the identifier
// rules still bind INSIDE them - no bare `hack`, and respectForNextRecruit only
// as a computed key - or the transient pays for the name.

/**
 * Recruit, pick every member's task, hold wanted down. Returns the state the
 * other bodies need, which is what the marker file used to carry.
 *
 * getTaskNames is free and getTaskStats is billed once however often it is
 * called; a hardcoded task table is the kind of thing that drifts between fork
 * versions without a symptom.
 */
const TICK = `
import { MAX_MEMBERS, MEMBER_PREFIX } from "/scripts/gang/config.js";
import { phaseFor, planTasks, wantedHeadroom } from "/scripts/gang/math.js";
const info = ns.gang.getGangInformation();
if (info.isHacking) return { refused: true };

const names = ns.gang.getMemberNames();
const used = new Set(names);
let next = 0;
let recruited = 0;
while (names.length < MAX_MEMBERS) {
  while (used.has(MEMBER_PREFIX + next)) next++;
  const candidate = MEMBER_PREFIX + next;
  if (!ns.gang.recruitMember(candidate)) break;
  used.add(candidate);
  names.push(candidate);
  recruited++;
}

const members = names.map((n) => ns.gang.getMemberInformation(n));
const tasks = ns.gang.getTaskNames().map((n) => ns.gang.getTaskStats(n));
const phase = phaseFor({ members, territory: info.territory });
const result = planTasks(info, members, tasks, phase);

let moved = 0;
for (const m of members) {
  const want = result.plan.get(m.name);
  if (want && want !== m.task) {
    ns.gang.setMemberTask(m.name, want);
    moved++;
  }
}

const nextAt = info["respectForNextRecruit"];
return {
  phase, recruited, moved,
  memberCount: members.length,
  trainees: result.trainees, vigilantes: result.vigilantes, warSlots: result.warSlots,
  respect: info.respect,
  nextRecruitAt: Number.isFinite(nextAt) ? nextAt : -1,
  wantedLevel: info.wantedLevel,
  headroom: wantedHeadroom(info),
  isHacking: false,
};
`;

/**
 * Engage territory warfare only when the WORST matchup is winnable - a clash is
 * drawn against one rival at a time and a lost one kills a member. Rivals with
 * no territory cannot be clashed with, including our own entry in the map.
 */
const WAR = `
import { warDecision } from "/scripts/gang/math.js";
const info = ns.gang.getGangInformation();
const others = ns.gang.getAllGangInformation();
const chances = [];
for (const [name, other] of Object.entries(others)) {
  if (name === info.faction) continue;
  if (!other || (other.territory ?? 0) <= 0) continue;
  chances.push(ns.gang.getChanceToWinClash(name));
}
const engage = warDecision(info.territoryWarfareEngaged, chances);
const changed = engage !== info.territoryWarfareEngaged;
if (changed) ns.gang.setTerritoryWarfare(engage);
return {
  engage, changed,
  worst: chances.length ? Math.min(...chances) : 0,
  rivals: chances.length,
  territory: info.territory,
  power: info.power,
};
`;

/**
 * Ascend members whose multiplier gain clears the threshold, unless it would
 * cost the next recruit. Decrements its own running respect rather than
 * re-reading the gang. getAscensionResult is null for a member who cannot.
 */
const ASCEND = `
import { shouldAscend, ascensionFactor } from "/scripts/gang/math.js";
import { ASCEND_MULT_THRESHOLD } from "/scripts/gang/config.js";
const state = JSON.parse(args[0]);
if (state.nextRecruitAt < 0) state.nextRecruitAt = Infinity;
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
    respect = Math.max(1, respect - (result.respect ?? 0));
    done.push({ name, factor });
  } else if (factor >= ASCEND_MULT_THRESHOLD) {
    blocked++;
  }
}
return { done, best, blocked, respect };
`;

/**
 * Buy gear, cheapest item first across the whole gang. getEquipmentStats is
 * there for isHackingItem: hack-only gear is a separate tier, opened only when
 * every member owns the combat list. A pass that buys nothing returns the
 * numbers that say why, derived through the same functions the planner used.
 */
const EQUIP = `
import { planPurchases, equipBudget, eligibleItems, considerItems } from "/scripts/gang/math.js";
const state = JSON.parse(args[0]);
const members = ns.gang.getMemberNames().map((n) => ns.gang.getMemberInformation(n));
const items = ns.gang.getEquipmentNames().map((n) => ({
  name: n,
  cost: ns.gang.getEquipmentCost(n),
  type: ns.gang.getEquipmentType(n),
  stats: ns.gang.getEquipmentStats(n),
}));
const budget = equipBudget(ns.getServerMoneyAvailable("home"));
const buys = planPurchases(members, items, budget, state.isHacking);
const eligible = eligibleItems(items);
const pool = considerItems(members, items, state.isHacking);
let bought = 0;
let spent = 0;
for (const b of buys) {
  if (!ns.gang.purchaseEquipment(b.member, b.item)) break;
  bought++;
  spent += b.cost;
}
return {
  planned: buys.length, bought, spent, budget,
  items: items.length, eligible: eligible.length,
  cheapest: pool.length ? pool[0].cost : 0,
  gated: eligible.length - pool.length,
};
`;

const CREATE = `return ns.gang.createGang(args[0]);`;

// ------------------------------------------------------------------ format ---

const n2 = (ns, v) => ns.format.number(v, 2, 1000, true);

function tickLine(ns, t) {
  const next = t.nextRecruitAt < 0 ? "roster full" : `next recruit at ${n2(ns, t.nextRecruitAt)}`;
  return `${t.phase}, ${t.memberCount} members${t.recruited ? ` (+${t.recruited})` : ""}, ` +
    `${t.moved} reassigned | ${t.trainees} training, ${t.vigilantes} penance, ` +
    `${t.warSlots} territory | respect ${n2(ns, t.respect)} (${next}) | ` +
    `wanted ${ns.format.number(t.wantedLevel, 2)}, ${ns.format.percent(t.headroom, 1)} of achievable`;
}

function warLine(ns, w) {
  // Every pass, not only on a change: "nothing changed" is the answer to "why
  // are we not taking territory", and it is the answer most of the time.
  return `${w.engage ? "ENGAGED" : "standing down"}${w.changed ? " (changed)" : ""} | ` +
    `worst win chance ${ns.format.percent(w.worst, 1)} across ${w.rivals} rivals | ` +
    `holding ${ns.format.percent(w.territory, 1)}, power ${n2(ns, w.power)}`;
}

function ascendLine(ns, a, state) {
  if (a.done.length) {
    const who = a.done.map((d) => `${d.name} x${d.factor.toFixed(2)}`).join(", ");
    return `${a.done.length} ascended (${who}) | respect now ${n2(ns, a.respect)}`;
  }
  if (a.blocked) {
    return `${a.blocked} ready at x${a.best.toFixed(2)} but HELD - ascending would drop respect ` +
      `under the ${n2(ns, state.nextRecruitAt)} needed for the next recruit`;
  }
  return `none ready - best x${a.best.toFixed(2)}, need x${ASCEND_MULT_THRESHOLD.toFixed(2)}`;
}

function equipLine(ns, e, state) {
  if (e.planned === 0) {
    let why;
    if (!e.eligible) why = "the game lists no item with a price";
    else if (e.cheapest > e.budget) why = `cheapest is $${ns.format.number(e.cheapest, 2)}, over budget`;
    else why = "the gang already owns every item it can afford";
    if (e.gated > 0) {
      why += `; ${e.gated} hacking-only item(s) held back until every member owns the combat list`;
    }
    return `nothing bought in ${state.phase}: ${e.eligible}/${e.items} items eligible, ` +
      `budget $${ns.format.number(e.budget, 2)} - ${why}`;
  }
  if (e.bought === 0) return `refused all ${e.planned} planned buys - money moved since the plan`;
  return `bought ${e.bought} of ${e.planned} planned for $${ns.format.number(e.spent, 2)} (${state.phase})`;
}

// -------------------------------------------------------------------- main ---

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const log = (s) => ns.print(`${new Date().toLocaleTimeString()}  ${s}`);

  /**
   * One body, and a failure that says so. Not fatal: early in a BitNode home
   * may have no room for a 14 GB transient, and a throw here would stop the
   * supervisor for boot to restart into the same wall a minute later.
   */
  const call = async (tag, body, ...args) => {
    try {
      return await rpc(ns, body, ...args);
    } catch (e) {
      log(`WARN: ${tag} failed - ${e.message ?? e}`);
      return null;
    }
  };

  const args = ns.args.map(String);
  const cIdx = args.indexOf("--create");
  if (cIdx >= 0 && !ns.gang.inGang()) {
    // Irreversible for the BitNode and picks the faction, so it is only ever
    // asked for by hand. createGang says no when karma or membership is short.
    const faction = args[cIdx + 1] ?? "";
    const made = faction && (await call("create", CREATE, faction));
    ns.tprint(made
      ? `gang founded with ${faction}.`
      : `ERROR: could not found a gang with "${faction}". Needs karma <= -54000 and membership in it.`);
  }

  if (!ns.gang.inGang()) {
    ns.tprint('gang: not in a gang - run scripts/gang/gang.js --create "<faction>" first.');
    return;
  }

  log("gang supervisor up");

  let updates = 0;
  let state = null;
  let lastPhase = "";

  while (true) {
    await ns.gang.nextUpdate();
    updates++;

    // tick first, always: it produces the state ascend and equip decide from,
    // so on a pass where several coincide they get this pass's numbers.
    if (updates % TICK_EVERY === 0) {
      const t = await call("tick", TICK);
      if (t?.refused) {
        ns.tprint("ERROR: gang/gang.js manages COMBAT gangs and this is a hacking gang. Refusing.");
        log("tick: REFUSED - hacking gang");
      } else if (t) {
        state = t;
        log(`tick: ${tickLine(ns, t)}`);
      }
    }
    if (updates % WAR_EVERY === 0) {
      const w = await call("war", WAR);
      if (w) log(`war: ${warLine(ns, w)}`);
    }
    // No tick yet means no respect guard to check against. Skipping is right;
    // guessing at the guard is not.
    if (updates % ASCEND_EVERY === 0) {
      const a = state && (await call("ascend", ASCEND, JSON.stringify(state)));
      log(`ascend: ${a ? ascendLine(ns, a, state) : state ? "skipped" : "no tick yet, skipping"}`);
    }
    if (updates % EQUIP_EVERY === 0) {
      const e = state && (await call("equip", EQUIP, JSON.stringify(state)));
      log(`equip: ${e ? equipLine(ns, e, state) : state ? "skipped" : "no tick yet, skipping"}`);
    }

    if (state && state.phase !== lastPhase) {
      lastPhase = state.phase;
      log(`PHASE -> ${state.phase}  (bonus time ${ns.format.time(ns.gang.getBonusTime())})`);
    }
  }
}
