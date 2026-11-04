import {
  CITIES, MAIN_CITY, AGRI, CHEM, TOBACCO, DUMMY_INDUSTRY, DUMMY_PREFIX, MAX_DIVISIONS, INDUSTRY,
  BOOST_MATS, BOOST_SIZE, OFFICE_COST, WAREHOUSE_COST, TEA_PER_EMPLOYEE, PARTY_PER_EMPLOYEE, UNLOCK_COST, APIS,
  UPGRADES, EMPLOYEE_UPGRADES, JOBS, RND, EXPORT_STRING, ROUND1, ROUND2, OFFER_TARGET, OFFER_WAIT,
  OFFER_PLATEAU, OFFER_MAX_WAIT, PRODUCTS_FOR_OFFER, ADVERT_FOCUS_PROFIT, ADVERT_FOCUS, PRODUCT_SPLIT,
  MAIN_OFFICE_SHARE, PRODUCT_SHARE, SUPPORT_WAREHOUSE_SHARE, PRODUCT_INVEST, BOOST_FUNDS_SHARE,
  LATE_BOOST_RATIO, DUMMY_FUNDS_SHARE, SUPPORT_RND, SUPPORT_JOBS, MAIN_JOBS, PROFIT_HIGH, RESEARCH, LAB, TA,
  STAT_RESEARCH, PRODUCTION_RESEARCH, STAT_SHARE, PRODUCTION_SHARE, TA_POOL_MULT, SUPPORT_LAB_SHARE,
  DIV_MIN, DIV_MAX, DIV_FAST, DIV_WINDOW,
} from "./config.js";

/**
 * Every corporation decision, pure - no ns anywhere, so it is 0 GB to import
 * and testable under Node. corp.js reads the corp through two rpc bodies,
 * hands the snapshot to plan(), and runs the ops it returns through the action
 * bodies. Same split as gang/math.js and sleeve/plan.js.
 *
 * Op names are STRING LITERALS on purpose: a local called `research` or
 * `expandCity` costs 20 GB in every importer (RamCalculations.ts bills bare
 * names), a string costs nothing.
 */

// ------------------------------------------------------------- formulas ----

/**
 * Cost of `n` levels of a corp upgrade from `level` - helpers.ts
 * calculateUpgradeCost, a geometric series.
 */
export function upgradeCost(name, level, n) {
  const { base, mult } = UPGRADES[name];
  return n <= 0 ? 0 : base * mult ** level * (1 - mult ** n) / (1 - mult);
}

/** Most levels of `name` that `budget` buys from `level` - calculateMaxAffordableUpgrade. */
export function maxUpgrades(name, level, budget) {
  if (!(budget > 0)) return 0;
  const { base, mult } = UPGRADES[name];
  const n = Math.floor(Math.log(1 + budget * (mult - 1) / (base * mult ** level)) / Math.log(mult));
  // The closed form can land one over on float error; the series is the truth.
  return n > 0 && upgradeCost(name, level, n) > budget ? n - 1 : Math.max(0, n);
}

/**
 * Warehouse levels `level` -> `level + n` (Actions.ts upgradeWarehouseCost): the
 * exponent is level + 1, one ahead of the other upgrades.
 */
export function warehouseCost(level, n) {
  return n <= 0 ? 0 : 1e9 * 1.07 ** (level + 1) * (1.07 ** n - 1) / 0.07;
}

export function maxWarehouse(level, budget) {
  if (!(budget > 0)) return 0;
  const n = Math.floor(Math.log(1 + budget * 0.07 / (1e9 * 1.07 ** (level + 1))) / Math.log(1.07));
  return n > 0 && warehouseCost(level, n) > budget ? n - 1 : Math.max(0, n);
}

/** Office `size` -> `size + inc` (helpers.ts calculateOfficeSizeUpgradeCost). */
export function officeCost(size, inc) {
  if (inc <= 0) return 0;
  return (OFFICE_COST / 0.09) * 1.09 ** (size / 3) * (1.09 ** (inc / 3) - 1);
}

export function maxOffice(size, budget) {
  if (!(budget > 0)) return 0;
  const inc = Math.floor(3 * Math.log(1 + budget * 0.09 / (OFFICE_COST * 1.09 ** (size / 3))) / Math.log(1.09));
  return inc > 0 && officeCost(size, inc) > budget ? inc - 1 : Math.max(0, inc);
}

/** `n` more Advert from `count` - Division.getAdVertCost is 1e9 * 1.06^count. */
export function advertCost(count, n) {
  return n <= 0 ? 0 : 1e9 * 1.06 ** count * (1.06 ** n - 1) / 0.06;
}

export function maxAdvert(count, budget) {
  if (!(budget > 0)) return 0;
  const n = Math.floor(Math.log(1 + budget * 0.06 / (1e9 * 1.06 ** count)) / Math.log(1.06));
  return n > 0 && advertCost(count, n) > budget ? n - 1 : Math.max(0, n);
}

/**
 * Boost material quantities that maximise a city's production multiplier in
 * `space` of warehouse - manual 8.3.2, re-derived:
 *
 *   maximise prod (1 + k x_i)^c_i  subject to  sum s_i x_i = S,  k = 0.002
 *   Lagrange: c_i k / (1 + k x_i) = l s_i  =>  s_i x_i = c_i (S + sum s_j / k) / C - s_i / k
 *
 * with C the sum of the active c_j. A material that comes out negative cannot be
 * held at a negative amount, so it is dropped and the rest re-solved - small
 * warehouses drop Robots (size 0.5) first. Returns units, BOOST_MATS order.
 */
