import { planMoney } from "./math.js";
import { HACKNET_CASH_FRACTION, PAYBACK_SECONDS, HASH_PRICE } from "./config.js";

/**
 * The hacknet money sweep: ONE pass, then exit.
 *
 * WHY A TRANSIENT, NOT A SERVICE, AND NOT AN RPC ENTRY. boot.js runs this every
 * HACKNET_EVERY ticks the way it runs contracts.js, so nothing is held between
 * sweeps. rpc.js would be the obvious shape given 21 ns.hacknet names at 0.50
 * GB each - but rpc only pays for a RESIDENT script: an entry process sits at
 * 2.60 GB (1.60 + ns.run) UNDERNEATH every body for the body's whole life, and
 * this script lives a few hundred milliseconds. Measured, two plain files peak
 * at 6.60 GB against 9.40 for an entry plus two bodies.
 *
 * WHY THIS FILE AND hashes.js ARE SEPARATE. RAM bills NAMES, not call sites. A
 * single file would carry ~4.50 GB of hash-only names for the entire pre-BitNode
 * 9 game, where they can do nothing.
 *
 * WHY NO get*UpgradeCost CALLS. Five of them at 0.50 GB each, and every one is
 * a pure function of (stat, count, costMult). The ladders are transcribed in
 * math.js at 0 GB and the four cost multipliers arrive from one
 * ns.getHacknetMultipliers() at 0.25.
 *
 * NAMES. Every ns.hacknet function is 0.50 GB as a bare identifier, so nothing
 * in this file or in math.js may be named after one. See tests/ram.test.mjs.
 *
 * Usage:  run scripts/hacknet/hacknet.js              (one sweep; boot does this)
 *         run scripts/hacknet/hacknet.js --dry-run    (plan and print, buy nothing)
 *
 * RAM: 1.60 base + numNodes/getNodeStats/purchaseNode/upgradeLevel/upgradeRam/
 *      upgradeCore/maxNumNodes 3.50 + getHacknetMultipliers 0.25
 *      + getServerMoneyAvailable 0.10 = 5.45 GB
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const log = (s) => ns.print(`${new Date().toLocaleTimeString()}  ${s}`);
  const dry = ns.args.map(String).includes("--dry-run");

  // Infinity for nodes, 20 for servers, straight off hasHacknetServers(). The
  // only reading that works with nothing owned - and with nothing owned the two
  // branches buy different things at different prices.
  const isServer = ns.hacknet.maxNumNodes() !== Infinity;
  const owned = ns.hacknet.numNodes();

  const units = [];
  for (let i = 0; i < owned; i++) {
    const s = ns.hacknet.getNodeStats(i);
    units.push({
      level: s.level,
      // getNodeStats reports maxRam in `ram` for a server, and `ramUsed` only
      // for one.
      ram: s.ram,
      cores: s.cores,
      // Defaulted so the node branch never reads undefined.
      cache: s.cache ?? 1,
      used: s.ramUsed ?? 0,
      // Money per second for a node, HASHES per second for a server.
      production: s.production,
    });
  }

  const money = ns.getServerMoneyAvailable("home");
  const budget = money * HACKNET_CASH_FRACTION;
  const mults = ns.getHacknetMultipliers();

  const plan = planMoney(
    { isServer, units, budget, mults },
    { PAYBACK_SECONDS, HASH_PRICE });

  if (!plan.buys.length) {
    // A sweep that buys nothing says WHY, with the figures. "0 bought" is the
    // ordinary state once the batcher is large and would otherwise be unreadable.
    log(`no buys: ${plan.reason} (budget $${ns.format.number(budget, 2)} of ` +
        `$${ns.format.number(money, 2)}, ${owned} ${isServer ? "server" : "node"}(s))`);
    return;
  }

  if (dry) {
    for (const buy of plan.buys) {
      log(`would buy ${buy.kind}${buy.index >= 0 ? ` on #${buy.index}` : ""} ` +
          `for $${ns.format.number(buy.price, 2)}`);
    }
    log(`dry run: ${plan.buys.length} buy(s), $${ns.format.number(plan.spent, 2)} of a ` +
        `$${ns.format.number(budget, 2)} budget - ${plan.reason}`);
    return;
  }

  let done = 0;
  let spent = 0;
  for (const buy of plan.buys) {
    // Each returns false when the game disagrees - most often because cash
    // moved between the plan and the purchase, cloud.js and sing bidding for
    // the same wallet. Not an error: the next sweep re-plans against the truth.
    const ok =
      buy.kind === "unit" ? ns.hacknet.purchaseNode() !== -1 :
      buy.kind === "level" ? ns.hacknet.upgradeLevel(buy.index, 1) :
      buy.kind === "ram" ? ns.hacknet.upgradeRam(buy.index, 1) :
      buy.kind === "core" ? ns.hacknet.upgradeCore(buy.index, 1) :
      false;
    if (!ok) {
      log(`WARN: ${buy.kind}${buy.index >= 0 ? ` on #${buy.index}` : ""} was refused at ` +
          `$${ns.format.number(buy.price, 2)} - replanning next sweep`);
      break;
    }
    done++;
    spent += buy.price;
  }

  log(`bought ${done} of ${plan.buys.length} for $${ns.format.number(spent, 2)} ` +
      `of a $${ns.format.number(budget, 2)} budget - ${plan.reason}`);
}
