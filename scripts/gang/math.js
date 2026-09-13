import {
  STAT_KEYS, WEIGHT_KEYS, COMBAT_STAT_KEYS, CHA_KEY, GANG_SOFTCAP,
  TRAIN_STAT_FLOOR, TRAIN_CHA_FLOOR, MAX_MEMBERS, TERRITORY_TARGET,
  WANTED_PENALTY_FLOOR, WANTED_MIN_LEVEL, ASCEND_MULT_THRESHOLD, WAR_MEMBER_FRACTION,
  WAR_WIN_THRESHOLD, WAR_DISENGAGE_THRESHOLD, EQUIP_BUDGET_FRACTION,
  BUY_GEAR_PHASES, EQUIP_AUGMENTATION,
  PHASE_TRAIN, PHASE_RESPECT, PHASE_TERRITORY, PHASE_MONEY,
  TASK_UNASSIGNED, TASK_TRAIN_COMBAT, TASK_TRAIN_CHARISMA, TASK_VIGILANTE,
  TASK_WARFARE, NON_EARNING_TASKS,
} from "./config.js";

/**
 * The gang's decision layer: every formula the game uses, plus the planning
 * built on top of them. Pure arithmetic, no ns call - this file must stay 0 GB,
 * because all four transients import it.
 *
 * The gain formulas are a line-for-line port of src/Gang/formulas/formulas.ts.
 * They are reproduced rather than called through ns.formulas.gang for two
 * reasons: ns.formulas needs Formulas.exe, which a fresh BitNode does not have,
 * and it takes real GangMember objects, which the ns API never hands out - only
 * GangMemberInfo. Every constant below (the 4x / 3.2x / 3.5x difficulty
 * subtractions, the 11x and 5x scale factors, the 0.005 territory floor, the
 * 100-cap on wanted) is from that file, not from memory.
 *
 * Stats are read as m[STAT_KEYS[i]] and never as m.hack. The game bills bare
 * identifiers, so the obvious spelling costs 0.10 GB in this file and in all
 * four importers; a string literal costs nothing. See config.js.
 */

/** respect / (respect + wantedLevel) - the multiplier on every gain. */
export function wantedPenalty(g) {
  const r = g.respect ?? 0;
  const w = g.wantedLevel ?? 0;
  if (r + w <= 0) return 1;
  return r / (r + w);
}

/**
 * The best penalty this gang could have - the one at wanted level 1.
 *
 * The game clamps wanted there (Gang.ts processGains), so this is a ceiling no
 * amount of penance can beat.
 */
export function achievableWantedPenalty(g) {
  const r = g.respect ?? 0;
  if (r <= 0) return 0;
  return r / (r + WANTED_MIN_LEVEL);
}

/**
 * The fraction of the attainable multiplier the gang is actually keeping.
 *
 * THIS, not the raw penalty, is what the governor may act on. The raw penalty
 * is low whenever respect is low, which early on it always is - a fresh gang at
 * 5 respect reads 0.833 with wanted already clamped to 1 and nothing to fix.
 * Acting on that posts vigilantes, vigilantes earn no respect, and respect is
 * the only term that could raise the number. The gang deadlocks, and it did.
 *
 * At the clamp this returns exactly 1, so the governor stands down there
 * without needing a special case for it.
 */
export function wantedHeadroom(g) {
  const best = achievableWantedPenalty(g);
  if (best <= 0) return 1;
  return wantedPenalty(g) / best;
}

/**
 * The weighted stat sum, less a multiple of the task's difficulty.
 *
 * The multiple differs per gain type and is the caller's to pass: 4 for
 * respect, 3.2 for money, 3.5 for wanted. A non-positive result means the task
 * pays NOTHING - not a little, zero - which is the whole reason the TRAIN phase
 * exists.
 */
