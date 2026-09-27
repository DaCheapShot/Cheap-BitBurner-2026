import { loadScripts, readScript, assert, assertClose } from "./harness.mjs";
import { makeNs } from "./mockNs.mjs";

/**
 * The sleeve subsystem.
 *
 * RAM pins live in tests/ram.test.mjs. This file is behaviour: the decisions in
 * sleeve/plan.js, sing's want list, and one sleeve.js pass driven against a
 * fake ns.sleeve - with every rpc transient really executed by the mock's
 * ns.run.
 */

const NO_ACCESS = "sleeve.getNumSleeves: You do not have access to the Sleeve API. This is either because " +
  "you are not in BitNode-10 or because you do not have Source-File 10.";

const skills = (v, over = {}) => ({
  hacking: v, strength: v, defense: v, dexterity: v, agility: v, charisma: v, intelligence: 0, ...over,
});

function sleeve(over = {}) {
  return { shock: 0, sync: 100, skills: skills(100), mults: { crime_success: 1 }, ...over };
}

const noWant = { factions: [], companies: [] };
const HACK = ["hacking", "field", "security"];

/**
 * A fake ns.sleeve that refuses what the game refuses (NetscriptFunctions/
 * Sleeve.ts): no access without SF10, a faction or company another sleeve is
 * CURRENTLY working, the gang's faction, and an unjoined faction.
 */
function sleeveApi(list, { access = true, joined = [], gangFaction = null, node = 10, free = 1 } = {}) {
  const guard = () => { if (!access) throw NO_ACCESS; };
  const other = (i, pred) => list.some((s, j) => j !== i && s.task && pred(s.task));
  const calls = [];
  const set = (i, task) => { calls.push([i, task]); list[i].task = task; return true; };
  return {
    calls,
    api: {
      getNumSleeves: () => { guard(); return list.length; },
      getSleeve: (i) => { guard(); const { task, ...rest } = list[i]; return structuredClone(rest); },
      getTask: (i) => { guard(); return list[i].task ? { ...list[i].task, nextCompletion: Promise.resolve() } : null; },
      setToShockRecovery: (i) => { guard(); return set(i, { type: "RECOVERY" }); },
      setToSynchronize: (i) => { guard(); return set(i, { type: "SYNCHRO" }); },
      setToCommitCrime: (i, crimeType) => { guard(); return set(i, { type: "CRIME", crimeType }); },
      // Sleeve.workoutAtGym: Powerhouse only in Sector-12, false anywhere else.
      setToGymWorkout: (i, location, classType) => {
        guard();
        if (location !== "Powerhouse Gym" || list[i].city !== "Sector-12") return false;
        return set(i, { type: "CLASS", classType, location });
      },
      // Sleeve.findPurchasableAugs / purchaseAugmentation: the shop minus what it
      // owns; a buy needs shock 0 and zeroes the sleeve's exp.
      getSleevePurchasableAugs: (i) => { guard(); return (list[i].shop ?? []).filter((a) => !(list[i].owned ?? []).includes(a.name)); },
      purchaseSleeveAug: (i, name) => {
        guard();
        const s = list[i];
        calls.push([i, { try: name }]);
        if (s.shock > 0 || !(s.shop ?? []).some((a) => a.name === name) || (s.owned ?? []).includes(name)) return false;
        (s.owned ??= []).push(name);
        s.exp = Object.fromEntries(Object.keys(s.exp ?? {}).map((k) => [k, 0]));
        calls.push([i, { buy: name }]);
        return true;
      },
      // SleeveCovenantPurchases.tsx: BN10, Covenant members, five at most.
      purchaseSleeve: () => {
        guard();
        if (node !== 10) throw "purchaseSleeve: You must be in BitNode 10 to use this API.";
        if (!joined.includes("The Covenant")) return { success: false, message: "not a member" };
        if (list.length - free >= 5) return { success: false, message: "maximum" };
        calls.push([list.length, { sleeve: true }]);
        list.push(sleeve({ shock: 100, sync: 1 }));
        return { success: true };
      },
      upgradeMemory: (i, n) => {
        guard();
        const m = list[i].memory ?? 1;
        if (m + n > 100) return { success: false, message: "max 100" };
        list[i].memory = m + n;
        calls.push([i, { memory: n }]);
        return { success: true };
      },
      setToFactionWork: (i, factionName, factionWorkType) => {
        guard();
        if (!joined.includes(factionName)) throw `Cannot work for faction ${factionName} without being a member.`;
        if (other(i, (t) => t.type === "FACTION" && t.factionName === factionName)) {
          throw `Sleeve ${i} cannot work for faction ${factionName} because another sleeve is already working for them.`;
        }
        if (factionName === gangFaction) throw `Sleeve ${i} cannot work for faction ${factionName} because you have started a gang with them.`;
        return set(i, { type: "FACTION", factionName, factionWorkType });
      },
      setToCompanyWork: (i, companyName) => {
        guard();
        if (other(i, (t) => t.type === "COMPANY" && t.companyName === companyName)) {
          throw `Sleeve ${i} cannot work for company ${companyName} because another sleeve is already working for them.`;
        }
        return set(i, { type: "COMPANY", companyName });
      },
    },
  };
}

