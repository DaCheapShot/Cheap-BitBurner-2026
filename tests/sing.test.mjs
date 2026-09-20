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
  rep = {}, files = {}, favor = {}, favorGain = {}, extra = {},
  // {faction: [{name, rep, price, prereqs?}]} - what the fake sells. Tian Di Hui
  // sells the implant by default, so its rep target is real rather than 1e6.
  augs = { "Tian Di Hui": [{ name: "Neuroreceptor Management Implant", rep: 75e3, price: 5e8 }] },
  installed = [],
  // Extra getServer records by host - the backdoor pass reads them.
  servers = {},
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
    // ServerProfiler is the cheapest and must still never be bought: not a port opener.
    getDarkwebPrograms: () => ["ServerProfiler.exe", "BruteSSH.exe", "FTPCrack.exe"],
    getDarkwebProgramCost: (n) => ({ "ServerProfiler.exe": 4e5, "BruteSSH.exe": 5e5 })[n] ?? 1.5e6,
    purchaseProgram: rec("purchaseProgram", () => true),
    checkFactionInvitations: () => (typeof invites === "function" ? invites() : invites),
    joinFaction: rec("joinFaction", (f) => { p.factions.push(f); return true; }),
    getFactionRep: (f) => rep[f] ?? 0,
    getFactionFavor: (f) => favor[f] ?? 0,
    getFactionFavorGain: (f) => favorGain[f] ?? 0,
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
    // The aug's own `stats` in the fixture, else no multipliers: not a priority aug.
    getAugmentationStats: rec("getAugmentationStats", (n) => aug(n)?.stats ?? {}),
    purchaseAugmentation: rec("purchaseAugmentation", (f, n) => { queued.push(n); return true; }),
    // The game kills every script here; the fake records and returns, so the
    // loop carries on to the STOP sentinel.
    // Shoplift pays more per second at these odds than Homicide does at its own.
    getCrimeStats: (c) => ({ Shoplift: { money: 15e3, time: 2e3 }, Homicide: { money: 45e3, time: 3e3 } })[c],
    getCrimeChance: (c) => ({ Shoplift: 0.9, Homicide: 0.3 })[c],
    installAugmentations: rec("installAugmentations", () => (queued.length ? undefined : false)),
    ...api,
  };
  const ns = makeNs({
    files: { ...files },
    servers: { home: { moneyAvailable: 1e9 }, ...servers },
    extra: {
      singularity,
      enums: { CrimeType: { shoplift: "Shoplift", homicide: "Homicide" } },
      gang: { inGang: () => inGang },
      getPlayer: () => p,
      getResetInfo: () => ({ currentNode: 4, ownedSF }),
      getFavorToDonate: () => 150,
      getServer: (h) => ({ hostname: h, ...servers[h] }),
      getBitNodeMultipliers: () => ({ FactionWorkRepGain: 0.75 }),
      hasTorRouter: rec("hasTorRouter", () => tor),
      // The pre-install contract sweep: started, and finished by the next look.
      isRunning: rec("isRunning", () => false),
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

  // The user's rule: rep is bought only as part of a batch that is bought. The
  // donation is priced beside the aug it unlocks, and it counts against cash.
  "the batch buys rep by donation, and only as part of the batch": async () => {
    const { planAugBuys, donationPerRep } = (await loadScripts())["sing/plan"];
    const perRep = donationPerRep(1, 0.75);
    const nine = Array.from({ length: 9 }, (_, i) => `a${i}`);
    const info = Object.fromEntries(nine.map((n) => [n, { rep: 1, price: 1e6 }]));
    info.SmartJaw = { rep: 375e3, price: 1e6 };
    const base = {
      augsOf: { CyberSec: nine, Bachman: ["SmartJaw"] }, owned: [], queued: 0, info, prereqs: {},
      rep: { CyberSec: 1e3, Bachman: 100e3 },
      donate: { perRep, can: (f) => f === "Bachman" },
    };
    const lift = 275001 * perRep;
    const augs = 1e6 * (1.9 ** 10 - 1) / 0.9;
    const ok = planAugBuys({ ...base, cash: lift + augs + 1 });
    assert(ok.buys.length === 10 && ok.buys.some((b) => b.name === "SmartJaw" && b.faction === "Bachman"),
      `SmartJaw via donation makes ten: ${ok.buys.map((b) => b.name)}`);
    assert(ok.donations.length === 1 && Math.abs(ok.donations[0].amount - lift) < 1,
      `one donation, 375001 - 100000 rep: ${JSON.stringify(ok.donations)}`);
    assert(Math.abs(ok.total - lift - augs) < 1, "the donation counts against cash with the augs");

    const short = planAugBuys({ ...base, cash: lift + augs - 1e3 });
    assert(!short.buys.length && !short.donations.length, "cash for the augs but not the rep: nothing, not even the donation");
    const noFavor = planAugBuys({ ...base, donate: null, cash: 1e15 });
    assert(!noFavor.buys.length && !noFavor.donations.length && noFavor.batch === 9, "no favor: SmartJaw is out of reach");
  },

  // Two augs from one faction: it is lifted ONCE, to the higher need.
  "a faction is lifted once, to the highest rep the batch needs from it": async () => {
    const { planAugBuys } = (await loadScripts())["sing/plan"];
    const names = Array.from({ length: 8 }, (_, i) => `a${i}`);
    const info = Object.fromEntries(names.map((n) => [n, { rep: 1, price: 1e6 }]));
    info.lo = { rep: 200e3, price: 2e6 };
    info.hi = { rep: 300e3, price: 3e6 };
    const plan = planAugBuys({
      augsOf: { F: names, B: ["lo", "hi"] }, owned: [], queued: 0, info, prereqs: {},
      rep: { F: 1e9, B: 100e3 }, cash: 1e15, donate: { perRep: 1, can: (f) => f === "B" },
    });
    assert(plan.buys.length === 10, `ten: ${plan.buys.length}`);
    assert(plan.donations.length === 1 && plan.donations[0].amount === 200001,
      `100k -> 300001 once, not per aug: ${JSON.stringify(plan.donations)}`);
  },

  // End to end: the donation lands immediately before the buys it unlocks.
  "a batch donates first, then buys - and the favored faction is never worked": async () => {
    const mods = await loadScripts();
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `aug${i}`, rep: 1, price: 1e4 }));
    const r = await driveSing(mods, {
      ticks: 1, p: player({ factions: ["Bachman & Associates", "CyberSec"], money: 1e13 }),
      rep: { CyberSec: 1e3 }, favor: { "Bachman & Associates": 150 },
      augs: { CyberSec: nine, "Bachman & Associates": [{ name: "SmartJaw", rep: 375e3, price: 1e6 }] },
    });
    const d = r.calls.filter((c) => c.startsWith("donateToFaction:"));
    assert(d.length === 1 && d[0].startsWith("donateToFaction:Bachman & Associates,"), `one donation: ${d}`);
    assert(Math.abs(Number(d[0].split(",")[1]) - 375001 / 0.75 * 1e6) < 1, `375001 rep at 1.33m per rep: ${d[0]}`);
    const firstBuy = r.calls.findIndex((c) => c.startsWith("purchaseAugmentation:"));
    assert(r.calls.indexOf(d[0]) < firstBuy, "rep before the augs it unlocks");
    assert(r.calls.includes("purchaseAugmentation:Bachman & Associates,SmartJaw"), "SmartJaw bought");
    assert(r.count("purchaseAugmentation") === 10, `the whole batch: ${r.count("purchaseAugmentation")}`);
    assert(!r.calls.some((c) => c.startsWith("workForFaction:Bachman")), "not worked");
  },

  // No batch, no donation - however much cash and favor there is.
  "nothing is donated when no batch is bought": async () => {
    const mods = await loadScripts();
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `aug${i}`, rep: 1, price: 1e4 }));
    const r = await driveSing(mods, {
      ticks: 4, p: player({ factions: ["Bachman & Associates", "CyberSec"], money: 1e13 }),
      rep: { CyberSec: 1e3 }, favor: { "Bachman & Associates": 150 },
      augs: { CyberSec: five, "Bachman & Associates": [{ name: "SmartJaw", rep: 375e3, price: 1e6 }] },
    });
    assert(r.count("donateToFaction") === 0, "six is not a batch - the money stays for the batcher");
    assert(r.count("purchaseAugmentation") === 0, "and nothing bought");
  },

  // A refused donation would leave the buys behind it stopping at its aug - a
  // partial batch. So nothing is bought.
  "a refused donation buys nothing": async () => {
    const mods = await loadScripts();
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `aug${i}`, rep: 1, price: 1e4 }));
    const r = await driveSing(mods, {
      ticks: 1, p: player({ factions: ["Bachman & Associates", "CyberSec"], money: 1e13 }),
      rep: { CyberSec: 1e3 }, favor: { "Bachman & Associates": 150 },
      augs: { CyberSec: nine, "Bachman & Associates": [{ name: "SmartJaw", rep: 375e3, price: 1e6 }] },
      api: { donateToFaction: () => false },
    });
    assert(r.count("purchaseAugmentation") === 0, "no partial batch");
    assert(r.ns._log.some((l) => l.includes("WARN: donation refused")), `said why: ${r.ns._log}`);
  },

  // The price comes from the game, never a guess: without SF5 the read throws,
  // warns once, and the batch is planned without donations.
  "no Source-File 5, no donation - and one warning": async () => {
    const mods = await loadScripts();
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `aug${i}`, rep: 1, price: 1e4 }));
    const r = await driveSing(mods, {
      ticks: 7, p: player({ factions: ["Bachman & Associates", "CyberSec"], money: 1e13 }),
      rep: { CyberSec: 1e3 }, favor: { "Bachman & Associates": 150 },
      augs: { CyberSec: nine, "Bachman & Associates": [{ name: "SmartJaw", rep: 375e3, price: 1e6 }] },
      extra: { getBitNodeMultipliers: () => { throw new Error("Requires Source-File 5 to run."); } },
    });
    assert(r.count("donateToFaction") === 0 && r.count("purchaseAugmentation") === 0, "nine without SmartJaw");
    assert(r.ns._log.filter((l) => l.includes("WARN: bitnode mults failed")).length === 1, `warned once: ${r.ns._log}`);
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

  "tier 1 rep targets count only priority augs; an unrated aug still counts": async () => {
    const { repTargets } = (await loadScripts())["sing/plan"];
    const augsOf = { A: ["h", "c"], B: ["c"], C: ["u"] };
    const info = { h: { rep: 5e3 }, c: { rep: 20e3 }, u: { rep: 7e3 } };
    const t = repTargets(augsOf, [], info, { h: true, c: false });
    assert(t.A === 5e3, `A: only h counts - got ${t.A}`);
    assert(t.B === 0, `B: sells only a non-priority aug - got ${t.B}`);
    assert(t.C === 7e3, `C: u is unrated, and unknown must not read as done - got ${t.C}`);
    assert(repTargets(augsOf, [], info).A === 20e3, "no priority map: every aug counts, as before");
  },

  "tier 1 first: a faction with priority augs left beats one with only the rest": async () => {
    const { chooseAction } = (await loadScripts())["sing/plan"];
    const p = player({ factions: ["NiteSec", "CyberSec"] });
    const workTypes = { NiteSec: ["hacking"], CyberSec: ["hacking"] };
    const targets = { NiteSec: 50e3, CyberSec: 10e3 };
    const priorityTargets = { NiteSec: 0, CyberSec: 10e3 };
    const one = chooseAction(p, state({ workTypes, targets, priorityTargets }));
    assert(one.faction === "CyberSec" && one.tier === 1 && one.target === 10e3,
      `NiteSec has no priority aug left - CyberSec in tier 1, got ${JSON.stringify(one)}`);
    const two = chooseAction(p, state({ workTypes, targets, priorityTargets, rep: { CyberSec: 10e3 } }));
    assert(two.faction === "NiteSec" && two.tier === 2 && two.target === 50e3,
      `tier 1 done - NiteSec for the rest, got ${JSON.stringify(two)}`);
    const flat = chooseAction(p, state({ workTypes, targets }));
    assert(flat.faction === "NiteSec" && flat.tier === undefined, "no priorityTargets: one pass, no tier");
  },

  "a company step is skipped in the tier where its faction has nothing left": async () => {
    const mods = await loadScripts();
    const { chooseAction } = mods["sing/plan"];
    const { WORK_ORDER } = mods["sing/config"];
    const none = Object.fromEntries(WORK_ORDER.filter((s) => s.company).map((s) => [s.faction ?? s.company, 0]));
    const a = chooseAction(player({ skills: { ...strong, hacking: 300 } }),
      state({ targets: {}, priorityTargets: none }));
    assert(a.kind === "company" && a.company === "Bachman & Associates" && a.tier === 2,
      `no company has a priority aug - the first company in tier 2, got ${JSON.stringify(a)}`);
  },

  "the batch plans priority augs first, then the rest, each dearest first": async () => {
    const { planAugBuys } = (await loadScripts())["sing/plan"];
    const info = { h1: { rep: 1, price: 1e6 }, h2: { rep: 1, price: 2e6 }, c1: { rep: 1, price: 9e6 } };
    const base = { augsOf: { F: ["h1", "h2", "c1"] }, owned: [], queued: 0, info, prereqs: {}, rep: { F: 1e9 }, cash: 1e15, force: true };
    const tiered = planAugBuys({ ...base, priority: { h1: true, h2: true, c1: false } }).buys.map((b) => b.name);
    assert(JSON.stringify(tiered) === '["h2","h1","c1"]', `priority first, then the rest: ${tiered}`);
    const flat = planAugBuys(base).buys.map((b) => b.name);
    assert(JSON.stringify(flat) === '["c1","h2","h1"]', `no priority map: dearest first, as before: ${flat}`);
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

  // Verified: entry software job = reqdHacking 1 + jobStatReqOffset (249 for
  // ECorp, MegaCorp, NWO; 224 for the rest). Each company's faction step follows
  // it, so a joined corp faction is worked before the next company grind.
  "every megacorp is a company step at its hiring bar, followed by its faction": async () => {
    const { WORK_ORDER } = (await loadScripts())["sing/config"];
    const bars = {
      "Bachman & Associates": 225, ECorp: 250, "OmniTek Incorporated": 225, NWO: 250, MegaCorp: 250,
      "Blade Industries": 225, "Four Sigma": 225, "KuaiGong International": 225,
      "Clarke Incorporated": 225, "Fulcrum Technologies": 225,
    };
    const cos = WORK_ORDER.filter((s) => s.company);
    assert(JSON.stringify(cos.map((s) => s.company).sort()) === JSON.stringify(Object.keys(bars).sort()),
      `companies: ${cos.map((s) => s.company)}`);
    for (const s of cos) {
      assert(s.hacking === bars[s.company] && s.rep === 400e3 && s.field === "Software", `${s.company}: ${JSON.stringify(s)}`);
      const next = WORK_ORDER[WORK_ORDER.indexOf(s) + 1];
      assert(next?.faction === (s.faction ?? s.company) && !next.company, `${s.company} must be followed by its faction step`);
    }
    assert(cos.find((s) => s.company === "Fulcrum Technologies").faction === "Fulcrum Secret Technologies",
      "Fulcrum's faction is named differently from its company");
  },

  "the city factions come after the hacking factions and before the megacorp grinds": async () => {
    const { WORK_ORDER } = (await loadScripts())["sing/config"];
    const at = (f) => WORK_ORDER.findIndex((s) => s.faction === f && !s.company);
    const firstCorp = WORK_ORDER.findIndex((s) => s.company === "ECorp");
    for (const c of ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven"]) {
      assert(at(c) > at("CyberSec") && at(c) < firstCorp, `${c} at ${at(c)}`);
    }
  },

  "Fulcrum's company step keys on its faction's name": async () => {
    const mods = await loadScripts();
    const { chooseAction } = mods["sing/plan"];
    const { WORK_ORDER } = mods["sing/config"];
    const zero = (except) => Object.fromEntries(WORK_ORDER.filter((s) => s.company)
      .map((s) => s.faction ?? s.company).filter((f) => f !== except).map((f) => [f, 0]));
    const p = player({ skills: { ...strong, hacking: 300 } });
    const a = chooseAction(p, state({ targets: zero("Fulcrum Secret Technologies") }));
    assert(a.kind === "company" && a.company === "Fulcrum Technologies", `got ${JSON.stringify(a)}`);
    const joined = chooseAction(player({ skills: { ...strong, hacking: 300 }, factions: ["Fulcrum Secret Technologies"] }),
      state({ targets: zero("Fulcrum Secret Technologies") }));
    assert(joined.company !== "Fulcrum Technologies", `its faction joined - done, got ${JSON.stringify(joined)}`);
  },

  "chooseCityGroup: a joined city decides; else most priority augs, then most augs, ties to Sector-12": async () => {
    const mods = await loadScripts();
    const { chooseCityGroup } = mods["sing/plan"];
    const { CITY_GROUPS } = mods["sing/config"];
    const [west, east, volhaven] = CITY_GROUPS;
    assert(chooseCityGroup(["Chongqing"], {}, []) === east, "joined Chongqing - the game has locked the rest");
    const augsOf = {
      "Sector-12": ["c1", "NeuroFlux Governor"], Aevum: [], Chongqing: ["h1"], "New Tokyo": ["h1", "h2"],
      Ishima: [], Volhaven: ["h1", "c2", "c3"],
    };
    const priority = { h1: true, h2: true, c1: false, c2: false, c3: false };
    assert(chooseCityGroup([], augsOf, [], priority) === east, "two priority augs east, one in Volhaven");
    assert(chooseCityGroup([], augsOf, ["h2"], priority) === volhaven, "one each - Volhaven has more augs in all");
    assert(chooseCityGroup([], augsOf, ["h1", "h2", "c1", "c2", "c3"], priority) === west,
      "nothing left anywhere (NeuroFlux never counts) - Sector-12's group");
  },

  "travel: Tian Di Hui first, then the group's cities, each once its money bar is met": async () => {
    const mods = await loadScripts();
    const { chooseTravel } = mods["sing/plan"];
    const [west, east] = mods["sing/config"].CITY_GROUPS;
    const go = (over, o = {}) => chooseTravel(player(over), { group: west, ...o });
    const hacker = { ...strong, hacking: 50 };
    assert(go({ skills: hacker, money: 1.4e6 }) === "Chongqing", "Tian Di Hui's $1m plus a fare out and back");
    assert(go({ skills: hacker, money: 1.39e6 }) === null, "short of the fares, and Sector-12 wants $15m");
    assert(go({ skills: { ...strong, hacking: 49 }, money: 1e9 }) === null, "no Tian Di Hui below 50 - wait for Sector-12 here");
    assert(go({ skills: hacker, city: "New Tokyo", money: 1e6 }) === null, "any Tian Di Hui city will do - wait there");
    const tdh = { skills: hacker, factions: ["Tian Di Hui"], city: "Chongqing" };
    assert(go({ ...tdh, money: 1e9 }) === "Sector-12", "then Sector-12's invite");
    assert(go({ ...tdh, money: 1e7 }) === null, "not yet affordable - stay put, never undo a trip for nothing");
    const s12 = { ...tdh, factions: ["Tian Di Hui", "Sector-12"], city: "Sector-12" };
    assert(go({ ...s12, money: 4.04e7 }) === "Aevum", "Aevum's $40m plus the fares");
    assert(go({ ...s12, money: 4e7 }) === null, "not with less");
    assert(go({ ...tdh, money: 1e9 }, { targets: { "Sector-12": 0, Aevum: 0 } }) === null, "nothing left to buy there");
    assert(go({ ...tdh, money: 1e9 }, { targets: { "Sector-12": 0, Aevum: 0 }, grindKarma: true }) === "Sector-12",
      "nothing wanted and grinding karma - the gym's city");
    assert(go({ ...tdh, money: 1e9 }, { group: east }) === null, "east: Chongqing is wanted and here");
    assert(go({ ...tdh, factions: ["Tian Di Hui", "Chongqing"], money: 1e9 }, { group: east }) === "New Tokyo", "then New Tokyo");
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
    assert(!r.calls.includes("purchaseProgram:ServerProfiler.exe"), "only PROGS_WANTED is bought");
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

  // The group is chosen on the aug pass at tick 0, which runs before JOIN.
  "invites outside this install's city group are declined": async () => {
    const mods = await loadScripts();
    const r = await driveSing(mods, {
      ticks: 1, invites: ["Sector-12", "Chongqing", "CyberSec"],
      augs: { Chongqing: [{ name: "Neuregen Gene Modification", rep: 1e12, price: 1, stats: { hacking_exp: 1.4 } }] },
    });
    const joins = r.calls.filter((c) => c.startsWith("joinFaction:"));
    assert(JSON.stringify(joins) === '["joinFaction:Chongqing","joinFaction:CyberSec"]',
      `the east has the only hacking aug - Sector-12 declined: ${joins}`);
  },

  // Before settling, owned.all can grow mid-process - AUTO_INSTALL off with a
  // batch bought over several passes - and a score computed from the new list
  // would fly the player between groups at $200k a leg. Once every sold aug is
  // rated the choice locks for the process, even though a fresh score (were it
  // recomputed) would now favour a different group.
  "the city group locks once settled - it does not re-flip as owned augs grow": async () => {
    const mods = await loadScripts();
    const { AUGS_EVERY } = mods["sing/config"];
    let ownedCalls = 0;
    const r = await driveSing(mods, {
      ticks: AUGS_EVERY * 2 + 1,
      // East (Chongqing, New Tokyo) has two priority augs against Sector-12's
      // one, so east is chosen first pass. From the second pass on, e1 and e2
      // read as already owned - simulating a batch bought elsewhere in the
      // process - which would flip an unlocked score to Sector-12's group.
      augs: {
        "Sector-12": [{ name: "w1", rep: 1e12, price: 1, stats: { hacking: 1.4 } }],
        Chongqing: [{ name: "e1", rep: 1e12, price: 1, stats: { hacking: 1.4 } }],
        "New Tokyo": [{ name: "e2", rep: 1e12, price: 1, stats: { hacking: 1.4 } }],
      },
      api: {
        getOwnedAugmentations: (purchased) => {
          if (!purchased) return [];
          ownedCalls++;
          return ownedCalls <= 1 ? [] : ["e1", "e2"];
        },
      },
    });
    const cityLines = r.ns._log.filter((l) => l.includes("  cities: "));
    assert(cityLines.length === 1, `the group must be chosen once and locked, not re-flipped: ${cityLines}`);
    assert(cityLines[0].includes("Chongqing"), `expected the east group to win and stick: ${cityLines}`);
  },

  // sold.every(...) over an EMPTY array is vacuously true - so a failed first
  // FAC_AUGS call (an ordinary rpc failure: no free RAM, a timeout) used to
  // settle the group on zero data and strand it on the CITY_GROUPS[0] fallback
  // for the rest of the process, with no later successful pass able to fix it.
  "a failed first FAC_AUGS call does not settle the group on no data": async () => {
    const mods = await loadScripts();
    const { AUGS_EVERY } = mods["sing/config"];
    const augsData = {
      "Sector-12": [{ name: "w1", rep: 1e12, price: 1, stats: { hacking: 1.4 } }],
      Chongqing: [{ name: "e1", rep: 1e12, price: 1, stats: { hacking: 1.4 } }],
      "New Tokyo": [{ name: "e2", rep: 1e12, price: 1, stats: { hacking: 1.4 } }],
    };
    let calls = 0;
    const r = await driveSing(mods, {
      ticks: AUGS_EVERY * 2 + 1,
      augs: augsData,
      api: {
        // The whole FAC_AUGS body throws on its first faction, so the entire
        // pass 1 read fails and augsOf stays empty; every later call succeeds.
        getAugmentationsFromFaction: (f) => {
          calls++;
          if (calls <= 1) throw new Error("no free RAM on home");
          return (augsData[f] ?? []).map((a) => a.name);
        },
      },
    });
    const cityLines = r.ns._log.filter((l) => l.includes("  cities: "));
    assert(cityLines.length > 0, `the group must eventually be decided: ${cityLines}`);
    assert(cityLines.at(-1).includes("cities: Chongqing"),
      `east has two priority augs against Sector-12's one - it must win once real data lands: ${cityLines}`);
  },

  // Once settled, chooseCityGroup used to be skipped entirely - so a city
  // faction joined in another group, by any path outside JOIN, was never
  // followed even though chooseCityGroup's own joined-group check would have
  // caught it for free.
  "a city faction joined after settling still overrides the locked group": async () => {
    const mods = await loadScripts();
    const { AUGS_EVERY } = mods["sing/config"];
    const p = player();
    let reads = 0;
    const r = await driveSing(mods, {
      ticks: AUGS_EVERY * 2 + 1,
      p,
      // Only Sector-12 sells anything, so west settles on real data at tick 0.
      augs: { "Sector-12": [{ name: "w1", rep: 1e12, price: 1, stats: { hacking: 1.4 } }] },
      api: {
        getCurrentWork: () => {
          reads++;
          // After the first aug pass has settled (tick 0), join a city
          // faction from a DIFFERENT group by hand - outside JOIN entirely.
          if (reads > AUGS_EVERY && !p.factions.includes("Chongqing")) p.factions.push("Chongqing");
          return null;
        },
      },
    });
    const cityLines = r.ns._log.filter((l) => l.includes("  cities: "));
    assert(cityLines.length >= 2, `settling on west, then Chongqing being joined, must reopen the choice: ${cityLines}`);
    assert(cityLines.at(-1).includes("cities: Chongqing"),
      `Chongqing is joined - its group must win regardless of the earlier settle: ${cityLines}`);
  },

  "each aug is rated once per process": async () => {
    const mods = await loadScripts();
    const { AUGS_EVERY } = mods["sing/config"];
    const r = await driveSing(mods, { ticks: AUGS_EVERY * 2 + 1, p: player({ factions: ["CyberSec"] }), augs: SELLS });
    assert(r.count("getAugmentationStats") === 2, `two augs sold, each rated once: ${r.count("getAugmentationStats")}`);
  },

  // The Red Pill has no multipliers in this fork - getAugmentationStats
  // returns stats "" - so AUG_STATS can only rate it tier 1 by NAME. Without
  // it in PRIORITY_AUGS this reads false and the node-ending aug waits behind
  // every tier-1 grind.
  "the Red Pill is tier 1 by name - it carries no multiplier to rate": async () => {
    const mods = await loadScripts();
    const body = bodies().AUG_STATS;
    const ns = makeNs({ extra: { singularity: { getAugmentationStats: () => ({}) } } });
    const r = await mods["rpc"].rpc(ns, body, "The Red Pill");
    assert(r["The Red Pill"] === true, `Red Pill must rate tier 1 by name, got ${JSON.stringify(r)}`);
  },

  "the work line names the tier": async () => {
    const mods = await loadScripts();
    const r = await driveSing(mods, {
      ticks: 1, p: player({ factions: ["CyberSec"] }),
      augs: { CyberSec: [{ name: "BitWire", rep: 1e12, price: 1, stats: { hacking: 1.05 } }] },
    });
    assert(r.ns._log.some((l) => l.includes("work: ") && l.includes("CyberSec") && l.includes("tier 1")),
      `${r.ns._log.filter((l) => l.includes("work: "))}`);
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

  // Out for Tian Di Hui at tick 0, invited at the first JOIN tick, then on to
  // Sector-12 for its own invite. Chongqing's invite arrives too and must be declined.
  "the Tian Di Hui round trip, end to end": async () => {
    const mods = await loadScripts();
    const p = player({ skills: { ...strong, hacking: 60 }, money: 2e7 });
    const { JOIN_EVERY } = mods["sing/config"];
    // Out at tick 0, invited at the first JOIN tick; READ runs before JOIN, so it
    // sees the join a tick later, flies home, and works the tick after that.
    const r = await driveSing(mods, {
      ticks: JOIN_EVERY + 3, p,
      invites: () => (p.city === "Chongqing" && !p.factions.includes("Tian Di Hui") ? ["Tian Di Hui", "Chongqing"] : []),
      augs: { "Tian Di Hui": [{ name: "Neuroreceptor Management Implant", rep: 75e3, price: 5e8 }],
        "Sector-12": [{ name: "CashRoot Starter Kit", rep: 1e12, price: 1 }] },
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

  // Phase 4. An install destroys every unsolved contract, so one sweep runs
  // first and is waited out; home RAM takes the cash the install would reset;
  // and the callback is boot.js, which the game runs with no arguments.
  "a queue of ten or more is installed: sweep, home RAM, then install through boot": async () => {
    const mods = await loadScripts();
    const { CONTRACTS_SERVICE } = mods["contracts/config"];
    const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `aug${i}`, rep: 1e3, price: (i + 1) * 1e4 }));
    const r = await driveSing(mods, {
      ticks: 1, p: player({ factions: ["CyberSec"] }), rep: { CyberSec: 1e5 }, augs: { CyberSec: eleven },
    });
    const ran = r.ns.ps("home");
    assert(ran.some((q) => `/${q.filename}` === CONTRACTS_SERVICE), `a contract sweep ran first: ${ran.map((q) => q.filename)}`);
    assert(r.count("isRunning") >= 1, "and was waited out");
    const i = r.calls.findIndex((c) => c.startsWith("installAugmentations:"));
    assert(r.calls[i] === "installAugmentations:/scripts/boot.js", `callback must be boot.js, got ${r.calls[i]}`);
    assert(r.calls.slice(0, i).filter((c) => c.startsWith("upgradeHomeRam:")).length >= 1, "home RAM before the install");
    assert(r.ns._log.some((l) => l.includes("[T] sing: installing 11 augs")), "announced on the terminal");
    assert(!r.ns._log.some((l) => l.includes("WARN")), `a body failed: ${r.ns._log.filter((l) => l.includes("WARN"))}`);
  },

  // The user's rule: the Red Pill ends the node's aug cycles, so it is bought
  // and installed the moment it is in reach - a queue of one, not ten.
  "the Red Pill in reach is bought and installed at once, batch of one": async () => {
    const mods = await loadScripts();
    const r = await driveSing(mods, {
      ticks: 1, p: player({ factions: ["Daedalus"] }), rep: { Daedalus: 3e6 },
      augs: { Daedalus: [{ name: "The Red Pill", rep: 2.5e6, price: 0 }] },
    });
    assert(r.count("purchaseAugmentation") === 1, `the pill alone: ${r.calls.filter((c) => c.startsWith("purchase"))}`);
    assert(r.count("installAugmentations") === 1, "and installed");
  },

  // Past the favor bar the pill's rep is BOUGHT - and before anything else: it
  // costs $0, so dearest-first would plan it last and let a dear aug take the
  // cash its donation needed.
  "the Red Pill's donation comes before a dearer aug that would take its cash": async () => {
    const mods = await loadScripts();
    const lift = (2.5e6 - 1e6 + 1) * 1e6 / 0.75;
    const r = await driveSing(mods, {
      ticks: 1, p: player({ factions: ["Daedalus", "CyberSec"], money: lift + 1e9 }),
      rep: { Daedalus: 1e6, CyberSec: 1e9 }, favor: { Daedalus: 150 },
      augs: { Daedalus: [{ name: "The Red Pill", rep: 2.5e6, price: 0 }], CyberSec: [{ name: "Dear", rep: 1, price: 1.5e12 }] },
    });
    const buys = r.calls.filter((c) => c.startsWith("purchaseAugmentation:"));
    assert(JSON.stringify(buys) === '["purchaseAugmentation:Daedalus,The Red Pill"]', `pill, not Dear: ${buys}`);
    assert(r.count("donateToFaction") === 1 && r.count("installAugmentations") === 1, "donated, bought, installed");
  },

  // Once installing would carry Daedalus to the donate bar, buy what fits and
  // install: the rest of the pill's 2.5m rep is then a donation, not a grind.
  "an install that crosses Daedalus's favor bar happens at any batch size": async () => {
    const mods = await loadScripts();
    const two = [{ name: "a", rep: 1e3, price: 1e4 }, { name: "b", rep: 1e3, price: 1e4 },
      { name: "The Red Pill", rep: 2.5e6, price: 0 }];
    const go = (favorGain) => driveSing(mods, {
      ticks: 1, p: player({ factions: ["Daedalus"] }), rep: { Daedalus: 5e5 }, favorGain, augs: { Daedalus: two },
    });
    const crossed = await go({ Daedalus: 151 });
    assert(crossed.count("purchaseAugmentation") === 2 && crossed.count("installAugmentations") === 1,
      `two bought and installed: ${crossed.calls.filter((c) => /purchase|install/.test(c))}`);
    const short = await go({ Daedalus: 149 });
    assert(short.count("purchaseAugmentation") === 0 && short.count("installAugmentations") === 0, "149 is not the bar");
  },

  "bestCrime ranks MONEY_CRIMES by chance x money / time, and none at zero odds": async () => {
    const { bestCrime } = (await loadScripts())["sing/plan"];
    const stats = {
      Shoplift: { money: 15e3, time: 2e3 }, Homicide: { money: 45e3, time: 3e3 },
      Heist: { money: 120e6, time: 600e3 },
    };
    assert(bestCrime(stats, { Shoplift: 1, Homicide: 0.3 }) === "Shoplift", "Shoplift $7.5k/s, Homicide $4.5k/s");
    assert(bestCrime(stats, { Shoplift: 1, Homicide: 0.9 }) === "Homicide", "Homicide $13.5k/s");
    // Heist at 50% is $100k/s - and still never picked: the long crimes are out.
    assert(bestCrime(stats, { Shoplift: 1, Homicide: 0.9, Heist: 0.5 }) === "Homicide", "Heist is not a MONEY_CRIME");
    assert(bestCrime(stats, { Heist: 1 }) === null, "no odds on the list, no crime");
  },

  // A fresh install: no faction, no company step open. Crime for money rather
  // than nothing, and the best one, started once and left running.
  "nothing to work: the best-paying crime, started once": async () => {
    const mods = await loadScripts();
    const r = await driveSing(mods, { ticks: 4 });
    const crimes = r.calls.filter((c) => c.startsWith("commitCrime:"));
    assert(JSON.stringify(crimes) === '["commitCrime:Shoplift,true"]', `one Shoplift, got ${crimes}`);
    assert(r.ns._log.some((l) => l.includes("crime Shoplift for money")), `why: ${r.ns._log.filter((l) => l.includes("work:"))}`);
    assert(!r.ns._log.some((l) => l.includes("WARN")), `a body failed: ${r.ns._log.filter((l) => l.includes("WARN"))}`);
  },

  "under ten queued: no sweep, no install": async () => {
    const mods = await loadScripts();
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `aug${i}`, rep: 1e3, price: 1e4 }));
    const r = await driveSing(mods, {
      ticks: 1, p: player({ factions: ["CyberSec"] }), rep: { CyberSec: 1e5 }, augs: { CyberSec: five },
    });
    assert(r.count("installAugmentations") === 0 && r.count("isRunning") === 0, "five queued is not an install");
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

  // ------------------------------------------------------------ backdoor ----

  // Fire-and-forget: one backdoor.js per server in reach, faction servers first,
  // each given its route from home - and a running copy is never doubled by the
  // next pass. The mock's processes never exit, so pass two sees all of them.
  "every server in reach gets a backdoor.js, faction servers first, never twice": async () => {
    const mods = await loadScripts();
    const { BACKDOOR_EVERY } = mods["sing/config"];
    const r = await driveSing(mods, {
      ticks: BACKDOOR_EVERY + 1,
      servers: {
        CSEC: { hasAdminRights: true, requiredHackingSkill: 50 },
        "avmnite-02h": { hasAdminRights: true, requiredHackingSkill: 200 },
        "I.I.I.I": { hasAdminRights: true, requiredHackingSkill: 1e9 },
        run4theh111z: { hasAdminRights: false, requiredHackingSkill: 1 },
        n00dles: { hasAdminRights: true, requiredHackingSkill: 1 },
        // Bought servers are direct-connect already, and hacknet ones throw.
        "cloud-0": { hasAdminRights: true, requiredHackingSkill: 1, purchasedByPlayer: true },
      },
      extra: {
        scan: (h) => ({
          home: ["n00dles", "cloud-0"],
          n00dles: ["home", "CSEC", "avmnite-02h", "I.I.I.I", "run4theh111z"],
        })[h] ?? [],
      },
    });
    const copies = r.ns.ps("home").filter((p) => p.filename === "scripts/sing/backdoor.js").map((p) => p.args);
    assert(JSON.stringify(copies) === JSON.stringify([
      ["home", "n00dles", "CSEC"], ["home", "n00dles", "avmnite-02h"], ["home", "n00dles"]]),
    `wrong routes, order or a duplicate: ${JSON.stringify(copies)}`);
    const log = r.ns._log.join(" | ");
    assert(log.includes("[T] sing: backdooring CSEC, avmnite-02h"), `faction servers must reach the terminal: ${log}`);
    assert(log.includes("3 already running"), `pass two must see the running copies: ${log}`);
    for (const why of ["I.I.I.I needs hacking", "run4theh111z not rooted"]) {
      assert(log.includes(why), `missing wait reason "${why}": ${log}`);
    }
  },

  "backdoors start only while home keeps BACKDOOR_KEEP_GB free": async () => {
    const mods = await loadScripts();
    const { BACKDOOR_GB, BACKDOOR_KEEP_GB } = mods["sing/config"];
    const r = await driveSing(mods, {
      ticks: 1,
      servers: {
        CSEC: { hasAdminRights: true, requiredHackingSkill: 1 },
        "avmnite-02h": { hasAdminRights: true, requiredHackingSkill: 1 },
      },
      // Room for exactly one copy beside the keep.
      extra: { getServerMaxRam: () => 100, getServerUsedRam: () => 100 - BACKDOOR_KEEP_GB - BACKDOOR_GB - 1 },
    });
    const copies = r.ns.ps("home").filter((p) => p.filename === "scripts/sing/backdoor.js");
    assert(copies.length === 1 && copies[0].args.at(-1) === "CSEC", `expected CSEC alone: ${JSON.stringify(copies)}`);
    assert(r.ns._log.some((l) => l.includes("1 in reach with no home RAM")), `the RAM wait must be said: ${r.ns._log}`);
  },

  "backdoor.js refuses w0r1d_d43m0n and always leaves the terminal on home": async () => {
    const { main } = (await loadScripts())["sing/backdoor"];
    const hops = [];
    const fake = (args) => ({ args, singularity: {
      connect: (h) => { hops.push(h); return h !== "n00dles"; },
      installBackdoor: async () => { hops.push("BACKDOOR"); },
    } });
    let msg = "";
    await main(fake(["home", "The-Cave", "w0r1d_d43m0n"])).catch((e) => { msg = e.message; });
    assert(msg.includes("w0r1d_d43m0n") && hops.length === 0, `w0r1d_d43m0n was not refused: ${hops}`);
    await main(fake(["home", "n00dles", "CSEC"]));
    assert(JSON.stringify(hops) === JSON.stringify(["home", "n00dles", "home"]),
      `a failed hop must not backdoor, and must end on home: ${hops}`);
    hops.length = 0;
    await main(fake(["home", "foodnstuff"]));
    assert(JSON.stringify(hops) === JSON.stringify(["home", "foodnstuff", "BACKDOOR", "home"]),
      `the happy path: ${hops}`);
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
    assert(JSON.stringify(tags) === JSON.stringify(["backdoors", "invites", "read", "tor", "upgrade"]),
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
