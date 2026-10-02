import {
  KARMA_MIN_CHANCE, MAX_SKILL_LEVEL, INT_CRIME_WEIGHT, SYNC_PER_SECOND, CRIMES,
  GANG_KARMA_TARGET, MONEY_CRIMES, GYM, GYM_CITY, GYM_EXP_PER_SECOND, GYM_STATS, JOB_MULTS,
  COVENANT, COVENANT_MAX_SLEEVES, COVENANT_SLEEVE_BASE, MEMORY_BASE_COST, MEMORY_MULT, MEMORY_MAX,
} from "./config.js";

/**
 * Every sleeve decision, pure and 0 GB - the sing/plan.js of this subtree.
 *
 * sleeve.js's rpc bodies read and act; this file decides between them, so it
 * is testable without a game. NAMES ARE BILLED: every ns.sleeve function is
 * 4.00 GB and the game charges an identifier whatever it really is, so nothing
 * here may be called `travel`, `getTask`, `getSleeve` or any other sleeve
 * function's name. tests/ram.test.mjs pins this file at the 1.60 base.
 */

/** calculateIntelligenceBonus, src/PersonObjects/formulas/intelligence.ts. */
export function intBonus(intelligence, weight = 1) {
  return 1 + (weight * Math.pow(intelligence ?? 0, 0.8)) / 600;
}

/**
 * Crime.successRate, transcribed. The node's CrimeSuccessRate multiplier is
 * left out: it scales every crime alike, so the ranking is unchanged, and it
 * enters the sync target only under a square root.
 *
 * @param person  getSleeve()'s shape: { skills, mults }
 */
export function crimeChance(person, crime) {
  const c = CRIMES[crime];
  if (!c) return 0;
  const sk = person.skills;
  let chance = INT_CRIME_WEIGHT * (sk.intelligence ?? 0);
  for (const [k, w] of Object.entries(c.w)) chance += w * (sk[k] ?? 0);
  chance = chance / MAX_SKILL_LEVEL / c.difficulty;
  chance *= person.mults?.crime_success ?? 1;
  chance *= intBonus(sk.intelligence, 1);
  return Math.min(chance, 1);
}

/**
 * The MONEY_CRIMES entry paying the most `by` ("karma" or "money") per second
 * at this sleeve's odds. Failure pays neither and still takes the full time, so
 * the rate is chance x payout / time. Karma is per sync-100 sleeve; the sleeve's
 * crime_money multiplier is common to every crime, so it is left out.
 *
 * Only MONEY_CRIMES, sing's rule: a switch restarts the crime and forfeits the
 * unit, and those four are 2-10 s.
 *
 * @returns {{ crime: string, rate: number }}  rate in payout per second
 */
export function bestCrime(person, by) {
  let best = { crime: MONEY_CRIMES[0], rate: 0 };
  for (const crime of MONEY_CRIMES) {
    const c = CRIMES[crime];
    if (!c) continue;
    const rate = crimeChance(person, crime) * c[by] / (c.time / 1000);
    if (rate > best.rate) best = { crime, rate };
  }
  return best;
}

/**
 * The sync to reach before a sleeve turns to crime, when karma is the goal.
 *
 * Karma per crime is crime.karma x sync/100 (SleeveCrimeWork.process), and sync
 * climbs at r per second (SleeveSynchroWork: 0.0002 x intBonus(PLAYER int, 0.5)
 * per 200 ms cycle). A sleeve owing K karma that syncs to S and then earns k per
 * second at full sync finishes in
 *     T(S) = (S - now) / r + 100 K / (k S)
 * and dT/dS = 0 at S* = sqrt(100 K r / k). Syncing all the way to 100 takes ~27
 * hours against a karma run of a couple of hours for eight sleeves, so the
 * optimum sits far below 100: ~26 for eight sleeves at full Homicide odds, ~42
 * for three. K shrinks and k rises as the run goes on, so S* only falls - a
 * sleeve that has turned to crime never turns back.
 *
 * @param owed        karma still needed, positive
 * @param sleeves     how many sleeves share it
 * @param playerInt   the PLAYER's intelligence - sync speed reads the player's
 * @param perSecond   bestCrime(sleeve, "karma").rate - karma/s at sync 100
 */