export function statWeightFor(task, m, difficultyMult) {
  let w = 0;
  for (let i = 0; i < STAT_KEYS.length; i++) {
    w += ((task[WEIGHT_KEYS[i]] ?? 0) / 100) * (m[STAT_KEYS[i]] ?? 0);
  }
  return w - difficultyMult * (task.difficulty ?? 0);
}

/** max(0.005, pow(territory * 100, exponent) / 100). */
export function territoryMult(g, exponent) {
  return Math.max(0.005, Math.pow((g.territory ?? 0) * 100, exponent ?? 0) / 100);
}

/**
 * The exponent both money and respect are raised to.
 *
 * GANG_SOFTCAP lives only here, which is why it cancels out of any RANKING:
 * pow is monotonic, so sorting tasks by respect gives the same order for every
 * positive exponent. See config.js.
 */
export function territoryPenalty(g) {
  return (0.2 * (g.territory ?? 0) + 0.8) * GANG_SOFTCAP;
}

export function respectGain(g, m, task) {
  if (!task || !task.baseRespect) return 0;
  const w = statWeightFor(task, m, 4);
  if (w <= 0) return 0;
  const tm = territoryMult(g, task.territory?.respect);
  if (!Number.isFinite(tm) || tm <= 0) return 0;
  return Math.pow(11 * task.baseRespect * w * tm * wantedPenalty(g), territoryPenalty(g));
}

export function moneyGain(g, m, task) {
  if (!task || !task.baseMoney) return 0;
  const w = statWeightFor(task, m, 3.2);
  if (w <= 0) return 0;
  const tm = territoryMult(g, task.territory?.money);
  if (!Number.isFinite(tm) || tm <= 0) return 0;
  return Math.pow(5 * task.baseMoney * w * tm * wantedPenalty(g), territoryPenalty(g));
}

/**
 * Wanted gain per cycle. NEGATIVE for the two penance tasks.
 *
 * Vigilante Justice and Ethical Hacking carry baseWanted -0.001 and take the
 * first branch, so their contribution is `0.4 * -0.001 * statWeight * mult` - a
 * computable negative, which is what lets the governor size itself exactly
 * instead of guessing how many vigilantes to post.
 */
export function wantedGain(g, m, task) {
  if (!task || !task.baseWanted) return 0;
  const w = statWeightFor(task, m, 3.5);
  if (w <= 0) return 0;
  const tm = territoryMult(g, task.territory?.wanted);
  if (!Number.isFinite(tm) || tm <= 0) return 0;
  if (task.baseWanted < 0) return 0.4 * task.baseWanted * w * tm;
  return Math.min(100, (7 * task.baseWanted) / Math.pow(3 * w * tm, 0.8));
}

export function ascensionPointsGain(exp) {
  return Math.max((exp ?? 0) - 1000, 0);
}

export function ascensionMultiplier(points) {
  return Math.max(Math.pow((points ?? 0) / 2000, 0.5), 1);
}

// ----------------------------------------------------------------- phases ---

/** The training task a member still needs, or null when it can earn. */
export function trainingTaskFor(m) {
  for (const k of COMBAT_STAT_KEYS) {
    if ((m[k] ?? 0) < TRAIN_STAT_FLOOR) return TASK_TRAIN_COMBAT;
  }
  if ((m[CHA_KEY] ?? 0) < TRAIN_CHA_FLOOR) return TASK_TRAIN_CHARISMA;
  return null;
}

/**
 * Which phase the GANG is in. Training is a per-member override, not a phase.
 *
 * TRAIN means nobody at all has cleared the floor, so nothing in the gang can
 * earn anything - the opening, and the aftermath of a mass ascension. Keying it
 * on "no member is ready" rather than "some member is training" matters: a
 * single freshly-ascended member must not drag eleven earners back to the
 * training yard.
 */
export function phaseFor({ members = [], territory = 0 } = {}) {
  const ready = members.filter((m) => trainingTaskFor(m) === null).length;
  if (ready === 0) return PHASE_TRAIN;
  if (members.length < MAX_MEMBERS) return PHASE_RESPECT;
  if (territory < TERRITORY_TARGET) return PHASE_TERRITORY;
  return PHASE_MONEY;
}

