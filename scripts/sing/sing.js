import {
  SING_TICK_MS, UPGRADE_EVERY, PROGS_EVERY, JOIN_EVERY, AUGS_EVERY, PARKED_MS,
  PROG_BUDGET_FRACTION, CITY_GROUPS,
  GANG_KARMA_TARGET, WORK_FOCUS, PROMOTE_EVERY, SHARE_HOLD_MARKER,
  WORK_ORDER, MIN_AUG_BATCH, NFG, RED_PILL, RED_PILL_FACTION, BACKDOOR_EVERY, BACKDOOR_SCRIPT, BACKDOOR_GB, BACKDOOR_KEEP_GB,
} from "./config.js";
import {
  chooseAction, chooseTravel, sameAsCurrent, repTargets, planAugBuys,
  canDonate, donationPerRep, bestCrime, chooseCityGroup,
} from "./plan.js";
import { rpc } from "scripts/rpc.js";

/**
 * The singularity supervisor: a cheap resident loop whose singularity calls all
 * run in rpc.js transients. BitNode 4 automation, minus the world daemon.
 *
 * WHY THIS SHAPE. The surface phase 1 needs is 30.30 GB held together, against a
 * fresh BN4 home's 32 GB shared with boot and the batcher. So this file holds
 * no singularity call at all (1.60 + ns.run 1.00 = 2.60) - every one lives in a
 * body below, billed to its own throwaway script for as long as it runs. Same
 * shape as gang/gang.js.
 *
 * MANY SMALL BODIES, NOT A FEW FAT ONES. rpc() allows one call in flight per
 * process, so the free RAM this subsystem needs is the MAX over bodies, never
 * the sum. commitCrime alone is 5.00 GB, so CRIME at 6.60 is the floor of that
 * max - and every other body is kept at or under it. Work used to be one ACT
 * body at 12.70 (stop, focus, gym, crime, faction together); split per action it
 * is 3.60 / 6.60 / 4.60, and the focus argument that every action call takes
 * directly retires setFocus and stopAction. tests/ram.test.mjs pins every body.
 *
 * SHARE FOLLOWS FACTION WORK. The share bonus multiplies faction work rep and
 * nothing else, so every tick this writes SHARE_HOLD_MARKER: "" while the
 * player is doing faction work, "hold" otherwise. The manager reads share
 * through the hold (effectiveShareFraction in scripts/config.js), so the RAM
 * goes back to the batcher during the gym, crime and company work.
 *
 * AUGS ARE BOUGHT AS A BATCH. Every AUGS_EVERY ticks: read what is owned and
 * queued, what each faction sells, and what each unowned aug costs in rep and
 * money. That sets each faction's rep target (plan.js repTargets - 0 once its
 * augs are all bought, so it is not worked for rep it cannot spend) and plans
 * a batch (planAugBuys). The batch is bought only when it reaches
 * MIN_AUG_BATCH with the queue and cash covers all of it; whatever is left then
 * goes on home RAM, which an install keeps and money it does not. Once
 * MIN_AUG_BATCH are queued the queue is INSTALLED (AUTO_INSTALL, live) and the
 * game restarts boot.js. What each faction sells and each aug's prerequisites
 * are fixed for the node, so they are read once and kept here.
 *
 * FAVOR BUYS REP - AT PURCHASE TIME ONLY. A faction at getFavorToDonate() favor
 * (150) is not worked; the work moves on down WORK_ORDER. When a batch is
 * planned, an aug that faction's rep does not reach is priced WITH the donation
 * that reaches it, and the donations are made immediately before the buys - so
 * money is never donated without a batch bought behind it. Favor moves only at
 * an install, so each faction's is read once per process.
 *
 * BACKDOORS. Every BACKDOOR_EVERY ticks, every server that is rooted and in
 * hacking range gets a backdoor.js started for it - the faction servers first,
 * whose invites arrive through the JOIN pass, then the rest of the network - as
 * many at once as home RAM holds beside BACKDOOR_KEEP_GB. Nothing waits for them:
 * installBackdoor takes hackTime / 4, and the next pass sees the result.
 *
 * ALWAYS ON. boot starts this unconditionally, because singularity has no 0 GB
 * availability check to gate on. Without Source-File 4 outside BN4 every body
 * throws "requires Source-File 4" (NetscriptHelpers.tsx checkSingularityAccess),
 * and this process PARKS on that message rather than exiting - an exited
 * service is relaunched by boot every tick forever.
 *
 * Usage:  run scripts/sing/sing.js       (boot.js starts it; --no-sing opts out)
 *
 * RAM: 1.60 base + run 1.00 = 2.60 GB
 */

// ------------------------------------------------------------------ bodies ---
//
// Plain template literals: rpc() rejects interpolation, and tests/rpc.test.mjs
// parses every one. The identifier rules bind INSIDE them - each is billed to
// its own transient for every name it holds, which tests/ram.test.mjs prices.
// Every figure comes back as a number; this file formats.

