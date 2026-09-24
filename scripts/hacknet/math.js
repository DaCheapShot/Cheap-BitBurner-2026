/**
 * Every hacknet decision, and no ns call anywhere in it.
 *
 * WHY THE COST LADDERS ARE TRANSCRIBED. ns.hacknet.getLevelUpgradeCost,
 * getRamUpgradeCost, getCoreUpgradeCost, getCacheUpgradeCost and
 * getPurchaseNodeCost are 0.50 GB each - 2.50 GB - and every one is a pure
 * function of (stat, count, costMult). The four cost multipliers come from a
 * single ns.getHacknetMultipliers() at 0.25 GB, so transcribing the ladders
 * here trades the money sweep's four cost functions (2.00) for that one read -
 * 1.75 net - and saves the hash sweep getCacheUpgradeCost (0.50), which is
 * 2.25 GB across the two entries, and makes them testable besides. This is the
 * same trade gang/math.js makes with the gain formulas.
 *
 * Transcribed line for line from src/Hacknet/formulas/HacknetNodes.ts and
 * HacknetServers.ts, constants from src/Hacknet/data/Constants.ts.
 *
 * NAMES. ns.hacknet has 21 functions at 0.50 GB each and this file is imported
 * by both entries, so a local named `upgradeLevel`, `getNodeStats`, `hashCost`
 * or `numNodes` would be charged twice. Upgrade kinds are the string literals
 * "level" | "ram" | "core" | "cache" for that reason. `level`, `ram`, `cores`,
 * `cache` and `production` are free and are used freely.
 *
 * A `unit` throughout is { level, ram, cores, cache, used, production } - what
 * getNodeStats returns, with `ram` holding maxRam and `cache`/`used` present
 * only for servers.
 */

/** src/Hacknet/data/Constants.ts, HacknetNodeConstants. */
export const NODE = {
  base: 1000, purchaseMult: 1.85, maxUnits: Infinity,
  levelBase: 500, levelMult: 1.04, maxLevel: 200,
  ramBase: 30e3, ramMult: 1.28, maxRam: 64,
  coreBase: 500e3, coreMult: 1.48, maxCores: 16,
  // The exponent of the level ladder starts one BELOW the current level here,
  // and AT it for servers. Both are as written; see levelPrice.
  levelOffset: -1,
};

/** src/Hacknet/data/Constants.ts, HacknetServerConstants. */
export const SERVER = {
  base: 50e3, purchaseMult: 3.2, maxUnits: 20,
  // calculateLevelUpgradeCost returns `10 * BaseCost * total * costMult`, so
  // the base of the level ladder is ten times the purchase base.
  levelBase: 10 * 50e3, levelMult: 1.1, maxLevel: 300,
  ramBase: 200e3, ramMult: 1.4, maxRam: 8192,
  coreBase: 1e6, coreMult: 1.55, maxCores: 128,
  cacheBase: 10e6, cacheMult: 1.85, maxCache: 15,
  levelOffset: 0,
};

const ladderOf = (isServer) => (isServer ? SERVER : NODE);

function levelPrice(K, start, count, costMult) {
  if (start + count > K.maxLevel) return Infinity;
  let total = 0;
  let cur = start + K.levelOffset;
  for (let i = 0; i < count; i++) {
    total += Math.pow(K.levelMult, cur);
    cur++;
  }
  return K.levelBase * total * costMult;
}

function ramPrice(K, start, count, costMult) {
  if (start * Math.pow(2, count) > K.maxRam) return Infinity;
  let total = 0;
  // The ladder is indexed by how many times RAM has already been DOUBLED, not
  // by the RAM itself, and both terms move per step.
  let doublings = Math.round(Math.log2(start));
  let cur = start;
  for (let i = 0; i < count; i++) {
    total += cur * K.ramBase * Math.pow(K.ramMult, doublings);
    cur *= 2;
    doublings++;
  }
  return total * costMult;
}

function corePrice(K, start, count, costMult) {
  if (start + count > K.maxCores) return Infinity;
  let total = 0;
  let cur = start;
  for (let i = 0; i < count; i++) {
    total += Math.pow(K.coreMult, cur - 1);
    cur++;
  }
  return K.coreBase * total * costMult;
}

