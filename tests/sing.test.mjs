import fs from "node:fs";
import path from "node:path";
import { loadScripts, readScript, assert } from "./harness.mjs";
import { makeNs } from "./mockNs.mjs";

/**
 * The singularity subsystem.
 *
 * The RAM pins live in tests/ram.test.mjs, beside the cost table they price
 * against. This file is behaviour: the decisions in plan.js, the invariants the
 * bodies must keep, and sing.js's loop driven against a fake singularity API -
 * with every rpc transient really executed by the mock's ns.run.
 */

const SF4_ERROR = "commitCrime: This singularity function requires Source-File 4 to run. " +
  "A power up you obtain later in the game.";

const strong = { strength: 100, defense: 100, dexterity: 100, agility: 100, hacking: 10, charisma: 1 };

function player(over = {}) {
  return {
    skills: { ...strong }, city: "Sector-12", karma: 0, factions: [], jobs: {}, money: 1e9,
    mults: { faction_rep: 1 }, ...over,
  };
}

/**
 * A faction selling nothing now has a rep target of 0 and is never worked, so a
 * loop test that wants CyberSec or Bachman worked must give them an aug to sell -
 * one no rep reaches, so it is never bought either.
 */
const SELLS = {
  CyberSec: [{ name: "Out Of Reach", rep: 1e12, price: 1 }],
  "Bachman & Associates": [{ name: "Also Out Of Reach", rep: 1e12, price: 1 }],
};

function state(over = {}) {
  return { hasSF2: false, inGang: false, rep: {}, workTypes: {}, companyRep: {}, ...over };
}

/**
 * Run sing.js's main for `ticks` ticks against a stateful fake.
 *
 * `api` overrides any singularity function. The fake keeps Player.currentWork
 * the way the game does - every work-starting call replaces it - so a
 * supervisor that restarts work every tick is visible as repeated calls.
 */
async function driveSing(mods, {
  ticks = 4, work = null, hasTor = false, invites = [], p = player(),
  ownedSF = new Map(), inGang = false, api = {}, run = undefined, companyRep = 0,
  rep = {}, files = {}, favor = {}, extra = {},
  // {faction: [{name, rep, price, prereqs?}]} - what the fake sells. Tian Di Hui
  // sells the implant by default, so its rep target is real rather than 1e6.
  augs = { "Tian Di Hui": [{ name: "Neuroreceptor Management Implant", rep: 75e3, price: 5e8 }] },
  installed = [],
} = {}) {
  const calls = [];
  let current = work;
  let tor = hasTor;
  let sleeps = 0;
  const rec = (name, fn) => (...a) => { calls.push(`${name}:${a.join(",")}`); return fn(...a); };
  const queued = [];
  const aug = (n) => Object.values(augs).flat().find((a) => a.name === n);
  const singularity = {
    getUpgradeHomeRamCost: () => 1e6,
    upgradeHomeRam: rec("upgradeHomeRam", () => true),
    purchaseTor: rec("purchaseTor", () => { tor = true; return true; }),
    getDarkwebPrograms: () => ["BruteSSH.exe", "FTPCrack.exe"],
    getDarkwebProgramCost: (n) => (n === "BruteSSH.exe" ? 5e5 : 1.5e6),
    purchaseProgram: rec("purchaseProgram", () => true),
    checkFactionInvitations: () => (typeof invites === "function" ? invites() : invites),
    joinFaction: rec("joinFaction", (f) => { p.factions.push(f); return true; }),
    getFactionRep: (f) => rep[f] ?? 0,
    getFactionFavor: (f) => favor[f] ?? 0,
    // donation.ts: $ / 1e6 * faction_rep * FactionWorkRepGain (BN4 0.75).
    donateToFaction: rec("donateToFaction", (f, amt) => {
      rep[f] = (rep[f] ?? 0) + (amt / 1e6) * p.mults.faction_rep * 0.75;
      return true;
    }),
    getFactionWorkTypes: () => ["hacking", "field"],
    getCompanyRep: () => companyRep,
    getCurrentWork: () => current,
    gymWorkout: rec("gymWorkout", (gym, stat) => {
      current = { type: "CLASS", classType: stat, location: gym };
      return true;
    }),
    commitCrime: rec("commitCrime", (crime) => { current = { type: "CRIME", crimeType: crime }; return 3000; }),
    workForFaction: rec("workForFaction", (faction, type) => {
      current = { type: "FACTION", factionName: faction, factionWorkType: type };
      return true;
    }),
    workForCompany: rec("workForCompany", (company) => {
      current = { type: "COMPANY", companyName: company };
      return true;
    }),
    applyToCompany: rec("applyToCompany", (company) => {
      const had = p.jobs[company];
      p.jobs[company] = had ? "Junior Software Engineer" : "Software Engineering Intern";
      return had === p.jobs[company] ? null : p.jobs[company];
    }),
    travelToCity: rec("travelToCity", (city) => { p.city = city; return true; }),
    getOwnedAugmentations: (purchased) => (purchased ? [...installed, ...queued] : [...installed]),
    getAugmentationsFromFaction: (f) => (augs[f] ?? []).map((a) => a.name),
    getAugmentationPrereq: (n) => aug(n)?.prereqs ?? [],
    getAugmentationRepReq: (n) => aug(n)?.rep ?? 0,
    // The game's own pricing: every queued aug multiplies the rest by 1.9.
    getAugmentationPrice: (n) => (aug(n)?.price ?? 0) * 1.9 ** queued.length,
    purchaseAugmentation: rec("purchaseAugmentation", (f, n) => { queued.push(n); return true; }),
    ...api,
  };
  const ns = makeNs({
    files: { ...files },
    servers: { home: { moneyAvailable: 1e9 } },
    extra: {
      singularity,
      gang: { inGang: () => inGang },
      getPlayer: () => p,
      getResetInfo: () => ({ currentNode: 4, ownedSF }),
      getFavorToDonate: () => 150,
      getBitNodeMultipliers: () => ({ FactionWorkRepGain: 0.75 }),
      hasTorRouter: rec("hasTorRouter", () => tor),
      sleep: async () => {
        if (++sleeps >= ticks) throw new Error("STOP");
        await new Promise((r) => setTimeout(r, 1));
      },
      ...(run ? { run } : {}),
      ...extra,
    },
  });
  try {
    await mods["sing/sing"].main(ns);
    assert(false, "the loop should only end by the STOP sentinel");
  } catch (e) {
    if (e.message !== "STOP") throw e;
  }
  return { ns, calls, count: (name) => calls.filter((c) => c.startsWith(`${name}:`)).length };
}