/**
 * Buy home RAM upgrades while each costs at most a fraction of the cash left:
 * HOME_RAM_BUDGET_FRACTION normally, args[0] when given - 1 after an aug
 * batch, which spends everything an install would reset anyway. Each upgrade
 * doubles the next price, so at 0.25 this is usually one. A non-finite cost
 * would cross JSON as null, so it crosses as -1.
 */
const UPGRADE = `
import { HOME_RAM_BUDGET_FRACTION } from "/scripts/sing/config.js";
const frac = args.length ? Number(args[0]) : HOME_RAM_BUDGET_FRACTION;
let money = ns.getServerMoneyAvailable("home");
const before = ns.getServerMaxRam("home");
let cost = ns.singularity.getUpgradeHomeRamCost();
let bought = 0;
let spent = 0;
while (Number.isFinite(cost) && cost <= money * frac && ns.singularity.upgradeHomeRam()) {
  bought++;
  spent += cost;
  money -= cost;
  cost = ns.singularity.getUpgradeHomeRamCost();
}
return {
  bought, spent, money, frac, before,
  after: ns.getServerMaxRam("home"),
  cost: Number.isFinite(cost) ? cost : -1,
};
`;

/** Once per BitNode. Split from PROGS so purchaseTor is not held on every sweep. */
const TOR = `
const had = ns.hasTorRouter();
return { had, owned: had || ns.singularity.purchaseTor() };
`;

/**
 * Cheapest WANTED program first, each at most PROG_BUDGET_FRACTION of what is
 * left. getDarkwebProgramCost returns 0 for a program already owned, so it
 * doubles as the ownership check and fileExists is not needed.
 */
const PROGS = `
import { PROG_BUDGET_FRACTION, PROGS_WANTED } from "/scripts/sing/config.js";
let money = ns.getServerMoneyAvailable("home");
const want = ns.singularity.getDarkwebPrograms()
  .filter((name) => PROGS_WANTED.includes(name))
  .map((name) => ({ name, cost: ns.singularity.getDarkwebProgramCost(name) }))
  .filter((p) => p.cost > 0)
  .sort((a, b) => a.cost - b.cost);
const bought = [];
for (const p of want) {
  if (p.cost > money * PROG_BUDGET_FRACTION) break;
  if (!ns.singularity.purchaseProgram(p.name)) break;
  money -= p.cost;
  bought.push(p.name);
}
const next = want[bought.length];
return { bought, left: want.length - bought.length, next: next ? next.cost : -1, money };
`;

/** Split from JOIN: the deny filter runs resident between the two. */
const INVITES = `return ns.singularity.checkFactionInvitations();`;

const JOIN = `
const joined = [];
for (const f of args) if (ns.singularity.joinFaction(f)) joined.push(f);
return joined;
`;

/**
 * Everything plan.js decides from. ownedSF is a Map and JSON.stringify turns a
 * Map into {} - returned raw, the SF2 gate would read false forever with no
 * error - so it is collapsed to a boolean here, inside the transient.
 *
 * GRIND_GANG_KARMA rides along from config for a different reason: a body
 * re-imports config.js every run, so the flag is LIVE - flip it and the next
 * tick obeys. Read resident, it would be frozen until sing restarted.
 */
const READ = `
import { WORK_ORDER, GRIND_GANG_KARMA } from "/scripts/sing/config.js";
const p = ns.getPlayer();
const reset = ns.getResetInfo();
const rep = {};
const workTypes = {};
for (const f of p.factions) {
  rep[f] = ns.singularity.getFactionRep(f);
  workTypes[f] = ns.singularity.getFactionWorkTypes(f);
}
const companyRep = {};
for (const s of WORK_ORDER) if (s.company) companyRep[s.company] = ns.singularity.getCompanyRep(s.company);
return {
  player: p,
  work: ns.singularity.getCurrentWork(),
  hasSF2: reset.currentNode === 2 || reset.ownedSF.has(2),
  inGang: ns.gang.inGang(),
  grindKarma: GRIND_GANG_KARMA,
  rep, workTypes, companyRep,
};
`;

// The three action bodies. They alone may touch Player.currentWork - one slot,
// and every work-starting call finishes whatever held it.
const GYM = `return ns.singularity.gymWorkout(args[0], args[1], args[2]);`;
const CRIME = `return ns.singularity.commitCrime(args[0], args[1]);`;
const FACTION = `return ns.singularity.workForFaction(args[0], args[1], args[2]);`;
const COMPANY = `return ns.singularity.workForCompany(args[0], args[1]);`;

/**
 * The idle fallback's two reads, 5.00 GB each so split. What a crime pays and
 * how long it takes moves only with the multipliers, which move at an install -
 * read once per process. The odds move with every stat point - read each time.
 * ns.enums is 0 GB.
 */
const CRIME_STATS = `
const out = {};
for (const c of Object.values(ns.enums.CrimeType)) {
  const s = ns.singularity.getCrimeStats(c);
  out[c] = { money: s.money, time: s.time };
}
return out;
`;
const CRIME_CHANCE = `
const out = {};
for (const c of Object.values(ns.enums.CrimeType)) out[c] = ns.singularity.getCrimeChance(c);
return out;
`;