export function karmaSyncTarget(owed, sleeves, playerInt, perSecond) {
  if (!(perSecond > 0)) return 100;
  const r = SYNC_PER_SECOND * intBonus(playerInt, 0.5);
  const s = Math.sqrt((100 * (owed / Math.max(1, sleeves)) * r) / perSecond);
  return Math.min(100, Math.max(1, s));
}

/**
 * Levels per second a stat gains from `expPerSecond` exp/s, at the sleeve's
 * current exp. calculateSkill is floor(m (32 ln(exp + 534.6) - 200)), so
 * d level / d exp = 32 m / (exp + 534.6) - each level costs more exp than the
 * last, which is what makes training stop paying.
 *
 * m (the stat mult x the node's level mult) is read back off the sleeve's own
 * skill and exp rather than from getBitNodeMultipliers (4.00 GB, SF5): the
 * half level added covers the floor. At level 1 the ratio is meaningless, so
 * the sleeve's own mult stands in.
 */
export function levelRate(person, stat, expPerSecond) {
  const exp = person.exp?.[stat] ?? 0;
  const skill = person.skills[stat] ?? 1;
  const span = 32 * Math.log(exp + 534.6) - 200;
  const m = skill > 1 && span > 1 ? (skill + 0.5) / span : person.mults?.[stat] ?? 1;
  return (32 * m / (exp + 534.6)) * expPerSecond;
}

/** How much more another gym stat must pay before a training sleeve switches to it. */
const STICKY = 1.25;

/** A sleeve's karma per second at its best karma crime, sync included. */
function karmaRate(s) {
  return (bestCrime(s, "karma").rate * s.sync) / 100;
}

/**
 * Which synced karma sleeves go to the gym, and on which stat - the rest do
 * crime. A live sleeve at 16 combat did Homicide at 8.2%: the right crime
 * (2.5x Shoplift's karma/s at those odds) and ~180 hours to -54000 alone, where
 * 40 minutes at the gym would triple the odds. Crime trains stats badly - a
 * failure pays 25% of the exp.
 *
 * TRAINING IS SHARED. applySleeveGains hands the exp a sleeve earns to every
 * OTHER sleeve at x sync/100 x its own (1 - shock/100), and to the player. So
 * one sleeve at the gym on Strength raises every sleeve's Strength, the ones
 * still doing Homicide included - which is why at most one sleeve trains each
 * stat, and why the gain is summed over all of them.
 *
 * A sleeve trains stat k while it PAYS: the karma/s its training adds across
 * every karma sleeve (one level's karma/s, x the levels/s each receives), times
 * the time left to the bar at the current total rate, beats the karma/s it
 * forgoes by not doing crime itself. That shrinks as levels get dearer and as
 * the karma owed runs down, so training stops by itself. Stats go in Homicide
 * weight order, each to the least productive sleeve not yet placed. The player's
 * own karma is left out, which can only make training look more worth it.
 *
 * Only a sleeve standing in GYM_CITY - travel is another 4.00 GB body and a
 * fare, for a stat the others would train for free.
 *
 * @param idx   indices of synced karma sleeves
 * @param tasks getTask per sleeve - a sleeve keeps its current stat unless
 *              another pays STICKY x more. Switching costs no progress, but
 *              the best stat alternates every level or two, and each switch is
 *              a line in boot's log.
 * @returns Map index -> { stat, type }
 */