function cachePrice(start, count) {
  if (start + count > SERVER.maxCache) return Infinity;
  let total = 0;
  let cur = start;
  for (let i = 0; i < count; i++) {
    total += Math.pow(SERVER.cacheMult, cur - 1);
    cur++;
  }
  // No cost multiplier: calculateCacheUpgradeCost takes no costMult argument at
  // all, unlike every other ladder here.
  return SERVER.cacheBase * total;
}

/** Cost of the next node or server, given how many are owned now. */
export function unitPrice(isServer, owned, mults) {
  const K = ladderOf(isServer);
  if (owned >= K.maxUnits) return Infinity;
  return K.base * Math.pow(K.purchaseMult, owned) * mults.purchaseCost;
}

/** Cost of ONE upgrade of `kind` on `unit`. Infinity at the maximum. */
export function stepPrice(isServer, kind, unit, mults) {
  const K = ladderOf(isServer);
  if (kind === "level") return levelPrice(K, unit.level, 1, mults.levelCost);
  if (kind === "ram") return ramPrice(K, unit.ram, 1, mults.ramCost);
  if (kind === "core") return corePrice(K, unit.cores, 1, mults.coreCost);
  if (kind === "cache") return isServer ? cachePrice(unit.cache, 1) : Infinity;
  return Infinity;
}

// ------------------------------------------------------------------ gain ---
//
// node   production = level*1.5   * 1.035^(ram-1)     * ((cores+5)/6)   * mult * bnMult
// server hashRate   = level*0.001 * 1.07^log2(maxRam) * (1+(cores-1)/5) * ramRatio * mult * bnMult
//
// Every upgrade's effect is an INDEPENDENT MULTIPLICATIVE FACTOR, so the gain
// of any one of them is a ratio applied to the production getNodeStats already
// reports. `mult` and `bnMult` appear in both the before and the after and
// cancel - which is why nothing here reads ns.getHacknetMultipliers().production,
// ns.formulas.hacknetNodes.* (Formulas.exe) or ns.getBitNodeMultipliers (4.00 GB).

/** Δ production from ONE upgrade of `kind`. Cache moves capacity, not rate. */
export function stepGain(isServer, kind, unit) {
  const p = unit.production;
  if (kind === "level") return p / unit.level;
  // (cores+5)/6 for a node, 1+(cores-1)/5 for a server: the +1 step is a
  // sixth and a fifth of the respective base, which is where the 5 and 4 below
  // come from.
  if (kind === "core") return p / (unit.cores + (isServer ? 4 : 5));
  if (kind === "ram") {
    if (!isServer) return p * (Math.pow(1.035, unit.ram) - 1);
    // Doubling maxRam moves the 1.07 ladder AND the used-RAM penalty, since
    // ramUsed stays put while maxRam doubles. With hacknet servers kept out of
    // the pool `used` is 0 and this is exactly 1.07.
    const used = unit.used ?? 0;
    const before = 1 - used / unit.ram;
    if (before <= 0) return 0;
    const after = 1 - used / (2 * unit.ram);
    return p * ((1.07 * after) / before - 1);
  }
  return 0;
}

/**
 * Production of a brand new unit, derived from an owned one.
 *
 * Divides the owned unit's reported production by its own factors, leaving the
 * constant term - which IS a fresh unit's rate, since every factor is 1 at
 * level 1, ram 1, cores 1 and nothing running. With nothing owned there is no
 * reference and the caller buys the first unit unconditionally instead.
 */
export function freshProduction(isServer, unit) {
  if (!isServer) {
    return unit.production /
      (unit.level * Math.pow(1.035, unit.ram - 1) * ((unit.cores + 5) / 6));
  }
  const used = unit.used ?? 0;
  const ratio = 1 - used / unit.ram;
  if (ratio <= 0) return 0;
  return unit.production /
    (unit.level * Math.pow(1.07, Math.log2(unit.ram)) * (1 + (unit.cores - 1) / 5) * ratio);
}

// ------------------------------------------------------------ money plan ---