/**
 * Hire or promote: applyForJob hands out the highest position the player
 * qualifies for, and touches nothing but Player.jobs - so it is safe mid-shift
 * and is not an action body. Returns the new job title, or null for "no".
 */
const APPLY = `return ns.singularity.applyToCompany(args[0], args[1]);`;

/**
 * Flies toward Tian Di Hui's invite or the chosen city group's - chooseTravel
 * decides which. travelToCity returns false when the fare is short.
 */
const TRAVEL = `return ns.singularity.travelToCity(args[0]);`;

// The aug bodies. Each call is 2.50-5.00 GB, so reading owned + sold + costs in
// one body would be 14.10 - over the 6.60 ceiling - and they are split per call.

/**
 * getOwnedAugmentations(true) lists queued augs too - NeuroFlux once per queued
 * level - so the difference from the installed list is the queue length the
 * price multiplier counts. `pill` is the Red Pill bought but not installed: an
 * install that failed must be retried on the next pass, and a queue of one is
 * under MIN_AUG_BATCH.
 */
const OWNED = `
import { RED_PILL } from "/scripts/sing/config.js";
const all = ns.singularity.getOwnedAugmentations(true);
const installed = ns.singularity.getOwnedAugmentations(false);
return { all, queued: all.length - installed.length, pill: all.includes(RED_PILL) && !installed.includes(RED_PILL) };
`;

const FAC_AUGS = `
const out = {};
for (const f of args) out[f] = ns.singularity.getAugmentationsFromFaction(f);
return out;
`;

const PREREQ = `
const out = {};
for (const a of args) out[a] = ns.singularity.getAugmentationPrereq(a);
return out;
`;

/** Rep and price, fresh every pass: each purchase re-prices every aug. */
const AUG_INFO = `
const out = {};
for (const a of args) {
  out[a] = { rep: ns.singularity.getAugmentationRepReq(a), price: ns.singularity.getAugmentationPrice(a) };
}
return out;
`;

/**
 * Is each aug tier 1? A multiplier in PRIORITY_MULTS above 1, or named in
 * PRIORITY_AUGS. getAugmentationStats is 5.00 alone, so this is its own 6.60
 * body; an aug's stats are fixed for the node, so each is rated once per
 * process - which also freezes the two lists until sing restarts.
 */
const AUG_STATS = `
import { PRIORITY_MULTS, PRIORITY_AUGS } from "/scripts/sing/config.js";
const out = {};
for (const a of args) {
  const m = ns.singularity.getAugmentationStats(a);
  out[a] = PRIORITY_AUGS.includes(a) || PRIORITY_MULTS.some((k) => m[k] > 1);
}
return out;
`;

/** In plan order - most expensive first - stopping at the first refusal. */
const BUY = `
const bought = [];
for (const [f, a] of JSON.parse(args[0])) {
  if (!ns.singularity.purchaseAugmentation(f, a)) break;
  bought.push(a);
}
return bought;
`;

/**
 * Favor per faction, and the bar to donate. getFavorToDonate is a plain ns call
 * (0.10) - it folds in the node's FavorToDonateToFaction, so 150 is never
 * hardcoded here. Split from READ, which is already on the 6.60 ceiling.
 */
const FAVOR = `
const favor = {};
for (const f of args) favor[f] = ns.singularity.getFactionFavor(f);
return { favor, need: ns.getFavorToDonate() };
`;

/**
 * The favor an install would add (addRepToFavor(favor, rep) - favor). Its own
 * body, not FAVOR's: FAVOR is read once per process, and this moves with rep.
 */
const FAVOR_GAIN = `return ns.singularity.getFactionFavorGain(args[0]);`;

/**
 * The node's FactionWorkRepGain, which prices a donation (donation.ts). Fixed
 * for the BitNode, so read once per process. Called with no arguments the game
 * defaults to (bitNodeN, SF level + 1) - exactly what initBitNodeMultipliers
 * installs as the live multipliers. Needs Source-File 5; without it this throws,
 * warns once, and nothing is donated rather than donated at a guessed price.
 * Its own body: 4.00 GB on top of FAVOR would be 6.70, over the ceiling.
 */
const BN_MULTS = `return ns.getBitNodeMultipliers().FactionWorkRepGain;`;

/**
 * Before an install: the AUTO_INSTALL flag, read here so it is live, and one
 * contract sweep - an install destroys every unsolved contract on the network
 * (Prestige.ts prestigeAllServers), and boot's own sweep can be a minute old.
 * -1 when the flag is off, else the sweep's pid; 0 means it could not start,
 * which is not worth holding the install for. It waits for the sweep so the
 * install cannot kill it mid-attempt; one past rpc's 10 s times out here and
 * the install waits for the next pass. Split from INSTALL: together 7.70.
 */
const SWEEP = `
import { AUTO_INSTALL } from "/scripts/sing/config.js";
import { CONTRACTS_SERVICE } from "/scripts/contracts/config.js";
if (!AUTO_INSTALL) return -1;
const pid = ns.run(CONTRACTS_SERVICE);
while (pid && ns.isRunning(pid)) await ns.sleep(200);
return pid;
`;