// ------------------------------------------------------- task assignment ----

/** Sum of every assigned member's wanted contribution. */
export function netWantedGain(g, members, plan, byName) {
  let net = 0;
  for (const m of members) {
    const task = byName.get(plan.get(m.name));
    if (task) net += wantedGain(g, m, task);
  }
  return net;
}

/**
 * Decide every member's task for this tick.
 *
 * Order is load-bearing:
 *   1. training overrides - a member below the floor earns zero from any task
 *   2. territory allotment, taken from the WEAKEST earners so the best ones
 *      keep working
 *   3. earners, each on its own best-scoring task for the phase
 *   4. the wanted governor, which converts earners to Vigilante Justice - and
 *      it must run LAST, because it needs the real wanted total to size itself
 *      against, and that total is not known until everyone else is placed.
 *
 * Hacking tasks are filtered out by task.isCombat. This is a combat gang by
 * decision; a hacking gang would need a second earner filter and different
 * training floors, and tick.js refuses rather than silently mis-assigning.
 */
export function planTasks(g, members, tasks, phase) {
  const byName = new Map(tasks.map((t) => [t.name, t]));
  const earnerTasks = tasks.filter(
    (t) => t.isCombat && !NON_EARNING_TASKS.includes(t.name),
  );
  const vigilante = byName.get(TASK_VIGILANTE);
  const score = phase === PHASE_MONEY ? moneyGain : respectGain;

  const plan = new Map();
  const ready = [];
  for (const m of members) {
    const training = trainingTaskFor(m);
    if (training) plan.set(m.name, training);
    else ready.push(m);
  }

  // Best task per ready member, best-first. The sort is what makes the
  // territory allotment below take the weakest earners rather than arbitrary
  // ones - putting the top earner on Territory Warfare costs the most income
  // for exactly the same power.
  const scored = ready
    .map((m) => {
      let best = null;
      let bestScore = 0;
      for (const t of earnerTasks) {
        const s = score(g, m, t);
        if (s > bestScore) {
          bestScore = s;
          best = t;
        }
      }
      return { m, task: best, score: bestScore };
    })
    .sort((a, b) => b.score - a.score);

  const warSlots =
    phase === PHASE_TERRITORY && byName.has(TASK_WARFARE)
      ? Math.min(scored.length, Math.round(scored.length * WAR_MEMBER_FRACTION))
      : 0;

  for (let i = 0; i < scored.length; i++) {
    const e = scored[i];
    if (i >= scored.length - warSlots) {
      plan.set(e.m.name, TASK_WARFARE);
    } else if (e.task) {
      plan.set(e.m.name, e.task.name);
    } else {
      // Cleared the stat floor but every earner still pays zero - possible when
      // the floors are tuned below what the best task's difficulty demands.
      // Train rather than sit on Unassigned earning nothing.
      plan.set(e.m.name, byName.has(TASK_TRAIN_COMBAT) ? TASK_TRAIN_COMBAT : TASK_UNASSIGNED);
    }
  }

  // The governor. Flip earners to Vigilante Justice, worst offender first,
  // until the gang's net wanted gain is non-positive - i.e. wanted stops
  // climbing. Sized, not guessed: every term in netWantedGain is computable.
  //
  // Gated on HEADROOM, never on the raw penalty. The raw penalty is low
  // whenever respect is low, and at the start of a gang it always is, with
  // wanted already sitting on the game's clamp of 1 and nothing to remove.
  // A live gang deadlocked on exactly that: penance earns no respect, respect
  // is the only term that could lift the penalty, so the governor never let
  // go. wantedHeadroom is 1 at the clamp, so this stands down there.
  let vigilantes = 0;
  if (vigilante && wantedHeadroom(g) < WANTED_PENALTY_FLOOR) {
    const candidates = scored
      .filter((e) => e.task && plan.get(e.m.name) === e.task.name)
      .map((e) => ({ e, w: wantedGain(g, e.m, e.task) }))
      .sort((a, b) => b.w - a.w);

    let net = netWantedGain(g, members, plan, byName);
    for (const c of candidates) {
      if (net <= 0) break;
      const before = wantedGain(g, c.e.m, c.e.task);
      const after = wantedGain(g, c.e.m, vigilante);
      plan.set(c.e.m.name, TASK_VIGILANTE);
      net += after - before;
      vigilantes++;
    }
  }

  return {
    plan,
    phase,
    vigilantes,
    warSlots,
    trainees: members.length - ready.length,
    netWanted: netWantedGain(g, members, plan, byName),
  };
}