/**
 * What to buy this sweep, in order.
 *
 * WHY MINIMUM PAYBACK AND NOT MINIMUM PRICE. Cheapest-first buys whichever
 * ladder happens to sit low, regardless of what it returns - on a node whose
 * level has run far ahead of its RAM that is the wrong rung every time. The
 * ratio is the whole point of having the gains.
 *
 * WHY THE BUDGET IS PRICED ONCE. The cap is on the SWEEP, not on each purchase:
 * priced per purchase it would ratchet down as cash fell and the sweep would
 * spend a different fraction depending only on how many rungs it happened to
 * take. cloud.js is bidding for the same wallet at 10% and sing's aug batch
 * wants all of it.
 *
 * WHY PRODUCTION IS PRICED AT THE SALE RATE IN BITNODE 9. There, production is
 * hashes/s, and a hash's floor value is the auto-sale rate - overflow is sold
 * at exactly that (processAllHacknetServerEarnings). It understates, because
 * the hash sweep only spends a hash when it beats that price, and understating
 * is the right direction for a spend decision.
 *
 * @param {object} state  { isServer, units, budget, mults }
 * @param {object} cfg    { PAYBACK_SECONDS, HASH_PRICE }
 */
export function planMoney(state, cfg) {
  const { isServer, budget, mults } = state;
  const perUnit = isServer ? cfg.HASH_PRICE : 1;
  // Owned nothing at the start of this sweep - the virgin-BitNode case, where
  // the only possible buy is the unconditional first unit and nothing about
  // its (unmeasured) production can be sized yet.
  const startedWithNothing = state.units.length === 0;
  // Local copies: the plan walks several rungs and each one changes what the
  // next is worth. Nothing here touches the caller's objects.
  const units = state.units.map((u) => ({ ...u }));
  const buys = [];
  let spent = 0;
  let reason = "nothing left inside the payback threshold";
  // The best-paying candidate SEEN, whether or not it cleared the bar. When a
  // sweep buys nothing this is the rung the user is looking at in the Hacknet
  // UI, and its payback against PAYBACK_SECONDS is the only figure that
  // explains the refusal. Without it the log reads as "cannot afford" beside a
  // $500 price tag and a nine-figure wallet - which is exactly how a live
  // BitNode 4 run was read. Ranked, not just the first: the refusal is about
  // the BEST rung failing, so naming a worse one would misattribute it.
  let nearest = null;

  for (;;) {
    let best = null;

    // A new unit. With nothing owned there is no production to derive its rate
    // from, so the first one is unconditional - $1,000 for a node, $50,000 for
    // a server, and in BitNode 9 no servers means no hashes at all.
    const nextPrice = unitPrice(isServer, units.length, mults);
    if (Number.isFinite(nextPrice)) {
      if (units.length === 0) {
        if (nextPrice <= budget - spent) {
          buys.push({ kind: "unit", index: -1, price: nextPrice });
          spent += nextPrice;
          units.push(isServer
            ? { level: 1, ram: 1, cores: 1, cache: 1, used: 0, production: 0 }
            : { level: 1, ram: 1, cores: 1, production: 0 });
          continue;
        }
        return { buys, spent, reason: "the first unit does not fit the budget" };
      }
      const fresh = freshProduction(isServer, units[0]) * perUnit;
      if (fresh > 0) {
        const payback = nextPrice / fresh;
        const cand = { kind: "unit", index: -1, price: nextPrice, payback };
        if (!nearest || payback < nearest.payback) nearest = cand;
        if (payback < cfg.PAYBACK_SECONDS) best = cand;
      }
    }

    for (let i = 0; i < units.length; i++) {
      // "cache" is absent on purpose: it buys hash capacity, not production, so
      // it has no payback to rank and is bought by the hash sweep when capacity
      // is what blocks a purchase.
      for (const kind of ["level", "ram", "core"]) {
        const price = stepPrice(isServer, kind, units[i], mults);
        // Infinity at the maximum, which is what keeps a maxed rung out of the
        // running with no separate cap check.
        if (!Number.isFinite(price)) continue;
        const gain = stepGain(isServer, kind, units[i]) * perUnit;
        if (gain <= 0) continue;
        const payback = price / gain;
        if (!nearest || payback < nearest.payback) nearest = { kind, index: i, price, payback };
        if (payback >= cfg.PAYBACK_SECONDS) continue;
        if (!best || payback < best.payback) best = { kind, index: i, price, payback };
      }
    }

    if (!best) break;
    if (best.price > budget - spent) {
      reason = "the next buy does not fit the sweep's budget";
      break;
    }

    buys.push({ kind: best.kind, index: best.index, price: best.price, payback: best.payback });
    spent += best.price;

    if (best.kind === "unit") {
      const fresh = freshProduction(isServer, units[0]);
      units.push(isServer
        ? { level: 1, ram: 1, cores: 1, cache: 1, used: 0, production: fresh }
        : { level: 1, ram: 1, cores: 1, production: fresh });
      continue;
    }

    const u = units[best.index];
    u.production += stepGain(isServer, best.kind, u);
    if (best.kind === "level") u.level += 1;
    if (best.kind === "ram") u.ram *= 2;
    if (best.kind === "core") u.cores += 1;
  }

  // The unconditional first unit reports production 0 until the game measures
  // it, so every rung on it (and any further unit derived from it) also gains
  // 0 and cannot clear the payback bar. That is not "nothing pays back" - it
  // is "nothing to size a payback FROM yet" - so say so rather than blaming a
  // threshold nothing was ever compared against.
  if (startedWithNothing && buys.length === 1 && buys[0].kind === "unit") {
    reason = "bought the first unit - waiting for a production reading before sizing the next buy";
  } else if (!buys.length && !nearest) {
    // Nothing was even RANKED. Every owned unit reports 0 production, so no
    // gain can be sized and no price can ever pay back - which is this
    // BitNode's HacknetNodeMoney multiplier at 0 (BitNode 8 sets it there), not
    // a threshold anything was measured against. Blaming the threshold here
    // would name a cause that was never consulted.
    reason = "every owned unit produces 0 - this BitNode's hacknet earns nothing at all";
  }

  return { buys, spent, reason, nearest };
}

