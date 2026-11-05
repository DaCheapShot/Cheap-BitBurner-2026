import { loadScripts, assert, assertClose } from "./harness.mjs";
import { makeNs } from "./mockNs.mjs";

/**
 * The corporation planner. RAM pins live in tests/ram.test.mjs; this is the
 * arithmetic and the decisions in corp/math.js.
 *
 * The cost formulas are checked against the game's code transcribed a second
 * time, flat (a loop where math.js has a closed form), and the boost optimizer
 * against the quantities the Corporation manual publishes for its standard
 * strategy - numbers its author measured, not derived from this code.
 */

const mods = await loadScripts();
const M = mods["corp/math"];
const C = mods["corp/config"];

const JOB_ZERO = { Operations: 0, Engineer: 0, Business: 0, Management: 0, "Research & Development": 0 };

/** A full office, every job as given. */
const office = (size, jobs = {}) => ({
  size, numEmployees: size, avgEnergy: 100, avgMorale: 100, maxEnergy: 100, maxMorale: 100,
  jobs: { ...JOB_ZERO, ...jobs },
});

/** Materials a city of `industry` holds: boost materials as given, outputs on sale. */
function mats(industry, stored = {}, extra = {}) {
  const out = {};
  for (const m of C.BOOST_MATS) out[m] = { stored: stored[m] ?? 0, buyAmount: 0, marketPrice: 1, exports: [] };
  for (const m of C.INDUSTRY[industry].makes) {
    out[m] = { stored: 0, buyAmount: 0, marketPrice: 1, exports: [], desiredSellAmount: "MAX", desiredSellPrice: "MP" };
  }
  return { ...out, ...extra };
}

/** A division in every city, built by `city(c)`. */
function division(industry, { rp = 0, office: o = () => office(4), warehouse = () => wh(4, 520), stored = {}, ...rest } = {}) {
  const d = { industry, researchPoints: rp, numAdVerts: 2, products: [], maxProducts: 3, prods: {}, researched: [],
    offices: {}, warehouses: {}, mats: {}, ...rest };
  for (const c of C.CITIES) {
    d.offices[c] = o(c);
    d.warehouses[c] = warehouse(c);
    d.mats[c] = mats(industry, stored);
  }
  return d;
}
const wh = (level, size) => ({ level, size, sizeUsed: 0, smartSupplyEnabled: true });

/** A corp snapshot: READ_CORP's fields plus divs. */
function corp({ funds = 150e9, round = 1, divs = {}, upgrades = {}, unlocks = {}, ...rest } = {}) {
  return {
    funds, revenue: 0, expenses: 0, public: false, valuation: 10e9, dividendRate: 0,
    divisions: Object.keys(divs), offer: { funds: 0, round },
    upgrades: Object.fromEntries(Object.keys(C.UPGRADES).map((u) => [u, upgrades[u] ?? 0])),
    unlocks: { "Office API": true, "Warehouse API": true, ...unlocks },
    divs, ...rest,
  };
}

const kinds = (p) => p.ops.map((o) => o[0]);
const opsOf = (p, k) => p.ops.filter((o) => o[0] === k);

/**
 * A fake ns.corporation with the game's semantics where corp.js leans on them:
 * a new division has Sector-12's office and warehouse (createDivision counts
 * both), getWarehouse THROWS for a city without one, setJobAssignment only
 * moves Unassigned staff and lands at the next START (OfficeSpace), every
 * purchase checks funds, and a bad city or job name throws like EnumHelper.
 * Each nextUpdate is one whole cycle ending in START; RP grows 10 per cycle.
 */
