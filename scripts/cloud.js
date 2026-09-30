import { ROOT_MARKER, CLOUD_DONE_MARKER, CLOUD_STATUS_FILE, CLOUD_HISTORY_FILE, CLOUD_HISTORY_KEEP } from "./config.js";
import { SETTINGS_FILE, setting } from "./settings.js";

/**
 * Cloud server purchaser / upgrader.
 *
 * Spends at most the `cloud.cash` setting (settings.js) of current money on any single action, so it
 * never empties your account.
 *
 * Policy: fill empty server slots before upgrading anything.
 *   - Under the server limit  -> buy a new server at the largest affordable size
 *   - At the server limit     -> upgrade the SMALLEST server to the largest
 *                                affordable size
 * Buying is better value per dollar than upgrading (an upgrade only pays for the
 * difference in RAM but you already paid for the base), so slots come first.
 *
 * Naming: cheapserv-00, cheapserv-01, ... The first FREE index is chosen here
 * rather than letting the game pick. cloud.purchaseServer auto-appends a suffix
 * on a name collision instead of failing - asking for an existing "cheapserv-00"
 * silently yields "cheapserv-00-0", which would wreck the numbering.
 *
 * Does NOT copy worker scripts. A purchase stamps ROOT_MARKER instead, and
 * scripts/boot.js notices and runs deploy.js - which keeps ns.scp (0.60 GB) out
 * of this script. Upgrades keep their files, so they need nothing either way.
 *
 * ONE PASS, then exit - a transient, the sleeve.js shape. boot.js runs it once
 * per tick with runToCompletion, so nothing is held between passes. A pass keeps
 * acting while money covers another action: stopping at one would take a boot
 * tick per server on a fresh BitNode's empty fleet.
 *
 * A transient's ns.print dies with it, so the pass overwrites CLOUD_STATUS_FILE
 * with what it did and what it waits on, and appends the same lines, timestamped,
 * to CLOUD_HISTORY_FILE whenever it bought something or the gist changed. The
 * gist ignores $ figures: a "wait" line re-prices every pass as cash grows, and
 * would otherwise be a history line a minute. Nothing reaches the terminal but
 * the --budget usage error, which has to reach whoever typed the bad argument.
 *
 * Usage:  run scripts/cloud.js                 one pass, then exit
 *         run scripts/cloud.js --dry-run       show the plan, buy nothing, write nothing
 *         run scripts/cloud.js --budget 0.25   spend up to 25% instead of cloud.cash
 *         cat /data/cloud.txt                  the last pass
 *         cat /data/cloud.log.txt              what it bought, and what it waited on
 *
 * RAM: 1.60 base
 *      + cloud.getServerNames 1.05 + purchaseServer 2.25 + upgradeServer 0.25
 *      + getServerCost 0.25 + getServerUpgradeCost 0.10
 *      + getServerLimit 0.05 + getRamLimit 0.05
 *      + getServerMaxRam 0.05 + getServerMoneyAvailable 0.10
 *      = 5.75 GB     (print, args, ns.read/write and ns.format are 0)
 */

// ---------------------------------------------------------------- config ----

const NAME_PREFIX = "cheapserv-";

/** Smallest server worth owning. Below 2GB nothing useful runs. */
const MIN_RAM = 8;

const money = (ns, m) => `$${ns.format.number(m, 2)}`;

// ------------------------------------------------------------------ names ---

/**
 * Lowest unused cheapserv-NN index, zero padded to 2 digits.
 * Returns null if every slot up to the limit is taken.
 */
function nextFreeName(owned, limit) {
  const taken = new Set(owned);
  for (let i = 0; i < Math.max(limit, 100); i++) {
    const name = NAME_PREFIX + String(i).padStart(2, "0");
    if (!taken.has(name)) return name;
  }
  return null;
}

// ------------------------------------------------------------- sizing ------

