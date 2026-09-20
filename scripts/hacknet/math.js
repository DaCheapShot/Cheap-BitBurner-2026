/**
 * Every hacknet decision, and no ns call anywhere in it.
 *
 * WHY THE COST LADDERS ARE TRANSCRIBED. ns.hacknet.getLevelUpgradeCost,
 * getRamUpgradeCost, getCoreUpgradeCost, getCacheUpgradeCost and
 * getPurchaseNodeCost are 0.50 GB each - 2.50 GB - and every one is a pure
 * function of (stat, count, costMult). The four cost multipliers come from a
 * single ns.getHacknetMultipliers() at 0.25 GB, so transcribing the ladders
 * here saves 2.25 GB off BOTH entries and makes them testable besides. This is
 * the same trade gang/math.js makes with the gain formulas.
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
  // Local copies: the plan walks several rungs and each one changes what the
  // next is worth. Nothing here touches the caller's objects.
  const units = state.units.map((u) => ({ ...u }));
  const buys = [];
  let spent = 0;
  let reason = "nothing left inside the payback threshold";

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
        if (payback < cfg.PAYBACK_SECONDS) best = { kind: "unit", index: -1, price: nextPrice, payback };
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
        if (payback >= cfg.PAYBACK_SECONDS) continue;
        if (!best || payback < best.payback) best = { kind, index: i, price, payback };
      }
    }

    if (!best) break;
    if (best.price > budget - spent) {
      reason = "the next buy does not fit the sweep's budget";
      break;
    }

    buys.push({ kind: best.kind, index: best.index, price: best.price });
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

  return { buys, spent, reason };
}