function fakeCorp({ cycles, onCycle = () => {} }) {
  const JOBS = [...C.JOBS, "Unassigned"];
  const city = (c) => { if (!C.CITIES.includes(c)) throw new Error(`bad city ${c}`); return c; };
  let corp = null;
  let n = 0;
  const newOffice = () => ({ size: 3, numEmployees: 0, avgEnergy: 100, avgMorale: 100, maxEnergy: 100, maxMorale: 100,
    jobs: Object.fromEntries(JOBS.map((j) => [j, 0])), next: Object.fromEntries(JOBS.map((j) => [j, 0])) });
  const newWarehouse = () => ({ level: 1, size: 100, sizeUsed: 0, smartSupplyEnabled: false,
    mats: Object.fromEntries([...C.BOOST_MATS, "Plants", "Food", "Chemicals", "Water"].map((m) =>
      [m, { stored: 0, buyAmount: 0, marketPrice: 1, exports: [], desiredSellAmount: 0, desiredSellPrice: "" }])) });
  const spend = (x) => { if (corp.funds < x) throw new Error(`cannot afford ${x}`); corp.funds -= x; };
  const div = (d) => { const v = corp.divs[d]; if (!v) throw new Error(`No division named '${d}'`); return v; };
  const off = (d, c) => { const o = div(d).offices[city(c)]; if (!o) throw new Error("no office"); return o; };
  const ware = (d, c) => { const w = div(d).warehouses[city(c)]; if (!w) throw new Error(`no warehouse in '${c}'`); return w; };
  const api = {
    hasCorporation: () => corp !== null,
    canCreateCorporation: () => (corp ? "CorporationExists" : "Success"),
    createCorporation: () => { corp = { funds: 150e9, divs: {}, unlocks: new Set(["Office API", "Warehouse API"]),
      upgrades: Object.fromEntries(Object.keys(C.UPGRADES).map((u) => [u, 0])), round: 1 }; return true; },
    nextUpdate: async () => {
      if (++n > cycles) throw new Error("STOP");
      for (const d of Object.values(corp?.divs ?? {})) {
        d.researchPoints += 10;
        for (const o of Object.values(d.offices)) o.jobs = { ...o.next };
        for (const w of Object.values(d.warehouses)) for (const m of Object.values(w.mats)) m.stored += m.buyAmount * 10;
      }
      onCycle(n, corp);
      return "START";
    },
    getCorporation: () => ({ funds: corp.funds, revenue: 0, expenses: 0, public: false, valuation: 1e10,
      dividendRate: 0, divisions: Object.keys(corp.divs) }),
    getInvestmentOffer: () => ({ funds: 1e9, shares: 0, round: corp.round }),
    getUpgradeLevel: (u) => corp.upgrades[u],
    hasUnlock: (u) => corp.unlocks.has(u),
    getDivision: (d) => {
      const v = div(d);
      return { industry: v.industry, cities: Object.keys(v.offices), researchPoints: v.researchPoints, numAdVerts: v.adverts,
        products: [], maxProducts: 3, awareness: 0, popularity: 0 };
    },
    getOffice: (d, c) => { const o = off(d, c); return { ...o, employeeJobs: { ...o.jobs } }; },
    getWarehouse: (d, c) => { const w = ware(d, c); return { level: w.level, size: w.size, sizeUsed: 0, smartSupplyEnabled: w.smartSupplyEnabled }; },
    getMaterial: (d, c, m) => ({ ...ware(d, c).mats[m] }),
    getProduct: () => { throw new Error("no products"); },
    hasResearched: () => false,
    expandIndustry: (ind, name) => {
      spend(C.INDUSTRY[ind].cost);
      corp.divs[name] = { industry: ind, researchPoints: 0, adverts: 0,
        offices: { "Sector-12": newOffice() }, warehouses: { "Sector-12": newWarehouse() } };
    },
    expandCity: (d, c) => { spend(C.OFFICE_COST); div(d).offices[city(c)] = newOffice(); },
    purchaseWarehouse: (d, c) => { spend(C.WAREHOUSE_COST); div(d).warehouses[city(c)] = newWarehouse(); },
    purchaseUnlock: (u) => { spend(C.UNLOCK_COST[u]); corp.unlocks.add(u); },
    setSmartSupply: (d, c, on) => { if (!corp.unlocks.has("Smart Supply")) throw new Error("no Smart Supply"); ware(d, c).smartSupplyEnabled = on; },
    levelUpgrade: (u) => { spend(M.upgradeCost(u, corp.upgrades[u], 1)); corp.upgrades[u]++; },
    upgradeWarehouse: (d, c, k) => { const w = ware(d, c); spend(M.warehouseCost(w.level, k)); w.level += k; w.size = w.level * 100 * (1 + 0.1 * corp.upgrades["Smart Storage"]); },
    hireAdVert: (d) => { const v = div(d); spend(M.advertCost(v.adverts, 1)); v.adverts++; },
    upgradeOfficeSize: (d, c, k) => { const o = off(d, c); spend(M.officeCost(o.size, k)); o.size += k; },
    hireEmployee: (d, c) => { const o = off(d, c); if (o.numEmployees >= o.size) return false; o.numEmployees++; o.next.Unassigned++; return true; },
    setJobAssignment: (d, c, job, amount) => {
      const o = off(d, c);
      if (!JOBS.includes(job)) throw new Error(`bad job ${job}`);
      const more = amount - o.next[job];
      if (o.next.Unassigned < more) throw new Error(`Unable to bring '${job} employees to ${amount}`);
      o.next[job] = amount;
      o.next.Unassigned -= more;
      return true;
    },
    buyTea: () => true,
    throwParty: () => 1,
    buyMaterial: (d, c, m, rate) => { if (!(rate >= 0)) throw new Error("bad rate"); ware(d, c).mats[m].buyAmount = rate; },
    sellMaterial: (d, c, m, amt, price) => { const x = ware(d, c).mats[m]; x.desiredSellAmount = amt; x.desiredSellPrice = price; },
  };
  return { api, state: () => corp };
}