// -------------------------------------------------------------- ascension ---

/**
 * The mean multiplier gain across the four combat stats.
 *
 * A mean rather than the best stat: a 1.3x on charisma while strength sits at
 * 1.0 is not worth wiping a member's exp and gear for. Charisma is excluded
 * from the criterion entirely because Train Charisma is difficulty 8 against
 * Train Combat's 100 - charisma comes back almost free, combat stats do not.
 * Hacking is excluded because this is a combat gang.
 */
export function ascensionFactor(result) {
  let sum = 0;
  for (const k of COMBAT_STAT_KEYS) sum += result[k] ?? 1;
  return sum / COMBAT_STAT_KEYS.length;
}

/**
 * Ascending costs respect (result.respect is the amount LOST), and respect is
 * what gates recruiting. Under a full roster a recruit is worth more than a
 * multiplier on one member, so an ascension that would push the gang back below
 * the next recruit threshold is refused outright.
 */
export function shouldAscend(result, { respect = 0, nextRecruitAt = 0, memberCount = 0 } = {}) {
  if (!result) return false;
  if (ascensionFactor(result) < ASCEND_MULT_THRESHOLD) return false;
  if (memberCount < MAX_MEMBERS && respect - (result.respect ?? 0) < nextRecruitAt) {
    return false;
  }
  return true;
}

// ------------------------------------------------------------------- war ----

/**
 * Engage on the WORST rival, not the average: a clash is drawn against one gang
 * at a time, and a 90% chance against five gangs plus 20% against a sixth is a
 * 20% fight waiting to happen. Losing one kills a member.
 */
export function warDecision(engaged, chances) {
  if (!chances.length) return false;
  const worst = Math.min(...chances);
  return engaged ? worst >= WAR_DISENGAGE_THRESHOLD : worst >= WAR_WIN_THRESHOLD;
}

// -------------------------------------------------------------- equipment ---

export function equipBudget(money) {
  return Math.max(0, (money ?? 0) * EQUIP_BUDGET_FRACTION);
}

/**
 * What to buy this sweep, cheapest ITEM first across the whole gang.
 *
 * Item-major, not member-major: iterating members first lets the first member
 * spend the entire budget on its own wishlist while eleven others own nothing.
 * Cheapest-first then spreads the same budget over the most upgrades.
 *
 * Augmentations are bought in every phase and gear only in BUY_GEAR_PHASES,
 * because ascend() reapplies augmentations and discards everything else.
 */
export function planPurchases(members, items, phase, budget) {
  const gearOk = BUY_GEAR_PHASES.includes(phase);
  const shortlist = items
    .filter((i) => (i.type === EQUIP_AUGMENTATION || gearOk) && i.cost > 0)
    .sort((a, b) => a.cost - b.cost);

  const owned = new Map(
    members.map((m) => [m.name, new Set([...(m.upgrades ?? []), ...(m.augmentations ?? [])])]),
  );

  const buys = [];
  let left = budget;
  for (const i of shortlist) {
    for (const m of members) {
      if (i.cost > left) break;
      if (owned.get(m.name).has(i.name)) continue;
      left -= i.cost;
      owned.get(m.name).add(i.name);
      buys.push({ member: m.name, item: i.name, cost: i.cost });
    }
  }
  return buys;
}