function gymPlan(sleeves, idx, owed, tasks = []) {
  const rates = new Map(idx.map((i) => [i, karmaRate(sleeves[i])]));
  const total = [...rates.values()].reduce((a, b) => a + b, 0);
  const left = total > 0 ? owed / total : Infinity;
  const free = idx.filter((i) => sleeves[i].city === GYM_CITY).sort((a, b) => rates.get(a) - rates.get(b));
  /** Karma/s gained per second of sleeve i training `stat`, over every karma sleeve. */
  const gainOf = (i, stat) => {
    const t = sleeves[i];
    // Exp/s the trainer earns: the game's own figure when READ had Formulas.exe,
    // else the gym's base x the sleeve's exp mult. Shock scales it (SleeveClassWork).
    const exp = (t.gym?.[stat] ?? GYM_EXP_PER_SECOND * (t.mults?.[`${stat}_exp`] ?? 1)) * (1 - t.shock / 100);
    let gain = 0;
    for (const j of idx) {
      const s = sleeves[j];
      const cut = j === i ? 1 : (s.sync / 100) * (1 - s.shock / 100);
      const up = { ...s, skills: { ...s.skills, [stat]: (s.skills[stat] ?? 1) + 1 } };
      gain += (karmaRate(up) - rates.get(j)) * levelRate(s, stat, exp * cut);
    }
    return gain;
  };
  // Each free sleeve, least productive first, takes the stat that pays MOST now
  // - not a fixed order: a fixed order sat 8 simulated hours pushing Strength to
  // 82 while Defense at 16 was far cheaper per karma, and the run took 51 hours.
  const out = new Map();
  const open = [...GYM_STATS];
  for (const i of free) {
    if (!open.length) break;
    const now = tasks[i]?.type === "CLASS" ? tasks[i].classType : null;
    const best = open
      .map(([stat, type]) => ({ stat, type, gain: gainOf(i, stat), rank: gainOf(i, stat) * (type === now ? STICKY : 1) }))
      .sort((a, b) => b.rank - a.rank)[0];
    if (!(best.gain * left > rates.get(i))) break;
    out.set(i, { stat: best.stat, type: best.type });
    open.splice(open.findIndex(([s]) => s === best.stat), 1);
  }
  return out;
}

/**
 * The faction work type paying the most rep for these skills, among `types`
 * (getFactionWorkTypes), or null. From src/PersonObjects/formulas/reputation.ts:
 * hacking is (hack + int/3), security 0.9 (str+def+dex+agi) / 4.5, field
 * 0.9 (str+def+dex+agi+cha) / 5.5. Everything else in those formulas - favor,
 * the faction_rep mult, the int bonus, the node multiplier - is common to all
 * three and cancels. The share bonus's hack+int term inside field and security
 * is dropped, which can only understate those two a little.
 */
export function bestWorkType(skills, types = []) {
  const s = (k) => skills[k] ?? 0;
  const combat = s("strength") + s("defense") + s("dexterity") + s("agility");
  const score = {
    hacking: s("hacking") + s("intelligence") / 3,
    security: (0.9 * combat) / 4.5,
    field: (0.9 * (combat + s("charisma"))) / 5.5,
  };
  let best = null;
  for (const t of types) if (t in score && (best === null || score[t] > score[best])) best = t;
  return best;
}

/**
 * REP_WANT_MARKER's text as { factions, companies }, or both empty. Missing,
 * empty and unparseable are all "no rep work" - never a default, so a stopped
 * sing sends sleeves to karma or money rather than to stale factions.
 */
export function parseWant(text) {
  try {
    const o = JSON.parse(String(text ?? "").trim() || "{}");
    return {
      factions: Array.isArray(o.factions) ? o.factions.filter((f) => f && typeof f.faction === "string") : [],
      companies: Array.isArray(o.companies) ? o.companies.filter((c) => typeof c === "string") : [],
    };
  } catch {
    return { factions: [], companies: [] };
  }
}

/**
 * Is `action` already what the sleeve is doing? An action body runs only when
 * this is false: restarting a crime zeroes its progress (new SleeveCrimeWork),
 * the same trap sing's sameAsCurrent guards.
 *
 * @param task  getTask()'s APICopy shape, trimmed by the TASKS body, or null
 */
export function sameTask(task, action) {
  if (!task) return false;
  if (action.kind === "recover") return task.type === "RECOVERY";
  if (action.kind === "sync") return task.type === "SYNCHRO";
  if (action.kind === "crime") return task.type === "CRIME" && task.crimeType === action.crime;
  if (action.kind === "gym") return task.type === "CLASS" && task.classType === action.stat && task.location === action.gym;
  if (action.kind === "faction") {
    return task.type === "FACTION" && task.factionName === action.faction && task.factionWorkType === action.type;
  }
  if (action.kind === "company") return task.type === "COMPANY" && task.companyName === action.company;
  return false;
}