export function boostTargets(factors, space) {
  const active = factors.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);
  for (;;) {
    const C = active.reduce((n, i) => n + factors[i], 0);
    const pad = active.reduce((n, i) => n + BOOST_SIZE[i] * 500, 0);
    const x = factors.map(() => 0);
    let drop = -1;
    for (const i of active) {
      x[i] = (factors[i] * (space + pad) / C - BOOST_SIZE[i] * 500) / BOOST_SIZE[i];
      if (x[i] < 0 && (drop < 0 || x[i] < x[drop])) drop = i;
    }
    if (drop < 0 || active.length === 1) return x.map((v) => Math.max(0, Math.floor(v)));
    active.splice(active.indexOf(drop), 1);
  }
}

/**
 * Whole employees per job from ratios that need not sum to 1: floors first,
 * then the largest remainders, so the counts always sum to `n`. `rnd` employees
 * go to R&D off the top.
 */
export function jobsFor(n, ratios, rnd = 0) {
  const out = Object.fromEntries(JOBS.map((j) => [j, 0]));
  const r = Math.min(n, Math.max(0, Math.round(rnd)));
  out[RND] += r;
  const left = n - r;
  const keys = Object.keys(ratios).filter((k) => ratios[k] > 0);
  const total = keys.reduce((s, k) => s + ratios[k], 0);
  if (!keys.length || !(total > 0)) {
    out[RND] += left;
    return out;
  }
  const exact = keys.map((k) => ({ k, v: (left * ratios[k]) / total }));
  let given = 0;
  for (const e of exact) {
    out[e.k] += Math.floor(e.v);
    given += Math.floor(e.v);
  }
  exact.sort((a, b) => (b.v % 1) - (a.v % 1));
  for (let i = 0; given < left; i++, given++) out[exact[i % exact.length].k]++;
  return out;
}

/** Do an office's jobs already match `want`? Unlisted jobs must be 0. */
export function sameJobs(have, want) {
  return JOBS.every((j) => (have?.[j] ?? 0) === (want[j] ?? 0));
}

/**
 * "Tobacco-12" -> 12; anything else 0. String.match, not RegExp.exec: the game
 * bills the property name `exec` as ns.exec, 1.30 GB in every importer.
 */