/** sing.js's rpc bodies by const name, as tests/rpc.test.mjs extracts them. */
function bodies() {
  const out = {};
  for (const m of readScript("sing/sing").matchAll(/\bconst\s+([A-Z_]+)\s*=\s*`([\s\S]*?)`;/g)) out[m[1]] = m[2];
  return out;
}

/** Every sing/ file, comments stripped. */
function singSources() {
  const dir = path.resolve(import.meta.dirname, "..", "scripts", "sing");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => [f,
    fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")]);
}

export const tests = {
  // ------------------------------------------------------------- plan.js ----

  "a stat under the floor trains at the gym, lowest stat first - for the gang grind only": async () => {
    const { chooseAction } = (await loadScripts())["sing/plan"];
    const weak = player({ skills: { ...strong, dexterity: 5, agility: 9 } });
    const a = chooseAction(weak, state({ grindKarma: true }));
    assert(a.kind === "gym" && a.stat === "dex", `expected gym dex, got ${JSON.stringify(a)}`);
    // The gym serves the gang grind and nothing else.
    assert(chooseAction(weak, state()).kind === "idle", "no gang grind, no gym");
  },

  // gymWorkout returns false outside the gym's own city. Choosing it anyway
  // would fail every tick; falling through is right - every city has Slums.
  "the gym is skipped outside its city": async () => {
    const { chooseAction } = (await loadScripts())["sing/plan"];
    const a = chooseAction(player({ city: "Aevum", skills: { ...strong, strength: 1 } }),
      state({ hasSF2: true, grindKarma: true }));
    assert(a.kind === "crime", `expected crime, got ${JSON.stringify(a)}`);
  },

  // ~15 hours of Homicide is rep not earned anywhere else, so it happens only
  // when asked for - and without SF2 there is no gang in BN4 to found at all.
  "crime only when asked for, with SF2, no gang, and karma above the target": async () => {
    const mods = await loadScripts();
    const { chooseAction } = mods["sing/plan"];
    const { GANG_KARMA_TARGET, GRIND_GANG_KARMA } = mods["sing/config"];
    assert(GRIND_GANG_KARMA === false, "the gang grind must default OFF");
    const on = { hasSF2: true, grindKarma: true };
    const ok = (p, s) => chooseAction(p, s).kind === "crime";
    assert(ok(player(), state(on)), "asked for, SF2, no gang, karma 0 should grind karma");
    assert(!ok(player(), state({ ...on, grindKarma: false })), "not asked for");
    assert(!ok(player(), state({ ...on, hasSF2: false })), "no SF2 - no gang to found");
    assert(!ok(player(), state({ ...on, inGang: true })), "already in a gang");
    assert(!ok(player({ karma: GANG_KARMA_TARGET - 1 }), state(on)), "karma already there");
  },

  // Hacking factions highest first: the higher shops largely cover the lower
  // ones' augs, so rep earned there buys CyberSec's too.
  "faction work follows the order list and the preferred work type": async () => {
    const mods = await loadScripts();
    const { chooseAction } = mods["sing/plan"];
    const a = chooseAction(player({ factions: ["Sector-12", "CyberSec", "NiteSec"] }), state({
      workTypes: { "Sector-12": ["hacking"], CyberSec: ["hacking"], NiteSec: ["security", "hacking"] },
    }));
    assert(a.kind === "faction" && a.faction === "NiteSec" && a.type === "hacking",
      `NiteSec is the first joined faction in WORK_ORDER, got ${JSON.stringify(a)}`);
    const HACKERS = ["Daedalus", "BitRunners", "The Black Hand", "NiteSec", "CyberSec"];
    const order = mods["sing/config"].WORK_ORDER.map((st) => st.faction).filter((f) => HACKERS.includes(f));
    assert(JSON.stringify(order) === JSON.stringify(HACKERS), `highest first, got ${order}`);
  },

  // A faction is worked to the rep its unbought augs need, and not past it -
  // the live case was Tian Di Hui being farmed with every aug already bought.
  "Tian Di Hui goes first, and only to its aug target": async () => {
    const { chooseAction } = (await loadScripts())["sing/plan"];
    const p = player({ factions: ["CyberSec", "Tian Di Hui"] });
    const workTypes = { CyberSec: ["hacking"], "Tian Di Hui": ["hacking"] };
    const targets = { "Tian Di Hui": 75e3, CyberSec: 10e3 };
    const before = chooseAction(p, state({ workTypes, targets, rep: { "Tian Di Hui": 74e3 } }));
    assert(before.faction === "Tian Di Hui", `expected Tian Di Hui first, got ${JSON.stringify(before)}`);
    const after = chooseAction(p, state({ workTypes, targets, rep: { "Tian Di Hui": 75e3 } }));
    assert(after.faction === "CyberSec", `at its target it should move on, got ${JSON.stringify(after)}`);
    const bought = chooseAction(p, state({ workTypes, targets: { ...targets, "Tian Di Hui": 0 } }));
    assert(bought.faction === "CyberSec", `every aug bought - target 0 - skip it, got ${JSON.stringify(bought)}`);
  },

  // ---------------------------------------------------------- donation ----

  "canDonate: favor at the bar, and a faction that offers work": async () => {
    const { canDonate } = (await loadScripts())["sing/plan"];
    const st = { favor: { A: 150, B: 149, G: 500 }, favorNeed: 150, workTypes: { A: ["hacking"], B: ["hacking"], G: [] } };
    assert(canDonate("A", st), "150 of 150");
    assert(!canDonate("B", st), "149 is short");
    assert(!canDonate("G", st), "the gang's faction offers no work, and donateToFaction refuses it");
    assert(!canDonate("A", { ...st, favorNeed: 0 }), "favor not read yet is not a yes");
  },

  // The live case: Bachman worked for 375k rep with 150 favor already banked.
  "a faction that takes donations is bought, not worked - unless nothing else is left": async () => {
    const { chooseAction } = (await loadScripts())["sing/plan"];
    const p = player({ factions: ["Bachman & Associates", "CyberSec"] });
    const st = state({
      workTypes: { "Bachman & Associates": ["hacking"], CyberSec: ["hacking"] },
      targets: { "Bachman & Associates": 375e3, CyberSec: 10e3 },
      favor: { "Bachman & Associates": 150 }, favorNeed: 150,
    });
    assert(chooseAction(p, st).faction === "CyberSec", "work moves on past the donatable faction");
    const alone = chooseAction(p, { ...st, targets: { ...st.targets, CyberSec: 0 } });
    assert(alone.faction === "Bachman & Associates", `nothing else: work it rather than idle, got ${JSON.stringify(alone)}`);
  },

  "planDonations: cheapest to finish first, within the budget, one rep over": async () => {
    const mods = await loadScripts();
    const { planDonations } = mods["sing/plan"];
    const { DONATE_BUDGET_FRACTION } = mods["sing/config"];
    const perRep = 1e6 / (2 * 0.75);
    const base = {
      targets: { A: 100e3, B: 10e3, C: 50e3, D: 50e3 }, rep: { A: 0, B: 0, C: 60e3, D: 0, E: 0 },
      favor: { A: 200, B: 150, C: 150, D: 10, E: 150 }, favorNeed: 150,
      workTypes: { A: ["hacking"], B: ["hacking"], C: ["hacking"], D: ["hacking"], E: ["hacking"] },
      repMult: 2, bnRepMult: 0.75,
    };
    const rich = planDonations({ ...base, cash: 1e15 });
    assert(JSON.stringify(rich.map((d) => d.faction)) === '["B","A"]',
      `B (10k short) then A; C is past its target, D lacks favor, E has no target: ${JSON.stringify(rich)}`);
    assert(Math.abs(rich[0].amount - 10001 * perRep) < 1, `B: 10001 rep at ${perRep}/rep, got ${rich[0].amount}`);
    const poor = planDonations({ ...base, cash: 12001 * perRep / DONATE_BUDGET_FRACTION });
    assert(poor.length === 2 && Math.abs(poor[1].amount - 2000 * perRep) < 1,
      `the budget finishes B and puts the last 2000 rep's worth into A: ${JSON.stringify(poor)}`);
  },

  // End to end: the donation lands in the aug pass and the work goes elsewhere.
  "a favored faction is donated to its target and never worked": async () => {
    const mods = await loadScripts();
    const r = await driveSing(mods, {
      ticks: 1, p: player({ factions: ["Bachman & Associates", "CyberSec"], money: 1e13 }),
      favor: { "Bachman & Associates": 150 },
      augs: { ...SELLS, "Bachman & Associates": [{ name: "SmartJaw", rep: 375e3, price: 1e15 }] },
    });
    const d = r.calls.filter((c) => c.startsWith("donateToFaction:"));
    assert(d.length === 1 && d[0].startsWith("donateToFaction:Bachman & Associates,"), `one donation: ${d}`);
    const amt = Number(d[0].split(",")[1]);
    assert(Math.abs(amt - 375001 / 0.75 * 1e6) < 1, `375001 rep at 1.33m per rep, got ${amt}`);
    assert(!r.calls.some((c) => c.startsWith("workForFaction:Bachman")), "not worked");
    assert(r.calls.some((c) => c.startsWith("workForFaction:CyberSec")), "the work moved on");
    assert(r.ns._log.some((l) => l.includes("donate: $")), `logged: ${r.ns._log}`);
  },

  // The price comes from the game, never a guess: without SF5 the read throws,
  // and nothing is donated.
  "no Source-File 5, no donation - and one warning": async () => {
    const mods = await loadScripts();
    const r = await driveSing(mods, {
      ticks: 7, p: player({ factions: ["Bachman & Associates", "CyberSec"], money: 1e13 }),
      favor: { "Bachman & Associates": 150 },
      augs: { ...SELLS, "Bachman & Associates": [{ name: "SmartJaw", rep: 375e3, price: 1e15 }] },
      extra: { getBitNodeMultipliers: () => { throw new Error("Requires Source-File 5 to run."); } },
    });
    assert(r.count("donateToFaction") === 0, "no multiplier, no donation");
    assert(r.ns._log.filter((l) => l.includes("WARN: bitnode mults failed")).length === 1, `warned once: ${r.ns._log}`);
  },

  // Ten augs already unlocked: the batch lacks CASH, and a donation would only
  // push it further away.
  "no donation while the batch is waiting on cash, not rep": async () => {
    const mods = await loadScripts();
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: `aug${i}`, rep: 1, price: 1e15 }));
    const r = await driveSing(mods, {
      ticks: 1, p: player({ factions: ["Bachman & Associates", "CyberSec"], money: 1e13 }),
      rep: { CyberSec: 1e3 }, favor: { "Bachman & Associates": 150 },
      augs: { CyberSec: ten, "Bachman & Associates": [{ name: "SmartJaw", rep: 375e3, price: 1e15 }] },
    });
    assert(r.count("donateToFaction") === 0, "saved for the batch");
    assert(r.ns._log.some((l) => l.includes("donate: holding - 10 augs unlocked")), `why: ${r.ns._log}`);
  },

  // ------------------------------------------------------------ augs ----

  "rep targets: the dearest unbought aug, 0 when none, NeuroFlux never counts": async () => {
    const { repTargets } = (await loadScripts())["sing/plan"];
    const augsOf = { A: ["x", "y", "NeuroFlux Governor"], B: ["y"], C: ["NeuroFlux Governor"], D: ["z"] };
    const info = { x: { rep: 5e3 }, y: { rep: 20e3 }, "NeuroFlux Governor": { rep: 1e9 } };
    const t = repTargets(augsOf, ["y"], info);
    assert(t.A === 5e3, `A: y is owned, x needs 5k - got ${t.A}`);
    assert(t.B === 0, `B: everything owned - got ${t.B}`);
    assert(t.C === 0, `C: sells only NeuroFlux - got ${t.C}`);
    assert(t.D === 1e6, `D: z unread must not read as done - got ${t.D}`);
  },

  "the batch: dearest first, each priced x1.9 per aug ahead of it": async () => {
    const { planAugBuys } = (await loadScripts())["sing/plan"];
    const names = Array.from({ length: 10 }, (_, i) => `a${i}`);
    const info = Object.fromEntries(names.map((n, i) => [n, { rep: 1, price: (i + 1) * 1e6 }]));
    const plan = planAugBuys({ augsOf: { F: names }, owned: [], queued: 0, info, prereqs: {}, rep: { F: 1e9 }, cash: 1e15 });
    assert(plan.buys.length === 10, `expected all 10, got ${plan.buys.length}`);
    assert(plan.buys[0].name === "a9" && plan.buys[9].name === "a0", `most expensive first: ${plan.buys.map((b) => b.name)}`);
    for (const [k, b] of plan.buys.entries()) {
      const want = info[b.name].price * 1.9 ** k;
      assert(Math.abs(b.cost - want) < 1e-6 * want, `${b.name} at position ${k}: ${b.cost} vs ${want}`);
    }
  },

  // The user's two rules: at least ten to install, counting the queue - and
  // cash for all of it, or nothing.
  "no batch under ten, none without the cash for all of it, the queue counts": async () => {
    const { planAugBuys } = (await loadScripts())["sing/plan"];
    const names = Array.from({ length: 10 }, (_, i) => `a${i}`);
    const info = Object.fromEntries(names.map((n) => [n, { rep: 1, price: 1e6 }]));
    const base = { augsOf: { F: names }, owned: [], queued: 0, info, prereqs: {}, rep: { F: 1e9 } };
    const full = 1e6 * (1.9 ** 10 - 1) / 0.9;
    assert(planAugBuys({ ...base, cash: full * 1.001 }).buys.length === 10, "ten affordable: buy");
    const short = planAugBuys({ ...base, cash: full * 0.99 });
    assert(short.buys.length === 0 && short.batch === 9, `nine affordable: buy nothing, got ${short.buys.length}`);
    const nine = planAugBuys({ ...base, augsOf: { F: names.slice(0, 9) }, cash: 1e15 });
    assert(nine.buys.length === 0, "nine for sale: buy nothing");
    const topUp = planAugBuys({ ...base, augsOf: { F: names.slice(0, 2) }, queued: 8, cash: 1e15 });
    assert(topUp.buys.length === 2, "eight queued + two: that is ten");
  },

  "NeuroFlux fills the batch, each level dearer in money and rep": async () => {
    const { planAugBuys } = (await loadScripts())["sing/plan"];
    const NFG = "NeuroFlux Governor";
    const names = ["a", "b", "c"];
    const info = { a: { rep: 1, price: 3e6 }, b: { rep: 1, price: 2e6 }, c: { rep: 1, price: 1e6 },
      [NFG]: { rep: 1e3, price: 1e6 } };
    const base = { augsOf: { F: [...names, NFG] }, owned: [], queued: 0, info, prereqs: {}, cash: 1e15 };
    const plan = planAugBuys({ ...base, rep: { F: 1e9 } });
    const levels = plan.buys.filter((b) => b.name === NFG);
    assert(plan.buys.length >= 10 && levels.length >= 7, `3 augs + NeuroFlux to ten or more: ${plan.buys.length}`);
    assert(Math.abs(levels[1].cost / levels[0].cost - 1.14 * 1.9) < 1e-9, "each level x1.14 x1.9");
    // Rep caps the levels: 1e3 x 1.14^k <= 2e3 allows k = 0..5, six levels.
    const capped = planAugBuys({ ...base, rep: { F: 2e3 } });
    assert(capped.buys.length === 0 && capped.batch === 9, `3 + six levels is nine - no batch: ${capped.batch}`);
  },

  "a prerequisite must be owned or earlier in the batch; rep, joins and SoA gate the rest": async () => {
    const { planAugBuys } = (await loadScripts())["sing/plan"];
    const names = Array.from({ length: 12 }, (_, i) => `a${i}`);
    const info = Object.fromEntries(names.map((n, i) => [n, { rep: 1, price: (i + 1) * 1e6 }]));
    info.locked = { rep: 1e12, price: 1e9 };
    info.soa = { rep: 1, price: 1e9 };
    info.far = { rep: 1, price: 1e9 };
    const plan = planAugBuys({
      augsOf: { F: [...names, "locked"], "Shadows of Anarchy": ["soa"], Unjoined: ["far"] },
      owned: [], queued: 0, info,
      // a11 is dearest and needs a0, which comes last: a11 must be skipped.
      prereqs: { a11: ["a0"], a10: ["owned-already"] },
      rep: { F: 1e9, "Shadows of Anarchy": 1e9 }, cash: 1e15,
    });
    const got = plan.buys.map((b) => b.name);
    assert(!got.includes("a11"), "a dependent before its prerequisite must be skipped");
    assert(!got.includes("a10"), "a prerequisite nobody owns must block");
    assert(!got.includes("locked"), "rep not met");
    assert(!got.includes("soa"), "Shadows of Anarchy prices off its own ladder - never");
    assert(!got.includes("far"), "only joined factions sell");
    assert(got.length === 10, `the other ten: ${got}`);
  },

  "the Bachman company step is skipped once its faction's augs are all owned": async () => {
    const { chooseAction } = (await loadScripts())["sing/plan"];
    const p = player({ skills: { ...strong, hacking: 300 }, factions: ["CyberSec"] });
    const workTypes = { CyberSec: ["hacking"] };
    assert(chooseAction(p, state({ workTypes })).kind === "company", "augs unknown: work the company");
    const done = chooseAction(p, state({ workTypes, targets: { "Bachman & Associates": 0 } }));
    assert(done.kind === "faction", `nothing to buy there: skip it, got ${JSON.stringify(done)}`);
  },

  // Bachman & Associates the COMPANY sits after Tian Di Hui and before every
  // other faction: its faction's augs raise rep gain, so they pay for
  // themselves on every later hour of faction work.
  "Bachman company work comes after Tian Di Hui and before the other factions": async () => {
    const { chooseAction } = (await loadScripts())["sing/plan"];
    const workTypes = { CyberSec: ["hacking"], "Tian Di Hui": ["hacking"] };
    const p = player({ skills: { ...strong, hacking: 300 }, factions: ["CyberSec", "Tian Di Hui"] });
    const tdh = chooseAction(p, state({ workTypes, rep: { "Tian Di Hui": 1e3 } }));
    assert(tdh.faction === "Tian Di Hui", `Tian Di Hui first, got ${JSON.stringify(tdh)}`);
    const co = chooseAction(p, state({ workTypes, rep: { "Tian Di Hui": 75e3 }, targets: { "Tian Di Hui": 75e3 } }));
    assert(co.kind === "company" && co.company === "Bachman & Associates" && co.field === "Software" &&
      co.employed === false, `then Bachman, got ${JSON.stringify(co)}`);
  },

  // The bars that end or skip the company step - every one of them a skip, so
  // the next step down gets the time instead.
  "the company step skips below the hiring bar, at 400k, and once the faction is in": async () => {
    const { chooseAction } = (await loadScripts())["sing/plan"];
    const workTypes = { CyberSec: ["hacking"] };
    const pick = (over, st = {}) => chooseAction(player({ factions: ["CyberSec"], ...over }),
      state({ workTypes, ...st })).kind;
    // Entry job is intern reqdHacking 1 + Bachman's jobStatReqOffset 224.
    assert(pick({ skills: { ...strong, hacking: 224 } }) === "faction", "224 hacking cannot be hired");
    assert(pick({ skills: { ...strong, hacking: 225 } }) === "company", "225 can");
    assert(pick({ skills: { ...strong, hacking: 10 }, jobs: { "Bachman & Associates": "IT Intern" } }) === "company",
      "already employed works whatever the hacking level");
    assert(pick({ skills: { ...strong, hacking: 300 } }, { companyRep: { "Bachman & Associates": 400e3 } }) === "faction",
      "400k company rep is the invite bar - done");
    assert(pick({ skills: { ...strong, hacking: 300 }, factions: ["CyberSec", "Bachman & Associates"] }) === "faction",
      "the faction is joined - done");
  },

  // Only ever the Tian Di Hui round trip, and only from/to its own two ends, so
  // a trip the player made by hand is never undone.
  "travel: out for Tian Di Hui with the fare home in hand, back once joined": async () => {
    const { chooseTravel } = (await loadScripts())["sing/plan"];
    const hacker = { ...strong, hacking: 50 };
    assert(chooseTravel(player({ skills: hacker, money: 1.4e6 })) === "Chongqing", "go");
    assert(chooseTravel(player({ skills: hacker, money: 1.39e6 })) === null, "not without the fare home");
    assert(chooseTravel(player({ skills: { ...strong, hacking: 49 }, money: 1e9 })) === null, "not below hacking 50");
    assert(chooseTravel(player({ skills: hacker, city: "Aevum" })) === null, "never from a city the player chose");
    assert(chooseTravel(player({ skills: hacker, city: "Chongqing" })) === null, "wait there for the invite");
    assert(chooseTravel(player({ skills: hacker, city: "Chongqing", factions: ["Tian Di Hui"] })) === "Sector-12",
      "home once joined");
    assert(chooseTravel(player({ skills: hacker, factions: ["Tian Di Hui"] })) === null, "done");
  },

  // workForFaction refuses the gang's faction and getFactionWorkTypes returns []
  // for it - which is how plan.js excludes it without paying 2.00 GB for
  // getGangInformation to learn its name.
  "never the gang's own faction, and nothing past the rep target": async () => {
    const mods = await loadScripts();
    const { chooseAction } = mods["sing/plan"];
    const { FACTION_REP_TARGET } = mods["sing/config"];
    const a = chooseAction(player({ factions: ["Slum Snakes", "CyberSec"] }), state({
      workTypes: { "Slum Snakes": [], CyberSec: ["hacking"] },
      rep: { CyberSec: FACTION_REP_TARGET },
    }));
    assert(a.kind === "idle", `expected idle, got ${JSON.stringify(a)}`);
  },

  // The guard whose absence has no symptom but a flat karma line: restarting a
  // crime resets CrimeWork.unitCompleted, so one longer than the tick never lands.
  "sameAsCurrent recognises each getCurrentWork() shape": async () => {
    const { sameAsCurrent } = (await loadScripts())["sing/plan"];
    const gym = { kind: "gym", gym: "Powerhouse Gym", stat: "str" };
    const crime = { kind: "crime", crime: "Homicide" };
    const fac = { kind: "faction", faction: "CyberSec", type: "hacking" };
    assert(sameAsCurrent({ type: "CLASS", classType: "str", location: "Powerhouse Gym" }, gym), "gym");
    assert(!sameAsCurrent({ type: "CLASS", classType: "def", location: "Powerhouse Gym" }, gym), "other stat");
    assert(sameAsCurrent({ type: "CRIME", crimeType: "Homicide" }, crime), "crime");
    assert(!sameAsCurrent({ type: "CRIME", crimeType: "Mug" }, crime), "other crime");
    assert(sameAsCurrent({ type: "FACTION", factionName: "CyberSec", factionWorkType: "hacking" }, fac), "faction");
    assert(!sameAsCurrent({ type: "FACTION", factionName: "CyberSec", factionWorkType: "field" }, fac), "other type");
    assert(!sameAsCurrent(null, crime), "nothing running");
    assert(sameAsCurrent(null, { kind: "idle" }) && sameAsCurrent({ type: "COMPANY" }, { kind: "idle" }),
      "idle leaves whatever is running alone");
    const co = { kind: "company", company: "Bachman & Associates", field: "Software" };
    assert(sameAsCurrent({ type: "COMPANY", companyName: "Bachman & Associates" }, co), "company");
    assert(!sameAsCurrent({ type: "COMPANY", companyName: "MegaCorp" }, co), "other company");
  },

  // ---------------------------------------------------------- invariants ----

  // One Player.currentWork slot, and every work-starting call finishes whatever
  // held it. Each action body may name its own call and nothing else may name
  // any of them - a PROGS body that started work would cancel the faction
  // session every fourth tick.
  "only the action bodies start work, one call each": () => {
    const STARTERS = ["gymWorkout", "commitCrime", "workForFaction", "universityCourse",
      "workForCompany", "stopAction", "setFocus"];
    const OWNER = { GYM: "gymWorkout", CRIME: "commitCrime", FACTION: "workForFaction", COMPANY: "workForCompany" };
    for (const [name, body] of Object.entries(bodies())) {
      for (const s of STARTERS) {
        if (OWNER[name] === s) continue;
        assert(!new RegExp(`\\b${s}\\b`).test(body), `${name} body names ${s} - only ${Object.keys(OWNER)} may start work`);
      }
    }
    // And outside the bodies, the resident file names none of them at all.
    const resident = readScript("sing/sing").replace(/\bconst\s+[A-Z_]+\s*=\s*`[\s\S]*?`;/g, "");
    for (const s of STARTERS) {
      assert(!new RegExp(`\\bns\\.[\\w.]*${s}\\b`).test(resident), `sing.js calls ${s} outside a body`);
    }
  },

  // Buying the program is cheaper than the hours writing it takes.
  "createProgram appears nowhere in sing/": () => {
    for (const [f, src] of singSources()) {
      assert(!src.includes("createProgram"), `sing/${f} mentions createProgram`);
    }
    assert(!readScript("sing/sing").includes("createProgram"), "not even in a comment");
  },

  // rpc() returns through JSON.stringify, and a Map stringifies to {} - so the
  // SF2 gate would read false forever with no error. READ must collapse it.
  "READ never returns ownedSF raw": () => {
    const body = bodies().READ;
    const uses = body.match(/ownedSF[\w.]*/g) ?? [];
    assert(uses.length > 0 && uses.every((u) => u === "ownedSF.has"),
      `ownedSF may only be read through .has() inside the body, got ${uses}`);
  },

  // ------------------------------------------------------------ the loop ----

  "each body runs on its cadence, cheapest-and-widens first": async () => {
    const mods = await loadScripts();
    const { UPGRADE_EVERY, JOIN_EVERY } = mods["sing/config"];
    const { ns } = await driveSing(mods, { ticks: 4 });
    const lines = (tag) => ns._log.filter((l) => l.includes(`  ${tag}: `));
    assert(lines("upgrade").length === Math.ceil(4 / UPGRADE_EVERY), `upgrade ran ${lines("upgrade").length}`);
    assert(lines("join").length === Math.ceil(4 / JOIN_EVERY), `join ran ${lines("join").length}`);
    assert(lines("work").length === 4, `work should report every tick: ${lines("work").length}`);
    const at = (tag) => ns._log.findIndex((l) => l.includes(`  ${tag}: `));
    assert(at("upgrade") < at("tor") && at("tor") < at("progs") && at("progs") < at("join") &&
      at("join") < at("work"), `dispatch order wrong: ${ns._log.join(" | ")}`);
    assert(!ns._log.some((l) => l.includes("WARN")), `a body failed: ${ns._log.filter((l) => l.includes("WARN"))}`);
  },

  // Invariant 2, end to end. Driven through faction work because the gym and
  // the karma grind are off by default and gated by a config the READ body
  // imports - but the guard is one sameAsCurrent() for every kind, and that is
  // what this pins.
  "work already running is never restarted": async () => {
    const mods = await loadScripts();
    const r = await driveSing(mods, { ticks: 5, p: player({ factions: ["CyberSec"] }), augs: SELLS });
    assert(r.count("workForFaction") === 1,
      `workForFaction should run once and then be left alone, ran ${r.count("workForFaction")}`);
    assert(r.ns._log.filter((l) => l.includes("(running)")).length === 4, "later ticks should see it running");
  },

  // rpc() returns through JSON.stringify, which turns a Map into {}. Run the
  // real READ body against a real Map and read what comes back.
  "READ carries SF2 out of the ownedSF Map as a boolean": async () => {
    const mods = await loadScripts();
    const body = bodies().READ;
    for (const [owned, want] of [[new Map([[2, 1]]), true], [new Map([[4, 3]]), false]]) {
      const ns = makeNs({
        extra: {
          getPlayer: () => player(),
          getResetInfo: () => ({ currentNode: 4, ownedSF: owned }),
          gang: { inGang: () => false },
          singularity: { getCurrentWork: () => null, getCompanyRep: () => 0 },
        },
      });
      const r = await mods["rpc"].rpc(ns, body);
      assert(r.hasSF2 === want, `ownedSF ${JSON.stringify([...owned])} -> hasSF2 ${r.hasSF2}`);
      assert(r.grindKarma === mods["sing/config"].GRIND_GANG_KARMA, "the live gang flag must ride along");
    }
  },

  "TOR is bought once and never asked about again": async () => {
    const mods = await loadScripts();
    const { PROGS_EVERY } = mods["sing/config"];
    const r = await driveSing(mods, { ticks: PROGS_EVERY * 2 + 1 });
    assert(r.count("purchaseTor") === 1, `purchaseTor ${r.count("purchaseTor")} times`);
    assert(r.count("hasTorRouter") === 1, `the TOR body should stop running once owned: ${r.count("hasTorRouter")}`);
    assert(r.count("purchaseProgram") >= 1, "programs should be bought once TOR is owned");
  },

  "denied invites never reach JOIN, allowed ones do": async () => {
    const mods = await loadScripts();
    const denied = await driveSing(mods, { ticks: 1, invites: ["Chongqing", "Volhaven"] });
    assert(denied.count("joinFaction") === 0, "JOIN must not run when every invite is denied");
    assert(denied.ns._log.some((l) => l.includes("declined")), "the log should say why nothing was joined");
    const mixed = await driveSing(mods, { ticks: 1, invites: ["CyberSec", "Ishima"] });
    assert(mixed.calls.includes("joinFaction:CyberSec") && mixed.count("joinFaction") === 1,
      `only CyberSec should be joined: ${mixed.calls}`);
  },

  // Hired on the first tick, worked once, promoted on the PROMOTE_EVERY cadence -
  // and a promotion must never restart the shift.
  "company work is applied for, worked once, and re-applied for promotion": async () => {
    const mods = await loadScripts();
    const { PROMOTE_EVERY } = mods["sing/config"];
    const r = await driveSing(mods, {
      ticks: PROMOTE_EVERY * 2 + 1,
      p: player({ skills: { ...strong, hacking: 300 }, factions: ["Tian Di Hui"] }),
      rep: { "Tian Di Hui": 1e5 },
      augs: { ...SELLS, "Tian Di Hui": [{ name: "Neuroreceptor Management Implant", rep: 75e3, price: 5e8 }] },
    });
    assert(r.count("applyToCompany") === 3, `hire at tick 0, promote at ${PROMOTE_EVERY} and ` +
      `${PROMOTE_EVERY * 2}: got ${r.count("applyToCompany")}`);
    assert(r.count("workForCompany") === 1, `one shift, never restarted: ${r.count("workForCompany")}`);
    assert(r.count("travelToCity") === 0, "already in Tian Di Hui - no trip");
  },

  // The whole trip against a fake that only invites a player standing in
  // Chongqing. Chongqing's own invite arrives too and must be declined.
  "the Tian Di Hui round trip, end to end": async () => {
    const mods = await loadScripts();
    const p = player({ skills: { ...strong, hacking: 60 }, money: 1e7 });
    const { JOIN_EVERY } = mods["sing/config"];
    // Out at tick 0, invited at the first JOIN tick; READ runs before JOIN, so it
    // sees the join a tick later, flies home, and works the tick after that.
    const r = await driveSing(mods, {
      ticks: JOIN_EVERY + 3, p,
      invites: () => (p.city === "Chongqing" && !p.factions.includes("Tian Di Hui") ? ["Tian Di Hui", "Chongqing"] : []),
    });
    const trips = r.calls.filter((c) => c.startsWith("travelToCity:"));
    assert(JSON.stringify(trips) === JSON.stringify(["travelToCity:Chongqing", "travelToCity:Sector-12"]),
      `out and back, got ${trips}`);
    assert(JSON.stringify(r.calls.filter((c) => c.startsWith("joinFaction:"))) === '["joinFaction:Tian Di Hui"]',
      "Tian Di Hui joined, Chongqing declined");
    assert(r.calls.some((c) => c.startsWith("workForFaction:Tian Di Hui")), "then worked");
  },

  // End to end against the fake's own x1.9 pricing: eleven affordable augs are
  // bought dearest first, then the leftover goes on home RAM.
  "an affordable batch of ten or more is bought, then home RAM with the rest": async () => {
    const mods = await loadScripts();
    const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `aug${i}`, rep: 1e3, price: (i + 1) * 1e4 }));
    const r = await driveSing(mods, {
      ticks: 1, p: player({ factions: ["CyberSec"] }), rep: { CyberSec: 1e5 }, augs: { CyberSec: eleven },
    });
    const buys = r.calls.filter((c) => c.startsWith("purchaseAugmentation:"));
    assert(buys.length === 11, `all eleven, got ${buys.length}`);
    assert(buys[0] === "purchaseAugmentation:CyberSec,aug10", `dearest first, got ${buys[0]}`);
    assert(r.ns._log.some((l) => l.includes("[T] sing: bought 11")), "a batch is announced on the terminal");
    const after = r.ns._log.findIndex((l) => l.includes("augs: bought"));
    assert(r.ns._log.slice(after).some((l) => l.includes("upgrade: bought")), "leftover goes on home RAM");
  },

  "under ten: nothing bought, and the log says why": async () => {
    const mods = await loadScripts();
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `aug${i}`, rep: 1e3, price: 1e4 }));
    const r = await driveSing(mods, {
      ticks: 1, p: player({ factions: ["CyberSec"] }), rep: { CyberSec: 1e5 }, augs: { CyberSec: five },
    });
    assert(r.count("purchaseAugmentation") === 0, "five is not a batch");
    assert(r.ns._log.some((l) => l.includes("augs: waiting: best batch is 5 of 10")), `why: ${r.ns._log}`);
  },

  // Share multiplies faction work rep and nothing else, so it is held through
  // everything else - and the hold is written on a CHANGE, not every tick.
  "share is held except during faction work": async () => {
    const mods = await loadScripts();
    const { SHARE_HOLD_MARKER } = mods["config"];
    const idle = await driveSing(mods, { ticks: 4 });
    assert(idle.ns._files[SHARE_HOLD_MARKER] === "hold", "no work must hold share");
    assert(idle.ns._log.filter((l) => l.includes("  share: ")).length === 1, "said once, not per tick");

    const faction = await driveSing(mods, {
      ticks: 2, p: player({ factions: ["CyberSec"] }), files: { [SHARE_HOLD_MARKER]: "hold" }, augs: SELLS,
    });
    assert(faction.ns._files[SHARE_HOLD_MARKER] === "", "faction work must release it");
  },

  // One reader for both managers, or a hold reaches one batcher and not the other.
  "both managers read share through the hold": () => {
    for (const f of ["managerCore", "continuous/lib/share"]) {
      const src = readScript(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert(/effectiveShareFraction\(ns\.read\(SHARE_MARKER\),\s*holdText\)/.test(src),
        `${f}.js must read share through effectiveShareFraction`);
      assert(!/shareFractionFrom\(ns\.read\(SHARE_MARKER\)\)/.test(src), `${f}.js reads the marker around the hold`);
    }
  },

  "effectiveShareFraction: the hold wins, nothing else is a hold": async () => {
    const { effectiveShareFraction } = (await loadScripts())["config"];
    assert(effectiveShareFraction("0.25", "hold") === 0, "held");
    assert(effectiveShareFraction("0.25", "") === 0.25, "an empty hold file is no hold");
    assert(effectiveShareFraction("0.25", undefined) === 0.25, "a missing hold file is no hold");
    assert(effectiveShareFraction("off", "") === 0, "the marker still decides when not held");
  },

  // Always on means it runs where singularity does not exist. Exiting would have
  // boot relaunch it every tick forever; it must park instead, and stop calling.
  "no Source-File 4 parks without exiting and calls nothing more": async () => {
    const mods = await loadScripts();
    const boom = () => { throw new Error(SF4_ERROR); };
    const api = Object.fromEntries(["getUpgradeHomeRamCost", "purchaseTor", "checkFactionInvitations",
      "getFactionRep", "getCurrentWork", "getDarkwebPrograms"].map((n) => [n, boom]));
    let runs = 0;
    const r = await driveSing(mods, { ticks: 6, api, files: { "/data/share-hold.txt": "hold" } });
    for (const f of Object.keys(r.ns._files)) if (f.includes("rpc-")) runs++;
    assert(r.ns._log.filter((l) => l.includes("Parked")).length === 1, `should park once: ${r.ns._log}`);
    assert(!r.ns._log.some((l) => l.includes("WARN")), "the SF4 message is a park, not a warning");
    assert(runs === 1, `only the first body should ever be written, got ${runs}`);
    assert(r.ns._files["/data/share-hold.txt"] === "", "a parked sing must release any share hold it left");
  },

  // The expected state for the first minutes of a BitNode. One line per body,
  // not one per body per tick - and it must NOT park on it.
  "no free RAM is warned once per body and retried": async () => {
    const mods = await loadScripts();
    const r = await driveSing(mods, { ticks: 6, run: () => 0 });
    const warns = r.ns._log.filter((l) => l.includes("WARN"));
    const tags = warns.map((l) => l.match(/WARN: (\w+) failed/)[1]).sort();
    assert(JSON.stringify(tags) === JSON.stringify(["invites", "read", "tor", "upgrade"]),
      `each failing body should warn exactly once, got ${tags}`);
    assert(!r.ns._log.some((l) => l.includes("Parked")), "a RAM failure must never park the subsystem");
  },

  // ------------------------------------------------------------- format ----

  // The game's formatters at 0 GB, never a hand-rolled one - see CLAUDE.md.
  "sing/ prints numbers only through ns.format": () => {
    for (const [f, src] of singSources()) {
      assert(!/toExponential\s*\(/.test(src), `sing/${f} uses toExponential`);
      assert(!/\*\s*100\s*\)\s*\.toFixed/.test(src), `sing/${f} hand-rolls a percentage`);
      assert(!/\bns\.formatNumber\b/.test(src), `sing/${f} calls ns.formatNumber, which this fork lacks`);
      assert(!/ns\.format\.number\s*\([^)]*,\s*0\s*[,)]/.test(src),
        `sing/${f} formats with 0 fractional digits - with a suffix, 1.6m and 2.05m both print "2m"`);
    }
  },
};
