import fs from "node:fs";
import path from "node:path";
import { loadScripts, assert, assertClose } from "./harness.mjs";
import { makeNs } from "./mockNs.mjs";

/**
 * The gang subsystem.
 *
 * Everything worth testing lives in gang/math.js on purpose: the transients are
 * thin, and a decision that can only be exercised by running a 12 GB script
 * against a live gang is a decision nobody checks. The gain formulas below are
 * transcribed from src/Gang/formulas/formulas.ts a SECOND time, flat, rather
 * than calling the module - a test that reuses the implementation's own helpers
 * proves only that the file is self-consistent.
 */

const TRAFFICK = {
  name: "Traffick Illegal Arms",
  isCombat: true, isHacking: false,
  baseRespect: 0.0002, baseMoney: 174, baseWanted: 0.24, difficulty: 32,
  hackWeight: 15, strWeight: 20, defWeight: 20, dexWeight: 20, agiWeight: 0, chaWeight: 25,
  territory: { money: 1, respect: 1, wanted: 1 },
};

const VIGILANTE = {
  name: "Vigilante Justice",
  isCombat: true, isHacking: true,
  baseRespect: 0, baseMoney: 0, baseWanted: -0.001, difficulty: 1,
  hackWeight: 20, strWeight: 20, defWeight: 20, dexWeight: 20, agiWeight: 20, chaWeight: 0,
  territory: { money: 1, respect: 1, wanted: 1 },
};

const MUG = {
  name: "Mug People",
  isCombat: true, isHacking: false,
  baseRespect: 0.00005, baseMoney: 3.6, baseWanted: 0.00005, difficulty: 1,
  hackWeight: 0, strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 10, chaWeight: 15,
  territory: { money: 1, respect: 1, wanted: 1 },
};

const TRAIN_COMBAT = {
  name: "Train Combat",
  isCombat: true, isHacking: true,
  baseRespect: 0, baseMoney: 0, baseWanted: 0, difficulty: 100,
  hackWeight: 0, strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 25, chaWeight: 0,
  territory: { money: 1, respect: 1, wanted: 1 },
};

const WARFARE = {
  name: "Territory Warfare",
  isCombat: true, isHacking: true,
  baseRespect: 0, baseMoney: 0, baseWanted: 0, difficulty: 5,
  hackWeight: 15, strWeight: 20, defWeight: 20, dexWeight: 20, agiWeight: 20, chaWeight: 5,
  territory: { money: 1, respect: 1, wanted: 1 },
};

const TASKS = [TRAFFICK, VIGILANTE, MUG, TRAIN_COMBAT, WARFARE];

/** A member with every stat at the same value. */
function member(name, v, over = {}) {
  return {
    name, task: "Unassigned",
    hack: v, str: v, def: v, dex: v, agi: v, cha: v,
    upgrades: [], augmentations: [],
    ...over,
  };
}

const GANG = { respect: 1000, wantedLevel: 1000, territory: 0.5 };

/**
 * Run gang.js's main for `updates` gang updates against a fake gang API.
 *
 * The mock's ns.run really executes each generated rpc transient, so the bodies
 * run for real and import the real gang/math.js. `calls` records every mutating
 * API call, plus any read named in `throwIn`, which throws instead.
 */
async function driveGang(mods, {
  updates = 30, roster = 4, respectForNextRecruit = 5000, isHacking = false,
  inGang = true, args = [], throwIn = null, ascension = null,
} = {}) {
  const calls = [];
  const members = Array.from({ length: roster }, (_, i) => member(`goon-${i}`, 300));
  let joined = inGang;
  let n = 0;
  const api = (name, fn) => (...a) => {
    if (name === throwIn) throw new Error(`${name} exploded`);
    return fn(...a);
  };
  const gang = {
    inGang: () => joined,
    getBonusTime: () => 0,
    nextUpdate: async () => {
      if (++n > updates) throw new Error("STOP");
      return 2000;
    },
    createGang: (f) => { calls.push(`createGang:${f}`); joined = true; return true; },
    getGangInformation: api("getGangInformation", () => ({
      faction: "Slum Snakes", isHacking, respect: 1e6, wantedLevel: 1, territory: 0.2, power: 10,
      territoryWarfareEngaged: false, respectForNextRecruit,
    })),
    getAllGangInformation: api("getAllGangInformation", () => ({
      "Slum Snakes": { territory: 0.2 }, Tetrads: { territory: 0.3 },
    })),
    getChanceToWinClash: () => 0.9,
    setTerritoryWarfare: () => { calls.push("setTerritoryWarfare"); },
    getMemberNames: () => members.map((m) => m.name),
    recruitMember: () => false,
    getMemberInformation: (name) => members.find((m) => m.name === name),
    getTaskNames: () => TASKS.map((t) => t.name),
    getTaskStats: (name) => TASKS.find((t) => t.name === name),
    setMemberTask: () => { calls.push("setMemberTask"); return true; },
    getAscensionResult: () => ascension,
    ascendMember: () => { calls.push("ascendMember"); return true; },
    getEquipmentNames: () => ["Katana"],
    getEquipmentCost: () => 12e6,
    getEquipmentType: () => "Weapon",
    getEquipmentStats: () => ({ str: 1.1 }),
    purchaseEquipment: () => { calls.push("purchaseEquipment"); return true; },
  };
  const ns = makeNs({ extra: { gang, args } });
  try {
    await mods["gang/gang"].main(ns);
    assert(false, "the loop should only end by the STOP sentinel");
  } catch (e) {
    if (e.message !== "STOP") throw e;
  }
  return { ns, calls };
}