/** One sleeve.js pass. `store` carries /data files between passes, as boot's ticks do. */
async function pass(mods, list, {
  store = {}, want = null, karma = 0, args = [], money = 0, augStats = null, node = null, sf10 = 0, canGang = false, inGang = false, access = true, joined = [], gangFaction = null,
} = {}) {
  const bn = node ?? (canGang ? 2 : 10);
  const { api, calls } = sleeveApi(list, { access, joined, gangFaction, node: bn, free: Math.min(3, sf10 + (bn === 10 ? 1 : 0)) });
  const { REP_WANT_MARKER } = mods["sleeve/config"];
  if (want) store[REP_WANT_MARKER] = JSON.stringify(want);
  const ns = makeNs({
    files: store,
    args,
    extra: {
      sleeve: api,
      gang: { inGang: () => inGang },
      getPlayer: () => ({ karma, skills: skills(1), money, factions: joined }),
      // Without augStats, getAugmentationStats throws as it does without SF4.
      singularity: { getAugmentationStats: (a) => {
        if (!augStats) throw "getAugmentationStats: This singularity function requires Source-File 4 to run.";
        return augStats[a] ?? {};
      } },
      getResetInfo: () => ({ currentNode: bn, ownedSF: new Map(sf10 ? [[10, sf10]] : []) }),
    },
  });
  await mods["sleeve/sleeve"].main(ns);
  return { ns, calls, store: ns._files, terminal: ns._log.filter((l) => l.startsWith("[T] ")) };
}