/**
 * Kills every script - this transient and sing.js with it - and 500 ms after
 * the reset runs boot.js with no arguments and one thread (Singularity.ts
 * runAfterReset). The callback is skipped only when home lacks the RAM, and
 * every script has just been killed, so boot's 3.50 GB always fits. Any reply
 * at all means no install; false is the game's "nothing queued".
 */
const INSTALL = `return ns.singularity.installAugmentations("/scripts/boot.js");`;

/**
 * What is left to backdoor, with each server's route from home, which servers
 * already have a backdoor.js running (so a pass never starts a second), and
 * home's free RAM (so a pass starts only what fits). Order is priority: the
 * BACKDOOR_HOSTS first - their invites are the point - then every other server
 * on the network. Skipped: home, anything the player bought (cloud and hacknet
 * servers are direct-connect already, and installBackdoor throws on hacknet),
 * and w0r1d_d43m0n, whose backdoor ends the BitNode. The BFS is connectme.js's, copied
 * rather than imported - importing it would bill connectme's getServer and
 * tprint to this body. The network is a tree rooted at home, so the parent map
 * gives THE route.
 */
const BACKDOORS = `
import { BACKDOOR_HOSTS, BACKDOOR_SCRIPT } from "/scripts/sing/config.js";
const parent = { home: null };
const queue = ["home"];
for (let i = 0; i < queue.length; i++) {
  for (const n of ns.scan(queue[i])) if (!(n in parent)) { parent[n] = queue[i]; queue.push(n); }
}
const first = BACKDOOR_HOSTS.filter((h) => h in parent);
const rest = queue.filter((h) => h !== "home" && h !== "w0r1d_d43m0n" && !BACKDOOR_HOSTS.includes(h));
const left = [];
for (const host of [...first, ...rest]) {
  const s = ns.getServer(host);
  if (s.backdoorInstalled || s.purchasedByPlayer) continue;
  const route = [];
  for (let h = host; h !== null; h = parent[h]) route.unshift(h);
  left.push({ host, route, faction: BACKDOOR_HOSTS.includes(host), root: s.hasAdminRights, need: s.requiredHackingSkill });
}
// ps reports paths without the leading slash; the target is a copy's last argument.
const busy = ns.ps("home").filter((p) => "/" + p.filename === BACKDOOR_SCRIPT).map((p) => String(p.args.at(-1)));
const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
return { level: ns.getHackingLevel(), left, busy, free };
`;

/** [[faction, $], ...] - returns the factions the game accepted. */
const DONATE = `
const done = [];
for (const [f, amt] of JSON.parse(args[0])) if (ns.singularity.donateToFaction(f, amt)) done.push(f);
return done;
`;

// ------------------------------------------------------------------ format ---

const money$ = (ns, v) => `$${ns.format.number(v, 2)}`;
const n2 = (ns, v) => ns.format.number(v, 2, 1000, true);

function upgradeLine(ns, u) {
  const ram = ns.format.ram(u.before);
  if (u.bought) {
    return `bought ${u.bought} home RAM upgrade(s) ${ram} -> ${ns.format.ram(u.after)} for ${money$(ns, u.spent)}`;
  }
  if (u.cost < 0) return `home RAM at its maximum, ${ram}`;
  if (u.cost <= u.money * u.frac) {
    return `the game refused a ${money$(ns, u.cost)} upgrade at ${ram} that cash covers`;
  }
  return `not upgrading home (${ram}): ${money$(ns, u.money)}, next upgrade ${money$(ns, u.cost)} ` +
    `(buys at ${ns.format.percent(u.frac, 0)} of cash)`;
}

/**
 * What stopped the NeuroFlux fill, which is what stopped the batch: it is the
 * only filler with no supply limit, so the batch is short exactly when it is.
 * Its shop price says nothing about the next level - each one is 1.14 x 1.9
 * dearer than the last, since every queued aug re-prices every later one.
 */
function nfgLine(ns, nfg) {
  if (!nfg) return "no NeuroFlux seller among the joined factions";
  const at = `${nfg.levels} NeuroFlux level(s)`;
  if (nfg.why === "rep") {
    return `${at}, then ${nfg.faction} rep ${n2(ns, nfg.have)} of ${n2(ns, nfg.need)} needed for the next`;
  }
  return `${at}, then the next costs ${money$(ns, nfg.cost)} against ${money$(ns, nfg.left)} left`;
}

function augsWaitLine(ns, plan, queued, cash) {
  if (queued >= MIN_AUG_BATCH) return `${queued} queued; nothing more affordable now`;
  return `waiting: best batch is ${plan.batch} of ${MIN_AUG_BATCH} (${queued} queued), ` +
    `${plan.eligible} unlocked by rep or favor, cash ${money$(ns, cash)} - ${nfgLine(ns, plan.nfg)}`;
}

function donationsLine(ns, ds) {
  return ds.map((d) => `${money$(ns, d.amount)} to ${d.faction} (+${n2(ns, d.rep)} rep)`).join(", ");
}

function progsLine(ns, p) {
  if (p.bought.length) return `bought ${p.bought.join(", ")}${p.left ? ` - ${p.left} left` : ""}`;
  if (!p.left) return "every wanted program owned";
  return `nothing bought: ${p.left} left, cheapest ${money$(ns, p.next)} against ` +
    `${money$(ns, p.money)} cash (buys at ${ns.format.percent(PROG_BUDGET_FRACTION, 0)})`;
}

