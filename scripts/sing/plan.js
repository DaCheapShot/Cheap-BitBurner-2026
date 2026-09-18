import {
  TRAIN_STAT_FLOOR, TRAIN_GYM, TRAIN_GYM_CITY, CRIME_TYPE, GANG_KARMA_TARGET,
  WORK_ORDER, WORK_TYPE_ORDER, FACTION_REP_TARGET,
  TDH_FACTION, TDH_CITY, TDH_HACKING, TDH_MONEY, HOME_CITY, TRAVEL_COST,
  MIN_AUG_BATCH, NFG, AUG_PRICE_MULT, NFG_LEVEL_MULT, AUG_SKIP_FACTIONS,
  DONATE_MONEY_PER_REP,
} from "./config.js";

/**
 * Every singularity decision, pure and 0 GB - the gang/math.js of this subtree.
 *
 * The rpc bodies in sing.js fetch and act; this file decides between them, so
 * it is testable without a game and one billed identifier here would be
 * charged to nothing but sing.js itself (bodies do not import it).
 */

/** getPlayer().skills key -> the GymType value gymWorkout takes. */
const GYM_STATS = [["strength", "str"], ["defense", "def"], ["dexterity", "dex"], ["agility", "agi"]];

/**
 * The rep a faction is worked to: its entry in `targets` (from repTargets), or
 * FACTION_REP_TARGET until its augs have been read. sing.js logs through this
 * too, so the line matches the decision.
 */
export function repTarget(faction, targets = {}) {
  return targets[faction] ?? FACTION_REP_TARGET;
}

/**
 * Per faction, the highest rep requirement among its augs that are neither
 * owned nor queued - 0 when there is nothing left to buy, which is what stops
 * a faction being worked for rep it can spend on nothing. NeuroFlux is left
 * out: it is sold by nearly every faction at an ever-rising level, so counting
 * it would make every target unreachable.
 *
 * @param augsOf  {faction: aug names}   getAugmentationsFromFaction
 * @param owned   aug names, installed AND queued - getOwnedAugmentations(true)
 * @param info    {aug: {rep, price}}    getAugmentationRepReq / Price
 */
export function repTargets(augsOf, owned, info) {
  const have = new Set(owned);
  const out = {};
  for (const [faction, augs] of Object.entries(augsOf)) {
    let max = 0;
    for (const a of augs) {
      if (a === NFG || have.has(a)) continue;
      // Unread means unknown, and unknown must not read as "done".
      max = Math.max(max, info[a]?.rep ?? FACTION_REP_TARGET);
    }
    out[faction] = max;
  }
  return out;
}

/**
 * The batch to buy now, or none.
 *
 * Most expensive first, because every queued aug multiplies the price of every
 * later one by AUG_PRICE_MULT - buying cheap-first pays the multiplier on the
 * expensive ones. An aug is skipped (not the batch) when it does not fit or a
 * prerequisite is neither owned nor already earlier in the batch. NeuroFlux
 * then fills, one level at a time, each level x NFG_LEVEL_MULT dearer in money
 * and rep. The batch is returned only when queued + batch reaches
 * MIN_AUG_BATCH and the cash covers all of it - buying part of one leaves
 * augs queued and no reason to install.
 *
 * An aug short of rep at every seller is still in reach at a seller that takes
 * donations (`o.donate`): its price then carries the donation that lifts that
 * faction to the aug's rep, and the batch's `donations` are made before its
 * buys. A faction is lifted once to the highest rep the batch needs from it -
 * a later aug from the same faction pays only the difference. One rep over,
 * so float rounding in the game's $/1e6 * mult cannot leave it a hair short.
 * NeuroFlux is never donated for; it fills on whatever rep the batch reaches.
 *
 * @param o.augsOf   {faction: aug names}
 * @param o.owned    installed and queued aug names
 * @param o.queued   how many are queued (not yet installed)
 * @param o.info     {aug: {rep, price}}, prices as the game quotes them NOW
 * @param o.prereqs  {aug: prerequisite names}
 * @param o.rep      {faction: rep} for joined factions - only these can sell
 * @param o.cash     money on hand
 * @param o.donate   { perRep, can(faction) } - or null, and nothing is donated
 * @returns {{ buys: {faction, name, cost}[], donations: {faction, amount, rep}[],
 *             batch: number, total: number, eligible: number }}
 */
