import {
  SING_TICK_MS, UPGRADE_EVERY, PROGS_EVERY, JOIN_EVERY, AUGS_EVERY, PARKED_MS,
  PROG_BUDGET_FRACTION, JOIN_DENY,
  GANG_KARMA_TARGET, WORK_FOCUS, PROMOTE_EVERY, SHARE_HOLD_MARKER,
  WORK_ORDER, MIN_AUG_BATCH, NFG,
} from "./config.js";
import {
  chooseAction, chooseTravel, sameAsCurrent, repTarget, repTargets, planAugBuys,
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
 * player is doing faction work, "hold" otherwise. Both managers read share
 * through the hold (effectiveShareFraction in scripts/config.js), so the RAM
 * goes back to the batcher during the gym, crime and company work.
 *
 * AUGS ARE BOUGHT AS A BATCH. Every AUGS_EVERY ticks: read what is owned and
 * queued, what each faction sells, and what each unowned aug costs in rep and
 * money. That sets each faction's rep target (plan.js repTargets - 0 once its
 * augs are all bought, so it is not worked for rep it cannot spend) and plans
 * a batch (planAugBuys). The batch is bought only when it reaches
 * MIN_AUG_BATCH with the queue and cash covers all of it; whatever is left then
 * goes on home RAM, which an install keeps and money it does not. Installing
 * stays manual. What each faction sells and each aug's prerequisites are fixed
 * for the node, so they are read once and kept here.
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
 * Cheapest program first, each at most PROG_BUDGET_FRACTION of what is left.
 * getDarkwebProgramCost returns 0 for a program already owned, so it doubles
 * as the ownership check and fileExists is not needed.
 */
const PROGS = `
import { PROG_BUDGET_FRACTION } from "/scripts/sing/config.js";
let money = ns.getServerMoneyAvailable("home");
const want = ns.singularity.getDarkwebPrograms()
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
 * Hire or promote: applyForJob hands out the highest position the player
 * qualifies for, and touches nothing but Player.jobs - so it is safe mid-shift
 * and is not an action body. Returns the new job title, or null for "no".
 */
const APPLY = `return ns.singularity.applyToCompany(args[0], args[1]);`;

/** The Tian Di Hui round trip. travelToCity returns false when the fare is short. */
const TRAVEL = `return ns.singularity.travelToCity(args[0]);`;

// The aug bodies. Each call is 2.50-5.00 GB, so reading owned + sold + costs in
// one body would be 14.10 - over the 6.60 ceiling - and they are split per call.

/**
 * getOwnedAugmentations(true) lists queued augs too - NeuroFlux once per queued
 * level - so the difference from the installed list is the queue length the
 * price multiplier counts.
 */
const OWNED = `
const all = ns.singularity.getOwnedAugmentations(true);
return { all, queued: all.length - ns.singularity.getOwnedAugmentations(false).length };
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