function joinLine(invites, joined, deny) {
  if (!invites.length) return "no pending invites";
  if (joined.length) return `accepted ${joined.join(", ")}`;
  const denied = invites.filter((f) => deny.includes(f));
  if (denied.length === invites.length) return `declined ${denied.join(", ")} (outside this install's city group)`;
  return `the game refused ${invites.filter((f) => !denied.includes(f)).join(", ")}`;
}

/**
 * Why each server not in reach is still waiting - the faction servers by name,
 * the rest of the network as counts, or the line would run to sixty hosts.
 */
function backdoorWaitLine(level, waiting) {
  const why = (b) => (!b.root ? "not rooted" : `needs hacking ${b.need} (have ${level})`);
  const named = waiting.filter((b) => b.faction).map((b) => `${b.host} ${why(b)}`);
  const others = waiting.filter((b) => !b.faction);
  if (others.length) {
    const count = {};
    for (const b of others) {
      const k = b.root ? "short on hacking" : "not rooted";
      count[k] = (count[k] ?? 0) + 1;
    }
    named.push(`${others.length} other server(s): ${Object.entries(count).map(([k, n]) => `${n} ${k}`).join(", ")}`);
  }
  return named.join(", ");
}

function describe(ns, a, r) {
  if (a.kind === "gym") return `gym ${a.stat} at ${a.gym}`;
  if (a.kind === "crime" && a.money) return `crime ${a.crime} for money - no faction or company work left`;
  if (a.kind === "crime") {
    return `crime ${a.crime}, karma ${ns.format.number(r.player.karma, 2)} of ` +
      `${ns.format.number(GANG_KARMA_TARGET, 2)}`;
  }
  const tier = a.tier ? `, tier ${a.tier}` : "";
  if (a.kind === "faction") {
    return `faction ${a.faction} (${a.type}${tier}), rep ${n2(ns, r.rep[a.faction] ?? 0)} of ${n2(ns, a.target)}` +
      (canDonate(a.faction, r) ? " - donatable, worked only for want of anything else" : "");
  }
  if (a.kind === "company") {
    return `company ${a.company} (${a.field}${tier}), company rep ${n2(ns, r.companyRep?.[a.company] ?? 0)}`;
  }
  return "idle - no joined faction with work left under its rep target";
}

/** The body and its arguments for a chosen action. The focus flag rides along. */
function actionCall(a) {
  if (a.kind === "gym") return [GYM, a.gym, a.stat, WORK_FOCUS];
  if (a.kind === "crime") return [CRIME, a.crime, WORK_FOCUS];
  if (a.kind === "company") return [COMPANY, a.company, WORK_FOCUS];
  return [FACTION, a.faction, a.type, WORK_FOCUS];
}

// -------------------------------------------------------------------- main ---