/** An action, as the status file and the terminal say it. */
export function describeAction(a) {
  if (a.kind === "recover") return "shock recovery";
  if (a.kind === "sync") return "synchronize";
  if (a.kind === "crime") return `crime ${a.crime}`;
  if (a.kind === "gym") return `gym ${a.stat} at ${a.gym}`;
  if (a.kind === "faction") return `faction ${a.faction} (${a.type})`;
  if (a.kind === "company") return `company ${a.company}`;
  return a.kind;
}

/** A current task in the same words, so "was X" reads like the new line. */
export function describeTask(t) {
  if (!t) return "idle";
  if (t.type === "RECOVERY") return "shock recovery";
  if (t.type === "SYNCHRO") return "synchronize";
  if (t.type === "CRIME") return `crime ${t.crimeType}`;
  if (t.type === "CLASS") return `gym ${t.classType} at ${t.location}`;
  if (t.type === "FACTION") return `faction ${t.factionName} (${t.factionWorkType})`;
  if (t.type === "COMPANY") return `company ${t.companyName}`;
  return String(t.type).toLowerCase();
}

/**
 * One action per sleeve, with the reason for it. The user's ranking, top rung
 * wins:
 *
 *   0. SHOCK - any sleeve above shock 0 recovers first, whatever else is open
 *      (the user's rule). Shock scales the exp a sleeve SHARES with every other
 *      sleeve and the player (applySleeveGains, x (1 - shock/100)), so a shocked
 *      trainer's gym hours reach nobody but itself. Recovery stops itself to
 *      idle at 0, and the next pass hands the sleeve real work.
 *   1. KARMA - every sleeve, while a gang is wanted (`gang.enabled` on, no
 *      --no-gang), can be founded (BN2 or SF2) and none exists yet. Sync up to
 *      karmaSyncTarget, then the gym or the best karma crime - and below
 *      KARMA_MIN_CHANCE at that crime, the best MONEY crime instead.
 *   2. FACTION REP, then 3. COMPANY REP - one sleeve per REP_WANT_MARKER entry,
 *      the game's rule (setToFactionWork / setToCompanyWork throw on a second).
 *   4. MONEY - the best money crime.
 *
 * A sleeve already on a wanted entry KEEPS it before anything is handed out,
 * so a tick never shuffles sleeves between factions.
 *
 * @param o.sleeves  [{ shock, sync, skills, mults }]   the READ body
 * @param o.tasks    [task | null]                       the TASKS body
 * @param o.player   { karma, skills }
 * @param o.want     parseWant(REP_WANT_MARKER)
 * @param o.karma    a gang is wanted: `gang.enabled` on and no --no-gang
 * @param o.canGang  BN2 or SF2 - there is a gang to found
 * @param o.inGang   ns.gang.inGang()
 * @returns [{ kind: "recover"|"sync"|"gym"|"crime"|"faction"|"company", ..., why }]
 */
