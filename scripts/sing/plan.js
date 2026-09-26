import {
  TRAIN_STAT_FLOOR, TRAIN_GYM, TRAIN_GYM_CITY, CRIME_TYPE, GANG_KARMA_TARGET,
  WORK_ORDER, WORK_TYPE_ORDER, FACTION_REP_TARGET,
  TDH_FACTION, TDH_CITIES, TDH_HACKING, TDH_MONEY, TRAVEL_COST, CITY_GROUPS, CITY_INVITE_MONEY,
  MIN_AUG_BATCH, NFG, AUG_PRICE_MULT, NFG_LEVEL_MULT, AUG_SKIP_FACTIONS,
  DONATE_MONEY_PER_REP, RED_PILL, MONEY_CRIMES,
  STUDY_COURSE, UNIVERSITIES, STUDY_MIN_MONEY,
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
 * @param priority {aug: bool} from the AUG_STATS body, or null. Given, an aug
 *                 rated false does not count - that is tier 1. An aug not rated
 *                 yet still counts: unknown must not read as done.
 */
export function repTargets(augsOf, owned, info, priority = null) {
  const have = new Set(owned);
  const out = {};
  for (const [faction, augs] of Object.entries(augsOf)) {
    let max = 0;
    for (const a of augs) {
      if (a === NFG || have.has(a) || priority?.[a] === false) continue;
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
 * expensive ones. Priority augs (hacking and rep gain, rated by AUG_STATS) go
 * ahead of the rest - the user's rule - and dearest-first holds inside each
 * class. An aug is skipped (not the batch) when it does not fit or a
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
 * Two things lift the MIN_AUG_BATCH rule, both the user's: `force` (the
 * install that crosses the donate-favor bar, see sing.js), and THE RED PILL in
 * the batch - it ends the node's aug cycles, so it is bought and installed the
 * moment it is in reach. Its rep is reserved before anything else: it costs no
 * money (Augmentations.ts moneyCost 0), so dearest-first would plan it last and
 * leave its donation only what the other augs had not taken.
 *
 * @param o.augsOf   {faction: aug names}
 * @param o.owned    installed and queued aug names
 * @param o.queued   how many are queued (not yet installed)
 * @param o.info     {aug: {rep, price}}, prices as the game quotes them NOW
 * @param o.prereqs  {aug: prerequisite names}
 * @param o.rep      {faction: rep} for joined factions - only these can sell
 * @param o.cash     money on hand
 * @param o.donate   { perRep, can(faction) } - or null, and nothing is donated
 * @param o.priority {aug: bool} - priority augs are planned first (tier 1), each class dearest first
 * @param o.force    buy what fits even under MIN_AUG_BATCH
 * @param o.minBatch the live `sing.minAugBatch`; MIN_AUG_BATCH when omitted
 * @returns {{ buys: {faction, name, cost}[], donations: {faction, amount, rep}[],
 *             batch: number, total: number, eligible: number,
 *             nfg: {faction, levels, why: "rep"|"cash", ...}|null }}
 */
export function planAugBuys({ augsOf, owned, queued, info, prereqs, rep, cash, donate = null, priority = null, force = false,
  minBatch = MIN_AUG_BATCH }) {
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

  const rank = (c) => (priority?.[c.name] === false ? 0 : 1);
  const eligible = Object.keys(sellers)
    .filter((a) => a !== NFG && !have.has(a) && info[a])
    .map((a) => ({ name: a, sellers: sellers[a], price: info[a].price, need: info[a].rep }))
    .filter((c) => Number.isFinite(lift(cheapest(c), c.need)))
    .sort((x, y) => rank(y) - rank(x) || y.price - x.price);

  const buys = [];
  const donated = {};
  let total = 0;
  const pill = eligible.find((c) => c.name === RED_PILL);
  if (pill) {
    const f = cheapest(pill);
    const d = lift(f, pill.need);
    if (d && d <= cash) {
      donated[f] = d;
      reach[f] = pill.need + 1;
      total = d;
    }
  }
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

  // Why the fill stopped, for the log. NeuroFlux looks cheap in the shop and
  // is the batch's only unlimited filler, so "best batch is 9 of 10" reads as
  // a money problem whatever actually stopped it - and it is usually rep, or
  // the AUG_PRICE_MULT compounding that makes level k cost 1.14 x 1.9 = 2.17
  // times level k-1. Naming the wrong cause is worse than naming none.
  let nfg = null;
  if (sellers[NFG] && info[NFG]) {
    const f = best(sellers[NFG]);
    for (let level = 0; ; level++) {
      const cost = info[NFG].price * NFG_LEVEL_MULT ** level * AUG_PRICE_MULT ** buys.length;
      const need = info[NFG].rep * NFG_LEVEL_MULT ** level;
      if (reach[f] < need) { nfg = { faction: f, levels: level, why: "rep", need, have: reach[f] }; break; }
      if (total + cost > cash) { nfg = { faction: f, levels: level, why: "cash", cost, left: cash - total }; break; }
      buys.push({ faction: f, name: NFG, cost });
      total += cost;
    }
  }

  const batch = queued + buys.length;
  const donations = Object.entries(donated)
    .map(([faction, amount]) => ({ faction, amount, rep: amount / donate.perRep }));
  const go = batch >= minBatch || force || buys.some((b) => b.name === RED_PILL);
  return { buys: go ? buys : [], donations: go ? donations : [], batch, total, eligible: eligible.length, nfg };
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
 * Would an install NOW carry this faction to the donate bar? Then the rep it
 * still wants is bought after the install instead of worked for now - the
 * live case was Bachman worked toward 375k with 150 favor already earned.
 * `favorGain` is getFactionFavorGain, re-read every aug pass (it moves with
 * rep). A faction already at the bar is canDonate's, not this.
 *
 * @param state  { favor: {faction: n}, favorNeed: n, favorGain: {faction: n} }
 */
export function bankedFavor(faction, state) {
  const f = state.favor?.[faction];
  return state.favorNeed > 0 && f !== undefined && f < state.favorNeed &&
    f + (state.favorGain?.[faction] ?? 0) >= state.favorNeed;
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
 * This install's city group: the one already joined into, since the game has
 * locked the others - else the group with the most priority augs left, then
 * the most augs of any kind, over its factions without duplicates. Ties go to
 * the earlier group, Sector-12's. NeuroFlux never counts, as in repTargets; an
 * unrated aug counts as priority, as there.
 *
 * @param priority {aug: bool} from AUG_STATS
 */
export function chooseCityGroup(joined, augsOf, owned, priority = {}) {
  const inGroup = CITY_GROUPS.find((g) => g.some((c) => joined.includes(c)));
  if (inGroup) return inGroup;
  const have = new Set(owned);
  const score = (g) => {
    const left = [...new Set(g.flatMap((c) => augsOf[c] ?? []))].filter((a) => a !== NFG && !have.has(a));
    return [left.filter((a) => priority[a] !== false).length, left.length];
  };
  let best = CITY_GROUPS[0];
  let bs = score(best);
  for (const g of CITY_GROUPS.slice(1)) {
    const s = score(g);
    if (s[0] > bs[0] || (s[0] === bs[0] && s[1] > bs[1])) [best, bs] = [g, s];
  }
  return best;
}

/**
 * Where to fly, or null. The stops, in order: Tian Di Hui (any of TDH_CITIES,
 * hacking TDH_HACKING) while unjoined with augs left, then each city of `group`
 * whose faction is unjoined with augs left. The first stop whose money bar is
 * met wins - the bar alone where the player already stands, the bar plus a
 * fare out and back from anywhere else, since an invite checks cash on hand
 * after the ticket. Standing in the winner's city is a wait for its invite, and
 * no stop affordable is a wait wherever the player is. With no stop left at
 * all, a karma grinder goes to the gym's city - the only other reason to move.
 *
 * ponytail: a cash dip while waiting can send the player on to a later, cheaper
 * stop and back again, $200k a leg. Add hysteresis if a log shows it.
 *
 * @param o.group      chooseCityGroup's pick
 * @param o.targets    {faction: rep}, tier 2 - 0 means nothing left there;
 *                     absent means unread, which counts as wanted
 * @param o.grindKarma GRIND_GANG_KARMA, as READ returned it
 */
export function chooseTravel(player, { group, targets = {}, grindKarma = false }) {
  const want = (f) => !player.factions.includes(f) && targets[f] !== 0;
  const stops = [];
  if (want(TDH_FACTION) && player.skills.hacking >= TDH_HACKING) stops.push({ cities: TDH_CITIES, money: TDH_MONEY });
  for (const c of group) if (want(c)) stops.push({ cities: [c], money: CITY_INVITE_MONEY[c] });
  const here = (s) => s.cities.includes(player.city);
  const next = stops.find((s) => player.money >= s.money + (here(s) ? 0 : 2 * TRAVEL_COST));
  if (next) return here(next) ? null : next.cities[0];
  if (!stops.length && grindKarma && player.city !== TRAIN_GYM_CITY) return TRAIN_GYM_CITY;
  return null;
}

/**
 * One pass down the steps against one tier's targets. Returns the first step
 * with work left, and the first donatable one met on the way - a faction that
 * takes donations has its rep bought with the next batch, so it is only a
 * fallback.
 */
function walk(player, state, targets) {
  let donatable = null;
  for (const step of steps(player)) {
    if (step.company) {
      const c = step.company;
      // The faction the company's invite leads to. The same name for every
      // megacorp but Fulcrum, whose faction is Fulcrum Secret Technologies.
      const f = step.faction ?? c;
      const employed = Boolean((player.jobs ?? {})[c]);
      // Done once its faction is joined or the rep bar is met. Not yet hireable
      // is a skip, not an application every tick that the game refuses.
      if (player.factions.includes(f) || (state.companyRep?.[c] ?? 0) >= step.rep) continue;
      // Nothing left to buy there in this tier: the invite would buy nothing.
      if (targets?.[f] === 0) continue;
      if (!employed && player.skills.hacking < step.hacking) continue;
      return { action: { kind: "company", company: c, field: step.field, employed } };
    }
    // The gang's own faction offers no work - getFactionWorkTypes returns []
    // for it - so "has a work type" excludes it without knowing its name, which
    // would cost getGangInformation (2.00 GB) to find out.
    const types = state.workTypes[step.faction] ?? [];
    const type = WORK_TYPE_ORDER.find((t) => types.includes(t));
    const target = repTarget(step.faction, targets);
    if (type && (state.rep[step.faction] ?? 0) < target) {
      const a = { kind: "faction", faction: step.faction, type, target };
      if (!canDonate(step.faction, state) && !bankedFavor(step.faction, state)) return { action: a };
      donatable ??= a;
    }
  }
  return { action: null, donatable };
}

/**
 * What the player should be doing, in priority order.
 *
 * @param player  the round-tripped ns.getPlayer() object
 * @param state   { hasSF2, inGang, grindKarma, rep: {faction: n},
 *                  workTypes: {faction: string[]}, companyRep: {company: n},
 *                  targets: {faction: rep} from repTargets,
 *                  priorityTargets: {faction: rep} tier 1, optional,
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

  // 3. Rep, down WORK_ORDER - in two tiers once the aug pass has rated augs:
  //    first to the rep the PRIORITY augs need (hacking and rep gain - the
  //    user's rule, the road to w0r1d_d43m0n's hacking bar), then to what
  //    everything else needs. A donatable faction is worked only when no tier
  //    has anything else left, at its favor's 1 + favor/100.
  const tiers = state.priorityTargets
    ? [[1, state.priorityTargets], [2, state.targets]]
    : [[null, state.targets]];
  let donatable = null;
  for (const [tier, targets] of tiers) {
    const w = walk(player, state, targets);
    const tag = tier ? { tier } : {};
    if (w.action) return { ...w.action, ...tag };
    if (w.donatable) donatable ??= { ...w.donatable, ...tag };
  }
  if (donatable) return { ...donatable, fallback: true };

  // 4. Nothing to work. sing.js turns this into a money crime (bestCrime) -
  //    the usual state for the first stretch after an install, before any
  //    invite - and only when that cannot be read is it truly idle.
  return { kind: "idle" };
}

/**
 * The joined factions an install now would lift to the donate bar that still
 * want rep - but only when nothing else is worth working (chooseAction is idle
 * or a fallback), since then the install is what opens their rep to money. []
 * otherwise. A karma grind's gym or crime is not a fallback: it installs nothing.
 */
export function installForFavor(player, state) {
  const a = chooseAction(player, state);
  if (a.kind !== "idle" && !a.fallback) return [];
  return player.factions.filter((f) => bankedFavor(f, state) &&
    (state.rep[f] ?? 0) < repTarget(f, state.targets));
}

/**
 * The MONEY_CRIMES entry paying the most per second at the player's own odds,
 * or null. Failure pays nothing and still takes the full time, so the rate is
 * chance x money / time. Both inputs come from the game (getCrimeStats money
 * already carries the player's and the node's multipliers), so no crime table
 * is transcribed here. Crimes outside the list are never picked, whatever they
 * pay - the user's rule, see MONEY_CRIMES.
 *
 * ponytail: no hysteresis. A switch restarts the crime and forfeits its
 * progress - at most Deal Drugs' 10 s - and chance only rises, so each pair
 * crosses once. Add a margin if a live log shows it flapping.
 *
 * @param stats   {crime: {money, time}}   getCrimeStats, time in ms
 * @param chances {crime: 0..1}            getCrimeChance
 */
export function bestCrime(stats, chances) {
  let best = null;
  let rate = 0;
  for (const crime of MONEY_CRIMES) {
    const c = stats[crime];
    if (!c) continue;
    const r = (chances[crime] ?? 0) * c.money / c.time;
    if (r > rate) [best, rate] = [crime, r];
  }
  return best;
}

/**
 * The idle fallback's first choice: a class, when asked for (`idleStudy`, the
 * live sing.idleStudy), where the player stands has a university and the cash
 * can carry it. Otherwise null, and sing.js falls through to bestCrime - a
 * city with no university must still earn something rather than retry a class
 * the game refuses every tick.
 */
export function studyAction(player, idleStudy) {
  const university = UNIVERSITIES[player.city];
  if (!idleStudy || !university || player.money < STUDY_MIN_MONEY) return null;
  return { kind: "study", university, course: STUDY_COURSE };
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
  if (action.kind === "study") {
    return work.type === "CLASS" && work.classType === action.course && work.location === action.university;
  }
  if (action.kind === "faction") {
    return work.type === "FACTION" && work.factionName === action.faction &&
      work.factionWorkType === action.type;
  }
  if (action.kind === "company") return work.type === "COMPANY" && work.companyName === action.company;
  return false;
}