/** The one message that means "no singularity here at all", verbatim from the game. */
const NO_ACCESS = "requires Source-File 4";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const log = (s) => ns.print(`${new Date().toLocaleTimeString()}  ${s}`);

  /**
   * One body, and a failure that says so ONCE. "no free RAM on home" is the
   * expected state for the first minutes of a BitNode, and a line a tick about
   * it is the noise that hides a real warning. Keyed per body, and cleared on
   * that body's next success, so a recurrence is reported again.
   */
  const warned = {};
  const call = async (tag, body, ...args) => {
    try {
      const v = await rpc(ns, body, ...args);
      delete warned[tag];
      return v;
    } catch (e) {
      const msg = String(e.message ?? e);
      if (msg.includes(NO_ACCESS)) {
        // Matched on the MESSAGE, not on "the first call failed": a RAM blip at
        // startup must not idle the subsystem for the whole BitNode.
        log("no Source-File 4 and not in BitNode 4 - singularity is unavailable. Parked; " +
          "boot.js --no-sing reclaims this 2.60 GB.");
        // A parked sing must not leave share held with nobody to release it.
        ns.write(SHARE_HOLD_MARKER, "", "w");
        // Not an exit: boot's ensureService would relaunch it every tick forever.
        while (true) await ns.sleep(PARKED_MS);
      }
      if (warned[tag] !== msg) log(`WARN: ${tag} failed - ${msg}`);
      warned[tag] = msg;
      return null;
    }
  };

  log("singularity supervisor up");

  let tick = 0;
  let tor = false;

  // Fixed for the BitNode, so read once and kept: what each faction sells, and
  // each aug's prerequisites. targets is re-derived every AUGS pass.
  const augsOf = {};
  const prereqs = {};
  let targets = {};
  // Tier 1's targets (priority augs only), and each aug's rating - fixed for
  // the node, so rated once and kept like prereqs.
  let priorityTargets = null;
  const priority = {};
  // This install's city faction group - re-chosen on every aug pass while
  // unsettled, then locked for the process (citySettled below). A joined city
  // faction always wins regardless: chooseCityGroup checks that before ever
  // scoring, so locking cannot strand the choice against a real join.
  let cityGroup = null;
  let citySettled = false;
  // Until the first aug pass has run, JOIN treats Sector-12's group as chosen
  // (deny below). Deliberate: the player starts in Sector-12 with ~$1k and its
  // own invite wants $15m, so locking in a group before there is a real choice
  // to make is practically unreachable anyway.
  const cities = () => cityGroup ?? CITY_GROUPS[0];
  // The cities: log line and JOIN's deny both need "every OTHER city faction" -
  // one helper so the two expressions cannot drift apart.
  const otherCities = (group) => CITY_GROUPS.flat().filter((c) => !group.includes(c));
  // Favor moves only at an install, which kills this process - read once.
  const favor = {};
  let favorNeed = 0;
  let bnRepMult = null;
  let crimeStats = null;
  // Backdoors vanish at an install, which kills this process - so once none is
  // left, none is left for the life of the process.
  let backdoorsDone = false;

  /**
   * How the batch may buy rep, or null. The price needs the node's rep
   * multiplier, read only once some faction can actually take a donation - so
   * a save without Source-File 5 that never reaches 150 favor never warns.
   */
  const donateTerms = async (r) => {
    const st = { favor, favorNeed, workTypes: r.workTypes };
    if (!r.player.factions.some((f) => canDonate(f, st))) return null;
    bnRepMult ??= await call("bitnode mults", BN_MULTS);
    if (!bnRepMult) return null;
    return { perRep: donationPerRep(r.player.mults.faction_rep, bnRepMult), can: (f) => canDonate(f, st) };
  };

  /**
   * Install the queue, restarting through boot.js. Returns only when it did
   * NOT install - AUTO_INSTALL off, or a body that failed and warned. Home RAM
   * first, with everything: the install resets money and keeps home RAM.
   */
  const install = async (queued) => {
    const swept = await call("sweep", SWEEP);
    if (swept === null) return;
    if (swept < 0) {
      log(`install: AUTO_INSTALL is off - ${queued} queued, install by hand`);
      return;
    }
    const u = await call("upgrade", UPGRADE, 1);
    if (u) log(`upgrade: ${upgradeLine(ns, u)}`);
    const line = `installing ${queued} augs${swept ? "" : " (the contract sweep could not start)"}, ` +
      "boot.js restarts with its defaults";
    log(`install: ${line}`);
    ns.tprint(`sing: ${line}`);
    if ((await call("install", INSTALL)) === false) log("WARN: install: the game reports nothing queued");
  };

  /**
   * Would an install now carry RED_PILL_FACTION to the donate bar? Then the
   * batch is bought at any size and installed - past the bar the rest of the
   * Red Pill's rep is bought with money instead of worked for. Asked only while
   * it can matter: joined, below the bar, and the Red Pill not yet bought.
   */
  const crossesFavorBar = async (r, owned) => {
    const f = RED_PILL_FACTION;
    if (!r.player.factions.includes(f) || owned.all.includes(RED_PILL)) return false;
    if (!favorNeed || !(f in favor) || favor[f] >= favorNeed) return false;
    const gain = await call("favor gain", FAVOR_GAIN, f);
    if (gain === null || favor[f] + gain < favorNeed) return false;
    log(`augs: installing now carries ${f} to ${n2(ns, favor[f] + gain)} favor (donates at ` +
      `${n2(ns, favorNeed)}) - buying what fits and installing, for the ${RED_PILL}`);
    return true;
  };

  /**
   * Refresh the rep targets, buy a batch if one is due, and install once
   * MIN_AUG_BATCH are queued. Every read is its own body - see the aug bodies
   * above for why.
   */
  const augsPass = async (r) => {
    const owned = await call("owned", OWNED);
    if (!owned) return;
    // Every faction WORK_ORDER names, joined or not: a company step and a city
    // stop are both judged by what their faction sells before any invite.
    const named = WORK_ORDER.map((s) => s.faction ?? s.company);
    const unread = [...new Set([...r.player.factions, ...named])].filter((f) => !(f in augsOf));
    if (unread.length) Object.assign(augsOf, (await call("faction augs", FAC_AUGS, ...unread)) ?? {});
    const sold = [...new Set(Object.values(augsOf).flat())];
    const noPrereqs = sold.filter((a) => a !== NFG && !(a in prereqs));
    if (noPrereqs.length) Object.assign(prereqs, (await call("prereqs", PREREQ, ...noPrereqs)) ?? {});
    const unrated = sold.filter((a) => a !== NFG && !(a in priority));
    if (unrated.length) Object.assign(priority, (await call("aug stats", AUG_STATS, ...unrated)) ?? {});
    const unowned = sold.filter((a) => a === NFG || !owned.all.includes(a));
    const info = unowned.length ? await call("aug info", AUG_INFO, ...unowned) : {};
    if (!info) return;

    targets = repTargets(augsOf, owned.all, info);
    priorityTargets = repTargets(augsOf, owned.all, info, priority);
    // Re-chosen only while unsettled: before every sold aug is rated, owned.all
    // still growing mid-batch and a failed AUG_STATS call defaulting to "every
    // aug is tier 1" can each move the score, and a group picked on that
    // half-known data would fly the player between groups at $200k a leg. Once
    // settled the score can never move again from here, so the choice locks
    // for the rest of the process. A city faction joined ANYWHERE - by JOIN or
    // by hand - still always overrides, settled or not: chooseCityGroup's
    // joined-group check runs before it ever scores anything, so recomputing
    // is free and skipping it would strand the group against a real join.
    const cityJoined = r.player.factions.some((f) => CITY_GROUPS.flat().includes(f));
    if (!citySettled || cityJoined) {
      const group = chooseCityGroup(r.player.factions, augsOf, owned.all, priority);
      if (group !== cityGroup) {
        cityGroup = group;
        log(`cities: ${group.join(", ")} this install - declining ${otherCities(group).join(", ")}`);
      }
      // Settle only on REAL data: every city faction's augs must have been
      // read (a failed FAC_AUGS call leaves augsOf empty, and sold.every on an
      // empty array is vacuously true - that locked the group to the
      // CITY_GROUPS[0] fallback forever on an ordinary rpc failure) and at
      // least one aug must actually have been sold and rated.
      citySettled ||= CITY_GROUPS.flat().every((c) => c in augsOf) &&
        sold.length > 0 && sold.every((a) => a === NFG || a in priority);
    }
    const noFavor = r.player.factions.filter((f) => !(f in favor));
    if (noFavor.length) {
      const v = await call("favor", FAVOR, ...noFavor);
      if (v) {
        Object.assign(favor, v.favor);
        favorNeed = v.need;
      }
    }
    const cash = r.player.money;
    const donate = await donateTerms(r);
    const force = await crossesFavorBar(r, owned);
    const plan = planAugBuys({
      augsOf, owned: owned.all, queued: owned.queued, info, prereqs, rep: r.rep, cash, donate, priority, force,
    });
    if (!plan.buys.length) {
      log(`augs: ${augsWaitLine(ns, plan, owned.queued, cash)}`);
      if (owned.queued >= MIN_AUG_BATCH || owned.pill || (force && owned.queued)) await install(owned.queued);
      return;
    }
    // The rep first, then the augs it unlocks. A refused donation stops the
    // batch before any buy: the buys behind it would stop at that aug and leave
    // a partial batch, which the batch rule exists to prevent.
    if (plan.donations.length) {
      const pairs = plan.donations.map((d) => [d.faction, d.amount]);
      const done = (await call("donate", DONATE, JSON.stringify(pairs))) ?? [];
      const got = plan.donations.filter((d) => done.includes(d.faction));
      if (got.length) {
        log(`donate: ${donationsLine(ns, got)}`);
        ns.tprint(`sing: donated ${donationsLine(ns, got)}`);
      }
      if (got.length < plan.donations.length) {
        log(`WARN: donation refused (${plan.donations.filter((d) => !got.includes(d)).map((d) => d.faction)}) - ` +
          "batch not bought this pass");
        return;
      }
    }
    const bought = (await call("buy", BUY, JSON.stringify(plan.buys.map((b) => [b.faction, b.name])))) ?? [];
    const queued = owned.queued + bought.length;
    const line = `bought ${bought.length} of ${plan.buys.length} planned (${bought.join(", ")}) - ` +
      `${queued} queued`;
    log(`augs: ${line}`);
    if (bought.length) ns.tprint(`sing: ${line}`);
    // Now, not at the next pass: a faction whose last aug was just bought must
    // not be worked for three ticks toward a target that no longer exists.
    const now = [...owned.all, ...bought];
    targets = repTargets(augsOf, now, info);
    priorityTargets = repTargets(augsOf, now, info, priority);
    if (queued >= MIN_AUG_BATCH || force || owned.pill || bought.includes(RED_PILL)) await install(queued);
    // Still here, so not installed. What is left would be reset by the install
    // when it comes; home RAM survives it.
    if (bought.length) {
      const u = await call("upgrade", UPGRADE, 1);
      if (u) log(`upgrade: ${upgradeLine(ns, u)}`);
    }
  };

  /**
   * Start a backdoor.js for every server in reach that has none running, in
   * priority order, while home has room beside BACKDOOR_KEEP_GB - and wait for
   * none of them. A copy that fails leaves its server unbackdoored, so the next
   * pass simply tries again. Only faction servers reach the terminal.
   */
  const backdoorPass = async () => {
    const b = await call("backdoors", BACKDOORS);
    if (!b) return;
    if (!b.left.length) {
      backdoorsDone = true;
      log("backdoor: every server on the network backdoored");
      return;
    }
    const ready = (x) => x.root && x.need <= b.level;
    const todo = b.left.filter((x) => ready(x) && !b.busy.includes(x.host));
    let room = Math.floor((b.free - BACKDOOR_KEEP_GB) / BACKDOOR_GB);
    const started = [];
    for (const x of todo) {
      if (room <= 0 || !ns.run(BACKDOOR_SCRIPT, 1, ...x.route)) break;
      room--;
      started.push(x);
    }
    const named = started.filter((x) => x.faction).map((x) => x.host);
    if (named.length) ns.tprint(`sing: backdooring ${named.join(", ")}`);
    const parts = [];
    if (started.length) parts.push(`started ${started.length} (${started.map((x) => x.host).join(", ")})`);
    if (b.busy.length) parts.push(`${b.busy.length} already running`);
    const blocked = todo.length - started.length;
    if (blocked) {
      parts.push(`${blocked} in reach with no home RAM for them (${ns.format.ram(b.free)} free, ` +
        `${ns.format.ram(BACKDOOR_GB)} each, keeping ${ns.format.ram(BACKDOOR_KEEP_GB)})`);
    }
    const waiting = b.left.filter((x) => !ready(x));
    if (waiting.length) parts.push(`waiting - ${backdoorWaitLine(b.level, waiting)}`);
    log(`backdoor: ${parts.join("; ")}`);
  };

  /** Write the share hold only on a change, and say so - it moves RAM network-wide. */
  const holdShare = (factionWork) => {
    const want = factionWork ? "" : "hold";
    if (ns.read(SHARE_HOLD_MARKER) === want) return;
    ns.write(SHARE_HOLD_MARKER, want, "w");
    log(`share: ${want ? "HELD - not doing faction work, the only work it multiplies" : "released - faction work"}`);
  };

  while (true) {
    // READ first: the aug pass plans against its money and rep, and gets the
    // cash before the home upgrade's 25% can take it.
    const r = await call("read", READ);
    if (r && tick % AUGS_EVERY === 0) await augsPass(r);

    if (tick % UPGRADE_EVERY === 0) {
      const u = await call("upgrade", UPGRADE);
      if (u) log(`upgrade: ${upgradeLine(ns, u)}`);
    }

    if (tick % PROGS_EVERY === 0) {
      if (!tor) {
        const t = await call("tor", TOR);
        if (t) {
          tor = t.owned;
          log(`tor: ${t.had ? "already owned" : t.owned ? "bought" : "not yet affordable"}`);
        }
      }
      if (tor) {
        const p = await call("progs", PROGS);
        if (p) log(`progs: ${progsLine(ns, p)}`);
      }
    }

    if (tick % JOIN_EVERY === 0) {
      const invites = await call("invites", INVITES);
      if (invites) {
        const deny = otherCities(cities());
        const want = invites.filter((f) => !deny.includes(f));
        const joined = want.length ? (await call("join", JOIN, ...want)) ?? [] : [];
        log(`join: ${joinLine(invites, joined, deny)}`);
      }
    }

    // Every tick. The action body runs only on a DIFFERENCE: restarting a crime
    // resets its progress, and one longer than the tick would never complete.
    // A flight skips this tick's work: r.player still says the old city, and the
    // gym is only where the player no longer is.
    //
    // r.player.money is READ's snapshot from the START of this tick - the aug
    // pass and the home upgrade above may already have spent some of it, so a
    // fare can be aimed at a city whose bar the spend has since missed (the
    // player then just waits there). Left alone on purpose: reordering travel
    // ahead of the spend passes would skip work more often for the sake of
    // avoiding one wasted fare and a delay.
    const city = r && chooseTravel(r.player, { group: cities(), targets, grindKarma: r.grindKarma });
    const flew = city ? await call("travel", TRAVEL, city) : false;
    if (city) log(`travel: ${flew ? "flew" : "could not fly"} to ${city}`);
    if (r && !flew) {
      const st = { ...r, targets, priorityTargets, favor, favorNeed };
      let action = chooseAction(r.player, st);
      // Nothing to work - the first stretch after an install, before any
      // invite. Money beats idling: it is what TOR, the programs, the Tian Di
      // Hui trip and home RAM all wait on.
      if (action.kind === "idle") {
        crimeStats ??= await call("crime stats", CRIME_STATS);
        const chances = crimeStats && await call("crime chance", CRIME_CHANCE);
        const crime = chances && bestCrime(crimeStats, chances);
        if (crime) action = { kind: "crime", crime, money: true };
      }
      const what = describe(ns, action, st);
      // Hired first, promoted every PROMOTE_EVERY ticks after - each rung raises
      // the company rep rate. Not hired means nothing to work at yet.
      let hired = action.kind !== "company" || action.employed;
      if (action.kind === "company" && (!action.employed || tick % PROMOTE_EVERY === 0)) {
        const job = await call("apply", APPLY, action.company, action.field);
        if (job) hired = true;
        log(`apply: ${job ? `now ${job} at ${action.company}` : action.employed ? "no promotion yet" : `not hired at ${action.company}`}`);
      }
      let started = null;
      if (sameAsCurrent(r.work, action)) {
        log(`work: ${what}${action.kind === "idle" ? "" : " (running)"}`);
      } else if (hired) {
        const [body, ...args] = actionCall(action);
        started = Boolean(await call(action.kind, body, ...args));
        log(`work: ${started ? "started" : "could not start"} ${what}`);
      }
      holdShare(started ? action.kind === "faction" : r.work?.type === "FACTION");
    }

    if (!backdoorsDone && tick % BACKDOOR_EVERY === 0) await backdoorPass();

    tick++;
    await ns.sleep(SING_TICK_MS);
  }
}