/** corp.js's main(), run for `cycles` corp cycles against fakeCorp. */
async function runCorp(cycles) {
  const fake = fakeCorp({ cycles });
  const ns = makeNs({ hosts: { home: 4096 }, extra: { corporation: fake.api, getServerMoneyAvailable: () => 0 } });
  try { await mods["corp/corp"].main(ns); } catch (e) { if (e.message !== "STOP") throw e; }
  return { corp: fake.state(), read: (f) => ns.read(f) };
}

export const tests = {
  // ------------------------------------------------------------ formulas ----

  "upgrade, warehouse, office and advert costs match the game's series": () => {
    for (const [name, { base, mult }] of Object.entries(C.UPGRADES)) {
      for (const level of [0, 3, 20]) {
        let flat = 0;
        for (let i = 0; i < 7; i++) flat += base * mult ** (level + i);
        assertClose(M.upgradeCost(name, level, 7), flat, flat * 1e-9, `${name} from ${level}`);
      }
    }
    // Actions.ts upgradeWarehouseCost: 1e9 * 1.07^(level + 1 + i), summed.
    for (const level of [1, 4, 16]) {
      let flat = 0;
      for (let i = 0; i < 5; i++) flat += 1e9 * 1.07 ** (level + 1 + i);
      assertClose(M.warehouseCost(level, 5), flat, flat * 1e-9, `warehouse from ${level}`);
    }
    // helpers.ts calculateOfficeSizeUpgradeCost, written out as the game does.
    for (const [size, inc] of [[3, 1], [4, 4], [30, 15]]) {
      const game = (4e9 / 0.09) * (1 + 0.09) ** (size / 3) * ((1 + 0.09) ** (inc / 3) - 1);
      assertClose(M.officeCost(size, inc), game, game * 1e-9, `office ${size}+${inc}`);
    }
    let ad = 0;
    for (let i = 0; i < 6; i++) ad += 1e9 * 1.06 ** (2 + i);
    assertClose(M.advertCost(2, 6), ad, ad * 1e-9, "advert");
  },

  "every max-affordable count buys within budget and one more would not": () => {
    const cases = [
      [(n) => M.upgradeCost("Smart Storage", 5, n), (b) => M.maxUpgrades("Smart Storage", 5, b)],
      [(n) => M.upgradeCost("Wilson Analytics", 2, n), (b) => M.maxUpgrades("Wilson Analytics", 2, b)],
      [(n) => M.warehouseCost(4, n), (b) => M.maxWarehouse(4, b)],
      [(n) => M.officeCost(9, n), (b) => M.maxOffice(9, b)],
      [(n) => M.advertCost(8, n), (b) => M.maxAdvert(8, b)],
    ];
    for (const [cost, max] of cases) {
      for (const budget of [0, 1e9, 7.3e9, 1e11, 4.2e12]) {
        const n = max(budget);
        assert(n >= 0 && cost(n) <= budget, `max ${n} over budget ${budget}`);
        assert(cost(n + 1) > budget, `max ${n} leaves ${n + 1} affordable at ${budget}`);
      }
    }
  },

  // The manual's standard strategy quantities (section 19). 0.84 of a 520
  // warehouse is round 1 without custom Smart Supply; round 2 is 0.76 of 5950
  // (Agriculture) and 0.95 of 700 (Chemical).
  "the boost optimizer reproduces the manual's published quantities": () => {
    const near = (got, want, what) => want.forEach((w, i) =>
      assert(Math.abs(got[i] - w) <= Math.max(2, w * 0.005), `${what} ${C.BOOST_MATS[i]}: ${got[i]} vs ${w}`));
    near(M.boostTargets(C.INDUSTRY.Agriculture.boost, 520 * 0.84), [777, 919, 60794, 0], "round 1 Agriculture");
    near(M.boostTargets(C.INDUSTRY.Agriculture.boost, 5950 * 0.76), [9081, 10146, 459400, 1416], "round 2 Agriculture");
    near(M.boostTargets(C.INDUSTRY.Chemical.boost, 700 * 0.95), [1717, 3194, 54917, 54], "round 2 Chemical");
  },

  // Optimal, not just plausible: no shift of space between two materials does better.
  "no small shift between boost materials improves the optimum": () => {
    const f = C.INDUSTRY.Tobacco.boost;
    const value = (x) => x.reduce((p, v, i) => p * (1 + 0.002 * v) ** f[i], 1);
    const space = 2000;
    const x = M.boostTargets(f, space);
    const used = x.reduce((n, v, i) => n + v * C.BOOST_SIZE[i], 0);
    assert(used <= space + 1e-6 && used > space * 0.99, `uses ${used} of ${space}`);
    const best = value(x);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j || x[i] < 10) continue;
        const y = [...x];
        const moved = 10 * C.BOOST_SIZE[i];
        y[i] -= 10;
        y[j] += moved / C.BOOST_SIZE[j];
        // 1e-4: the targets are floored to whole units, which can leave up to
        // one unit of each material's space (0.5 for Robots) unused.
        assert(value(y) <= best * (1 + 1e-4), `moving ${C.BOOST_MATS[i]} -> ${C.BOOST_MATS[j]} improves it`);
      }
    }
  },

  "jobs split sums to the office and follows the ratios": () => {
    for (const n of [1, 4, 9, 30, 1003]) {
      const j = M.jobsFor(n, C.SUPPORT_JOBS, Math.round(n * C.SUPPORT_RND));
      assert(Object.values(j).reduce((a, b) => a + b, 0) === n, `${n}: ${JSON.stringify(j)}`);
    }
    const j = M.jobsFor(1000, C.SUPPORT_JOBS, 200);
    assert(j["Research & Development"] === 200 && Math.abs(j.Engineer - 506) <= 1 && j.Business === 0, JSON.stringify(j));
    assert(M.jobsFor(4, {}, 4)["Research & Development"] === 4, "all R&D");
  },

  // ------------------------------------------------------------- offers ----

  "an offer waits for the window, then takes the target, a plateau, or the deadline": () => {
    const rise = Array.from({ length: C.OFFER_WAIT - 1 }, (_, i) => (i + 1) * 1e9);
    assert(!M.takeOffer(rise, 1), "taken before OFFER_WAIT cycles");
    assert(M.takeOffer([...rise, C.OFFER_TARGET[1]], 1), "target reached, not taken");
    const climbing = Array.from({ length: C.OFFER_WAIT + 2 }, (_, i) => (i + 1) * 1e9);
    assert(!M.takeOffer(climbing, 1), "taken while still rising");
    const flat = [...climbing, ...Array(C.OFFER_PLATEAU).fill(1e9)];
    assert(M.takeOffer(flat, 1), "a plateau must be taken");
    const slow = Array.from({ length: C.OFFER_MAX_WAIT }, (_, i) => (i + 1) * 1e6);
    assert(M.takeOffer(slow, 1), "the deadline must take it");
  },

  "dividends ramp from DIV_MIN when profit grows fast to DIV_MAX when flat": () => {
    const series = (from, to) => Array.from({ length: C.DIV_WINDOW }, (_, i) => from * (to / from) ** (i / (C.DIV_WINDOW - 1)));
    assert(M.dividendRate([1, 2, 3]) === C.DIV_MIN, "too little history");
    assertClose(M.dividendRate(series(1e9, 1e12)), C.DIV_MIN, 1e-9, "fast growth");
    assertClose(M.dividendRate(series(1e12, 1e12)), C.DIV_MAX, 1e-9, "flat");
    const mid = M.dividendRate(series(1e12, 1e12 * Math.sqrt(C.DIV_FAST)));
    assertClose(mid, (C.DIV_MIN + C.DIV_MAX) / 2, 0.05, "half-speed growth (tenth-means span 0.9 of the window)");
    // Flat profit with one-pass spikes either end must still read flat.
    const noisy = series(1e12, 1e12);
    noisy[0] = 1e10;
    noisy[noisy.length - 1] = 1e14;
    assert(M.dividendRate(noisy) > 0.8, `one-pass spikes moved the rate to ${M.dividendRate(noisy)}`);
  },

  // --------------------------------------------------------------- plan ----

  // Outside BN3 without SF3.3 every office and warehouse call throws, so the
  // two APIs come before anything else.
  "the Office and Warehouse APIs are bought before anything else": () => {
    const p = M.plan(corp({ funds: 400e9, unlocks: { "Office API": false, "Warehouse API": false } }));
    assert(JSON.stringify(p.ops.slice(0, 2)) === JSON.stringify([["unlock", "Office API"], ["unlock", "Warehouse API"]]),
      JSON.stringify(p.ops));
    const broke = M.plan(corp({ funds: 60e9, unlocks: { "Office API": false, "Warehouse API": false } }));
    assert(JSON.stringify(broke.ops) === JSON.stringify([["unlock", "Office API"]]), "nothing else until both are owned");
  },

  "round 1 opens Agriculture, then its cities, then Smart Supply": () => {
    const open = M.plan(corp());
    assert(JSON.stringify(open.ops) === JSON.stringify([["industry", "Agriculture", "Agriculture"]]), JSON.stringify(open.ops));

    // A new division has Sector-12 only.
    const d = division("Agriculture");
    for (const c of C.CITIES.slice(1)) {
      delete d.offices[c];
      delete d.warehouses[c];
    }
    const cities = M.plan(corp({ funds: 110e9, divs: { Agriculture: d } }));
    assert(opsOf(cities, "city").length === 5, `cities: ${JSON.stringify(cities.ops)}`);
    assert(!kinds(cities).includes("unlock"), "Smart Supply before the cities are open");
  },

  "round 1: R&D until 55 RP, then 1/1/1/1 and the boost materials": () => {
    const early = division("Agriculture", { rp: 10, office: () => office(3, { Operations: 3 }) });
    const p = M.plan(corp({ funds: 40e9, divs: { Agriculture: early }, unlocks: { "Smart Supply": true } }));
    const jobs = opsOf(p, "jobs");
    assert(jobs.length === 6 && jobs.every((o) => o[3]["Research & Development"] === 4), JSON.stringify(jobs));
    assert(opsOf(p, "size").length === 6 && opsOf(p, "hire").length === 6, "office 3 -> 4 and hire");
    assert(!kinds(p).includes("buy"), "boost materials before the RP");
    assert(opsOf(p, "upgrade").some((o) => o[1] === "Smart Storage"), "Smart Storage");
    assert(!p.setupDone, "setup done while waiting on RP");

    const ready = division("Agriculture", { rp: 60,
      office: () => office(4, { Operations: 1, Engineer: 1, Business: 1, Management: 1 }) });
    const q = M.plan(corp({ funds: 0, divs: { Agriculture: ready }, unlocks: { "Smart Supply": true },
      upgrades: { "Smart Storage": 3 } }));
    const buys = opsOf(q, "buy");
    assert(buys.length === 18, `three boost materials (no Robots) in six cities, got ${buys.length}`);
    const re = buys.find((o) => o[1] === "Agriculture" && o[3] === "Real Estate");
    assertClose(re[4] * 10, 60794, 2, "Real Estate bought per second for one cycle");
    assert(!q.setupDone, "not done until stocked");

    // Stocked: the buys are cleared and the round is ready for its offer.
    const t = M.boostTargets(C.INDUSTRY.Agriculture.boost, 520 * 0.84);
    const stocked = division("Agriculture", { rp: 60,
      office: () => office(4, { Operations: 1, Engineer: 1, Business: 1, Management: 1 }),
      stored: Object.fromEntries(C.BOOST_MATS.map((m, i) => [m, t[i]])) });
    for (const c of C.CITIES) stocked.mats[c]["Real Estate"].buyAmount = 6079.4;
    const r = M.plan(corp({ funds: 0, divs: { Agriculture: stocked }, unlocks: { "Smart Supply": true },
      upgrades: { "Smart Storage": 3 } }));
    assert(opsOf(r, "buy").every((o) => o[4] === 0) && opsOf(r, "buy").length === 6, "the per-second buy must be cleared");
    assert(r.setupDone, `setup should be done: ${r.notes}`);
  },

  "round 2 buys Export, opens Chemical and routes Plants and Chemicals both ways": () => {
    const agri = division("Agriculture", { rp: 100, office: () => office(4, { "Research & Development": 4 }) });
    const first = M.plan(corp({ round: 2, funds: 500e9, divs: { Agriculture: agri }, unlocks: { "Smart Supply": true } }));
    assert(kinds(first).includes("unlock") && opsOf(first, "unlock")[0][1] === "Export", "Export first");
    assert(opsOf(first, "industry").some((o) => o[1] === "Chemical"), JSON.stringify(first.ops));

    const chem = division("Chemical", { rp: 50, office: () => office(3, { "Research & Development": 3 }), warehouse: () => wh(2, 700) });
    const p = M.plan(corp({ round: 2, funds: 300e9, divs: { Agriculture: agri, Chemical: chem },
      unlocks: { "Smart Supply": true, "Export": true } }));
    const ex = opsOf(p, "export");
    assert(ex.filter((o) => o[0] === "export" && o[1] === "Agriculture" && o[5] === "Plants").length === 6, "Plants -> Chemical");
    assert(ex.filter((o) => o[1] === "Chemical" && o[5] === "Chemicals").length === 6, "Chemicals -> Agriculture");
    assert(ex.every((o) => o[6] === C.EXPORT_STRING), "the manual's export string");
    assert(!kinds(p).includes("buy"), "boosts wait for 700/390 RP");
  },

  // Exports are served FIFO, so Tobacco's route must come before Chemical's.
  "round 3 opens Tobacco and puts its Plants export ahead of Chemical's": () => {
    const agri = division("Agriculture", { rp: 900, office: () => office(8) });
    for (const c of C.CITIES) agri.mats[c].Plants = { ...agri.mats[c].Plants, exports: [{ division: "Chemical", city: c }] };
    const chem = division("Chemical", { rp: 400, office: () => office(3), warehouse: () => wh(2, 700) });
    const tob = division("Tobacco", { office: () => office(3), products: [] });
    const p = M.plan(corp({ round: 3, funds: 10e12, divs: { Agriculture: agri, Chemical: chem, Tobacco: tob },
      unlocks: { "Smart Supply": true, "Export": true } }));
    const s12 = p.ops.filter((o) => (o[0] === "export" || o[0] === "unexport") && o[1] === "Agriculture" && o[2] === "Sector-12");
    assert(s12[0][0] === "unexport" && s12[0][3] === "Chemical", JSON.stringify(s12));
    assert(s12[1][3] === "Tobacco" && s12[2][3] === "Chemical", `Tobacco first: ${JSON.stringify(s12)}`);
    const make = opsOf(p, "make");
    assert(make.length === 1 && make[0][2] === "Sector-12" && make[0][3] === "Tobacco-1", JSON.stringify(make));
    assert(!kinds(p).includes("lab"), "no research in round 3");
    assert(opsOf(p, "industry").some((o) => o[1] === "Restaurant"), "a dummy division once funds allow");
  },

  "a full shelf drops the worst product before designing the next": () => {
    const prods = {
      "Tobacco-1": { developmentProgress: 100, rating: 50, desiredSellAmount: "MAX" },
      "Tobacco-2": { developmentProgress: 100, rating: 10, desiredSellAmount: "MAX" },
      "Tobacco-3": { developmentProgress: 100, rating: 90, desiredSellAmount: 0 },
    };
    const tob = division("Tobacco", { office: () => office(30), products: Object.keys(prods), prods });
    const agri = division("Agriculture", { office: () => office(8) });
    const chem = division("Chemical", { office: () => office(3) });
    // Round 5: past the offers, so nothing is frozen for one.
    const p = M.plan(corp({ round: 5, funds: 1e15, divs: { Agriculture: agri, Chemical: chem, Tobacco: tob },
      unlocks: { "Smart Supply": true, "Export": true } }));
    assert(JSON.stringify(opsOf(p, "drop")) === JSON.stringify([["drop", "Tobacco", "Tobacco-2"]]), JSON.stringify(opsOf(p, "drop")));
    assert(opsOf(p, "make")[0]?.[3] === "Tobacco-4", JSON.stringify(opsOf(p, "make")));
    assert(JSON.stringify(opsOf(p, "psell")) === JSON.stringify([["psell", "Tobacco", "Tobacco-3", "MAX", "MP"]]), "unsold product");
  },

  // FundsSource.ts: office, warehouse, upgrades and product development are
  // long-term sources, and a cycle with one has assetDelta <= 0 - the private
  // valuation's 315e3x term then counts nothing. Live: round 3 $5.53t, round 4 $6.62t.
  "while a round 3 or 4 offer is watched, nothing counted as capital spending is bought": () => {
    const prods = {
      "Tobacco-1": { developmentProgress: 100, rating: 50, desiredSellAmount: "MAX" },
      "Tobacco-2": { developmentProgress: 100, rating: 60, desiredSellAmount: "MAX" },
    };
    const divs = () => ({ Agriculture: division("Agriculture", { office: () => office(8) }),
      Chemical: division("Chemical", { office: () => office(3) }),
      Tobacco: division("Tobacco", { office: () => office(30), products: Object.keys(prods), prods }) });
    const u = { "Smart Supply": true, "Export": true };
    const w = M.plan(corp({ round: 4, funds: 1e15, divs: divs(), unlocks: u }));
    assert(w.setupDone, "two products finished: round 4 is watched");
    for (const k of ["size", "upgrade", "whUp", "make", "industry", "city", "warehouse"]) {
      assert(!kinds(w).includes(k), `${k} bought while watching: ${JSON.stringify(opsOf(w, k))}`);
    }
    assert(kinds(w).includes("jobs"), "the profit job split still goes in");
    const r = M.plan(corp({ round: 3, funds: 1e15, divs: { ...divs(), Tobacco: division("Tobacco",
      { office: () => office(30), products: ["Tobacco-1"], prods: { "Tobacco-1": { developmentProgress: 40 } } }) }, unlocks: u }));
    assert(!r.setupDone && kinds(r).includes("size"), "still building before the first product: spends");
  },

  // Live: $1.47e99 funds spent every pass, valuation pinned at the game's $10b
  // floor, bribes never opened. Public valuation counts negative assetDelta.
  "public and rich, a pass spends under half the retained profit, never the funds": () => {
    const divs = () => ({ Agriculture: division("Agriculture", { office: () => office(8) }),
      Chemical: division("Chemical", { office: () => office(3) }),
      Tobacco: division("Tobacco", { office: () => office(30), products: [] }) });
    const u = { "Smart Supply": true, "Export": true };
    const priced = (p) => p.ops.some((o) => ["size", "upgrade", "whUp", "advert", "make"].includes(o[0]));
    const s = (funds, dividendRate = 0) => corp({ round: 5, public: true, funds, revenue: 2e20, expenses: 1e20,
      dividendRate, divs: divs(), unlocks: u });
    assert(priced(M.plan(s(1e30))), "still buys from profit");
    const none = M.plan(corp({ round: 5, public: true, funds: 1e30, revenue: 1e20, expenses: 2e20, divs: divs(), unlocks: u }));
    assert(!priced(none), `a loss leaves nothing to spend: ${JSON.stringify(none.ops.filter((o) => o[0] === "size"))}`);
    const poor = M.plan(corp({ round: 5, public: true, funds: 1e15, revenue: 1e10, expenses: 0, divs: divs(), unlocks: u }));
    assert(priced(poor) && opsOf(poor, "size").length, "under CAPEX_CAP_FUNDS the funds still go in");
  },

  "Tobacco saves its RP for both TAs before any other research": () => {
    const lab = ["Hi-Tech R&D Laboratory"];
    const plan = (rp) => M.plan(corp({ round: 5, funds: 1e15, unlocks: { "Smart Supply": true, "Export": true },
      divs: { Agriculture: division("Agriculture"), Chemical: division("Chemical"),
        Tobacco: division("Tobacco", { office: () => office(30), rp, researched: lab }) } }));
    const labs = (p) => opsOf(p, "lab").filter((o) => o[1] === "Tobacco").map((o) => o[2]);
    assert(labs(plan(100e3)).length === 0, `bought under the TA bar: ${labs(plan(100e3))}`);
    const got = labs(plan(150e3));
    assert(got[0] === "Market-TA.I" && got[1] === "Market-TA.II", JSON.stringify(got));
  },

  "after the fourth round it lists with no shares issued": () => {
    const tob = division("Tobacco", { office: () => office(30) });
    const p = M.plan(corp({ round: 5, funds: 1e20, divs: { Agriculture: division("Agriculture"),
      Chemical: division("Chemical"), Tobacco: tob }, unlocks: { "Smart Supply": true, "Export": true } }));
    assert(JSON.stringify(opsOf(p, "public")) === JSON.stringify([["public", 0]]), JSON.stringify(opsOf(p, "public")));
  },

  // corp.js's real loop and every body it runs, against the fake: founding,
  // the six cities, Smart Supply, the office, R&D to 55 RP, the job switch, and
  // the boost materials landing. A body with its arguments in the wrong order
  // shows up here as a WARN in the history file.
  "corp.js founds the corporation and plays round 1 to its boost materials": async () => {
    const r = await runCorp(14);
    const a = r.corp?.divs?.Agriculture;
    assert(a, "Agriculture was never opened");
    assert(Object.keys(a.offices).length === 6 && Object.keys(a.warehouses).length === 6, "six cities with warehouses");
    assert(r.corp.unlocks.has("Smart Supply"), "Smart Supply");
    assert(Object.values(a.warehouses).every((w) => w.smartSupplyEnabled), "Smart Supply on everywhere");
    for (const o of Object.values(a.offices)) {
      assert(o.size === 4 && o.numEmployees === 4, `office ${o.size}/${o.numEmployees}`);
      assert(o.jobs.Operations === 1 && o.jobs.Engineer === 1 && o.jobs.Business === 1 && o.jobs.Management === 1,
        `jobs after 55 RP: ${JSON.stringify(o.jobs)}`);
    }
    const re = a.warehouses["Sector-12"].mats["Real Estate"];
    assert(re.stored > 0, "boost materials never landed");
    const log = r.read(C.HISTORY_FILE);
    assert(!log.includes("WARN"), `a body refused an op:\n${log}`);
    assert(log.includes("founded") && log.includes("opened Agriculture"), log);
    const st = JSON.parse(r.read(C.CORP_STATE_FILE));
    assert(st.reserveGb === C.CORP_BODY_GB && st.homeWant === C.CORP_HOME_GB, JSON.stringify(st));
    assert(st.round === 1 && st.public === false && typeof st.waiting === "string", `hud fields: ${JSON.stringify(st)}`);
    assert(r.read(C.STATUS_FILE).startsWith("stage 1"), r.read(C.STATUS_FILE));
  },

  "corpState passes the hud's fields and stays inert on junk": () => {
    const st = C.corpState(JSON.stringify({ valuation: 2e14, round: 3, offer: 5.5e12, profit: -4, public: false,
      waiting: "Tobacco: 0/1 products" }));
    assert(st.round === 3 && st.offer === 5.5e12 && st.profit === -4 && st.waiting === "Tobacco: 0/1 products", JSON.stringify(st));
    const junk = C.corpState("{not json");
    assert(junk.round === 0 && junk.public === false && junk.waiting === "" && junk.profit === 0, JSON.stringify(junk));
    assert(C.corpState('{"public":"yes","waiting":7}').public === false, "only a real true is public");
  },

  "the hud shows the round and its wait before public, profit and bribes after": () => {
    const H = mods["hud"];
    const money = (n) => `$${n}`;
    const st = (o) => C.corpState(JSON.stringify(o));
    assert(H.corpRows(st({}), money).length === 0, "no corp, no rows");
    const r3 = H.corpRows(st({ round: 3, offer: 5, waiting: "x".repeat(60) }), money);
    assert(r3[0][0] === "Corp" && r3[0][1] === "R3 · $5", JSON.stringify(r3));
    assert(r3[1][0] === "Corp wait" && r3[1][1].length === 22 && r3[1][1].endsWith("…"), JSON.stringify(r3));
    const pre = H.corpRows(st({ round: 3, offer: 5, waiting: "round 3: 0/1 products" }), money);
    assert(pre[1][1] === "0/1 products", `the round prefix stays on the Corp row: ${JSON.stringify(pre)}`);
    assert(H.corpRows(st({ round: 1, offer: 1 }), money).length === 1, "nothing waited on, no wait row");
    const pub = (valuation) => H.corpRows(st({ public: true, round: 5, profit: 9, valuation }), money);
    assert(JSON.stringify(pub(1e13)) === JSON.stringify([["Corp", "$9/s"]]), JSON.stringify(pub(1e13)));
    assert(pub(C.BRIBE_VALUATION)[0][1] === "$9/s · bribes", JSON.stringify(pub(C.BRIBE_VALUATION)));
  },

  // The plan never spends what it does not have, however much it wants.
  "no pass plans to spend more than the corp holds": () => {
    for (const funds of [0, 5e9, 60e9, 300e9, 2e12, 1e16]) {
      for (const round of [1, 2, 3, 4, 5]) {
        const s = corp({ round, funds, divs: { Agriculture: division("Agriculture", { rp: 1e5 }),
          Chemical: division("Chemical", { rp: 1e5 }), Tobacco: division("Tobacco") },
          unlocks: { "Smart Supply": true, "Export": true } });
        const p = M.plan(s);
        let spent = 0;
        for (const o of p.ops) {
          if (o[0] === "industry") spent += C.INDUSTRY[o[1]].cost;
          if (o[0] === "city") spent += C.OFFICE_COST;
          if (o[0] === "warehouse") spent += C.WAREHOUSE_COST;
          if (o[0] === "make") spent += o[4] + o[5];
        }
        assert(spent <= funds + 1e-6, `round ${round} at ${funds}: plans ${spent}`);
      }
    }
  },
};
