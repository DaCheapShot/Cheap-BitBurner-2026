import { planHashes } from "./math.js";
import {
  TARGETS_MARKER,
  HASH_PRICE, HASH_SALE_COST, HASH_HORIZON_S, HASH_VALUE_MARGIN, MONEY_SOFTCAP,
  MAX_MONEY_UPGRADE, MIN_SECURITY_UPGRADE, SELL_MONEY_UPGRADE,
} from "./config.js";
import { SETTINGS_FILE, setting, settingsLog } from "scripts/settings.js";

/**
 * The hash sweep: ONE pass, then exit. A no-op outside BitNode 9.
 *
 * WHY IT IS A SEPARATE FILE FROM hacknet.js. RAM bills NAMES, not call sites.
 * Seven of the nine hacknet names below are ones the money sweep never needs
 * (numNodes and getNodeStats are in both), so folding the two files together
 * would cost 3.50 GB for the whole pre-BitNode-9 game, where hashCapacity() is
 * 0 and they can do nothing. Split, this exits in about 20 ms having paid for
 * one read.
 *
 * WHY REFUSING EVERY CANDIDATE IS STILL CORRECT, AND WHAT IT DOES NOT COVER.
 * The OVERFLOW is auto-sold at exactly HASH_PRICE -
 * processAllHacknetServerEarnings computes
 * `wastedHashes / upgrade.cost * upgrade.value`, the same rate as buying Sell
 * for Money by hand - so no upgrade is worth buying unless it beats that rate,
 * and the only ones worth buying are the ones that are NOT money.
 *
 * But only the overflow. storeHashes() caps the balance at capacity and pays
 * out just the remainder, so everything at or BELOW capacity sits, and a
 * hacknet server's capacity is `32 * 2^cache` - 64 hashes, $16m a server,
 * parked for as long as nothing spends it. That is the whole of a fresh
 * BitNode 9's first prep, when no manager has published a target yet. So the
 * sweep sells when nothing is worth buying, at the same rate, and the balance
 * is only held when a real purchase is being saved for.
 *
 * WHY THE TARGETS COME FROM A FILE. Increase Maximum Money and Reduce Minimum
 * Security only pay on a server the batcher is actually hitting, and which
 * batcher is up is the user's choice. Whichever manager runs publishes its own
 * list; boot clears it when none survives a swap. Missing or empty means spend
 * nothing, never a default.
 *
 * Usage:  run scripts/hacknet/hashes.js              (one sweep; boot does this)
 *         run scripts/hacknet/hashes.js --dry-run    (plan and print, spend nothing)
 *
 * RAM: 1.60 base + numNodes/getNodeStats/numHashes/hashCapacity/hashCost/
 *      getHashUpgradeLevel/getHashUpgrades/spendHashes/upgradeCache 4.50
 *      + getServerMoneyAvailable/getServerMaxMoney/getServerMinSecurityLevel/
 *        getServerRequiredHackingLevel/getTotalScriptIncome 0.50 = 6.60 GB
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const log = (s) => ns.print(`${new Date().toLocaleTimeString()}  ${s}`);
  const news = settingsLog(null, ns.read(SETTINGS_FILE), "hacknet.");
  if (news) log(news);
  const dry = ns.args.map(String).includes("--dry-run");

  // hashCapacity() returns 0 without hacknet servers, which is every BitNode
  // but 9 (and SF9 elsewhere). Nothing below can do anything there.
  const capacity = ns.hacknet.hashCapacity();
  if (capacity <= 0) return;

  // Asked, not assumed. spendHashes resolves the name through
  // getEnumHelper().nsGetMember and THROWS on a miss, so a fork that renames an
  // upgrade would take the sweep down; this turns it into one log line.
  const offered = new Set(ns.hacknet.getHashUpgrades());
  for (const name of [MAX_MONEY_UPGRADE, MIN_SECURITY_UPGRADE, SELL_MONEY_UPGRADE]) {
    if (!offered.has(name)) {
      log(`WARN: this fork does not offer "${name}" - nothing to spend hashes on`);
      return;
    }
  }

  // NO EARLY RETURN on an empty list. There is nothing to BUY without targets,
  // but the hashes already in the store are still worth selling - and that is
  // exactly the state a fresh BitNode 9 sits in for its whole first prep, with
  // the hacknet producing and no manager having rescanned yet. planHashes
  // decides; this reads the file and hands it over either way.
  const hosts = ns.read(TARGETS_MARKER).split("\n").map((s) => s.trim()).filter(Boolean);

  const targets = hosts.map((host) => ({
    host,
    moneyMax: ns.getServerMaxMoney(host),
    // MINIMUM security, not current: a streaming target sits at its minimum,
    // and changeMinimumSecurity moves only that.
    minSec: ns.getServerMinSecurityLevel(host),
    reqSkill: ns.getServerRequiredHackingLevel(host),
  }));

  // costPerLevel is derived rather than hardcoded: hashCost(name, 1) at level L
  // is costPerLevel * (L+1), so one live read keeps the constant current if the
  // fork ever retunes it.
  const levels = {};
  const perLevel = {};
  for (const name of [MAX_MONEY_UPGRADE, MIN_SECURITY_UPGRADE]) {
    levels[name] = ns.hacknet.getHashUpgradeLevel(name);
    perLevel[name] = ns.hacknet.hashCost(name, 1) / (levels[name] + 1);
  }

  const owned = ns.hacknet.numNodes();
  const units = [];
  for (let i = 0; i < owned; i++) {
    units.push({ index: i, cache: ns.hacknet.getNodeStats(i).cache ?? 1 });
  }

  const inc = ns.getTotalScriptIncome();
  // [0] sums onlineMoneyMade/onlineRunningTime over scripts running RIGHT NOW
  // (NetscriptFunctions.ts) - and the batcher is just-in-time, so hack.js
  // credits its money and exits microseconds later. [0] is therefore dominated
  // by zeros and reads one to two orders of magnitude low. [1] is
  // scriptProdSinceLastAug / (playtimeSinceLastAug/1000), a real $/s rate - it
  // averages in the pre-ramp period too, so it UNDERSTATES, which is the safe
  // direction every other estimate in this module already leans. Take the
  // larger of the two rather than trusting [0] alone.
  const income = Math.max(inc[0], inc[1]);

  const plan = planHashes(
    {
      hashes: ns.hacknet.numHashes(),
      capacity,
      levels, perLevel, income, targets, units,
      budget: ns.getServerMoneyAvailable("home") * setting(ns.read(SETTINGS_FILE), "hacknet.cash"),
      // Only the cache ladder is read out of this, and it is the one ladder
      // that takes no cost multiplier - passed for the shared signature.
      mults: { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 },
    },
    {
      HASH_PRICE, HASH_SALE_COST, HASH_HORIZON_S, HASH_VALUE_MARGIN, MONEY_SOFTCAP,
      MAX_MONEY_UPGRADE, MIN_SECURITY_UPGRADE,
    });

  if (dry) {
    for (const s of plan.spends) {
      log(`would spend ${s.hashes} hashes: ${s.upgrade} x${s.count} on ${s.host}`);
    }
    if (plan.cacheBuy) log(`would upgrade cache on #${plan.cacheBuy.index} for $${ns.format.number(plan.cacheBuy.price, 2)}`);
    if (plan.sell) {
      log(`would sell ${plan.sell * HASH_SALE_COST} hashes for ` +
          `$${ns.format.number(plan.sell * HASH_SALE_COST * HASH_PRICE, 2)}`);
    }
    log(`dry run: ${plan.reason} (income $${ns.format.number(income, 2)}/s over ` +
        `${targets.length} target(s))`);
    return;
  }

  let spent = 0;
  let sold = 0;
  for (const s of plan.spends) {
    // One call per pair: raising max money and lowering minimum security both
    // put a streaming target off baseline, so the re-prep is paid once here
    // rather than once per level.
    if (ns.hacknet.spendHashes(s.upgrade, s.host, s.count)) {
      spent += s.hashes;
      log(`${s.upgrade} x${s.count} on ${s.host} for ${s.hashes} hashes ` +
          `($${ns.format.number(s.hashes * HASH_PRICE, 2)} of forgone sales)`);
    } else {
      // Refused for a reason the plan could not see - most often the target
      // stopped being foreign, which is the only ownership the two
      // server-targeted upgrades accept.
      log(`WARN: ${s.upgrade} on ${s.host} was refused`);
    }
  }

  if (plan.cacheBuy) {
    const ok = ns.hacknet.upgradeCache(plan.cacheBuy.index, 1);
    log(ok
      ? `cache up on #${plan.cacheBuy.index} for $${ns.format.number(plan.cacheBuy.price, 2)} - ${plan.reason}`
      : `WARN: cache upgrade on #${plan.cacheBuy.index} was refused`);
  }

  // The fallback, and the reason the no-targets case no longer returns early:
  // hashes at or below capacity are never auto-sold, so with nothing to buy
  // they sit. One call, whatever the count - Sell for Money takes a count and
  // pays value * count, and its cost is flat, so there is no ladder to walk.
  if (plan.sell > 0) {
    const hashes = plan.sell * HASH_SALE_COST;
    if (ns.hacknet.spendHashes(SELL_MONEY_UPGRADE, "", plan.sell)) {
      sold = hashes;
      log(`sold ${hashes} hashes for $${ns.format.number(hashes * HASH_PRICE, 2)} - ${plan.reason}`);
    } else {
      // The balance moved between the plan and the call - the game credits
      // production continuously, so this can only ever be a stale read down.
      log(`WARN: selling ${hashes} hashes was refused - replanning next sweep`);
    }
  }

  if (!plan.spends.length && !plan.cacheBuy && !sold) {
    // 2 fractional digits, never 0: isInteger suppresses decimals only BELOW
    // suffixStart, so (n, 0, 1000, true) prints both 1.6m and 2.05m as "2m".
    // A live gang log read `respect 2m (next recruit at 2m)` while 450k short.
    log(`no spend: ${plan.reason} (income $${ns.format.number(income, 2)}/s over ` +
        `${targets.length} target(s), ${ns.format.number(capacity, 2, 1000, true)} capacity)`);
  } else if (spent) {
    log(`spent ${spent} hashes - ${plan.reason}`);
  }
}