export const tests = {
  // Transcribed flat from the game source. statWeight for TRAFFICK at 300 in
  // every stat is (15+20+20+20+0+25)/100 * 300 = 300, less 4 * 32 = 172.
  "respectGain reproduces the game's formula": async () => {
    const { respectGain } = (await loadScripts())["gang/math"];
    const w = 300 - 4 * 32;
    const tm = Math.max(0.005, Math.pow(0.5 * 100, 1) / 100);
    const penalty = 1000 / (1000 + 1000);
    const expected = Math.pow(11 * 0.0002 * w * tm * penalty, (0.2 * 0.5 + 0.8) * 1);
    assertClose(respectGain(GANG, member("a", 300), TRAFFICK), expected, 1e-12, "respect");
  },

  // Money subtracts 3.2 * difficulty, not 4, and scales by 5 rather than 11.
  // Getting those two crossed is invisible in play and wrong everywhere.
  "moneyGain reproduces the game's formula": async () => {
    const { moneyGain } = (await loadScripts())["gang/math"];
    const w = 300 - 3.2 * 32;
    const tm = Math.max(0.005, Math.pow(0.5 * 100, 1) / 100);
    const penalty = 1000 / (1000 + 1000);
    const expected = Math.pow(5 * 174 * w * tm * penalty, (0.2 * 0.5 + 0.8) * 1);
    assertClose(moneyGain(GANG, member("a", 300), TRAFFICK), expected, 1e-6, "money");
  },

  "wantedGain takes the negative branch for penance tasks and the capped one otherwise": async () => {
    const { wantedGain } = (await loadScripts())["gang/math"];
    const tm = Math.max(0.005, Math.pow(0.5 * 100, 1) / 100);

    const wPos = 300 - 3.5 * 32;
    const expectPos = Math.min(100, (7 * 0.24) / Math.pow(3 * wPos * tm, 0.8));
    assertClose(wantedGain(GANG, member("a", 300), TRAFFICK), expectPos, 1e-12, "positive");

    // Vigilante weights five stats at 20 each, so 100/100 * 300 = 300 less 3.5.
    const wNeg = 300 - 3.5 * 1;
    const expectNeg = 0.4 * -0.001 * wNeg * tm;
    const got = wantedGain(GANG, member("a", 300), VIGILANTE);
    assertClose(got, expectNeg, 1e-12, "negative");
    assert(got < 0, "Vigilante Justice must REDUCE wanted, or the governor cannot work");
  },

  // The reason the TRAIN phase exists at all. A weak member on a hard task is
  // not merely inefficient, it earns exactly zero - so "assign the best task"
  // without a floor would park the whole opening roster on nothing.
  "a task whose difficulty outweighs the member pays exactly zero": async () => {
    const { respectGain, moneyGain } = (await loadScripts())["gang/math"];
    const weak = member("a", 10);
    assert(respectGain(GANG, weak, TRAFFICK) === 0, "respect should be 0 below the difficulty");
    assert(moneyGain(GANG, weak, TRAFFICK) === 0, "money should be 0 below the difficulty");
  },

  "the phase ladder advances on roster then territory, and one raw member does not reset it":
    async () => {
      const { phaseFor } = (await loadScripts())["gang/math"];
      const { PHASE_TRAIN, PHASE_RESPECT, PHASE_TERRITORY, PHASE_MONEY, MAX_MEMBERS } =
        (await loadScripts())["gang/config"];

      const raw = (n) => Array.from({ length: n }, (_, i) => member(`r${i}`, 5));
      const ready = (n) => Array.from({ length: n }, (_, i) => member(`g${i}`, 400));

      assert(phaseFor({ members: raw(3), territory: 0 }) === PHASE_TRAIN, "all raw -> train");
      assert(phaseFor({ members: ready(6), territory: 0 }) === PHASE_RESPECT, "short roster -> respect");
      assert(phaseFor({ members: ready(MAX_MEMBERS), territory: 0.2 }) === PHASE_TERRITORY,
        "full roster, low territory -> territory");
      assert(phaseFor({ members: ready(MAX_MEMBERS), territory: 1 }) === PHASE_MONEY,
        "full roster, territory held -> money");

      // The one that would bite: a member freshly ascended back to zero stats
      // must not drag eleven earners into the training yard.
      const mixed = [...ready(MAX_MEMBERS - 1), member("fresh", 1)];
      assert(phaseFor({ members: mixed, territory: 1 }) === PHASE_MONEY,
        "one untrained member must not reset the gang's phase");
    },

  "members below the stat floor train instead of earning": async () => {
    const mods = await loadScripts();
    const { planTasks } = mods["gang/math"];
    const { PHASE_RESPECT, TASK_TRAIN_COMBAT, TASK_TRAIN_CHARISMA } = mods["gang/config"];

    const members = [
      member("weak", 5),
      member("strong", 400),
      member("nocha", 400, { cha: 1 }),
    ];
    const { plan } = planTasks(GANG, members, TASKS, PHASE_RESPECT);
    assert(plan.get("weak") === TASK_TRAIN_COMBAT, "weak member should train combat");
    assert(plan.get("nocha") === TASK_TRAIN_CHARISMA,
      "combat stats met but charisma short should train charisma - Deal Drugs is 60% cha");
    assert(plan.get("strong") !== TASK_TRAIN_COMBAT, "a trained member should be earning");
  },

  // Sized, not guessed. The governor's whole claim is that it posts the FEWEST
  // vigilantes that stop wanted climbing - so removing one must break it.
  "the wanted governor posts the fewest vigilantes that make net wanted non-positive":
    async () => {
      const mods = await loadScripts();
      const { planTasks, netWantedGain, wantedGain } = mods["gang/math"];
      const { PHASE_RESPECT, TASK_VIGILANTE, WANTED_PENALTY_FLOOR } = mods["gang/config"];

      // A gang deep in the red: penalty well under the floor.
      const sick = { respect: 1000, wantedLevel: 900, territory: 0.5 };
      assert(sick.respect / (sick.respect + sick.wantedLevel) < WANTED_PENALTY_FLOOR,
        "fixture must actually be below the floor or this tests nothing");

      const members = Array.from({ length: 8 }, (_, i) => member(`m${i}`, 400));
      const res = planTasks(sick, members, TASKS, PHASE_RESPECT);
      const byName = new Map(TASKS.map((t) => [t.name, t]));

      assert(res.vigilantes > 0, "governor should have engaged below the floor");
      assert(res.netWanted <= 0, `net wanted should be non-positive, got ${res.netWanted}`);

      // Releasing one vigilante back to its earner must push net positive again,
      // which is what "fewest" means.
      const one = [...res.plan.entries()].find(([, t]) => t === TASK_VIGILANTE)[0];
      const trimmed = new Map(res.plan);
      trimmed.set(one, TRAFFICK.name);
      assert(netWantedGain(sick, members, trimmed, byName) > 0,
        "one fewer vigilante should leave wanted climbing - the governor is over-posting");

      // And a healthy gang must not post any at all. GANG above is NOT healthy
      // - 1000 respect against 1000 wanted is a penalty of 0.5 - so this needs
      // its own fixture rather than reusing it.
      const healthy = { respect: 1e6, wantedLevel: 1, territory: 0.5 };
      assert(healthy.respect / (healthy.respect + healthy.wantedLevel) > WANTED_PENALTY_FLOOR,
        "fixture must be above the floor");
      const well = planTasks(healthy, members, TASKS, PHASE_RESPECT);
      assert(wantedGain(healthy, members[0], VIGILANTE) < 0, "fixture sanity");
      assert(well.vigilantes === 0, "governor must stay out of the way above the floor");
    },

  // The live failure this test exists for. A fresh gang in PHASE_RESPECT sits at
  // a handful of respect with wanted already on the game's clamp of 1 - so the
  // RAW penalty reads 0.833, under any sensible floor, while there is nothing
  // whatsoever to fix. Gating on that posted vigilantes, vigilantes earn no
  // respect, respect is the only term that could lift the penalty, and the gang
  // never got out. Gang.ts also skips the whole wanted block at exactly 1 with
  // negative gain, so the penance was not merely wasted, it was ignored.
  "the governor stands down when wanted is already on the game's floor": async () => {
    const mods = await loadScripts();
    const { planTasks, wantedPenalty, wantedHeadroom } = mods["gang/math"];
    const { PHASE_RESPECT, WANTED_PENALTY_FLOOR, WANTED_MIN_LEVEL } = mods["gang/config"];

    const fresh = { respect: 5, wantedLevel: WANTED_MIN_LEVEL, territory: 0 };
    assert(wantedPenalty(fresh) < WANTED_PENALTY_FLOOR,
      "fixture must look bad by the RAW penalty, or this tests nothing");
    assertClose(wantedHeadroom(fresh), 1, 1e-12,
      "at the clamp there is no headroom to chase, so the ratio must be exactly 1");

    const members = Array.from({ length: 4 }, (_, i) => member(`m${i}`, 400));
    const res = planTasks(fresh, members, TASKS, PHASE_RESPECT);
    assert(res.vigilantes === 0,
      `posted ${res.vigilantes} vigilantes with wanted already at its floor - ` +
        `they cannot lower it, and they stop the respect that is the only way out`);
  },

  // The other half: real excess wanted must still be acted on, at any respect.
  "the governor still engages when wanted is genuinely above the floor": async () => {
    const mods = await loadScripts();
    const { planTasks, wantedHeadroom } = mods["gang/math"];
    const { PHASE_RESPECT, WANTED_PENALTY_FLOOR } = mods["gang/config"];

    const sick = { respect: 1000, wantedLevel: 900, territory: 0.5 };
    assert(wantedHeadroom(sick) < WANTED_PENALTY_FLOOR, "fixture must have real headroom");

    const members = Array.from({ length: 8 }, (_, i) => member(`m${i}`, 400));
    const res = planTasks(sick, members, TASKS, PHASE_RESPECT);
    assert(res.vigilantes > 0, "899 of 900 wanted levels are removable - the governor must act");
    assert(res.netWanted <= 0, `net wanted should be non-positive, got ${res.netWanted}`);
  },

  "the territory allotment takes the weakest earners, not the best ones": async () => {
    const mods = await loadScripts();
    const { planTasks } = mods["gang/math"];
    const { PHASE_TERRITORY, TASK_WARFARE, MAX_MEMBERS } = mods["gang/config"];

    // Descending strength, so the best earner is m0.
    const members = Array.from({ length: MAX_MEMBERS }, (_, i) => member(`m${i}`, 400 - i * 10));
    const { plan, warSlots } = planTasks(GANG, members, TASKS, PHASE_TERRITORY);

    assert(warSlots > 0, "the territory phase should staff territory warfare");
    assert(plan.get("m0") !== TASK_WARFARE,
      "the top earner must keep earning - warfare costs the same power from a weaker member");
    assert(plan.get(`m${MAX_MEMBERS - 1}`) === TASK_WARFARE, "the weakest earner should take warfare");
  },

  // A live gang sat at 12 members, 6 on Territory Warfare and 6 on Terrorism,
  // and earned $0: TERRITORY ranked earners on respect, Terrorism wins respect
  // for combat stats, and Terrorism has no baseMoney. Respect is the scorer
  // only while it buys recruits.
  "a full roster earns money while it builds power, not Terrorism's $0": async () => {
    const mods = await loadScripts();
    const { planTasks, moneyGain } = mods["gang/math"];
    const { PHASE_RESPECT, PHASE_TERRITORY, PHASE_MONEY, TASK_WARFARE, MAX_MEMBERS } = mods["gang/config"];

    // Verbatim from src/Gang/data/tasks.ts.
    const TERRORISM = {
      name: "Terrorism", isCombat: true, baseRespect: 0.01, baseWanted: 6,
      hackWeight: 20, strWeight: 20, defWeight: 20, dexWeight: 20, chaWeight: 20,
      difficulty: 36, territory: { money: 1, respect: 2, wanted: 2 },
    };
    const HUMAN = {
      name: "Human Trafficking", isCombat: true, baseRespect: 0.004, baseWanted: 1.25, baseMoney: 360,
      hackWeight: 30, strWeight: 5, defWeight: 5, dexWeight: 30, chaWeight: 30,
      difficulty: 36, territory: { money: 1.5, respect: 1.5, wanted: 1.6 },
    };
    const tasks = [...TASKS, TERRORISM, HUMAN];
    // The live gang at 10:05:25: respect dwarfs wanted, so the governor is idle.
    const live = { respect: 15.81e6, wantedLevel: 24.87e3, territory: 0.143 };
    const members = Array.from({ length: MAX_MEMBERS }, (_, i) =>
      member(`m${i}`, 1000, { hack: 150, cha: 500 }));

    // Recruiting still ranks on respect - that is what it is for.
    const recruiting = planTasks(live, members.slice(0, 6), tasks, PHASE_RESPECT);
    assert([...recruiting.plan.values()].every((t) => t === "Terrorism"),
      `RESPECT must still rank on respect, got ${[...recruiting.plan.values()]}`);

    for (const phase of [PHASE_TERRITORY, PHASE_MONEY]) {
      const { plan, vigilantes } = planTasks(live, members, tasks, phase);
      assert(vigilantes === 0, `the fixture should leave the governor idle in ${phase}`);
      const earners = [...plan.values()].filter((t) => t !== TASK_WARFARE);
      assert(earners.length > 0, `${phase} should keep some earners`);
      assert(!earners.includes("Terrorism"), `${phase} put an earner on Terrorism, which pays $0`);
      for (const [name, t] of plan) {
        if (t === TASK_WARFARE) continue;
        const m = members.find((x) => x.name === name);
        assert(moneyGain(live, m, tasks.find((x) => x.name === t)) > 0,
          `${phase}: ${name} is on ${t}, which earns no money`);
      }
    }
  },

  "ascension is refused when it would cost the next recruit": async () => {
    const mods = await loadScripts();
    const { shouldAscend } = mods["gang/math"];
    const { MAX_MEMBERS, ASCEND_MULT_THRESHOLD } = mods["gang/config"];

    const big = ASCEND_MULT_THRESHOLD + 0.2;
    const result = { respect: 400, hack: 1, str: big, def: big, dex: big, agi: big, cha: 1 };

    assert(!shouldAscend(result, { respect: 500, nextRecruitAt: 450, memberCount: 6 }),
      "500 - 400 = 100 is under the 450 needed to recruit; the recruit is worth more");
    assert(shouldAscend(result, { respect: 5000, nextRecruitAt: 450, memberCount: 6 }),
      "plenty of respect to spare - should ascend");
    assert(shouldAscend(result, { respect: 500, nextRecruitAt: 450, memberCount: MAX_MEMBERS }),
      "roster is full, so there is no recruit to protect");

    const small = { respect: 0, hack: 9, str: 1.01, def: 1.01, dex: 1.01, agi: 1.01, cha: 9 };
    assert(!shouldAscend(small, { respect: 1e9, nextRecruitAt: 1, memberCount: 6 }),
      "a big hack/cha factor must not carry a combat gang past the threshold");
    assert(!shouldAscend(null, { respect: 1e9, nextRecruitAt: 1, memberCount: 6 }),
      "a null result means the member cannot ascend");
  },

  // Hysteresis, and the minimum rather than the mean. A clash is drawn against
  // one rival at a time, so five safe matchups do not make a sixth safe.
  "war engages on the worst matchup and holds through hysteresis": async () => {
    const mods = await loadScripts();
    const { warDecision } = mods["gang/math"];
    const { WAR_WIN_THRESHOLD, WAR_DISENGAGE_THRESHOLD } = mods["gang/config"];
    const mid = (WAR_WIN_THRESHOLD + WAR_DISENGAGE_THRESHOLD) / 2;

    assert(!warDecision(false, [0.99, 0.99, 0.99, 0.2]),
      "one bad matchup must veto - averaging would engage here");
    assert(warDecision(false, [0.99, WAR_WIN_THRESHOLD]), "all clear -> engage");
    assert(warDecision(true, [mid]), "already engaged, above the disengage floor -> stay in");
    assert(!warDecision(false, [mid]), "not engaged, below the engage threshold -> stay out");
    assert(!warDecision(true, [WAR_DISENGAGE_THRESHOLD - 0.01]), "below the floor -> pull out");
    assert(!warDecision(false, []), "no rivals holding territory -> nothing to fight");
  },

  // Gear used to be held back in TRAIN as money the next ascension would burn.
  // Member stats include the equipment multipliers, so gear is what lifts a
  // trainee over TRAIN_STAT_FLOOR sooner - and the floor is what ends TRAIN.
  // The planner no longer takes a phase at all; this pins that gear is bought.
  "gear is bought in every phase, TRAIN included": async () => {
    const { planPurchases } = (await loadScripts())["gang/math"];

    const items = [
      { name: "Baseball Bat", cost: 10, type: "Weapon" },
      { name: "BitWire", cost: 10, type: "Augmentation" },
    ];
    const members = [member("a", 100), member("b", 100)];

    const buys = planPurchases(members, items, 1000);
    assert(buys.filter((b) => b.item === "Baseball Bat").length === 2,
      "gear should be bought for a trainee - it shortens TRAIN");
    assert(buys.length === 4, `everyone gets everything on a full budget, got ${buys.length}`);
  },

  // Member-major spending let the first member empty the budget on its own
  // wishlist while the rest owned nothing.
  "a tight budget is spread across the gang, not sunk into one member": async () => {
    const { planPurchases } = (await loadScripts())["gang/math"];

    const items = [
      { name: "cheap", cost: 10, type: "Augmentation" },
      { name: "dear", cost: 100, type: "Augmentation" },
    ];
    const members = [member("a", 100), member("b", 100), member("c", 100)];

    const buys = planPurchases(members, items, 35);
    assert(buys.length === 3, `expected 3 cheap buys inside a 35 budget, got ${buys.length}`);
    assert(new Set(buys.map((b) => b.member)).size === 3, "every member should get one");
    assert(buys.every((b) => b.item === "cheap"), "cheapest first, so nobody gets the dear one");
  },

  // The equip body reports a zero-buy pass by re-deriving the shortlist, so the two
  // must agree. Duplicating the filter in the transient would drift from the
  // planner and hand the log a cause that is not the real one.
  "the eligibility the log reports is the one the planner used": async () => {
    const mods = await loadScripts();
    const { eligibleItems, planPurchases } = (await loadScripts())["gang/math"];

    const items = [
      { name: "Bat", cost: 10, type: "Weapon" },
      { name: "Van", cost: 10, type: "Vehicle" },
      { name: "BitWire", cost: 10, type: "Augmentation" },
      { name: "Free", cost: 0, type: "Augmentation" },
    ];
    const members = [member("a", 100)];

    assert(eligibleItems(items).length === 3, "a zero-cost item is never eligible");

    // The planner cannot buy anything the log would call ineligible.
    const names = new Set(eligibleItems(items).map((i) => i.name));
    for (const b of planPurchases(members, items, 1e9)) {
      assert(names.has(b.item), `planner bought ${b.item}, which eligibleItems calls ineligible`);
    }
  },

  "already-owned equipment is never bought twice": async () => {
    const { planPurchases } = (await loadScripts())["gang/math"];
    const items = [{ name: "BitWire", cost: 10, type: "Augmentation" }];
    const members = [
      member("has-upgrade", 100, { upgrades: ["BitWire"] }),
      member("has-aug", 100, { augmentations: ["BitWire"] }),
      member("has-none", 100),
    ];
    const buys = planPurchases(members, items, 1000);
    assert(buys.length === 1 && buys[0].member === "has-none",
      "upgrades AND augmentations both count as owned");
  },

  // No combat task weights hacking above zero, so a Rootkit in a combat gang
  // buys a stat nobody can earn from - and cheapest-first handed a $5m NUKE
  // Rootkit priority over a $12m Katana the gang could actually use.
  "the hack tier stays shut until every member owns the combat list": async () => {
    const mods = await loadScripts();
    const { planPurchases } = mods["gang/math"];

    // Costs and stats are the game's, from src/Gang/data/upgrades.ts.
    const rootkit = { name: "NUKE Rootkit", cost: 5e6, type: "Rootkit", stats: { hack: 1.05 } };
    const katana = { name: "Katana", cost: 12e6, type: "Weapon", stats: { str: 1.08, dex: 1.08 } };
    const armor = { name: "LiquidArmor", cost: 25e6, type: "Armor", stats: { def: 1.15 } };
    const items = [rootkit, katana, armor];
    const one = [member("a", 100)];

    // The case ordering alone could not fix. $20m buys the Katana, cannot
    // afford the armor, and must NOT spend the $8m remainder on the Rootkit:
    // the combat list is still incomplete, so the tier is shut.
    const leak = planPurchases(one, items, 20e6).map((b) => b.item);
    assert(leak.length === 1 && leak[0] === "Katana",
      `leftover budget must be held while combat gear is unbought, got ${leak}`);

    // Still not never: a budget that finishes the combat list opens the tier.
    const rich = planPurchases(one, items, 1e9).map((b) => b.item);
    assert(rich.length === 3, `a full budget buys everything, got ${rich}`);
    assert(rich[2] === "NUKE Rootkit", `the Rootkit goes last, got ${rich}`);

    // A member who already owns the combat list opens it on any budget.
    const kitted = [member("a", 100, { upgrades: ["Katana", "LiquidArmor"] })];
    const opened = planPurchases(kitted, items, 6e6).map((b) => b.item);
    assert(opened.length === 1 && opened[0] === "NUKE Rootkit",
      `an owned combat list must open the hack tier, got ${opened}`);

    // ONE member short is enough to keep it shut - it is every member, not any.
    const mixed = [member("a", 100, { upgrades: ["Katana", "LiquidArmor"] }), member("b", 100)];
    const shut = planPurchases(mixed, items, 6e6).map((b) => b.item);
    assert(!shut.includes("NUKE Rootkit"),
      `one unequipped member keeps the tier shut, got ${shut}`);
  },

  // "Only" is the operative word: an item raising hack AND a combat stat is
  // still worth its place. No stock item mixes them, but a fork that adds one
  // must be ranked on its merits rather than demoted for the hack field.
  "hack-only means only, and a hacking gang is left alone": async () => {
    const mods = await loadScripts();
    const { considerItems, isHackingItem } = mods["gang/math"];

    assert(isHackingItem({ stats: { hack: 1.05 } }), "a pure hack item is one");
    assert(!isHackingItem({ stats: { hack: 1.05, str: 1.1 } }), "a mixed item is NOT");
    assert(!isHackingItem({ stats: { cha: 1.1 } }), "a charisma item is not");
    assert(!isHackingItem({}), "an item with no stats must not throw or be held back");

    const items = [
      { name: "rootkit", cost: 10, type: "Augmentation", stats: { hack: 1.1 } },
      { name: "blade", cost: 100, type: "Augmentation", stats: { str: 1.3 } },
    ];
    const members = [member("a", 100)];
    const combat = considerItems(members, items, false).map((i) => i.name);
    assert(combat.length === 1 && combat[0] === "blade",
      `a combat gang must not even consider the rootkit yet, got ${combat}`);

    // The mirrored rule is deliberately NOT implemented - a hacking gang keeps
    // the plain cheapest-first list, with nothing held back.
    const hacking = considerItems(members, items, true).map((i) => i.name);
    assert(hacking[0] === "rootkit" && hacking[1] === "blade",
      `a hacking gang considers everything, cheapest first, got ${hacking}`);
  },

  // The supervisor, driven for real: every body runs through rpc() against a
  // fake gang API, importing the real gang/math.js. Awaited one at a time is the
  // RAM argument - rpc() would throw on overlap anyway.
  "the supervisor runs every body on its cadence, tick first": async () => {
    const mods = await loadScripts();
    const cfg = mods["gang/config"];
    const { ns } = await driveGang(mods, { updates: 30 });

    const count = (tag) => ns._log.filter((l) => l.includes(`  ${tag}: `)).length;
    assert(count("tick") === Math.floor(30 / cfg.TICK_EVERY), `tick ran ${count("tick")} times: ${ns._log}`);
    assert(count("war") === Math.floor(30 / cfg.WAR_EVERY), "war cadence");
    assert(count("ascend") === Math.floor(30 / cfg.ASCEND_EVERY), "ascend cadence");
    assert(count("equip") === Math.floor(30 / cfg.EQUIP_EVERY), "equip cadence");

    // tick produces the state ascend and equip decide from, so on a pass where
    // they coincide it must go first - and none of them may find it missing.
    const firstAscend = ns._log.findIndex((l) => l.includes("  ascend: "));
    assert(ns._log.slice(0, firstAscend).some((l) => l.includes("  tick: ")),
      "tick must run before the bodies that read its state");
    assert(!ns._log.some((l) => l.includes("no tick yet")), `a body ran without state: ${ns._log}`);
    assert(!ns._log.some((l) => l.includes("WARN")), `a body failed: ${ns._log.filter((l) => l.includes("WARN"))}`);
    assert(ns._log.some((l) => l.includes("PHASE -> ")), "the phase line should be logged");
  },

  // What the port and the report-on-every-path rule existed for. rpc() catches
  // a body's throw INSIDE the transient and hands it back, so an exception is a
  // named WARN - never silence - and the loop carries on.
  "a body that throws is logged by name and does not stop the supervisor": async () => {
    const mods = await loadScripts();
    const { ns } = await driveGang(mods, { updates: 20, throwIn: "getAllGangInformation" });
    assert(ns._log.some((l) => l.includes("WARN: war failed") && l.includes("getAllGangInformation exploded")),
      `the throw should be named, got ${ns._log}`);
    const lastTick = ns._log.map((l) => l.includes("  tick: ")).lastIndexOf(true);
    const firstWarn = ns._log.findIndex((l) => l.includes("WARN: war failed"));
    assert(lastTick > firstWarn, "tick should keep running after war failed");
  },

  // Gang.respectForNextRecruit() is Infinity at a full roster, and JSON has no
  // Infinity - it would arrive as null. A full roster killed ascend and equip
  // once already (commit 7951306), when the same number went through a file.
  "a full roster crosses the rpc boundary and still ascends": async () => {
    const mods = await loadScripts();
    const { MAX_MEMBERS, ASCEND_MULT_THRESHOLD } = mods["gang/config"];
    const big = ASCEND_MULT_THRESHOLD + 0.5;
    const { ns, calls } = await driveGang(mods, {
      updates: 15, roster: MAX_MEMBERS, respectForNextRecruit: Infinity,
      ascension: { respect: 10, hack: 1, str: big, def: big, dex: big, agi: big, cha: 1 },
    });
    assert(ns._log.some((l) => l.includes("roster full")), `tick should say the roster is full: ${ns._log}`);
    assert(calls.filter((c) => c === "ascendMember").length === MAX_MEMBERS,
      `every member should ascend, calls: ${calls.filter((c) => c === "ascendMember").length}`);
  },

  // tick assigns combat tasks only; on a hacking gang it would filter every task
  // out and assign nobody. Refusing is the honest answer.
  "a hacking gang is refused, not mis-assigned": async () => {
    const mods = await loadScripts();
    const { ns, calls } = await driveGang(mods, { updates: 5, isHacking: true });
    assert(ns._log.some((l) => l.includes("REFUSED")), `should refuse: ${ns._log}`);
    assert(!calls.includes("setMemberTask"), "no task may be set on a hacking gang");
  },

  // Irreversible for the BitNode, so only ever by hand - and it replaces the
  // separate create.js.
  "--create founds the gang and then supervises it": async () => {
    const mods = await loadScripts();
    const { ns, calls } = await driveGang(mods, {
      updates: 5, inGang: false, args: ["--create", "Slum Snakes"],
    });
    assert(calls.includes("createGang:Slum Snakes"), `createGang should get the faction: ${calls}`);
    assert(ns._log.some((l) => l.includes("  tick: ")), "the supervisor should run once the gang exists");
  },

  // "$5.43e+7" is unreadable in a log. ns.format.number is the game's OWN
  // formatter at 0 GB - the same one the UI uses, and it honours the player's
  // Numeric Display settings, which nothing hand-rolled can do.
  //
  // Note the fork shape: ns.format.number, NOT ns.formatNumber. The cost table
  // is `const format = { number: 0, ram: 0, percent: 0, time: 0 }`.
  "money and counts go through the game's own formatter": () => {
    const dir = path.resolve(import.meta.dirname, "..", "scripts", "gang");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      assert(!/toExponential\s*\(/.test(src),
        `gang/${f} uses toExponential - "$5.43e+7" is not a money format. Use ns.format.number.`);
      assert(!/\*\s*100\s*\)\s*\.toFixed/.test(src),
        `gang/${f} hand-rolls a percentage - use ns.format.percent, which matches the UI.`);
      assert(!/\bns\.formatNumber\b/.test(src),
        `gang/${f} calls ns.formatNumber, which does not exist in this fork - it is ns.format.number`);
    }
  },

  // The mock must agree with the game or the log is only right in tests.
  "the formatter turns the reported figures into readable money": async () => {
    const { makeNs: fresh } = await import("./mockNs.mjs");
    const ns = fresh({});
    assert(ns.format.number(54300000, 2) === "54.30m", ns.format.number(54300000, 2));
    assert(ns.format.number(1940000000, 2) === "1.94b", ns.format.number(1940000000, 2));
    assert(ns.format.number(412, 2, 1000, true) === "412", ns.format.number(412, 2, 1000, true));
    assert(ns.format.percent(0.124, 1) === "12.4%", ns.format.percent(0.124, 1));

    // The live report: "respect 2m (next recruit at 2m)" for 1.6m against 2.05m.
    // isInteger applies only BELOW suffixStart - once a suffix is in play the
    // game uses fractionalDigits regardless, so 0 digits rounded both to "2m"
    // and the line said the gang had exactly what it needed.
    const have = ns.format.number(1_600_000, 2, 1000, true);
    const need = ns.format.number(2_050_000, 2, 1000, true);
    assert(have === "1.60m", have);
    assert(need === "2.05m", need);
    assert(have !== need, "two respect figures a recruit apart must not render identically");

    // The game's rollover guard: a mantissa rounding to 1000.00 takes the next
    // suffix instead. Without it this reads "1000.00k".
    assert(ns.format.number(999_999, 2) === "1.00m", ns.format.number(999_999, 2));
  },

  // The precise shape of the live bug, banned so it cannot come back: zero
  // fractional digits is only safe when a suffix can never appear.
  "no suffixed figure is printed with zero fractional digits": () => {
    const dir = path.resolve(import.meta.dirname, "..", "scripts", "gang");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      assert(!/ns\.format\.number\s*\([^)]*,\s*0\s*[,)]/.test(src),
        `gang/${f} formats a number with 0 fractional digits. isInteger only suppresses ` +
          `decimals BELOW suffixStart - with a suffix, 1.6m and 2.05m both print as "2m".`);
    }
  },

  "a pid of 0 is survivable, not fatal": async () => {
    const mods = await loadScripts();
    let updates = 0;
    const ns = makeNs({
      extra: {
        run: () => 0, // home is full - normal early in a BitNode
        gang: {
          inGang: () => true,
          getBonusTime: () => 0,
          nextUpdate: async () => {
            if (++updates > 12) throw new Error("STOP");
            return 2000;
          },
        },
      },
    });
    try {
      await mods["gang/gang"].main(ns);
      assert(false, "should have reached the sentinel");
    } catch (e) {
      assert(e.message === "STOP",
        `ns.run returning 0 must not stop the supervisor - boot would just restart it ` +
          `into the same wall a minute later. Got: ${e.message}`);
    }
  },

  // Parsing, not behaviour. `node --check` cannot: with no package.json, Node
  // reads a bare .js as CommonJS and rejects `export`. So importing every file
  // IS the syntax gate, and this test keeps a new file from escaping it. The rpc
  // bodies inside gang.js are parsed by tests/rpc.test.mjs.
  "every gang script parses and exports a main": async () => {
    const dir = path.resolve(import.meta.dirname, "..", "scripts", "gang");
    const mods = await loadScripts();
    const ENTRIES = ["gang.js"];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const mod = mods[`gang/${f.replace(/\.js$/, "")}`];
      assert(mod, `scripts/gang/${f} is not in harness.mjs's NESTED list, so nothing parses it`);
      if (ENTRIES.includes(f)) {
        assert(typeof mod.main === "function", `gang/${f} must export main`);
      }
    }
  },

  // GangMemberInfo, GangTaskStats and GangMemberAscension all carry a field
  // literally named `hack`, and RamCalculations.ts bills bare identifiers - so
  // `m.hack` costs 0.10 GB in the file that writes it AND in every importer.
  // STAT_KEYS exists to keep that out of the shared modules.
  // Comments and quoted strings are stripped; TEMPLATE literals deliberately
  // are not. A template can interpolate - `${m.hack}` is a real 0.10 GB read
  // and has to stay visible - and telling its literal text from its ${} parts
  // by regex is exactly the kind of half-right matcher that turns a guard into
  // a suggestion. So prose inside a backtick string trips this too. That is a
  // false positive, and the fix is to reword the log line ("hacking-only", not
  // "hack-only"), not to loosen the strip.
  "no gang file spells a stat as .hack": () => {
    const dir = path.resolve(import.meta.dirname, "..", "scripts", "gang");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/"(?:\\.|[^"\\])*"/g, " ")
        .replace(/'(?:\\.|[^'\\])*'/g, " ");
      assert(!/(?<![\w$])\.?hack(?![\w$])/.test(src),
        `gang/${f} contains a bare \`hack\` identifier - the game charges 0.10 GB for the ` +
          `name alone. Read the stat through STAT_KEYS instead.`);
    }
  },

  // The same trap one level up: respectForNextRecruit is a GangGenInfo FIELD
  // and a 1.00 GB ns.gang function. Reading it with a dot buys a full API call
  // for a number already in hand.
  "respectForNextRecruit is only ever read as a computed key": () => {
    const dir = path.resolve(import.meta.dirname, "..", "scripts", "gang");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      assert(!/\.respectForNextRecruit(?![\w$])/.test(src),
        `gang/${f} reads .respectForNextRecruit with a dot - that is 1.00 GB. ` +
          `Use info["respectForNextRecruit"]; a computed key is a Literal and costs nothing.`);
    }
  },
};
