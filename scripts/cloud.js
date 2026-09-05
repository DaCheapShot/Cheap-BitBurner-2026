import { ROOT_MARKER, CLOUD_DONE_MARKER } from "./config.js";

/**
 * Cloud server purchaser / upgrader.
 *
 * Spends at most BUDGET_FRACTION of current money on any single action, so it
 * can be left running without ever emptying your account.
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
 * Usage:  run scripts/cloud.js                 one action, then exit
 *         run scripts/cloud.js --dry-run       show the plan, buy nothing
 *         run scripts/cloud.js --loop          keep going as money accumulates
 *         run scripts/cloud.js --loop 30000    ...checking every 30s
 *         run scripts/cloud.js --budget 0.25   spend up to 25% instead of 10%
 *
 * RAM: 1.60 base
 *      + cloud.getServerNames 1.05 + purchaseServer 2.25 + upgradeServer 0.25
 *      + getServerCost 0.25 + getServerUpgradeCost 0.10
 *      + getServerLimit 0.05 + getRamLimit 0.05
 *      + getServerMaxRam 0.05 + getServerMoneyAvailable 0.10
 *      = 5.75 GB     (sleep, print, args and ns.write are 0)
 */

// ---------------------------------------------------------------- config ----

/** Hard cap on what one purchase or upgrade may cost, as a fraction of money. */
const BUDGET_FRACTION = 0.10;

const NAME_PREFIX = "cheapserv-";

/** Smallest server worth owning. Below 2GB nothing useful runs. */
const MIN_RAM = 2;

const DEFAULT_LOOP_MS = 60000;

// ---------------------------------------------------------------- format ----

function fmtMoney(m) {
  if (!Number.isFinite(m)) return "$inf";
  for (const [div, suf] of [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]]) {
    if (Math.abs(m) >= div) return `$${(m / div).toFixed(2)}${suf}`;
  }
  return `$${m.toFixed(0)}`;
}

const fmtRam = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(0)}TB` : `${gb}GB`);

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

// -------------------------------------------------------------- one pass ----

/**
 * Decide and perform at most ONE action.
 * @returns {{acted: boolean, done: boolean, msg: string}}
 *          done=true means nothing further is possible (fully maxed out)
 */
function step(ns, budgetFraction, dryRun) {
  const money = ns.getServerMoneyAvailable("home");
  const budget = money * budgetFraction;
  const limit = ns.cloud.getServerLimit();
  const ramLimit = ns.cloud.getRamLimit();
  const owned = ns.cloud.getServerNames();

  // ---- buy a new server while slots remain --------------------------------
  if (owned.length < limit) {
    const pick = largestAffordable((r) => ns.cloud.getServerCost(r), budget, ramLimit);
    if (!pick) {
      return {
        acted: false,
        done: false,
        msg:
          `wait: ${fmtMoney(budget)} budget (${(budgetFraction * 100).toFixed(0)}% of ` +
          `${fmtMoney(money)}) < ${fmtMoney(ns.cloud.getServerCost(MIN_RAM))} for the ` +
          `smallest ${fmtRam(MIN_RAM)} server`,
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
        msg: `WOULD BUY ${name} @ ${fmtRam(pick.ram)} for ${fmtMoney(pick.cost)} ` +
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
        `BOUGHT ${got} @ ${fmtRam(pick.ram)} for ${fmtMoney(pick.cost)} ` +
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
      msg: `all ${owned.length} server(s) at the ${fmtRam(ramLimit)} maximum - nothing left to buy`,
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
        `wait: ${fmtMoney(budget)} budget < ${fmtMoney(next)} to take ${smallest.host} ` +
        `from ${fmtRam(smallest.ram)} to ${fmtRam(smallest.ram * 2)}`,
    };
  }

  if (dryRun) {
    return {
      acted: false,
      done: false,
      msg:
        `WOULD UPGRADE ${smallest.host} ${fmtRam(smallest.ram)} -> ${fmtRam(pick.ram)} ` +
        `for ${fmtMoney(pick.cost)}`,
    };
  }

  const ok = ns.cloud.upgradeServer(smallest.host, pick.ram);
  return {
    acted: ok,
    done: false,
    msg: ok
      ? `UPGRADED ${smallest.host} ${fmtRam(smallest.ram)} -> ${fmtRam(pick.ram)} ` +
        `for ${fmtMoney(pick.cost)}`
      : `upgradeServer(${smallest.host}, ${pick.ram}) returned false`,
  };
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const args = ns.args.map(String);
  const dryRun = args.includes("--dry-run");
  const loop = args.includes("--loop");

  const lIdx = args.indexOf("--loop");
  const loopMs = lIdx >= 0 && Number(args[lIdx + 1]) > 0 ? Number(args[lIdx + 1]) : DEFAULT_LOOP_MS;

  const bIdx = args.indexOf("--budget");
  let budgetFraction = BUDGET_FRACTION;
  if (bIdx >= 0) {
    const v = Number(args[bIdx + 1]);
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
      ns.tprint(`ERROR: --budget needs a fraction in (0,1], got "${args[bIdx + 1]}"`);
      return;
    }
    budgetFraction = v;
  }

  // Any run of this script re-evaluates from scratch, so a marker left by an
  // earlier run is worthless from here on. Clear it first and re-stamp only if
  // we actually reach the terminal state - never leave a stale "maxed" claim
  // behind after buying or upgrading something.
  if (!dryRun) ns.write(CLOUD_DONE_MARKER, "", "w");

  if (!loop) {
    const r = step(ns, budgetFraction, dryRun);
    if (r.done && !dryRun) ns.write(CLOUD_DONE_MARKER, `${Date.now()}\n${r.msg}`, "w");
    ns.tprint(`cloud: ${r.msg}`);
    return;
  }

  ns.ui.openTail();
  ns.print(
    `cloud loop: up to ${(budgetFraction * 100).toFixed(0)}% of money per action, ` +
      `checking every ${(loopMs / 1000).toFixed(0)}s${dryRun ? " [DRY RUN]" : ""}`,
  );

  let lastMsg = "";
  while (true) {
    const r = step(ns, budgetFraction, dryRun);

    // "wait:" lines repeat every tick while money accumulates - only print on
    // change so the log stays readable over hours.
    if (r.acted || r.msg !== lastMsg) {
      ns.print(r.msg);
      lastMsg = r.msg;
    }

    if (r.done) {
      // Nothing left to buy or upgrade. Stamp it so boot.js stops relaunching
      // this every tick just to watch it exit again.
      if (!dryRun) ns.write(CLOUD_DONE_MARKER, `${Date.now()}\n${r.msg}`, "w");
      ns.tprint(`cloud: ${r.msg}`);
      return;
    }

    // After a successful buy/upgrade, try again immediately - money may still
    // cover another action.
    await ns.sleep(r.acted ? 200 : loopMs);
  }
}