export function assign({ sleeves, tasks = [], player, want, karma, canGang, inGang }) {
  const out = sleeves.map((s) => (s.shock > 0
    ? { kind: "recover", rung: "shock", why: `shock ${s.shock.toFixed(1)}, recovering to 0 before anything else` }
    : null));
  const ready = sleeves.map((s, i) => i).filter((i) => !out[i]);

  const owed = player.karma - GANG_KARMA_TARGET;
  if (karma && canGang && !inGang && owed > 0) {
    const synced = [];
    for (const i of ready) {
      const s = sleeves[i];
      const best = bestCrime(s, "karma");
      const target = karmaSyncTarget(owed, sleeves.length, player.skills?.intelligence, best.rate);
      if (s.sync < target) out[i] = { kind: "sync", rung: "karma", why: `karma: sync ${s.sync.toFixed(1)} of ${target.toFixed(1)} before crime` };
      else synced.push(i);
    }
    const gym = gymPlan(sleeves, synced, owed, tasks);
    for (const i of synced) {
      const g = gym.get(i);
      const best = bestCrime(sleeves[i], "karma");
      const odds = crimeChance(sleeves[i], best.crime);
      const at = `${best.crime} at ${(odds * 100).toFixed(1)}%`;
      // No gym stat left for it and karma odds this poor: money instead (the
      // user's rule). It stays on the karma rung, so it still never buys an aug
      // - a wipe would take the odds back down with it.
      const cash = !g && odds < KARMA_MIN_CHANCE ? bestCrime(sleeves[i], "money").crime : null;
      out[i] = g
        ? { kind: "gym", rung: "karma", gym: GYM, stat: g.type, why: `karma: training ${g.stat} pays more than ${at} (shared with every sleeve)` }
        : cash
          ? { kind: "crime", rung: "karma", crime: cash,
              why: `money: ${at} is under ${(KARMA_MIN_CHANCE * 100).toFixed(0)}%, ${cash} at ${(crimeChance(sleeves[i], cash) * 100).toFixed(1)}%` }
          : { kind: "crime", rung: "karma", crime: best.crime, why: `karma for a gang, ${at}` };
    }
    return out;
  }

  const jobs = [
    ...want.factions
      .map((f) => ({ kind: "faction", faction: f.faction, types: f.types ?? [] }))
      .filter((j) => bestWorkType({}, j.types) !== null),
    ...want.companies.map((c) => ({ kind: "company", company: c })),
  ];
  const key = (j) => (j.kind === "faction" ? `f:${j.faction}` : `c:${j.company}`);
  const holds = (t, j) => t && (j.kind === "faction"
    ? t.type === "FACTION" && t.factionName === j.faction
    : t.type === "COMPANY" && t.companyName === j.company);
  const place = (s, j) => (j.kind === "faction"
    ? { kind: "faction", rung: "rep", faction: j.faction, type: bestWorkType(s.skills, j.types), why: "faction rep sing wants" }
    : { kind: "company", rung: "rep", company: j.company, why: "company rep for its faction's invite" });

  // 1. Keep, then 2. fill.
  const taken = new Set();
  for (const i of ready) {
    const j = jobs.find((x) => !taken.has(key(x)) && holds(tasks[i], x));
    if (j) {
      out[i] = place(sleeves[i], j);
      taken.add(key(j));
    }
  }
  const open = jobs.filter((j) => !taken.has(key(j)));
  for (const i of ready) if (!out[i] && open.length) out[i] = place(sleeves[i], open.shift());

  // 4. Money.
  sleeves.forEach((s, i) => {
    if (!out[i]) out[i] = { kind: "crime", rung: "money", crime: bestCrime(s, "money").crime, why: "money - no rep work open" };
  });
  return out;
}

/**
 * Which sleeves buy which augs this pass. Every purchase zeroes that sleeve's
 * exp (Sleeve.installAugmentation), so:
 *
 *   - the sleeve with the LEAST total exp goes first - its wipe costs least;
 *   - each sleeve buys everything the budget still covers in one batch, and
 *     only when that batch reaches `minBatch` - otherwise it waits, and the
 *     budget passes to the next sleeve. There is NO "all that is left" escape:
 *     the shop is what faction rep has unlocked so far, so it trickles in one
 *     aug at a time, and "everything left" was true on every unlock. A live
 *     sleeve took 13 wipes in 23 hours, 11 of them for one or two augs;
 *   - a KARMA sleeve never buys. Its stats are its karma rate: one wipe took
 *     Homicide from 40% to 3% and ~2 hours of gym to win back, and the next
 *     unlock landed before it did, so the sleeve trained for a day and never
 *     did crime. It buys once the gang exists and it moves to another rung;
 *   - tier 1 first: augs raising a multiplier the sleeve's current rung uses
 *     (JOB_MULTS), then the rest; cheapest first inside a tier, so a wipe buys
 *     as many as it can. An aug with no stats read is tier 2 - with no stats at
 *     all that is plain cheapest-first.
 *
 * The budget is priced once for the pass and shared: re-pricing per sleeve
 * would ratchet down as cash fell, and spend a different fraction depending on
 * nothing but how many sleeves happened to buy.
 *
 * @param o.sleeves  READ's sleeves - exp is what ranks them
 * @param o.actions  assign()'s, for each sleeve's rung
 * @param o.avail    {sleeve: [{name, cost}]} from getSleevePurchasableAugs
 * @param o.stats    {aug: Multipliers}, possibly partial or empty
 * @param o.budget   money this pass may spend
 * @param o.minBatch the live `sleeve.augMin`
 * @returns {{ buys: {i, names, cost}[], waits: {i, fit, of}[] }}
 */
