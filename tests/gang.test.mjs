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

  // TRAIN is excluded and RESPECT is not, which looks inconsistent and is not.
  // In TRAIN nobody has cleared the stat floor, so gear buys stats that earn
  // nothing before the next ascension wipes them. In RESPECT the members are
  // already working, so the gear pays for itself before it is lost.
  "gear is excluded only while nobody can earn from it": async () => {
    const mods = await loadScripts();
    const { planPurchases } = mods["gang/math"];
    const { PHASE_TRAIN, PHASE_RESPECT, PHASE_MONEY } = mods["gang/config"];

    const items = [
      { name: "Baseball Bat", cost: 10, type: "Weapon" },
      { name: "BitWire", cost: 10, type: "Augmentation" },
    ];
    const members = [member("a", 100), member("b", 100)];

    const training = planPurchases(members, items, PHASE_TRAIN, 1000);
    assert(training.every((b) => b.item === "BitWire"),
      "gear bought in TRAIN earns nothing before the next ascend() wipes it");
    assert(training.length === 2, "both members should still get the augmentation");

    for (const phase of [PHASE_RESPECT, PHASE_MONEY]) {
      const buys = planPurchases(members, items, phase, 1000);
      assert(buys.some((b) => b.item === "Baseball Bat"),
        `gear should be bought in ${phase} - the members are earning with it`);
    }
  },

  // Member-major spending let the first member empty the budget on its own
  // wishlist while the rest owned nothing.
  "a tight budget is spread across the gang, not sunk into one member": async () => {
    const { planPurchases } = (await loadScripts())["gang/math"];
    const { PHASE_MONEY } = (await loadScripts())["gang/config"];

    const items = [
      { name: "cheap", cost: 10, type: "Augmentation" },
      { name: "dear", cost: 100, type: "Augmentation" },
    ];
    const members = [member("a", 100), member("b", 100), member("c", 100)];

    const buys = planPurchases(members, items, PHASE_MONEY, 35);
    assert(buys.length === 3, `expected 3 cheap buys inside a 35 budget, got ${buys.length}`);
    assert(new Set(buys.map((b) => b.member)).size === 3, "every member should get one");
    assert(buys.every((b) => b.item === "cheap"), "cheapest first, so nobody gets the dear one");
  },

  // equip.js reports a zero-buy pass by re-deriving the shortlist, so the two
  // must agree. Duplicating the filter in the transient would drift from the
  // planner and hand the log a cause that is not the real one.
  "the eligibility the log reports is the one the planner used": async () => {
    const mods = await loadScripts();
    const { eligibleItems, planPurchases } = mods["gang/math"];
    const { PHASE_TRAIN, PHASE_MONEY } = mods["gang/config"];

    const items = [
      { name: "Bat", cost: 10, type: "Weapon" },
      { name: "Van", cost: 10, type: "Vehicle" },
      { name: "BitWire", cost: 10, type: "Augmentation" },
      { name: "Free", cost: 0, type: "Augmentation" },
    ];
    const members = [member("a", 100)];

    const early = eligibleItems(items, PHASE_TRAIN);
    assert(early.length === 1 && early[0].name === "BitWire",
      `outside BUY_GEAR_PHASES only augmentations are eligible, got ${early.map((i) => i.name)}`);
    assert(eligibleItems(items, PHASE_MONEY).length === 3, "a zero-cost item is never eligible");

    // The planner cannot buy anything the log would call ineligible.
    const names = new Set(eligibleItems(items, PHASE_TRAIN).map((i) => i.name));
    for (const b of planPurchases(members, items, PHASE_TRAIN, 1e9)) {
      assert(names.has(b.item), `planner bought ${b.item}, which eligibleItems calls ineligible`);
    }
  },

  "already-owned equipment is never bought twice": async () => {
    const { planPurchases } = (await loadScripts())["gang/math"];
    const { PHASE_MONEY } = (await loadScripts())["gang/config"];
    const items = [{ name: "BitWire", cost: 10, type: "Augmentation" }];
    const members = [
      member("has-upgrade", 100, { upgrades: ["BitWire"] }),
      member("has-aug", 100, { augmentations: ["BitWire"] }),
      member("has-none", 100),
    ];
    const buys = planPurchases(members, items, PHASE_MONEY, 1000);
    assert(buys.length === 1 && buys[0].member === "has-none",
      "upgrades AND augmentations both count as owned");
  },

  // Missing, corrupt and schema-invalid all collapse to null, exactly as
  // calib.js does - a partial object would reach the respect guard as NaN and
  // compare false against every bound.
  "the marker reader refuses anything it cannot fully parse": async () => {
    const { readMarker } = (await loadScripts())["gang/marker"];
    const { GANG_MARKER } = (await loadScripts())["gang/config"];

    assert(readMarker(makeNs({})) === null, "no file -> null");
    assert(readMarker(makeNs({ files: { [GANG_MARKER]: "money\n1\n2" } })) === null,
      "too few lines -> null");
    assert(readMarker(makeNs({ files: { [GANG_MARKER]: "money\nx\n2\n3\n0.5\n99" } })) === null,
      "a non-numeric field -> null, not NaN");
    assert(readMarker(makeNs({ files: { [GANG_MARKER]: "\n1\n2\n3\n0.5\n99" } })) === null,
      "no phase -> null");

    const ok = readMarker(makeNs({ files: { [GANG_MARKER]: "money\n1\n2\n3\n0.5\n99" } }));
    assert(ok && ok.phase === "money" && ok.nextRecruitAt === 2 && ok.memberCount === 3,
      "a well-formed marker should parse");
  },

  // The RAM argument for the whole split. Fired unawaited these would stack to
  // ~46 GB and the cheap ones would fail to start behind the expensive one.
  "the supervisor runs one transient at a time, on the configured cadence": async () => {
    const mods = await loadScripts();
    const cfg = mods["gang/config"];

    const launched = [];
    const alive = new Set();
    let updates = 0;
    let nextPid = 1;

    const ns = makeNs({
      extra: {
        run: (file) => {
          assert(alive.size === 0,
            `${file} started while another transient was still running - the peak would be ` +
              `the SUM of them, which is what the split exists to avoid`);
          launched.push(file);
          const pid = nextPid++;
          alive.add(pid);
          return pid;
        },
        // Reports the process once, then lets it exit - so runOne has to
        // actually poll and wait rather than finding an empty table.
        ps: () => {
          const live = [...alive].map((pid) => ({ pid, filename: "x", host: "home" }));
          alive.clear();
          return live;
        },
        gang: {
          inGang: () => true,
          getBonusTime: () => 0,
          nextUpdate: async () => {
            if (++updates > 30) throw new Error("STOP");
            return 2000;
          },
        },
      },
    });

    try {
      await mods["gang/gang"].main(ns);
      assert(false, "the loop should only end by the STOP sentinel");
    } catch (e) {
      assert(e.message === "STOP", `unexpected failure: ${e.message}`);
    }

    const count = (f) => launched.filter((x) => x === f).length;
    assert(count(cfg.GANG_TICK) === Math.floor(30 / cfg.TICK_EVERY),
      `tick ran ${count(cfg.GANG_TICK)} times in 30 updates`);
    assert(count(cfg.GANG_WAR) === Math.floor(30 / cfg.WAR_EVERY), "war cadence");
    assert(count(cfg.GANG_ASCEND) === Math.floor(30 / cfg.ASCEND_EVERY), "ascend cadence");
    assert(count(cfg.GANG_EQUIP) === Math.floor(30 / cfg.EQUIP_EVERY), "equip cadence");

    // tick writes the marker the other three read, so on a pass where several
    // coincide it must go first or they work from last pass's numbers.
    const firstOfPass15 = launched.indexOf(cfg.GANG_ASCEND);
    assert(launched.lastIndexOf(cfg.GANG_TICK, firstOfPass15) < firstOfPass15,
      "tick.js must run before the transients that read its marker");
  },

  "a pid of 0 is survivable, not fatal": async () => {
    const mods = await loadScripts();
    let updates = 0;
    const ns = makeNs({
      extra: {
        run: () => 0, // home is full - normal early in a BitNode
        ps: () => [],
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

  // Parsing, not behaviour. Nothing else in this repo parses tick.js, ascend.js,
  // equip.js, war.js or create.js - and `node --check` cannot: with no
  // package.json, Node reads a bare .js as CommonJS and rejects `export`. So
  // importing every one of them IS the syntax gate, and this test is what keeps
  // a new file from quietly escaping it.
  "every gang script parses and exports a main": async () => {
    const dir = path.resolve(import.meta.dirname, "..", "scripts", "gang");
    const mods = await loadScripts();
    const ENTRIES = ["gang.js", "tick.js", "ascend.js", "equip.js", "war.js", "create.js"];
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
