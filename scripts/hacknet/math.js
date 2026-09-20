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