export function productIndex(name) {
  const m = String(name).match(/-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

// --------------------------------------------------------------- offers ----

/**
 * Take the investment offer now? `seen` is every offer since the round's setup
 * finished, oldest first. Not before OFFER_WAIT cycles - valuation is a mean of
 * the last 10. Then on reaching the target, on OFFER_PLATEAU cycles without a
 * new high, or at OFFER_MAX_WAIT whatever it is.
 */
export function takeOffer(seen, round) {
  if (seen.length < OFFER_WAIT) return false;
  const now = seen[seen.length - 1];
  if (now >= (OFFER_TARGET[round] ?? Infinity)) return true;
  if (seen.length >= OFFER_MAX_WAIT) return true;
  const best = Math.max(...seen);
  const lastHigh = seen.lastIndexOf(best);
  return seen.length - 1 - lastHigh >= OFFER_PLATEAU && now > 0;
}

/**
 * The dividend rate, from profit over the last DIV_WINDOW passes (`profits`,
 * per second, oldest first): DIV_MIN while it grows DIV_FAST x a window or
 * faster, DIV_MAX when flat, log-linear between. Too little history or no
 * profit pays DIV_MIN - the corp is still building.
 */
export function dividendRate(profits) {
  if (profits.length < DIV_WINDOW) return DIV_MIN;
  // Medians of the window's oldest and newest tenth, not two single passes: one
  // cycle's profit swings with product sales, and a live run read 81%, 10%, 90%
  // in three consecutive passes off single samples. A median, because a mean
  // still follows one 100x pass.
  const k = Math.max(1, Math.floor(DIV_WINDOW / 10));
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const w = profits.slice(-DIV_WINDOW);
  const then = median(w.slice(0, k));
  const now = median(w.slice(-k));
  if (!(then > 0) || !(now > 0)) return DIV_MIN;
  const growth = Math.log(now / then) / Math.log(DIV_FAST);
  const t = Math.min(1, Math.max(0, 1 - growth));
  return DIV_MIN + (DIV_MAX - DIV_MIN) * t;
}

// ----------------------------------------------------------------- plan ----

/** Which action body each op runs in - corp.js runs them in BODY_ORDER. */
export const BODY_OF = {
  industry: "SETUP", city: "SETUP", warehouse: "SETUP",
  unlock: "UNLOCK", smart: "UNLOCK",
  upgrade: "UPGRADE", whUp: "UPGRADE", advert: "UPGRADE",
  size: "STAFF", hire: "STAFF", jobs: "STAFF",
  tea: "MORALE", party: "MORALE",
  buy: "TRADE", sell: "TRADE",
  export: "EXPORT", unexport: "EXPORT",
  make: "PRODUCT", drop: "PRODUCT", psell: "PRODUCT",
  taMat: "TA", taProd: "TA", lab: "TA",
  accept: "FINANCE", public: "FINANCE", dividend: "FINANCE",
};
export const BODY_ORDER = ["SETUP", "UNLOCK", "UPGRADE", "STAFF", "EXPORT", "TRADE", "MORALE", "PRODUCT", "TA", "FINANCE"];

/** Where we are: 1-4 the private funding rounds, 5 ready to list, "public" after. */
export function stageOf(s) {
  if (s.public) return "public";
  return s.offer?.round ?? 1;
}

/**
 * The plan for one pass: ops, what it waits on, and whether the round's setup
 * is finished (corp.js then starts watching the offer).
 *
 * @param s   the snapshot: READ_CORP's fields plus `divs` from READ_DIV
 * @param mem { taOn: Set of "div|city|mat" / "div|name" already switched to TA2 }
 * @returns {{ ops: any[][], notes: string[], stage, setupDone: boolean, mode: string }}
 */
export function plan(s, mem = {}) {
  const ctx = { s, cash: s.funds, ops: [], notes: [], mem, stage: stageOf(s) };
  let setupDone = false;
  let mode = "";
  // Nothing below works without both APIs: every office and warehouse call throws.
  if (!APIS.every((api) => unlock(ctx, api))) mode = "buying the Office and Warehouse APIs";
  else if (ctx.stage === 1) setupDone = round1(ctx);
  else if (ctx.stage === 2) setupDone = round2(ctx);
  else {
    const r = growth(ctx);
    setupDone = r.setupDone;
    mode = r.mode;
  }
  return { ops: ctx.ops, notes: ctx.notes, stage: ctx.stage, setupDone, mode };
}

// ------------------------------------------------------------- helpers ----

const div = (ctx, name) => ctx.s.divs?.[name];
const push = (ctx, ...op) => ctx.ops.push(op);
function pay(ctx, cost) {
  if (!(cost <= ctx.cash)) return false;
  ctx.cash -= cost;
  return true;
}

/** Create the division, or say why not. True once it exists. */
function ensureDivision(ctx, name, industry) {
  if (div(ctx, name)) return true;
  if (ctx.s.divisions?.includes(name)) return false; // exists, not read this pass
  const cost = INDUSTRY[industry].cost;
  if (pay(ctx, cost)) push(ctx, "industry", industry, name);
  else ctx.notes.push(`${name}: waiting for ${cost} to open the division`);
  return false;
}

/** An office and a warehouse in every city. True once all six have both. */
function ensureCities(ctx, name) {
  const d = div(ctx, name);
  let done = true;
  for (const city of CITIES) {
    if (!d.offices?.[city]) {
      done = false;
      if (pay(ctx, OFFICE_COST)) push(ctx, "city", name, city);
      else { ctx.notes.push(`${name}: waiting for funds to open ${city}`); return false; }
    } else if (!d.warehouses?.[city]) {
      done = false;
      if (pay(ctx, WAREHOUSE_COST)) push(ctx, "warehouse", name, city);
      else { ctx.notes.push(`${name}: waiting for funds for a ${city} warehouse`); return false; }
    }
  }
  return done;
}

/** Own `name`, buying it this pass if funds allow. True once owned or bought. */
function unlock(ctx, name) {
  if (ctx.s.unlocks?.[name]) return true;
  if (pay(ctx, UNLOCK_COST[name])) {
    push(ctx, "unlock", name);
    return true;
  }
  ctx.notes.push(`waiting for funds to unlock ${name}`);
  return false;
}

/** Smart Supply on in every warehouse, once unlocked - a warehouse bought before the unlock starts off. */
function smartSupply(ctx, name) {
  if (!ctx.s.unlocks?.["Smart Supply"]) return;
  for (const [city, w] of Object.entries(div(ctx, name).warehouses ?? {})) {
    if (w && !w.smartSupplyEnabled) push(ctx, "smart", name, city);
  }
}

/** Sell every produced material, all of it at market price (TA2 overrides the price once on). */
function sellOutputs(ctx, name, industry) {
  const d = div(ctx, name);
  for (const city of Object.keys(d.warehouses ?? {})) {
    for (const mat of INDUSTRY[industry].makes) {
      const m = d.mats?.[city]?.[mat];
      if (m && (m.desiredSellAmount !== "MAX" || m.desiredSellPrice !== "MP")) push(ctx, "sell", name, city, mat, "MAX", "MP");
    }
  }
}

/** Tea and a party wherever energy or morale has slipped below max - the manual's "every cycle". */
function morale(ctx, name) {
  for (const [city, o] of Object.entries(div(ctx, name).offices ?? {})) {
    if (!(o.numEmployees > 0)) continue;
    if (o.avgEnergy < o.maxEnergy - 0.5 && pay(ctx, TEA_PER_EMPLOYEE * o.numEmployees)) push(ctx, "tea", name, city);
    if (o.avgMorale < o.maxMorale - 0.5 && pay(ctx, PARTY_PER_EMPLOYEE * o.numEmployees)) {
      push(ctx, "party", name, city, PARTY_PER_EMPLOYEE);
    }
  }
}

/**
 * Grow an office to `size` (as far as `budget` goes, default all cash), hire
 * into it and set its jobs from `jobsOf(size)`. Returns the size it will have.
 */
function staff(ctx, name, city, size, jobsOf, budget = ctx.cash) {
  const o = div(ctx, name).offices[city];
  let target = o.size;
  if (size > o.size) {
    let inc = size - o.size;
    if (!(officeCost(o.size, inc) <= Math.min(budget, ctx.cash))) inc = maxOffice(o.size, Math.min(budget, ctx.cash));
    if (inc > 0 && pay(ctx, officeCost(o.size, inc))) {
      push(ctx, "size", name, city, inc);
      target = o.size + inc;
    }
  }
  if (o.numEmployees < target) push(ctx, "hire", name, city, target - o.numEmployees);
  const want = jobsOf(target);
  if (!sameJobs(o.jobs, want)) push(ctx, "jobs", name, city, want);
  return target;
}

/** Corp upgrade to `level`, or as far as `budget` reaches. True once there. */
function upgradeTo(ctx, name, level, budget = ctx.cash) {
  const have = ctx.s.upgrades?.[name] ?? 0;
  if (have >= level) return true;
  let n = level - have;
  if (!(upgradeCost(name, have, n) <= Math.min(budget, ctx.cash))) n = maxUpgrades(name, have, Math.min(budget, ctx.cash));
  if (n > 0 && pay(ctx, upgradeCost(name, have, n))) push(ctx, "upgrade", name, n);
  return have + n >= level;
}

/** Every warehouse of a division to `level`, city by city. True once all are there. */
function warehouseTo(ctx, name, level) {
  let done = true;
  for (const [city, w] of Object.entries(div(ctx, name).warehouses ?? {})) {
    const n = level - w.level;
    if (n <= 0) continue;
    if (pay(ctx, warehouseCost(w.level, n))) push(ctx, "whUp", name, city, n);
    else done = false;
  }
  return done;
}

function advertTo(ctx, name, count, budget = ctx.cash) {
  const have = div(ctx, name).numAdVerts ?? 0;
  if (have >= count) return true;
  let n = count - have;
  if (!(advertCost(have, n) <= Math.min(budget, ctx.cash))) n = maxAdvert(have, Math.min(budget, ctx.cash));
  if (n > 0 && pay(ctx, advertCost(have, n))) push(ctx, "advert", name, n);
  return have + n >= count;
}

/**
 * Top each warehouse's boost materials up to the optimum for `ratio` of its
 * size. Bought per second for one cycle, never in bulk: per-second buys may go
 * into debt and bulk must pay up front (manual 19.1). The rate is set back to 0
 * the pass after - a buy left on buys forever. `cap` limits what the top-ups
 * may cost at market price; a city over it waits. True once every city holds
 * its targets.
 */
function boosts(ctx, name, industry, ratio, cap = Infinity) {
  const d = div(ctx, name);
  let done = true;
  for (const [city, w] of Object.entries(d.warehouses ?? {})) {
    const want = boostTargets(INDUSTRY[industry].boost, w.size * ratio);
    const mats = d.mats?.[city] ?? {};
    const cost = BOOST_MATS.reduce((n, mat, i) =>
      n + Math.max(0, want[i] - (mats[mat]?.stored ?? 0)) * (mats[mat]?.marketPrice ?? 0), 0);
    const afford = cost <= cap;
    // Capped top-ups are paid for out of this pass; uncapped ones (rounds 1
    // and 2) are meant to go into debt at the end of the round.
    if (afford && cap !== Infinity) {
      cap -= cost;
      ctx.cash -= cost;
    }
    BOOST_MATS.forEach((mat, i) => {
      const m = mats[mat];
      if (!m) return;
      const short = m.stored < want[i] * 0.99;
      if (short) done = false;
      const rate = short && afford ? (want[i] - m.stored) / 10 : 0;
      if (Math.abs(rate - (m.buyAmount ?? 0)) > 1e-9) push(ctx, "buy", name, city, mat, rate);
    });
  }
  return done;
}

/** `src`'s `mat` exported to each `dsts` division in the same city, in that order (exports run FIFO). */
function exportsTo(ctx, src, mat, dsts) {
  const d = div(ctx, src);
  for (const city of CITIES) {
    const have = (d.mats?.[city]?.[mat]?.exports ?? []).filter((e) => e.city === city).map((e) => e.division);
    const want = dsts.filter((t) => div(ctx, t)?.warehouses?.[city]);
    if (!d.warehouses?.[city] || !want.length) continue;
    if (want.every((t, i) => have[i] === t) && have.length === want.length) continue;
    for (const t of have) push(ctx, "unexport", src, city, t, city, mat);
    for (const t of want) push(ctx, "export", src, city, t, city, mat, EXPORT_STRING);
  }
}

/** Have the office's CURRENT jobs (applied at START) reached `want` everywhere? */
function jobsApplied(ctx, name, jobsOf) {
  return Object.values(div(ctx, name).offices ?? {}).every((o) => sameJobs(o.jobs, jobsOf(o.size)));
}

const allRnd = (n) => jobsFor(n, {}, n);
const fixed = (counts) => () => ({ ...Object.fromEntries(JOBS.map((j) => [j, 0])), ...counts });

// -------------------------------------------------------------- round 1 ----

function round1(ctx) {
  if (!ensureDivision(ctx, AGRI, "Agriculture")) return false;
  if (!ensureCities(ctx, AGRI)) return false;
  if (!unlock(ctx, "Smart Supply")) return false;
  smartSupply(ctx, AGRI);
  sellOutputs(ctx, AGRI, "Agriculture");
  morale(ctx, AGRI);
  const d = div(ctx, AGRI);
  const rpReady = d.researchPoints >= ROUND1.rp;
  const jobsOf = rpReady ? fixed(ROUND1.jobs) : allRnd;
  for (const city of CITIES) staff(ctx, AGRI, city, ROUND1.office, jobsOf);
  const built = upgradeTo(ctx, "Smart Storage", ROUND1.smartStorage) &
    warehouseTo(ctx, AGRI, ROUND1.warehouse) & advertTo(ctx, AGRI, ROUND1.advert);
  if (!rpReady) {
    ctx.notes.push(`${AGRI}: R&D to ${ROUND1.rp} RP (${Math.floor(d.researchPoints)})`);
    return false;
  }
  if (!built) ctx.notes.push("round 1: upgrades still short of the recipe");
  const stocked = boosts(ctx, AGRI, "Agriculture", ROUND1.boostRatio);
  if (!stocked) ctx.notes.push(`${AGRI}: stocking boost materials`);
  return stocked && jobsApplied(ctx, AGRI, jobsOf);
}

// -------------------------------------------------------------- round 2 ----

function round2(ctx) {
  const R = ROUND2;
  if (!unlock(ctx, "Export")) return false;
  const a = div(ctx, AGRI);
  const c = div(ctx, CHEM);
  const rpReady = (a?.researchPoints ?? 0) >= R.agri.rp && (c?.researchPoints ?? 0) >= R.chem.rp;
  const agriJobs = rpReady ? fixed(R.agri.jobs) : allRnd;
  for (const city of CITIES) staff(ctx, AGRI, city, R.agri.office, agriJobs);
  smartSupply(ctx, AGRI);
  sellOutputs(ctx, AGRI, "Agriculture");
  morale(ctx, AGRI);
  if (!ensureDivision(ctx, CHEM, "Chemical")) return false;
  if (!ensureCities(ctx, CHEM)) return false;
  smartSupply(ctx, CHEM);
  sellOutputs(ctx, CHEM, "Chemical");
  morale(ctx, CHEM);
  exportsTo(ctx, AGRI, "Plants", [CHEM]);
  exportsTo(ctx, CHEM, "Chemicals", [AGRI]);
  const chemJobs = rpReady ? fixed(R.chem.jobs) : allRnd;
  for (const city of CITIES) staff(ctx, CHEM, city, R.chem.office, chemJobs);
  warehouseTo(ctx, CHEM, R.chem.warehouse);
  advertTo(ctx, AGRI, R.agri.advert);
  balanceStorage(ctx);
  if (!rpReady) {
    ctx.notes.push(`R&D to ${R.agri.rp}/${R.chem.rp} RP (${Math.floor(a.researchPoints)}/${Math.floor(c.researchPoints)})`);
    return false;
  }
  const stocked = boosts(ctx, AGRI, "Agriculture", R.agri.boostRatio) & boosts(ctx, CHEM, "Chemical", R.chem.boostRatio);
  if (!stocked) ctx.notes.push("stocking boost materials");
  return Boolean(stocked) && jobsApplied(ctx, AGRI, agriJobs) && jobsApplied(ctx, CHEM, chemJobs);
}

/**
 * Smart Storage to 25, Agriculture's warehouses to 17 and Smart Factories to 17,
 * the cheapest next step first while it is affordable. The manual's optimizer
 * picks the best mix for the funds in hand; buying the cheapest rung each time
 * lands close to it and never strands funds on one ladder while another is cheap.
 */
function balanceStorage(ctx) {
  const R = ROUND2;
  const a = div(ctx, AGRI);
  const lv = {
    ss: ctx.s.upgrades?.["Smart Storage"] ?? 0,
    sf: ctx.s.upgrades?.["Smart Factories"] ?? 0,
    wh: Math.min(...Object.values(a.warehouses ?? {}).map((w) => w.level)),
  };
  const bought = { ss: 0, sf: 0 };
  const wh = Object.fromEntries(Object.entries(a.warehouses ?? {}).map(([city, w]) => [city, w.level]));
  for (;;) {
    const steps = [];
    if (lv.ss < R.smartStorage) steps.push({ k: "ss", cost: upgradeCost("Smart Storage", lv.ss, 1) });
    if (lv.sf < R.smartFactories) steps.push({ k: "sf", cost: upgradeCost("Smart Factories", lv.sf, 1) });
    if (lv.wh < R.agri.warehouse) {
      const cost = Object.values(wh).reduce((n, l) => n + (l <= lv.wh ? warehouseCost(l, 1) : 0), 0);
      steps.push({ k: "wh", cost });
    }
    if (!steps.length) break;
    steps.sort((x, y) => x.cost - y.cost);
    if (!pay(ctx, steps[0].cost)) break;
    const k = steps[0].k;
    if (k === "wh") {
      for (const city of Object.keys(wh)) if (wh[city] <= lv.wh) wh[city]++;
    } else bought[k]++;
    lv[k]++;
  }
  if (bought.ss) push(ctx, "upgrade", "Smart Storage", bought.ss);
  if (bought.sf) push(ctx, "upgrade", "Smart Factories", bought.sf);
  for (const [city, l] of Object.entries(wh)) {
    const n = l - a.warehouses[city].level;
    if (n > 0) push(ctx, "whUp", AGRI, city, n);
  }
}

// ----------------------------------------------------------- round 3 on ----

/** Products finished so far, counted by their index - discontinued ones included. */
function finishedCount(d) {
  const done = (d?.products ?? []).filter((n) => d.prods?.[n]?.developmentProgress >= 100);
  return Math.max(0, ...done.map(productIndex));
}

function growth(ctx) {
  const s = ctx.s;
  const stage = ctx.stage;
  const profit = (s.revenue ?? 0) - (s.expenses ?? 0);
  if (!ensureDivision(ctx, TOBACCO, "Tobacco")) return { setupDone: false, mode: "opening Tobacco" };
  const citiesDone = ensureCities(ctx, TOBACCO);
  for (const [name, ind] of [[AGRI, "Agriculture"], [CHEM, "Chemical"], [TOBACCO, "Tobacco"]]) {
    if (!div(ctx, name)) continue;
    smartSupply(ctx, name);
    if (ind !== "Tobacco") sellOutputs(ctx, name, ind);
    morale(ctx, name);
  }
  // Tobacco first: an export route is served FIFO, and the product division
  // is the one that must not run short of Plants (manual 4.3).
  exportsTo(ctx, AGRI, "Plants", [TOBACCO, CHEM]);
  exportsTo(ctx, CHEM, "Chemicals", [AGRI]);

  const t = div(ctx, TOBACCO);
  const finished = finishedCount(t);
  const need = PRODUCTS_FOR_OFFER[stage] ?? 0;
  const offering = stage === 3 || stage === 4;
  const profitMode = offering && finished >= need;
  // While the offer is watched, nothing is bought that this fork counts as a
  // capital expenditure (FundsSource.ts: office, warehouse, upgrades, product
  // development). Each one ADDS its price to the cycle's assets and then takes it
  // from funds, so assetDelta - the 315e3x term of a private valuation - goes
  // negative for that cycle and counts as 0. A live run spent every pass and
  // took round 3 at $5.53t and round 4 at $6.62t against a 1e16 target: the
  // offer was funds/3 and nothing else, flat from the first cycle, so the
  // plateau rule fired the moment OFFER_WAIT allowed it. Tea, parties, Advert
  // and materials are operating flows and stay on.
  const watching = profitMode && citiesDone;
  products(ctx, t, !watching);
  if (citiesDone && !watching) dummies(ctx);

  // Two cycles of expenses stay put: tea, salaries and a party must never bounce.
  const floor = 2 * 10 * (s.expenses ?? 0);
  const spendable = Math.max(0, ctx.cash - floor);
  const productShare = stage === "public" || stage === 5 ? PRODUCT_SHARE.later : PRODUCT_SHARE.early;
  const support = watching ? 0 : spendable * (1 - productShare);
  if (citiesDone) productDivision(ctx, watching ? 0 : spendable * productShare, profit, finished, profitMode);
  supportDivision(ctx, AGRI, "Agriculture", support * 5 / 6);
  supportDivision(ctx, CHEM, "Chemical", support / 6);
  for (const name of [AGRI, CHEM, TOBACCO]) labWork(ctx, name);
  if (citiesDone) boosts(ctx, TOBACCO, "Tobacco", LATE_BOOST_RATIO, ctx.cash * BOOST_FUNDS_SHARE);

  if (stage === 5) push(ctx, "public", 0);
  if (stage === "public") ctx.notes.push(`profit ${profit}/s`);
  if (offering && !profitMode) ctx.notes.push(`round ${stage}: ${finished}/${need} products before the offer`);
  const mode = profitMode ? "profit (before the offer)" : stage === "public" ? "public" : `round ${stage}`;
  return { setupDone: profitMode && citiesDone, mode };
}

/**
 * Keep one product in development at all times (manual 4.3): when none is,
 * drop the worst finished product if the shelf is full and design the next,
 * investing PRODUCT_INVEST of funds in design and the same in marketing - the
 * effect scales with the investment^0.1, so more buys little. Finished products
 * sell everything at market price until TA2 sets the price.
 */
function products(ctx, t, design = true) {
  const names = t?.products ?? [];
  const developing = names.filter((n) => !(t.prods?.[n]?.developmentProgress >= 100));
  const done = names.filter((n) => t.prods?.[n]?.developmentProgress >= 100);
  for (const n of done) {
    if (t.prods[n].desiredSellAmount !== "MAX") push(ctx, "psell", TOBACCO, n, "MAX", "MP");
  }
  if (!design || developing.length || !t?.offices?.[MAIN_CITY]) return;
  if (names.length >= (t.maxProducts ?? 3) && done.length) {
    const worst = done.reduce((w, n) => (t.prods[n].rating < t.prods[w].rating ? n : w));
    push(ctx, "drop", TOBACCO, worst);
  }
  const invest = Math.max(1e9, ctx.s.funds * PRODUCT_INVEST);
  if (pay(ctx, 2 * invest)) {
    const next = Math.max(0, ...names.map(productIndex)) + 1;
    push(ctx, "make", TOBACCO, MAIN_CITY, `Tobacco-${next}`, invest, invest);
  } else ctx.notes.push("waiting for funds to design the next product");
}

/** Dummy Restaurant divisions to the division cap: each office and warehouse lifts valuation x1.1^(1/12). */
function dummies(ctx) {
  const s = ctx.s;
  const names = s.divisions ?? [];
  for (const name of names.filter((n) => n.startsWith(DUMMY_PREFIX))) {
    if (div(ctx, name) && !ensureCities(ctx, name)) return;
  }
  const full = INDUSTRY[DUMMY_INDUSTRY].cost + 5 * OFFICE_COST + 5 * WAREHOUSE_COST;
  if (names.length >= MAX_DIVISIONS || full > s.funds * DUMMY_FUNDS_SHARE) return;
  const k = names.filter((n) => n.startsWith(DUMMY_PREFIX)).length + 1;
  if (pay(ctx, INDUSTRY[DUMMY_INDUSTRY].cost)) push(ctx, "industry", DUMMY_INDUSTRY, `${DUMMY_PREFIX}${k}`);
}

/** The main office's job ratios for this stage (manual 19.4.2). */
function mainJobs(stage, profit, profitMode) {
  if (stage === 3) return profitMode ? MAIN_JOBS.profit3 : MAIN_JOBS.progress3;
  if (stage === 4) return profitMode ? MAIN_JOBS.profit4 : MAIN_JOBS.progress4;
  return profit >= PROFIT_HIGH ? MAIN_JOBS.profitProgressHigh : MAIN_JOBS.profitProgressLow;
}

/** The five support offices' jobs (manual 19.4.2). */
function supportOfficeJobs(stage, finished) {
  if (stage === 3 && finished < 1) return (n) => allRnd(n);
  if (stage === 3 || stage === 4) {
    return (n) => (n >= 5
      ? jobsFor(n, { Operations: 1, Engineer: 1, Business: 1, Management: 1 }, n - 4)
      : allRnd(n));
  }
  return (n) => jobsFor(n, MAIN_JOBS.profit4, Math.floor(n / 2));
}

/**
 * The product division's share of the pass, split by the manual's ratios.
 * Below ADVERT_FOCUS_PROFIT Wilson and Advert share a slice; above it Wilson is
 * bought from the last cycle's profit alone and ADVERT_FOCUS of funds goes to
 * Advert before anything else.
 */
function productDivision(ctx, budget, profit, finished, profitMode) {
  const stage = ctx.stage;
  const focus = profit >= ADVERT_FOCUS_PROFIT;
  if (focus) {
    const wl = ctx.s.upgrades?.["Wilson Analytics"] ?? 0;
    if (upgradeCost("Wilson Analytics", wl, 1) <= profit * 10) upgradeTo(ctx, "Wilson Analytics", wl + 1);
    advertTo(ctx, TOBACCO, Infinity, ctx.s.funds * ADVERT_FOCUS);
    budget = Math.min(budget, ctx.cash);
  }
  const split = focus ? PRODUCT_SPLIT.after : PRODUCT_SPLIT.before;
  const total = Object.values(split).reduce((n, v) => n + v, 0);
  const slice = (k) => (budget * split[k]) / total;

  rawProduction(ctx, slice("raw"));
  if (!focus) {
    const b = slice("wilsonAdvert");
    const before = ctx.cash;
    const wl = ctx.s.upgrades?.["Wilson Analytics"] ?? 0;
    if (upgradeCost("Wilson Analytics", wl, 1) <= b / 2) upgradeTo(ctx, "Wilson Analytics", Infinity, b / 2);
    advertTo(ctx, TOBACCO, Infinity, b - (before - ctx.cash));
  }

  const officeBudget = slice("office");
  const mainShare = MAIN_OFFICE_SHARE[stage] ?? MAIN_OFFICE_SHARE.later;
  const ratios = mainJobs(stage, profit, profitMode);
  staff(ctx, TOBACCO, MAIN_CITY, Infinity, (n) => jobsFor(n, ratios), officeBudget * mainShare);
  const supportJobs = supportOfficeJobs(stage, finished);
  for (const city of CITIES.filter((c) => c !== MAIN_CITY)) {
    staff(ctx, TOBACCO, city, Infinity, supportJobs, (officeBudget * (1 - mainShare)) / 5);
  }

  const each = slice("employee") / EMPLOYEE_UPGRADES.length;
  for (const u of EMPLOYEE_UPGRADES) upgradeTo(ctx, u, Infinity, each);
  upgradeTo(ctx, "ABC SalesBots", Infinity, slice("sales"));
  upgradeTo(ctx, "Project Insight", Infinity, slice("insight"));
}

/** Smart Factories, Smart Storage and Tobacco's warehouses, cheapest rung first within `budget`. */
function rawProduction(ctx, budget) {
  const t = div(ctx, TOBACCO);
  const lv = { ss: ctx.s.upgrades?.["Smart Storage"] ?? 0, sf: ctx.s.upgrades?.["Smart Factories"] ?? 0 };
  const wh = Object.fromEntries(Object.entries(t.warehouses ?? {}).map(([c, w]) => [c, w.level]));
  const bought = { ss: 0, sf: 0 };
  for (;;) {
    const low = Math.min(...Object.values(wh));
    const whCost = Object.values(wh).reduce((n, l) => n + (l === low ? warehouseCost(l, 1) : 0), 0);
    const steps = [
      { k: "ss", cost: upgradeCost("Smart Storage", lv.ss, 1) },
      { k: "sf", cost: upgradeCost("Smart Factories", lv.sf, 1) },
      { k: "wh", cost: whCost },
    ].sort((x, y) => x.cost - y.cost);
    if (!(steps[0].cost <= budget) || !pay(ctx, steps[0].cost)) break;
    budget -= steps[0].cost;
    if (steps[0].k === "wh") {
      for (const c of Object.keys(wh)) if (wh[c] === low) wh[c]++;
    } else {
      bought[steps[0].k]++;
      lv[steps[0].k]++;
    }
  }
  if (bought.ss) push(ctx, "upgrade", "Smart Storage", bought.ss);
  if (bought.sf) push(ctx, "upgrade", "Smart Factories", bought.sf);
  for (const [c, l] of Object.entries(wh)) {
    const n = l - t.warehouses[c].level;
    if (n > 0) push(ctx, "whUp", TOBACCO, c, n);
  }
}

/**
 * A support division: SUPPORT_WAREHOUSE_SHARE of its budget on warehouses, the
 * rest on offices, equally per city; a fifth of staff on R&D, the rest mostly
 * Engineers - in round 3+ EngineerProduction, not RP, sets material quality
 * (manual 11.2). Boost materials topped up from what is left.
 */
function supportDivision(ctx, name, industry, budget) {
  const d = div(ctx, name);
  if (!d) return;
  const perCity = budget / 6;
  for (const [city, w] of Object.entries(d.warehouses ?? {})) {
    const n = maxWarehouse(w.level, perCity * SUPPORT_WAREHOUSE_SHARE);
    if (n > 0 && pay(ctx, warehouseCost(w.level, n))) push(ctx, "whUp", name, city, n);
  }
  for (const city of Object.keys(d.offices ?? {})) {
    staff(ctx, name, city, Infinity, (n) => jobsFor(n, SUPPORT_JOBS, Math.round(n * SUPPORT_RND)),
      perCity * (1 - SUPPORT_WAREHOUSE_SHARE));
  }
  boosts(ctx, name, industry, LATE_BOOST_RATIO, ctx.cash * BOOST_FUNDS_SHARE);
}

/**
 * Research by the manual's rules, from this division's own pool (RP is not
 * shared, the research is - across the same industry). Nothing in round 3: RP
 * there is product rating. Then the lab; TA.I and TA.II together once the pool
 * holds TA_POOL_MULT x both; then stats under STAT_SHARE of the pool and
 * production under PRODUCTION_SHARE. TA2 is switched on as it lands.
 */
function labWork(ctx, name) {
  const d = div(ctx, name);
  if (!d || ctx.stage === 3) return;
  const product = name === TOBACCO;
  let pool = d.researchPoints ?? 0;
  const have = new Set(d.researched ?? []);
  const take = (r) => {
    pool -= RESEARCH[r].cost;
    have.add(r);
    push(ctx, "lab", name, r);
  };
  const ok = (r) => !have.has(r) && (!RESEARCH[r].parent || have.has(RESEARCH[r].parent)) &&
    (product || !RESEARCH[r].products);
  if (ok(LAB) && RESEARCH[LAB].cost <= pool * (product ? 1 : SUPPORT_LAB_SHARE)) take(LAB);
  if (!have.has(LAB)) return;
  const taCost = TA.reduce((n, r) => n + (have.has(r) ? 0 : RESEARCH[r].cost), 0);
  if (taCost && pool >= TA_POOL_MULT * taCost) {
    for (const r of TA) if (!have.has(r)) take(r);
  }
  // The product division saves for TA before anything else: products sell at MP
  // until TA2 prices them. Buying ADA and Drones on the way kept a live Tobacco
  // under the 140k bar for 2.5 hours.
  else if (taCost && product) return;
  for (const r of STAT_RESEARCH) if (ok(r) && RESEARCH[r].cost <= pool * STAT_SHARE) take(r);
  for (const r of PRODUCTION_RESEARCH) if (ok(r) && RESEARCH[r].cost <= pool * PRODUCTION_SHARE) take(r);

  if (!have.has("Market-TA.II")) return;
  const taOn = ctx.mem.taOn ?? new Set();
  if (product) {
    for (const n of d.products ?? []) {
      if (d.prods?.[n]?.developmentProgress >= 100 && !taOn.has(`${name}|${n}`)) push(ctx, "taProd", name, n);
    }
  } else {
    const makes = name === AGRI ? INDUSTRY.Agriculture.makes : INDUSTRY.Chemical.makes;
    for (const city of Object.keys(d.warehouses ?? {})) {
      for (const mat of makes) if (!taOn.has(`${name}|${city}|${mat}`)) push(ctx, "taMat", name, city, mat);
    }
  }
}

/** The key corp.js remembers a TA2 op by, so it is sent once per process. */
export function taKey(op) {
  return op[0] === "taProd" ? `${op[1]}|${op[2]}` : `${op[1]}|${op[2]}|${op[3]}`;
}