export function planAugBuys({ augsOf, owned, queued, info, prereqs, rep, cash, donate = null }) {
  // Who sells each aug, among joined factions we may buy from.
  const sellers = {};
  for (const [faction, augs] of Object.entries(augsOf)) {
    if (!(faction in rep) || AUG_SKIP_FACTIONS.includes(faction)) continue;
    for (const a of augs) (sellers[a] ??= []).push(faction);
  }
  // The rep each faction will have once this batch's donations are made.
  const reach = { ...rep };
  const best = (factions) => factions.reduce((b, f) => (reach[f] > reach[b] ? f : b));
  const have = new Set(owned);
  /** Money to lift faction f to `need` rep: 0 if it is there, Infinity if it cannot be bought. */
  const lift = (f, need) => {
    if (reach[f] >= need) return 0;
    return donate?.can(f) ? (need - reach[f] + 1) * donate.perRep : Infinity;
  };
  const cheapest = (c) => c.sellers.reduce((b, f) => (lift(f, c.need) < lift(b, c.need) ? f : b));

  const eligible = Object.keys(sellers)
    .filter((a) => a !== NFG && !have.has(a) && info[a])
    .map((a) => ({ name: a, sellers: sellers[a], price: info[a].price, need: info[a].rep }))
    .filter((c) => Number.isFinite(lift(cheapest(c), c.need)))
    .sort((x, y) => y.price - x.price);

  const buys = [];
  const donated = {};
  let total = 0;
  for (const c of eligible) {
    if (!(prereqs[c.name] ?? []).every((p) => have.has(p))) continue;
    const f = cheapest(c);
    const d = lift(f, c.need);
    const cost = c.price * AUG_PRICE_MULT ** buys.length;
    if (total + cost + d > cash) continue;
    if (d) {
      donated[f] = (donated[f] ?? 0) + d;
      reach[f] = c.need + 1;
    }
    buys.push({ faction: f, name: c.name, cost });
    total += cost + d;
    have.add(c.name);
  }

  if (sellers[NFG] && info[NFG]) {
    const f = best(sellers[NFG]);
    for (let level = 0; ; level++) {
      const cost = info[NFG].price * NFG_LEVEL_MULT ** level * AUG_PRICE_MULT ** buys.length;
      if (reach[f] < info[NFG].rep * NFG_LEVEL_MULT ** level || total + cost > cash) break;
      buys.push({ faction: f, name: NFG, cost });
      total += cost;
    }
  }

  const batch = queued + buys.length;
  const donations = Object.entries(donated)
    .map(([faction, amount]) => ({ faction, amount, rep: amount / donate.perRep }));
  const go = batch >= MIN_AUG_BATCH;
  return { buys: go ? buys : [], donations: go ? donations : [], batch, total, eligible: eligible.length };
}

/** Dollars per rep point donated (donation.ts): 1e6 / faction_rep / FactionWorkRepGain. */
export function donationPerRep(repMult, bnRepMult) {
  return DONATE_MONEY_PER_REP / (repMult * bnRepMult);
}

/**
 * Can this faction take a donation? Favor at the bar (getFavorToDonate), and
 * a faction that offers work - donateToFaction refuses the gang's faction and
 * any faction without work, and getFactionWorkTypes returns [] for exactly
 * those, so the same read decides it without naming the gang.
 *
 * @param state  { favor: {faction: n}, favorNeed: n, workTypes: {faction: string[]} }
 */
export function canDonate(faction, state) {
  return state.favorNeed > 0 && (state.favor?.[faction] ?? 0) >= state.favorNeed &&
    (state.workTypes?.[faction] ?? []).length > 0;
}

/**
 * WORK_ORDER's steps that can apply now, then every joined faction it does not
 * list. A faction step needs the faction joined; a company step needs nothing
 * here - chooseAction decides whether it is still worth working.
 */
function steps(player) {
  const joined = player.factions;
  const listed = WORK_ORDER.map((s) => s.faction).filter(Boolean);
  return [
    ...WORK_ORDER.filter((s) => s.company || joined.includes(s.faction)),
    ...joined.filter((f) => !listed.includes(f)).map((f) => ({ faction: f })),
  ];
}

/**
 * Where to fly, or null. Only ever the Tian Di Hui round trip: out from
 * HOME_CITY once the invite's hacking and money bars are met with the fare home
 * in hand, back once joined. Leaving only from home and returning only from
 * TDH_CITY means a trip the player made by hand is never undone.
 */
export function chooseTravel(player) {
  const joined = player.factions.includes(TDH_FACTION);
  if (!joined && player.city === HOME_CITY && player.skills.hacking >= TDH_HACKING &&
      player.money >= TDH_MONEY + 2 * TRAVEL_COST) {
    return TDH_CITY;
  }
  if (joined && player.city === TDH_CITY) return HOME_CITY;
  return null;
}

/**
 * What the player should be doing, in priority order.
 *
 * @param player  the round-tripped ns.getPlayer() object
 * @param state   { hasSF2, inGang, grindKarma, rep: {faction: n},
 *                  workTypes: {faction: string[]}, companyRep: {company: n},
 *                  targets: {faction: rep} from repTargets,
 *                  favor: {faction: n}, favorNeed: n }
 * @returns       { kind: "gym"|"crime"|"faction"|"company"|"idle", ... }
 */