/** In plan order - most expensive first - stopping at the first refusal. */
const BUY = `
const bought = [];
for (const [f, a] of JSON.parse(args[0])) {
  if (!ns.singularity.purchaseAugmentation(f, a)) break;
  bought.push(a);
}
return bought;
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

function augsWaitLine(ns, plan, queued, cash) {
  if (queued >= MIN_AUG_BATCH) return `${queued} queued - install when ready; nothing more affordable now`;
  return `waiting: best batch is ${plan.batch} of ${MIN_AUG_BATCH} (${queued} queued), ` +
    `${plan.eligible} unlocked by rep, cash ${money$(ns, cash)}`;
}

function progsLine(ns, p) {
  if (p.bought.length) return `bought ${p.bought.join(", ")}${p.left ? ` - ${p.left} left` : ""}`;
  if (!p.left) return "every darkweb program owned";
  return `nothing bought: ${p.left} left, cheapest ${money$(ns, p.next)} against ` +
    `${money$(ns, p.money)} cash (buys at ${ns.format.percent(PROG_BUDGET_FRACTION, 0)})`;
}

function joinLine(invites, joined) {
  if (!invites.length) return "no pending invites";
  if (joined.length) return `accepted ${joined.join(", ")}`;
  const denied = invites.filter((f) => JOIN_DENY.includes(f));
  if (denied.length === invites.length) return `declined ${denied.join(", ")} (JOIN_DENY)`;
  return `the game refused ${invites.filter((f) => !denied.includes(f)).join(", ")}`;
}

function describe(ns, a, r, targets) {
  if (a.kind === "gym") return `gym ${a.stat} at ${a.gym}`;
  if (a.kind === "crime") {
    return `crime ${a.crime}, karma ${ns.format.number(r.player.karma, 2)} of ` +
      `${ns.format.number(GANG_KARMA_TARGET, 2)}`;
  }
  if (a.kind === "faction") {
    return `faction ${a.faction} (${a.type}), rep ${n2(ns, r.rep[a.faction] ?? 0)} of ` +
      `${n2(ns, repTarget(a.faction, targets))}`;
  }
  if (a.kind === "company") {
    return `company ${a.company} (${a.field}), company rep ${n2(ns, r.companyRep?.[a.company] ?? 0)}`;
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

  /**
   * Refresh the rep targets and buy a batch if one is due. Every read is its
   * own body - see the aug bodies above for why.
   */
  const augsPass = async (r) => {
    const owned = await call("owned", OWNED);
    if (!owned) return;
    const companies = WORK_ORDER.filter((s) => s.company).map((s) => s.company);
    const unread = [...new Set([...r.player.factions, ...companies])].filter((f) => !(f in augsOf));
    if (unread.length) Object.assign(augsOf, (await call("faction augs", FAC_AUGS, ...unread)) ?? {});
    const sold = [...new Set(Object.values(augsOf).flat())];
    const noPrereqs = sold.filter((a) => a !== NFG && !(a in prereqs));
    if (noPrereqs.length) Object.assign(prereqs, (await call("prereqs", PREREQ, ...noPrereqs)) ?? {});
    const unowned = sold.filter((a) => a === NFG || !owned.all.includes(a));
    const info = unowned.length ? await call("aug info", AUG_INFO, ...unowned) : {};
    if (!info) return;

    targets = repTargets(augsOf, owned.all, info);
    const cash = r.player.money;
    const plan = planAugBuys({ augsOf, owned: owned.all, queued: owned.queued, info, prereqs, rep: r.rep, cash });
    if (!plan.buys.length) {
      log(`augs: ${augsWaitLine(ns, plan, owned.queued, cash)}`);
      return;
    }
    const bought = (await call("buy", BUY, JSON.stringify(plan.buys.map((b) => [b.faction, b.name])))) ?? [];
    const line = `bought ${bought.length} of ${plan.buys.length} planned (${bought.join(", ")}) - ` +
      `${owned.queued + bought.length} queued, install when ready`;
    log(`augs: ${line}`);
    if (bought.length) ns.tprint(`sing: ${line}`);
    // What is left would be reset by the install; home RAM survives it.
    if (bought.length) {
      const u = await call("upgrade", UPGRADE, 1);
      if (u) log(`upgrade: ${upgradeLine(ns, u)}`);
    }
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
        const want = invites.filter((f) => !JOIN_DENY.includes(f));
        const joined = want.length ? (await call("join", JOIN, ...want)) ?? [] : [];
        log(`join: ${joinLine(invites, joined)}`);
      }
    }

    // Every tick. The action body runs only on a DIFFERENCE: restarting a crime
    // resets its progress, and one longer than the tick would never complete.
    // A flight skips this tick's work: r.player still says the old city, and the
    // gym is only where the player no longer is.
    const city = r && chooseTravel(r.player);
    const flew = city ? await call("travel", TRAVEL, city) : false;
    if (city) log(`travel: ${flew ? "flew" : "could not fly"} to ${city}`);
    if (r && !flew) {
      const action = chooseAction(r.player, { ...r, targets });
      const what = describe(ns, action, r, targets);
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

    tick++;
    await ns.sleep(SING_TICK_MS);
  }
}
