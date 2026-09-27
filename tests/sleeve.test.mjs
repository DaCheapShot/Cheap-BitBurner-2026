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
function sleeveApi(list, { access = true, joined = [], gangFaction = null } = {}) {
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
  store = {}, want = null, karma = 0, args = [], canGang = false, inGang = false, access = true, joined = [], gangFaction = null,
} = {}) {
  const { api, calls } = sleeveApi(list, { access, joined, gangFaction });
  const { REP_WANT_MARKER } = mods["sleeve/config"];
  if (want) store[REP_WANT_MARKER] = JSON.stringify(want);
  const ns = makeNs({
    files: store,
    args,
    extra: {
      sleeve: api,
      gang: { inGang: () => inGang },
      getPlayer: () => ({ karma, skills: skills(1) }),
      getResetInfo: () => ({ currentNode: canGang ? 2 : 10, ownedSF: new Map() }),
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