export function planAugs({ sleeves, actions, avail, stats = {}, budget, minBatch }) {
  const spentExp = (i) => Object.values(sleeves[i].exp ?? {}).reduce((a, b) => a + b, 0);
  const order = Object.keys(avail).map(Number)
    .filter((i) => avail[i]?.length && actions[i]?.rung !== "karma").sort((a, b) => spentExp(a) - spentExp(b));
  let left = budget;
  const buys = [];
  const waits = [];
  for (const i of order) {
    const keys = JOB_MULTS[actions[i]?.rung] ?? [];
    const tier = (a) => (keys.some((k) => (stats[a.name]?.[k] ?? 1) > 1) ? 0 : 1);
    const ranked = [...avail[i]].sort((a, b) => tier(a) - tier(b) || a.cost - b.cost);
    const names = [];
    let cost = 0;
    for (const a of ranked) {
      if (cost + a.cost > left) continue;
      names.push(a.name);
      cost += a.cost;
    }
    if (names.length && names.length >= minBatch) {
      buys.push({ i, names, cost });
      left -= cost;
    } else {
      waits.push({ i, fit: names.length, of: ranked.length });
    }
  }
  return { buys, waits };
}

/** getSleeveCost: the k-th Covenant sleeve (0-based), Infinity past the fifth. */
export function covenantSleevePrice(bought) {
  return bought >= 0 && bought < COVENANT_MAX_SLEEVES ? 10 ** bought * COVENANT_SLEEVE_BASE : Infinity;
}

/** Sleeve.getMemoryUpgradeCost for ONE point at memory `memory`; Infinity at the cap. */
export function memoryPointPrice(memory) {
  return memory < MEMORY_MAX ? MEMORY_BASE_COST * MEMORY_MULT ** (memory - 1) : Infinity;
}

/**
 * Sleeves bought from the Covenant so far. recalculateNumberOfOwnedSleeves:
 * min(3, SF10 level + 1 in BN10) come free, the rest were bought.
 */
export function covenantBought(count, sf10, node) {
  return Math.max(0, count - Math.min(3, (sf10 ?? 0) + (node === 10 ? 1 : 0)));
}

/**
 * This pass's Covenant purchases, or null outside BN10 or without the faction.
 *
 * The next sleeve first, when its price is at most `frac` of cash - one a pass,
 * since each costs 10x the last. Then memory, one point at a time to the
 * lowest-memory sleeve, spending at most `frac` of the SURPLUS: cash minus the
 * next sleeve still to buy. Without that reserve, $1t points would eat the
 * savings for a $100t sleeve forever. With all five bought there is no reserve.
 *
 * @returns {{ sleeve: number|null, next: number, memory: {i, amount, cost}[],
 *             nextPoint: number, surplus: number } | null}
 */
export function planCovenant({ sleeves, sf10, node, factions = [], cash, frac }) {
  if (node !== 10 || !factions.includes(COVENANT)) return null;
  const bought = covenantBought(sleeves.length, sf10, node);
  const price = covenantSleevePrice(bought);
  const sleeve = price <= frac * cash ? price : null;
  const reserve = covenantSleevePrice(bought + (sleeve ? 1 : 0));
  const surplus = Math.max(0, cash - (sleeve ?? 0) - (Number.isFinite(reserve) ? reserve : 0));
  let left = frac * surplus;
  const mem = sleeves.map((s) => s.memory ?? 1);
  const add = new Map();
  for (;;) {
    let i = 0;
    for (let j = 1; j < mem.length; j++) if (mem[j] < mem[i]) i = j;
    const cost = memoryPointPrice(mem[i]);
    if (!mem.length || cost > left) break;
    left -= cost;
    mem[i]++;
    const a = add.get(i) ?? { i, amount: 0, cost: 0 };
    a.amount++;
    a.cost += cost;
    add.set(i, a);
  }
  const low = mem.length ? Math.min(...mem) : MEMORY_MAX;
  return {
    sleeve, next: price, memory: [...add.values()],
    nextPoint: memoryPointPrice(low), surplus,
  };
}