export const tests = {
  // ------------------------------------------------------------- the math ---

  // Crime.successRate transcribed a second time, flat, from src/Crime/Crime.ts
  // and Crimes.ts - not through the module's own table.
  "crimeChance is Crime.successRate": async () => {
    const { crimeChance } = (await loadScripts())["sleeve/plan"];
    const p = { skills: skills(10), mults: { crime_success: 1 } };
    // Homicide: weights str 2, def 2, dex 0.5, agi 0.5, difficulty 1.
    assertClose(crimeChance(p, "Homicide"), (2 * 10 + 2 * 10 + 0.5 * 10 + 0.5 * 10) / 975 / 1, 1e-12, "Homicide");
    // Mug: str 1.5, def 0.5, dex 1.5, agi 0.5, difficulty 1/5.
    assertClose(crimeChance(p, "Mug"), (1.5 * 10 + 0.5 * 10 + 1.5 * 10 + 0.5 * 10) / 975 / 0.2, 1e-12, "Mug");
    // Deal Drugs: cha 3, dex 2, agi 1; x crime_success; int adds 0.025 x int and the int bonus.
    const q = { skills: skills(10, { intelligence: 100 }), mults: { crime_success: 1.5 } };
    const bonus = 1 + Math.pow(100, 0.8) / 600;
    assertClose(crimeChance(q, "Deal Drugs"), ((3 + 2 + 1) * 10 + 0.025 * 100) / 975 / 1 * 1.5 * bonus, 1e-12, "Deal Drugs");
    assert(crimeChance({ skills: skills(1000), mults: {} }, "Shoplift") === 1, "capped at 1");
  },

  "karmaSyncTarget is the minimum of the finish time": async () => {
    const { karmaSyncTarget } = (await loadScripts())["sleeve/plan"];
    // T(S) = (S - 1)/r + 100 K/(k S), minimised by brute force.
    for (const [owed, n, k] of [[54000, 8, 1], [54000, 3, 1], [20000, 5, 0.4], [54000, 1, 0.05]]) {
      const r = 0.001;
      const T = (S) => (S - 1) / r + (100 * (owed / n)) / (k * S);
      let best = 1;
      for (let S = 1; S <= 100; S += 0.01) if (T(S) < T(best)) best = S;
      assertClose(karmaSyncTarget(owed, n, 0, k), best, 0.02, `owed ${owed}, ${n} sleeves, k ${k}`);
    }
    assert(karmaSyncTarget(54000, 8, 0, 0) === 100, "no odds at all: sync is the only progress");
  },

  // The derivation in sleeve/config.js, checked by simulating it: from shock
  // 100, recover while shock > theta, then work. Work decays shock at 1e-4 a
  // cycle, recovery at 3e-4 (Sleeve.process + SleeveRecoveryWork); rep is
  // (100 - shock) a cycle while working. Over a long horizon the best theta is 100/3.
  "SHOCK_RECOVER_ABOVE maximises rep over a long grind": async () => {
    const { SHOCK_RECOVER_ABOVE } = (await loadScripts())["sleeve/config"];
    const rep = (theta) => {
      let s = 100, total = 0;
      const dt = 500;
      for (let t = 0; t < 4e6; t += dt) {
        if (s > theta) s = Math.max(0, s - 3e-4 * dt);
        else { total += (100 - s) * dt; s = Math.max(0, s - 1e-4 * dt); }
      }
      return total;
    };
    let best = 0;
    for (let theta = 0; theta <= 100; theta += 0.5) if (rep(theta) > rep(best)) best = theta;
    assertClose(SHOCK_RECOVER_ABOVE, best, 1, `simulated best threshold ${best}`);
  },

  "bestWorkType picks the formula's winner among the offered types": async () => {
    const { bestWorkType } = (await loadScripts())["sleeve/plan"];
    assert(bestWorkType(skills(10, { hacking: 500 }), HACK) === "hacking", "a hacker hacks");
    assert(bestWorkType(skills(10, { strength: 500, defense: 500 }), HACK) === "security", "a brawler guards");
    assert(bestWorkType(skills(100, { hacking: 1 }), ["hacking", "field"]) === "field", "field when security is not offered");
    assert(bestWorkType(skills(100), []) === null, "no types - the gang's faction - is no work");
  },

  // ------------------------------------------------------------- the rungs --

  "karma first: every sleeve syncs, then crimes, while a gang can be founded": async () => {
    const { assign } = (await loadScripts())["sleeve/plan"];
    const want = { factions: [{ faction: "CyberSec", types: HACK }], companies: [] };
    const base = { player: { karma: 0, skills: skills(1) }, want, karma: true, canGang: true, inGang: false };
    const a = assign({ ...base, sleeves: [sleeve({ sync: 1 }), sleeve({ sync: 100 })] });
    assert(a[0].kind === "sync", `sync 1 syncs first, got ${a[0].kind}`);
    assert(a[1].kind === "crime" && a[1].crime === "Homicide", `synced sleeve does Homicide, got ${JSON.stringify(a[1])}`);
    // Each thing that switches the rung off hands the sleeves to rep.
    for (const [why, over] of [["gang exists", { inGang: true }], ["no SF2", { canGang: false }],
      ["setting off", { karma: false }], ["bar reached", { player: { karma: -54001, skills: skills(1) } }]]) {
      const b = assign({ ...base, ...over, sleeves: [sleeve({ sync: 100 })] });
      assert(b[0].kind === "faction", `${why}: rep, got ${b[0].kind}`);
    }
  },

  "rep: one sleeve per entry, least shocked first, then money": async () => {
    const { assign } = (await loadScripts())["sleeve/plan"];
    const want = { factions: [{ faction: "CyberSec", types: HACK }, { faction: "NiteSec", types: HACK }],
      companies: ["ECorp"] };
    const sleeves = [sleeve({ shock: 20 }), sleeve({ shock: 0 }), sleeve({ shock: 10 }), sleeve({ shock: 0 })];
    const a = assign({ sleeves, player: { karma: 0 }, want, karma: false });
    const placed = a.filter((x) => x.kind !== "crime").map((x) => x.faction ?? x.company);
    assert(new Set(placed).size === placed.length, `an entry was handed out twice: ${placed}`);
    assert(a[1].faction === "CyberSec" && a[3].faction === "NiteSec" && a[2].company === "ECorp",
      `least shocked take the entries in order: ${JSON.stringify(a)}`);
    assert(a[0].kind === "crime", `the spare earns money: ${a[0].kind}`);
  },

  "shock: only as many sleeves recover as there are entries left open": async () => {
    const { assign } = (await loadScripts())["sleeve/plan"];
    const want = { factions: [{ faction: "CyberSec", types: HACK }], companies: [] };
    const a = assign({ sleeves: [sleeve({ shock: 90 }), sleeve({ shock: 60 }), sleeve({ shock: 100 })],
      player: { karma: 0 }, want, karma: false });
    assert(a[1].kind === "recover", `least shocked recovers for the one entry: ${a[1].kind}`);
    assert(a[0].kind === "crime" && a[2].kind === "crime", "the others earn money meanwhile");
    const b = assign({ sleeves: [sleeve({ shock: 30 })], player: { karma: 0 }, want, karma: false });
    assert(b[0].kind === "faction", "at or under the threshold it works");
  },

  "a sleeve keeps the entry it is on - no shuffling between ticks": async () => {
    const { assign } = (await loadScripts())["sleeve/plan"];
    const want = { factions: [{ faction: "CyberSec", types: HACK }, { faction: "NiteSec", types: HACK }], companies: [] };
    const tasks = [null, { type: "FACTION", factionName: "NiteSec", factionWorkType: "hacking" }];
    const a = assign({ sleeves: [sleeve({ shock: 0 }), sleeve({ shock: 30 })], tasks, player: { karma: 0 }, want, karma: false });
    assert(a[1].faction === "NiteSec", `the holder keeps NiteSec: ${JSON.stringify(a[1])}`);
    assert(a[0].faction === "CyberSec", `the other takes what is left: ${JSON.stringify(a[0])}`);
  },

  "no want file, or a mangled one, is no rep work - never a default": async () => {
    const { assign, parseWant } = (await loadScripts())["sleeve/plan"];
    for (const text of ["", undefined, "{not json", "[]", '{"factions": 3}']) {
      const want = parseWant(text);
      assert(want.factions.length === 0 && want.companies.length === 0, `"${text}" parsed as work`);
      const a = assign({ sleeves: [sleeve()], player: { karma: 0 }, want, karma: false });
      assert(a[0].kind === "crime", `"${text}": money, got ${a[0].kind}`);
    }
    // Skills 100: Mug pays 36k / 4 s at 100%, Homicide 45k / 3 s at 51% - Mug.
    assert(assign({ sleeves: [sleeve()], player: { karma: 0 }, want: noWant, karma: false })[0].crime === "Mug",
      "the best money crime at these odds");
  },

  "sameTask matches getTask's shape, so an unchanged task is left alone": async () => {
    const { sameTask } = (await loadScripts())["sleeve/plan"];
    assert(sameTask({ type: "CRIME", crimeType: "Homicide" }, { kind: "crime", crime: "Homicide" }), "crime");
    assert(!sameTask({ type: "CRIME", crimeType: "Mug" }, { kind: "crime", crime: "Homicide" }), "other crime");
    assert(sameTask({ type: "RECOVERY" }, { kind: "recover" }), "recover");
    assert(sameTask({ type: "SYNCHRO" }, { kind: "sync" }), "sync");
    assert(!sameTask(null, { kind: "sync" }), "idle is never the same");
    assert(sameTask({ type: "FACTION", factionName: "X", factionWorkType: "hacking" },
      { kind: "faction", faction: "X", type: "hacking" }), "faction");
    assert(!sameTask({ type: "FACTION", factionName: "X", factionWorkType: "field" },
      { kind: "faction", faction: "X", type: "hacking" }), "faction, other type");
    assert(sameTask({ type: "COMPANY", companyName: "ECorp" }, { kind: "company", company: "ECorp" }), "company");
  },

  // ------------------------------------------------------------- the gym ---

  // skill = floor(m (32 ln(exp + 534.6) - 200)): a live sleeve read 16 at 1,294
  // exp, so m is ~0.41 there, and levels/s from 10 exp/s follow from it.
  "levelRate reads the level multiplier back off skill and exp": async () => {
    const { levelRate } = (await loadScripts())["sleeve/plan"];
    const s = { skills: { strength: 16 }, exp: { strength: 1294 }, mults: {} };
    const m = 16.5 / (32 * Math.log(1294 + 534.6) - 200);
    assertClose(levelRate(s, "strength", 10), (32 * m / (1294 + 534.6)) * 10, 1e-12, "levels/s");
    assert(levelRate({ skills: { strength: 1 }, exp: { strength: 0 }, mults: { strength: 2 } }, "strength", 10) ===
      (32 * 2 / 534.6) * 10, "level 1 falls back to the sleeve's own mult");
  },

  // The live report: a synced sleeve at 16 combat doing Homicide at 8.2%. The
  // gym triples those odds in well under an hour, so it trains.
  "the live case: 16 combat at 8% trains at the gym instead of Homicide": async () => {
    const { assign } = (await loadScripts())["sleeve/plan"];
    const weak = sleeve({ city: "Sector-12", skills: skills(16, { hacking: 1, charisma: 1, intelligence: 1 }),
      exp: { strength: 1294, defense: 1294, dexterity: 1294, agility: 1294 } });
    const a = assign({ sleeves: [weak], player: { karma: -100, skills: skills(1) }, want: noWant,
      karma: true, canGang: true, inGang: false });
    assert(a[0].kind === "gym" && a[0].stat === "str" && a[0].gym === "Powerhouse Gym",
      `expected Strength at Powerhouse, got ${JSON.stringify(a[0])}`);
  },

  "training stops paying: capped odds, almost no karma owed, or not in Sector-12": async () => {
    const { assign } = (await loadScripts())["sleeve/plan"];
    const base = { player: { karma: -100, skills: skills(1) }, want: noWant, karma: true, canGang: true, inGang: false };
    const exp16 = { strength: 1294, defense: 1294, dexterity: 1294, agility: 1294 };
    const at = (over) => sleeve({ city: "Sector-12", skills: skills(16), exp: exp16, ...over });
    // Homicide at 100% already: another level buys nothing.
    const capped = assign({ ...base, sleeves: [at({ skills: skills(400), exp: { strength: 1e9, defense: 1e9, dexterity: 1e9, agility: 1e9 } })] });
    assert(capped[0].kind === "crime", `capped odds still trained: ${JSON.stringify(capped[0])}`);
    // Three karma short of the bar: the training could never repay itself.
    const nearly = assign({ ...base, player: { karma: -53997, skills: skills(1) }, sleeves: [at({})] });
    assert(nearly[0].kind === "crime", `trained with 3 karma owed: ${JSON.stringify(nearly[0])}`);
    const away = assign({ ...base, sleeves: [at({ city: "Aevum" })] });
    assert(away[0].kind === "crime", "no Powerhouse outside Sector-12 - no travel for it");
  },

  // Exp is shared, so one trainer per stat is enough - the rest keep earning
  // karma and get the levels anyway.
  "at most one sleeve per stat trains; the rest do crime": async () => {
    const { assign } = (await loadScripts())["sleeve/plan"];
    const exp16 = { strength: 1294, defense: 1294, dexterity: 1294, agility: 1294 };
    const many = Array.from({ length: 6 }, () => sleeve({ city: "Sector-12", skills: skills(16), exp: exp16 }));
    const a = assign({ sleeves: many, player: { karma: 0, skills: skills(1) }, want: noWant, karma: true, canGang: true, inGang: false });
    const stats = a.filter((x) => x.kind === "gym").map((x) => x.stat);
    assert(stats.length >= 1 && stats.length <= 4, `trainers: ${stats}`);
    assert(new Set(stats).size === stats.length, `a stat trained twice: ${stats}`);
    assert(stats[0] === "str", `Strength first - Homicide weighs it 2: ${stats}`);
    assert(a.some((x) => x.kind === "crime"), "somebody is still earning karma");
  },

  "a pass puts a trainer in the gym, and leaves it there next pass": async () => {
    const mods = await loadScripts();
    const exp16 = { strength: 1294, defense: 1294, dexterity: 1294, agility: 1294 };
    const list = [sleeve({ city: "Sector-12", skills: skills(16), exp: exp16 })];
    const one = await pass(mods, list, { canGang: true });
    assert(list[0].task?.type === "CLASS" && list[0].task.classType === "str", `not at the gym: ${JSON.stringify(list[0].task)}`);
    const two = await pass(mods, list, { canGang: true, store: one.store });
    assert(two.calls.length === 0, `restarted the workout: ${JSON.stringify(two.calls)}`);
  },

  // ------------------------------------------------------------- the augs --

  "planAugs: least-exp sleeve first, tier 1 by rung, cheapest within, one shared budget": async () => {
    const { planAugs } = (await loadScripts())["sleeve/plan"];
    const shop = [{ name: "Rep", cost: 50 }, { name: "Cheap", cost: 10 }, { name: "Combat", cost: 40 }];
    const stats = { Rep: { faction_rep: 1.1 }, Cheap: {}, Combat: { strength: 1.1 } };
    const sleeves = [{ exp: { strength: 5000 } }, { exp: { strength: 10 } }];
    const actions = [{ rung: "rep" }, { rung: "karma" }];
    // Budget for one sleeve's whole shop and no more: the fresh one gets it.
    const p = planAugs({ sleeves, actions, avail: { 0: shop, 1: shop }, stats, budget: 100, minBatch: 1 });
    assert(p.buys.length === 1 && p.buys[0].i === 1, `least exp first: ${JSON.stringify(p.buys)}`);
    assert(p.buys[0].names[0] === "Combat", `a karma sleeve's tier 1 is combat: ${p.buys[0].names}`);
    assert(p.buys[0].names.join() === "Combat,Cheap,Rep", `then cheapest: ${p.buys[0].names}`);
    assert(p.waits.length === 1 && p.waits[0].i === 0 && p.waits[0].fit === 0, `the other waits: ${JSON.stringify(p.waits)}`);
    const rep = planAugs({ sleeves: [sleeves[0]], actions: [actions[0]], avail: { 0: shop }, stats, budget: 1e9, minBatch: 1 });
    assert(rep.buys[0].names[0] === "Rep", "a rep sleeve's tier 1 is faction_rep");
    const blind = planAugs({ sleeves: [sleeves[0]], actions: [actions[0]], avail: { 0: shop }, stats: {}, budget: 1e9, minBatch: 1 });
    assert(blind.buys[0].names.join() === "Cheap,Combat,Rep", "no stats: plain cheapest-first");
  },

  // Each buy wipes the sleeve's exp, so a batch too small to be worth a wipe
  // waits - unless it is everything the sleeve has left to buy.
  "planAugs: a batch under augMin waits, unless it is all that is left": async () => {
    const { planAugs } = (await loadScripts())["sleeve/plan"];
    const three = [{ name: "A", cost: 10 }, { name: "B", cost: 10 }, { name: "C", cost: 10 }];
    const base = { sleeves: [{ exp: {} }], actions: [{ rung: "money" }], stats: {}, minBatch: 3 };
    assert(planAugs({ ...base, avail: { 0: three }, budget: 20 }).buys.length === 0, "2 of 3 affordable, min 3: wait");
    assert(planAugs({ ...base, avail: { 0: three }, budget: 30 }).buys[0].names.length === 3, "3 affordable: buy");
    const tail = planAugs({ ...base, avail: { 0: three.slice(0, 2) }, budget: 20 });
    assert(tail.buys[0]?.names.length === 2, `the last two go even under the minimum: ${JSON.stringify(tail)}`);
  },

  "a pass buys a batch for a shock-0 sleeve, caches the stats, and never for a shocked one": async () => {
    const mods = await loadScripts();
    const { STATUS_FILE, AUG_STATS_FILE } = mods["sleeve/config"];
    const shop = [{ name: "A", cost: 1e6 }, { name: "B", cost: 1e6 }, { name: "C", cost: 1e6 }];
    const list = [sleeve({ shock: 0, shop, exp: { strength: 999 } }), sleeve({ shock: 5, shop })];
    const r = await pass(mods, list, { money: 1e8, augStats: { A: {}, B: {}, C: {} } });
    assert(JSON.stringify(list[0].owned) === JSON.stringify(["A", "B", "C"]), `bought: ${list[0].owned} / ${r.store[STATUS_FILE]}`);
    assert(list[0].exp.strength === 0, "the game wiped its exp - the status line says so");
    assert(!r.calls.some(([i, c]) => i === 1 && c.try), "a shocked sleeve is never even tried");
    assert(r.store[STATUS_FILE].includes("sleeve 0 bought 3") && r.store[STATUS_FILE].includes("exp wiped"), r.store[STATUS_FILE]);
    assert(JSON.parse(r.store[AUG_STATS_FILE]).A, "stats are cached for the next pass");
    // 10% of $10m is $1m: one aug fits, min 3 - the sleeve waits and says why.
    const poor = [sleeve({ shock: 0, shop })];
    const w = await pass(mods, poor, { money: 1e7 });
    assert(!poor[0].owned, "under the batch minimum nothing is bought");
    assert(w.store[STATUS_FILE].includes("waits - 1 of 3 affordable"), w.store[STATUS_FILE]);
    assert(w.store[STATUS_FILE].includes("unrated"), "no SF4: said, and it still plans cheapest-first");
  },

  "sleeve.augCash 0 buys nothing": async () => {
    const mods = await loadScripts();
    const { SETTINGS_FILE } = mods["settings"];
    const list = [sleeve({ shock: 0, shop: [{ name: "A", cost: 1 }] })];
    await pass(mods, list, { money: 1e12, store: { [SETTINGS_FILE]: JSON.stringify({ "sleeve.augCash": 0 }) } });
    assert(!list[0].owned, "bought with a zero budget");
  },

  // --------------------------------------------------------------- history --

  // sleeves.txt is rewritten every pass, so what happened between two looks
  // was lost. The history keeps it: events only, timestamped, capped.
  "the history keeps what happened across passes, and only what happened": async () => {
    const mods = await loadScripts();
    const { HISTORY_FILE, HISTORY_KEEP } = mods["sleeve/config"];
    const list = [sleeve()];
    const one = await pass(mods, list, {});
    const h1 = one.store[HISTORY_FILE].trim().split("\n");
    assert(h1.length === 1 && h1[0].includes("sleeve 0: crime Mug") && h1[0].includes("[was idle]"),
      `the change is logged: ${h1}`);
    const two = await pass(mods, list, { store: one.store });
    assert(two.store[HISTORY_FILE].trim().split("\n").length === 1, "a quiet pass adds nothing");
    // A body that fails every pass is logged once, not once a minute.
    const broken = { ...two.store };
    await pass(mods, [], { access: false, store: broken });
    await pass(mods, [], { access: false, store: broken });
    const warns = broken[HISTORY_FILE].split("\n").filter((l) => l.includes("WARN"));
    assert(warns.length === 1, `a repeating warning logged ${warns.length} times`);
    // Capped, oldest dropped.
    const full = { [HISTORY_FILE]: Array.from({ length: HISTORY_KEEP }, (_, i) => `old ${i}`).join("\n") };
    await pass(mods, [sleeve()], { store: full });
    const h = full[HISTORY_FILE].trim().split("\n");
    assert(h.length === HISTORY_KEEP && h[0] === "old 1" && h.at(-1).includes("sleeve 0"), `cap: ${h.length}, first ${h[0]}`);
  },

  // --------------------------------------------------------- the covenant --

  // Transcribed a second time, flat, from SleeveCovenantPurchases.tsx and
  // Sleeve.getMemoryUpgradeCost.
  "Covenant prices and the bought count are the game's": async () => {
    const { covenantSleevePrice, memoryPointPrice, covenantBought } = (await loadScripts())["sleeve/plan"];
    assert([0, 1, 2, 3, 4].map(covenantSleevePrice).join() === [10e12, 100e12, 1e15, 10e15, 100e15].join(), "10^k x $10t");
    assert(covenantSleevePrice(5) === Infinity, "five at most");
    assertClose(memoryPointPrice(1), 1e12, 1e-3, "first point $1t");
    assertClose(memoryPointPrice(11), 1e12 * 1.02 ** 10, 1e-3, "1.02x a point");
    assert(memoryPointPrice(100) === Infinity, "memory caps at 100");
    assert(covenantBought(1, 0, 10) === 0, "BN10's free sleeve is not a purchase");
    assert(covenantBought(5, 2, 10) === 2, "SF10.2 in BN10: 3 free");
    assert(covenantBought(4, 5, 10) === 1, "free sleeves cap at 3");
  },

  "planCovenant: a sleeve when affordable, memory only from the surplus above the next one": async () => {
    const { planCovenant } = (await loadScripts())["sleeve/plan"];
    const two = [{ memory: 1 }, { memory: 3 }];
    const base = { sleeves: two, sf10: 1, node: 10, factions: ["The Covenant"], frac: 0.5 };
    assert(planCovenant({ ...base, node: 9, cash: 1e20 }) === null, "BN10 only");
    assert(planCovenant({ ...base, factions: [], cash: 1e20 }) === null, "Covenant members only");
    // $30t: the $10t sleeve fits half; the next one costs $100t, so nothing is surplus.
    const a = planCovenant({ ...base, cash: 30e12 });
    assert(a.sleeve === 10e12 && a.memory.length === 0, `sleeve, no memory: ${JSON.stringify(a)}`);
    // $11t: no sleeve (it needs $20t at 50%), $10t of it reserved for that
    // sleeve: $1t surplus, $0.5t to spend - under one $1t point. Saving.
    const b = planCovenant({ ...base, cash: 11e12 });
    assert(b.sleeve === null && b.memory.length === 0 && b.surplus === 1e12, `saving: ${JSON.stringify(b)}`);
    // $15t: $5t surplus, $2.5t to spend - two points ($1t, $1.02t), both to
    // the lower sleeve, since after one it is still the lower.
    const d = planCovenant({ ...base, cash: 15e12 });
    assert(d.memory.length === 1 && d.memory[0].i === 0 && d.memory[0].amount === 2,
      `2 points to the lower sleeve: ${JSON.stringify(d.memory)}`);
    // All five bought: no reserve, memory takes its share of everything.
    const all = planCovenant({ ...base, sleeves: Array.from({ length: 7 }, () => ({ memory: 100 })), cash: 1e18 });
    assert(all.sleeve === null && all.memory.length === 0 && !Number.isFinite(all.next), "maxed out: nothing to do");
  },

  "a pass buys the next Covenant sleeve and memory, and says what it waits for": async () => {
    const mods = await loadScripts();
    const { STATUS_FILE } = mods["sleeve/config"];
    const list = [sleeve({ memory: 1 })];
    const r = await pass(mods, list, { node: 10, joined: ["The Covenant"], money: 100e12 });
    assert(list.length === 2, `no sleeve bought: ${r.store[STATUS_FILE]}`);
    assert(r.store[STATUS_FILE].includes("covenant: bought sleeve 1 for $10.00t"), r.store[STATUS_FILE]);
    // $100t - $10t - the $100t reserve: no surplus, memory waits.
    assert(r.store[STATUS_FILE].includes("saving for the next sleeve"), r.store[STATUS_FILE]);
    const rich = [sleeve({ memory: 1 })];
    const r2 = await pass(mods, rich, { node: 10, joined: ["The Covenant"], money: 1e15 });
    assert(rich[0].memory > 1, `no memory bought with surplus: ${r2.store[STATUS_FILE]}`);
    assert(r2.store[STATUS_FILE].includes("memory: sleeve 0 +"), r2.store[STATUS_FILE]);
    const none = [sleeve()];
    const r3 = await pass(mods, none, { node: 10, joined: [], money: 1e18 });
    assert(none.length === 1 && !r3.store[STATUS_FILE].includes("covenant"), "no Covenant: silent, no buy");
  },

  "a pass reports sleeve aug spending in dollars": async () => {
    const mods = await loadScripts();
    const { STATUS_FILE } = mods["sleeve/config"];
    const shop = [{ name: "A", cost: 1e6 }, { name: "B", cost: 1e6 }, { name: "C", cost: 1e6 }];
    const r = await pass(mods, [sleeve({ shock: 0, shop })], { money: 1e8, augStats: {} });
    assert(r.store[STATUS_FILE].includes("($3.00m, exp wiped)"), `money needs its $: ${r.store[STATUS_FILE]}`);
  },

  // ----------------------------------------------------------- sing's side --

  "sing's want list: every workable step, tier 1 first, nothing donatable, employed companies only": async () => {
    const { repWant } = (await loadScripts())["sing/plan"];
    const p = {
      skills: skills(300), factions: ["CyberSec", "NiteSec", "Tian Di Hui", "Slum Snakes"],
      jobs: { ECorp: "Software Engineer" }, karma: 0,
    };
    const st = {
      rep: { CyberSec: 0, NiteSec: 0, "Tian Di Hui": 0, "Slum Snakes": 0 },
      workTypes: { CyberSec: HACK, NiteSec: HACK, "Tian Di Hui": HACK, "Slum Snakes": [] },
      companyRep: {},
      targets: { CyberSec: 1e5, NiteSec: 1e5, "Tian Di Hui": 1e5, "Slum Snakes": 1e5, ECorp: 1e5, "Bachman & Associates": 1e5 },
      priorityTargets: { CyberSec: 1e5, NiteSec: 0, "Tian Di Hui": 0, ECorp: 0, "Bachman & Associates": 0 },
      favor: { "Tian Di Hui": 150 }, favorNeed: 150,
    };
    const w = repWant(p, st);
    const names = w.factions.map((f) => f.faction);
    assert(names[0] === "CyberSec", `tier 1 leads: ${names}`);
    assert(names.includes("NiteSec"), `tier 2 follows: ${names}`);
    assert(!names.includes("Tian Di Hui"), "a donatable faction's rep is bought, not worked");
    assert(!names.includes("Slum Snakes"), "the gang's faction has no work types");
    assert(new Set(names).size === names.length, "each faction once");
    assert(JSON.stringify(w.companies) === JSON.stringify(["ECorp"]), `only where the player is employed: ${w.companies}`);
  },

  // ------------------------------------------------------------ the pass ----

  // boot gates on SF10 now, so a hand-run without it is just a WARN line - and
  // nothing, ever, goes to the terminal: the user's rule.
  "no Sleeve API: a status line, nothing on the terminal, a clean exit": async () => {
    const mods = await loadScripts();
    const { STATUS_FILE, SLEEVE_FACTION_MARKER } = mods["sleeve/config"];
    const r = await pass(mods, [], { access: false, store: { [SLEEVE_FACTION_MARKER]: "faction" } });
    assert(r.store[STATUS_FILE].includes("WARN: count failed"), `status: ${r.store[STATUS_FILE]}`);
    assert(r.terminal.length === 0, `printed: ${r.terminal}`);
    assert(r.store[SLEEVE_FACTION_MARKER] === "", "a stale release of the share hold is cleared");
  },

  "nothing in sleeve/ prints to the terminal": () => {
    for (const f of ["sleeve/sleeve", "sleeve/plan", "sleeve/config"]) {
      assert(!/\btprint\s*\(/.test(readScript(f)), `${f}.js calls tprint`);
    }
  },

  // The order bug the ACTS table exists for: sleeve 0 holds CyberSec but is too
  // shocked to keep it, sleeve 1 is fit. The game refuses CyberSec for sleeve 1
  // while sleeve 0 still works it, so sleeve 0 must leave first.
  "a pass moves sleeves off a faction before another is put on it": async () => {
    const mods = await loadScripts();
    const { SLEEVE_FACTION_MARKER, STATUS_FILE } = mods["sleeve/config"];
    const list = [
      sleeve({ shock: 80, task: { type: "FACTION", factionName: "CyberSec", factionWorkType: "hacking" } }),
      sleeve({ shock: 0 }),
    ];
    const want = { factions: [{ faction: "CyberSec", types: HACK }], companies: [] };
    const r = await pass(mods, list, { want, joined: ["CyberSec"] });
    assert(list[1].task?.factionName === "CyberSec", `sleeve 1 took CyberSec: ${JSON.stringify(list[1].task)} / ${r.store[STATUS_FILE]}`);
    assert(list[0].task?.type === "CRIME", `sleeve 0 went to money: ${JSON.stringify(list[0].task)}`);
    assert(r.store[SLEEVE_FACTION_MARKER] === "faction", "a sleeve on faction work releases sing's share hold");
    assert(r.store[STATUS_FILE].includes("[was idle]"), `the change is marked in the status file: ${r.store[STATUS_FILE]}`);
    assert(r.ns._log.some((l) => l.includes("sleeve 1: faction CyberSec")), "and in the script's own log");
    assert(r.terminal.length === 0, "and never printed");
  },

  "an unchanged task is not restarted": async () => {
    const mods = await loadScripts();
    const list = [sleeve({ task: { type: "CRIME", crimeType: "Mug" } })];
    const r = await pass(mods, list, {});
    assert(r.calls.length === 0, `restarted a running crime: ${JSON.stringify(r.calls)}`);
    assert(!r.store[mods["sleeve/config"].STATUS_FILE].includes("[was"), "an unchanged task is not marked changed");
  },

  "one refused sleeve does not lose the batch, and its refusal is in the status file": async () => {
    const mods = await loadScripts();
    const { STATUS_FILE } = mods["sleeve/config"];
    const list = [sleeve(), sleeve()];
    const want = { factions: [{ faction: "Unjoined", types: HACK }, { faction: "CyberSec", types: HACK }], companies: [] };
    const r = await pass(mods, list, { want, joined: ["CyberSec"] });
    assert(list[1].task?.factionName === "CyberSec", "the batch carried on past the throw");
    assert(r.store[STATUS_FILE].includes("could not start faction Unjoined"), `refusal: ${r.store[STATUS_FILE]}`);
    assert(r.terminal.length === 0, "never printed");
  },

  // Karma buys nothing but a gang: the rung follows gang.enabled and boot's
  // --no-gang, with no switch of its own to disagree with them.
  "karma follows the gang switch and --no-gang": async () => {
    const mods = await loadScripts();
    const { SETTINGS_FILE } = mods["settings"];
    const on = [sleeve({ sync: 100 })];
    await pass(mods, on, { canGang: true });
    assert(on[0].task?.crimeType === "Homicide", `gang on: karma, got ${JSON.stringify(on[0].task)}`);
    const off = [sleeve({ sync: 100 })];
    await pass(mods, off, { canGang: true, store: { [SETTINGS_FILE]: JSON.stringify({ "gang.enabled": 0 }) } });
    assert(off[0].task?.crimeType === "Mug", `gang.enabled off: money, got ${JSON.stringify(off[0].task)}`);
    const flag = [sleeve({ sync: 100 })];
    await pass(mods, flag, { canGang: true, args: ["--no-gang"] });
    assert(flag[0].task?.crimeType === "Mug", `--no-gang: money, got ${JSON.stringify(flag[0].task)}`);
  },
};