export function chooseAction(player, state) {
  // 1. Gym, lowest stat first - only for the gang grind, which is the only
  //    thing here the combat stats serve (Homicide's success, and the combat
  //    bars on the crime factions' invites). And only where the gym is:
  //    gymWorkout returns false anywhere else, and falling through to crime is
  //    right - every city has Slums.
  const low = GYM_STATS
    .filter(([k]) => player.skills[k] < TRAIN_STAT_FLOOR)
    .sort((a, b) => player.skills[a[0]] - player.skills[b[0]]);
  if (state.grindKarma && low.length && player.city === TRAIN_GYM_CITY) {
    return { kind: "gym", gym: TRAIN_GYM, stat: low[0][1] };
  }

  // 2. Karma for a gang, only when asked for (GRIND_GANG_KARMA, ~15 hours) and
  //    only with SF2 - without it there is no gang in BN4 to found.
  if (state.grindKarma && state.hasSF2 && !state.inGang && player.karma > GANG_KARMA_TARGET) {
    return { kind: "crime", crime: CRIME_TYPE };
  }

  // 3. Rep, down WORK_ORDER. A faction that takes donations has its rep bought
  //    with the next aug batch, so it is not worked - unless nothing else is
  //    left, when working it (at its favor's 1 + favor/100) still beats idling.
  let donatable = null;
  for (const step of steps(player)) {
    if (step.company) {
      const c = step.company;
      const employed = Boolean((player.jobs ?? {})[c]);
      // Done once its faction is joined or the rep bar is met. Not yet hireable
      // is a skip, not an application every tick that the game refuses.
      if (player.factions.includes(c) || (state.companyRep?.[c] ?? 0) >= step.rep) continue;
      // Its faction's augs are all owned: the invite would buy nothing.
      if (state.targets?.[c] === 0) continue;
      if (!employed && player.skills.hacking < step.hacking) continue;
      return { kind: "company", company: c, field: step.field, employed };
    }
    // The gang's own faction offers no work - getFactionWorkTypes returns []
    // for it - so "has a work type" excludes it without knowing its name, which
    // would cost getGangInformation (2.00 GB) to find out.
    const types = state.workTypes[step.faction] ?? [];
    const type = WORK_TYPE_ORDER.find((t) => types.includes(t));
    if (type && (state.rep[step.faction] ?? 0) < repTarget(step.faction, state.targets)) {
      const a = { kind: "faction", faction: step.faction, type };
      if (!canDonate(step.faction, state)) return a;
      donatable ??= a;
    }
  }
  if (donatable) return donatable;

  // 4. Nothing to work. sing.js turns this into a money crime (bestCrime) -
  //    the usual state for the first stretch after an install, before any
  //    invite - and only when that cannot be read is it truly idle.
  return { kind: "idle" };
}

/**
 * The crime paying the most per second at the player's own odds, or null.
 * Failure pays nothing and still takes the full time, so the rate is
 * chance x money / time. Both inputs come from the game (getCrimeStats money
 * already carries the player's and the node's multipliers), so no crime table
 * is transcribed here.
 *
 * ponytail: no hysteresis. A switch restarts the crime and forfeits its
 * progress - up to Heist's 600 s - but chance only rises, so each pair
 * crosses once. Add a margin if a live log shows it flapping.
 *
 * @param stats   {crime: {money, time}}   getCrimeStats, time in ms
 * @param chances {crime: 0..1}            getCrimeChance
 */
export function bestCrime(stats, chances) {
  let best = null;
  let rate = 0;
  for (const [crime, c] of Object.entries(stats)) {
    const r = (chances[crime] ?? 0) * c.money / c.time;
    if (r > rate) [best, rate] = [crime, r];
  }
  return best;
}

/**
 * Is `action` already what the player is doing?
 *
 * The guard that makes invariant 2 structural: an action body runs only when
 * this is false. Restarting crime resets CrimeWork.unitCompleted to 0, so a
 * crime longer than the tick, restarted every tick, would never complete once.
 *
 * `work` is getCurrentWork()'s APICopy() shape (src/Work/*Work.ts), or null.
 */
export function sameAsCurrent(work, action) {
  if (action.kind === "idle") return true;
  if (!work) return false;
  if (action.kind === "gym") {
    return work.type === "CLASS" && work.classType === action.stat && work.location === action.gym;
  }
  if (action.kind === "crime") return work.type === "CRIME" && work.crimeType === action.crime;
  if (action.kind === "faction") {
    return work.type === "FACTION" && work.factionName === action.faction &&
      work.factionWorkType === action.type;
  }
  if (action.kind === "company") return work.type === "COMPANY" && work.companyName === action.company;
  return false;
}