/**
 * Largest power-of-2 RAM whose cost fits the budget.
 *
 * Walks down from the game's RAM limit rather than up, so it always lands on the
 * biggest affordable tier in one pass.
 *
 * @param {(ram: number) => number} costFn  cost for a given RAM, Infinity/-1 if invalid
 * @returns {{ram: number, cost: number}|null}
 */
function largestAffordable(costFn, budget, ramLimit, minRam = MIN_RAM) {
  for (let ram = ramLimit; ram >= minRam; ram /= 2) {
    const cost = costFn(ram);
    // getServerCost returns Infinity and getServerUpgradeCost returns -1 for
    // invalid input; treat both as "not available at this size".
    if (!Number.isFinite(cost) || cost < 0) continue;
    if (cost <= budget) return { ram, cost };
  }
  return null;
}

// -------------------------------------------------------------- one step ----

/**
 * Decide and perform at most ONE action.
 * @returns {{acted: boolean, done: boolean, msg: string}}
 *          done=true means nothing further is possible (fully maxed out)
 */
function step(ns, budgetFraction, dryRun) {
  const cash = ns.getServerMoneyAvailable("home");
  const budget = cash * budgetFraction;
  const limit = ns.cloud.getServerLimit();
  const ramLimit = ns.cloud.getRamLimit();
  const owned = ns.cloud.getServerNames();

  // ---- buy a new server while slots remain --------------------------------
  if (owned.length < limit) {
    const pick = largestAffordable((r) => ns.cloud.getServerCost(r), budget, ramLimit);
    if (!pick) {
      // The cash that makes the budget cover it: the wait line is logged once,
      // so it has to say when it will stop being true.
      const cost = ns.cloud.getServerCost(MIN_RAM);
      return {
        acted: false,
        done: false,
        msg:
          `wait: ${money(ns, budget)} budget (${ns.format.percent(budgetFraction, 0)} of ` +
          `${money(ns, cash)}) < ${money(ns, cost)} for the ` +
          `smallest ${ns.format.ram(MIN_RAM)} server (slot ${owned.length + 1}/${limit}) - needs ${money(ns, cost / budgetFraction)} cash`,
      };
    }

    const name = nextFreeName(owned, limit);
    if (!name) {
      return { acted: false, done: false, msg: `no free ${NAME_PREFIX}NN name below the limit` };
    }

    if (dryRun) {
      return {
        acted: false,
        done: false,
        msg: `WOULD BUY ${name} @ ${ns.format.ram(pick.ram)} for ${money(ns, pick.cost)} ` +
          `(slot ${owned.length + 1}/${limit})`,
      };
    }

    const got = ns.cloud.purchaseServer(name, pick.ram);
    if (!got) {
      return { acted: false, done: false, msg: `purchaseServer("${name}", ${pick.ram}) failed` };
    }

    // The game renames on collision rather than failing - surface it if it did.
    const renamed = got !== name ? `  (game renamed from ${name})` : "";

    // A new server is empty, and without workers the batcher's exec just
    // returns 0. Copying is scripts/deploy.js's job, so stamp the marker
    // boot.js polls and let it deploy - that keeps scp (0.60 GB) out of this
    // script entirely. Until that happens the pool skips hosts with no worker
    // files, so an undeployed server is idle rather than broken.
    ns.write(ROOT_MARKER, `${Date.now()}\nbought ${got}`, "w");

    return {
      acted: true,
      done: false,
      msg:
        `BOUGHT ${got} @ ${ns.format.ram(pick.ram)} for ${money(ns, pick.cost)} ` +
        `(slot ${owned.length + 1}/${limit})${renamed}  workers queued for deploy`,
    };
  }

  // ---- at the slot limit: upgrade the smallest ----------------------------
  let smallest = null;
  for (const host of owned) {
    const ram = ns.getServerMaxRam(host);
    if (!smallest || ram < smallest.ram) smallest = { host, ram };
  }

  if (!smallest) return { acted: false, done: true, msg: "no cloud servers to upgrade" };

  if (smallest.ram >= ramLimit) {
    return {
      acted: false,
      done: true,
      msg: `all ${owned.length} server(s) at the ${ns.format.ram(ramLimit)} maximum - nothing left to buy`,
    };
  }

  // Only sizes strictly larger than what it already has are upgrades.
  const pick = largestAffordable(
    (r) => ns.cloud.getServerUpgradeCost(smallest.host, r),
    budget,
    ramLimit,
    smallest.ram * 2,
  );

  if (!pick) {
    const next = ns.cloud.getServerUpgradeCost(smallest.host, smallest.ram * 2);
    return {
      acted: false,
      done: false,
      msg:
        `wait: ${money(ns, budget)} budget < ${money(ns, next)} to take ${smallest.host} ` +
        `from ${ns.format.ram(smallest.ram)} to ${ns.format.ram(smallest.ram * 2)} - needs ${money(ns, next / budgetFraction)} cash`,
    };
  }

  if (dryRun) {
    return {
      acted: false,
      done: false,
      msg:
        `WOULD UPGRADE ${smallest.host} ${ns.format.ram(smallest.ram)} -> ${ns.format.ram(pick.ram)} ` +
        `for ${money(ns, pick.cost)}`,
    };
  }

  const ok = ns.cloud.upgradeServer(smallest.host, pick.ram);
  return {
    acted: ok,
    done: false,
    msg: ok
      ? `UPGRADED ${smallest.host} ${ns.format.ram(smallest.ram)} -> ${ns.format.ram(pick.ram)} ` +
        `for ${money(ns, pick.cost)}`
      : `upgradeServer(${smallest.host}, ${pick.ram}) returned false`,
  };
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const args = ns.args.map(String);
  const dryRun = args.includes("--dry-run");

  // --budget pins the fraction for this run; otherwise it is the live
  // `cloud.cash` setting, read once per pass so scripts/set.js needs no restart.
  const bIdx = args.indexOf("--budget");
  let fraction = setting(ns.read(SETTINGS_FILE), "cloud.cash");
  if (bIdx >= 0) {
    const v = Number(args[bIdx + 1]);
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
      ns.tprint(`ERROR: --budget needs a fraction in (0,1], got "${args[bIdx + 1]}"`);
      return;
    }
    fraction = v;
  }

  // Any run of this script re-evaluates from scratch, so a marker left by an
  // earlier run is worthless from here on. Clear it first and re-stamp only if
  // we actually reach the terminal state - never leave a stale "maxed" claim
  // behind after buying or upgrading something.
  if (!dryRun) ns.write(CLOUD_DONE_MARKER, "", "w");

  // Act until one step does not: each action spends money, so the budget -
  // a fraction of what is LEFT - shrinks until nothing more fits. A dry run
  // never acts, so it plans exactly one step.
  const lines = [];
  let r;
  do {
    r = step(ns, fraction, dryRun);
    lines.push(r.msg);
  } while (r.acted);

  // Survives exit under "Recently killed", and a hand-run with a tail shows it.
  for (const l of lines) ns.print(`cloud: ${l}`);
  if (dryRun) return;

  // Stamp the terminal state so boot.js stops re-running a pass that can only
  // say "maxed" again.
  if (r.done) ns.write(CLOUD_DONE_MARKER, `${Date.now()}\n${r.msg}`, "w");

  const status = lines.join("\n");
  const gist = (s) => s.trim().replace(/\$\S+/g, "$");
  const before = ns.read(CLOUD_STATUS_FILE);
  ns.write(CLOUD_STATUS_FILE, status + "\n", "w");
  if (lines.length > 1 || gist(status) !== gist(before)) {
    const stamp = new Date().toLocaleString();
    const kept = ns.read(CLOUD_HISTORY_FILE).split("\n").filter(Boolean);
    const all = [...kept, ...lines.map((l) => `${stamp}  ${l}`)].slice(-CLOUD_HISTORY_KEEP);
    ns.write(CLOUD_HISTORY_FILE, all.join("\n") + "\n", "w");
  }
}