// ----------------------------------------------------------- hash value ---

/**
 * Hashes for `count` levels of an upgrade starting at `level`.
 *
 * HashUpgrade.getCost's collapsed sum of (level+1) + (level+2) + ... The level
 * counter is GLOBAL per upgrade - hashManager.upgrades[name] - so spreading
 * purchases across targets does not reset the price, and the two upgrades'
 * ladders climb independently of one another.
 */
export function bundlePrice(perLevel, level, count) {
  return perLevel * 0.5 * count * (count + 2 * level + 1);
}

/**
 * Income factor from one Increase Maximum Money, +2% of max money.
 *
 * The soft cap is transcribed from Server.changeMaximumMoney rather than
 * approximated by refusing to buy above it: `1 + (n-1)/Math.log(aboveCap)/
 * Math.log(8)`, two divisions by logs, which is what the source does.
 */
export function maxMoneyFactor(moneyMax, softcap) {
  const step = 1.02;
  if (moneyMax <= softcap) return step;
  return 1 + (step - 1) / Math.log(moneyMax - softcap) / Math.log(8);
}

/**
 * Income factor from one Reduce Minimum Security, x0.98 floored at 1.
 *
 * From src/Hacking.ts. Three terms move together as minimum security falls:
 *
 *   hack chance       ∝ (100 - d)/100      more batches land
 *   money per thread  ∝ (100 - d)/100      fewer hack threads buy the same steal
 *   op time           ∝ (2.5*R*d + 500)    hack; grow x3.2, weaken x4
 *
 * so income ∝ (100 - d)² / (2.5*R*d + 500). diffFactor is 2.5, read from
 * calculateHackingTime - not the 2.4 that is easy to misremember.
 *
 * The grow-thread improvement is left out (grow rate also rises as difficulty
 * falls), so this UNDERSTATES, which is the safe direction for a spend
 * decision. At R=1000 it is +3.04% at d=20 and +2.04% at d=3 - better than
 * Increase Maximum Money's flat +2% at the same tier, which is the whole reason
 * it is computed rather than skipped.
 *
 * Server.changeMinimumSecurity clamps minDifficulty at 1, so at the floor there
 * is nothing left to buy and this returns exactly 1.
 */
export function minSecurityFactor(reqSkill, minSec) {
  const after = Math.max(1, minSec * 0.98);
  if (after >= minSec) return 1;
  const chance = (100 - after) / (100 - minSec);
  const time = (2.5 * reqSkill * minSec + 500) / (2.5 * reqSkill * after + 500);
  return chance * chance * time;
}

// ------------------------------------------------------------- hash plan ---

/**
 * What to spend hashes on this sweep.
 *
 * Both upgrades reduce to one number - the factor by which the batcher's income
 * on that target changes - so they are ranked against each other and against
 * the sale price on the same scale.
 *
 *   incomeShare = income / targets.length
 *   gain$       = (f - 1) * incomeShare * HASH_HORIZON_S
 *   cost$       = hashes * HASH_PRICE
 *   buy while gain$ > cost$ * HASH_VALUE_MARGIN, best gain$ per hash first
 *
 * WHY INCOME IS DIVIDED BY THE TARGET COUNT. It UNDER-attributes income to any
 * one target rather than crediting the whole stream to it. Nothing here knows
 * the per-target split, and over-crediting is the direction that buys upgrades
 * that do not repay.
 *
 * WHY REFUSING EVERY CANDIDATE IS CORRECT, AND WHY IT IS NOT THE WHOLE ANSWER.
 * Overflow hashes are auto-sold at exactly HASH_PRICE
 * (processAllHacknetServerEarnings), so an upgrade that cannot beat that rate
 * is one worth refusing. But it is the OVERFLOW alone: storeHashes() caps the
 * balance at capacity and pays out only the remainder, so a balance below
 * capacity sits indefinitely. Hence `sell` - the two branches where nothing is
 * worth buying at any balance turn the store into cash at the same rate, and
 * the two where a purchase is merely out of reach hold it. Every branch that
 * buys nothing says which of the four reasons it was.
 *
 * WHY ONE SPEND PER PAIR. Raising max money leaves the target below its new
 * maximum, and lowering minimum security leaves it above its new floor -
 * changeMinimumSecurity moves minDifficulty only, never the current security.
 * Both put a streaming target off baseline and cost a re-prep, so the sweep
 * pays that once per pair rather than once per level.
 *
 * @param {object} state { hashes, capacity, levels, perLevel, income, targets,
 *                         units, budget, mults }
 * @param {object} cfg   { HASH_PRICE, HASH_HORIZON_S, HASH_VALUE_MARGIN,
 *                         MONEY_SOFTCAP, MAX_MONEY_UPGRADE, MIN_SECURITY_UPGRADE }
 */
export function planHashes(state, cfg) {
  const none = (why, sell = 0) => ({ spends: [], cacheBuy: null, sell, reason: why });

  /**
   * How many Sell-for-Money purchases the balance covers, each HASH_SALE_COST
   * hashes for HASH_SALE_VALUE.
   *
   * Only ever called on the two outcomes where NOTHING is going to be bought.
   * The game auto-sells the overflow alone - storeHashes() caps at capacity and
   * pays out only the remainder - so everything at or below capacity sits
   * forever, which at `32 * 2^cache` per server is 64 hashes and $16m a server
   * parked while no manager has published a target. The rate is identical
   * either way, so this is not a discount taken for liquidity; it is the same
   * money, collected now rather than never.
   */
  const sellable = () => Math.floor(state.hashes / cfg.HASH_SALE_COST);

  if (!state.targets.length) return none("no targets published by any manager", sellable());

  const upgrades = [cfg.MAX_MONEY_UPGRADE, cfg.MIN_SECURITY_UPGRADE];
  // Local copies: each buy changes what the next one is worth, and the level
  // counters are global per upgrade so they climb across targets too.
  const live = state.targets.map((t) => ({ ...t }));
  const levels = { ...state.levels };
  const counts = new Map();
  let left = state.hashes;
  let capacityShort = 0;
  let balanceShort = 0;

  const factorFor = (upgrade, t) =>
    upgrade === cfg.MAX_MONEY_UPGRADE
      ? maxMoneyFactor(t.moneyMax, cfg.MONEY_SOFTCAP)
      : minSecurityFactor(t.reqSkill, t.minSec);

  // Named for the docstring's `incomeShare`, not `share` - a bare `share` local
  // is billed 2.40 GB as `ns.share` in every importer (both hacknet entries and
  // boot.js), the same identifier tax gang/math.js dodges.
  const incomeShare = state.income / live.length;

  for (;;) {
    let best = null;
    for (const t of live) {
      for (const upgrade of upgrades) {
        const f = factorFor(upgrade, t);
        if (f <= 1) continue;
        const price = bundlePrice(state.perLevel[upgrade], levels[upgrade], 1);
        // A perLevel of 0 (unreachable in this fork - both upgrades are
        // costPerLevel: 50 - but a fork can retune it) makes bundlePrice 0,
        // which the greedy would then "buy" forever: `left -= 0` never drains
        // the balance, so this never terminates. Wedges a 6.60 GB transient
        // that runToCompletion times out on but never kills, and boot's isUp
        // check then blocks every future hash sweep for the life of the process.
        if (!(price > 0)) continue;
        const gain = (f - 1) * incomeShare * cfg.HASH_HORIZON_S;
        // Eligibility BEFORE affordability, so "worth buying but out of reach"
        // is distinguishable from "not worth buying" - they need different
        // answers and only one of them is a reason to buy cache.
        if (gain <= price * cfg.HASH_PRICE * cfg.HASH_VALUE_MARGIN) continue;
        if (price > state.capacity) { capacityShort = Math.max(capacityShort, price); continue; }
        if (price > left) { balanceShort = Math.max(balanceShort, price); continue; }
        const value = gain / price;
        if (!best || value > best.value) best = { upgrade, t, price, value };
      }
    }
    if (!best) break;

    left -= best.price;
    levels[best.upgrade] += 1;
    const key = `${best.upgrade}|${best.t.host}`;
    const entry = counts.get(key) ?? { upgrade: best.upgrade, host: best.t.host, count: 0, hashes: 0 };
    entry.count += 1;
    entry.hashes += best.price;
    counts.set(key, entry);

    // Advance the target's own state so the next round prices the upgrade it
    // would really be buying: max money compounds, minimum security floors at 1.
    if (best.upgrade === cfg.MAX_MONEY_UPGRADE) {
      best.t.moneyMax *= maxMoneyFactor(best.t.moneyMax, cfg.MONEY_SOFTCAP);
    } else {
      best.t.minSec = Math.max(1, best.t.minSec * 0.98);
    }
  }

  const spends = [...counts.values()];
  if (spends.length) return { spends, cacheBuy: null, sell: 0, reason: `${spends.length} spend(s) planned` };

  // Capacity first: a store too small to HOLD the bundle can never fill, while
  // a balance too small fills on its own in a minute or two.
  if (capacityShort > 0) {
    const cacheBuy = planCache(state);
    // No sale here, and none in the balanceShort branch below either: both mean
    // a purchase IS worth making and is merely out of reach, so the hashes are
    // being saved toward it. Selling them would fund the cache upgrade and then
    // leave nothing to fill the larger store with - the two branches that DO
    // sell are the ones where nothing is worth buying at any balance.
    return {
      spends: [],
      cacheBuy,
      sell: 0,
      reason: cacheBuy
        ? `hash capacity ${state.capacity} cannot hold a ${capacityShort}-hash buy - upgrading cache`
        : `hash capacity ${state.capacity} cannot hold a ${capacityShort}-hash buy, and cache does not fit the budget`,
    };
  }
  if (balanceShort > 0) return none(`waiting on hashes: ${state.hashes} of ${balanceShort}`);
  return none("nothing beats the sale price", sellable());
}

/** The cheapest cache rung that fits the budget: always the lowest cache level. */
function planCache(state) {
  let best = null;
  for (const u of state.units) {
    const price = stepPrice(true, "cache", u, state.mults);
    if (!Number.isFinite(price) || price > state.budget) continue;
    if (!best || price < best.price) best = { index: u.index, price };
  }
  return best;
}
