import {
  CORP_STATE_FILE, STATUS_FILE, HISTORY_FILE, HISTORY_KEEP, CORP_BODY_GB, CORP_HOME_GB, CORP_NAME,
  DUMMY_PREFIX, APIS, OFFER_TARGET, DIV_WINDOW, DIV_STEP, SELF_FUND_COST,
} from "./config.js";
import { plan, takeOffer, dividendRate, BODY_OF, BODY_ORDER, taKey } from "./math.js";
import { rpc } from "scripts/rpc.js";
import { SETTINGS_FILE, setting } from "scripts/settings.js";

/**
 * The corporation supervisor: a resident loop that acts once per corp cycle.
 * BitNode 3, or anywhere with Source-File 3 - boot.js asks once and starts it
 * only there.
 *
 * WHY THIS SHAPE. Every ns.corporation function is 10 GB (a read) or 20 GB (an
 * action) and the strategy needs ~45 of them: ~700 GB held together. So this
 * file holds none (1.60 + run 1.00 + getServerMoneyAvailable 0.10 = 2.70; the
 * names it does use - hasCorporation, canCreateCorporation, nextUpdate - are
 * 0 GB). Two READ bodies take a snapshot, corp/math.js plans the whole pass
 * from it, and the ops run through ten action bodies grouped so none passes
 * CORP_BODY_GB. rpc() runs one body at a time, so the max is what home needs,
 * and the manager leaves it free there (CORP_STATE_FILE.reserveGb).
 *
 * ONCE PER CYCLE, AT START. nextUpdate() is 0 GB and resolves after each of the
 * five states; a pass runs when START has just happened. Job changes apply at
 * the NEXT START and a per-second buy runs at PURCHASE, so acting right after
 * START gives every change one full cycle before it is read back.
 *
 * NO STATE FILE OF ITS OWN. The plan is derived from the corp every pass -
 * funding round, divisions, RP, products - so a restart picks up where it left
 * off. What it keeps in memory is only what the game does not hold: the offers
 * seen since a round's setup finished (takeOffer), recent profit (dividends),
 * and which TA2 switches it already sent.
 *
 * The status is /data/corp.txt, rewritten every pass; what happened goes to
 * /data/corp.log.txt. Nothing to the terminal but offers taken and going public.
 *
 * RAM: 1.60 base + run 1.00 + getServerMoneyAvailable 0.10 = 2.70 GB
 */

// ------------------------------------------------------------------ bodies ---
//
// Plain template literals (rpc rejects interpolation; tests/rpc.test.mjs parses
// them, tests/ram.test.mjs prices them). Each action body runs a list of ops
// and returns one string per op: "" for done, the game's error otherwise - a
// refused op must not stop the ones after it.

/** Seed money in BN3 ("seed"), the player's $150b anywhere else ("self"). */
const CREATE = `
return ns.corporation.createCorporation(args[0], args[1] === "self");
`;

/** The corporation-wide half of the snapshot. */
const READ_CORP = `
import { UPGRADES, UNLOCK_COST } from "/scripts/corp/config.js";
const c = ns.corporation;
const k = c.getCorporation();
const o = c.getInvestmentOffer();
const upgrades = {};
for (const u of Object.keys(UPGRADES)) upgrades[u] = c.getUpgradeLevel(u);
const unlocks = {};
for (const u of Object.keys(UNLOCK_COST)) unlocks[u] = c.hasUnlock(u);
return {
  funds: k.funds, revenue: k.revenue, expenses: k.expenses, public: k.public, valuation: k.valuation,
  dividendRate: k.dividendRate, divisions: k.divisions, offer: { funds: o.funds, round: o.round },
  upgrades, unlocks,
};
`;

/**
 * Every division named in args[0] ([name, full] pairs). A dummy is read light:
 * its cities and warehouses, which is all the plan asks of it. A missing
 * warehouse THROWS in getWarehouse, so it is caught and left out.
 */
const READ_DIV = `
import { BOOST_MATS, INDUSTRY, RESEARCH, MAIN_CITY } from "/scripts/corp/config.js";
const c = ns.corporation;
const out = {};
for (const [name, full] of JSON.parse(args[0])) {
  const d = c.getDivision(name);
  const r = {
    industry: d.industry, cities: d.cities, researchPoints: d.researchPoints, numAdVerts: d.numAdVerts,
    products: d.products, maxProducts: d.maxProducts, awareness: d.awareness, popularity: d.popularity,
    offices: {}, warehouses: {}, mats: {}, prods: {}, researched: [],
  };
  for (const city of d.cities) {
    if (full) {
      const o = c.getOffice(name, city);
      r.offices[city] = {
        size: o.size, numEmployees: o.numEmployees, avgEnergy: o.avgEnergy, avgMorale: o.avgMorale,
        maxEnergy: o.maxEnergy, maxMorale: o.maxMorale, jobs: o.employeeJobs,
      };
    } else r.offices[city] = { size: 0, numEmployees: 0 };
    let w = null;
    try { w = c.getWarehouse(name, city); } catch { w = null; }
    if (!w) continue;
    r.warehouses[city] = { level: w.level, size: w.size, sizeUsed: w.sizeUsed, smartSupplyEnabled: w.smartSupplyEnabled };
    if (!full) continue;
    const mats = {};
    for (const m of [...BOOST_MATS, ...(INDUSTRY[d.industry]?.makes ?? [])]) {
      const x = c.getMaterial(name, city, m);
      mats[m] = {
        stored: x.stored, buyAmount: x.buyAmount, marketPrice: x.marketPrice, exports: x.exports,
        desiredSellAmount: x.desiredSellAmount, desiredSellPrice: x.desiredSellPrice,
      };
    }
    r.mats[city] = mats;
  }
  if (full) {
    for (const p of d.products) {
      const x = c.getProduct(name, MAIN_CITY, p);
      r.prods[p] = {
        developmentProgress: x.developmentProgress, rating: x.rating, effectiveRating: x.effectiveRating,
        desiredSellAmount: x.desiredSellAmount, desiredSellPrice: x.desiredSellPrice,
      };
    }
    for (const n of Object.keys(RESEARCH)) {
      try { if (c.hasResearched(name, n)) r.researched.push(n); } catch { /* not in this tree */ }
    }
  }
  out[name] = r;
}
return out;
`;

/** New divisions, offices and warehouses. */
const SETUP = `
const c = ns.corporation;
const out = [];
for (const [op, ...a] of JSON.parse(args[0])) {
  try {
    if (op === "industry") c.expandIndustry(a[0], a[1]);
    else if (op === "city") c.expandCity(a[0], a[1]);
    else if (op === "warehouse") c.purchaseWarehouse(a[0], a[1]);
    else throw new Error("not a SETUP op: " + op);
    out.push("");
  } catch (e) { out.push(String(e?.message ?? e)); }
}
return out;
`;

/** One-time unlocks, and Smart Supply switched on per warehouse. */
const UNLOCK = `
const c = ns.corporation;
const out = [];
for (const [op, ...a] of JSON.parse(args[0])) {
  try {
    if (op === "unlock") c.purchaseUnlock(a[0]);
    else if (op === "smart") c.setSmartSupply(a[0], a[1], true);
    else throw new Error("not an UNLOCK op: " + op);
    out.push("");
  } catch (e) { out.push(String(e?.message ?? e)); }
}
return out;
`;

/** Levelled upgrades, warehouse levels and Advert. */
const UPGRADE = `
const c = ns.corporation;
const out = [];
for (const [op, ...a] of JSON.parse(args[0])) {
  try {
    if (op === "upgrade") for (let i = 0; i < a[1]; i++) c.levelUpgrade(a[0]);
    else if (op === "whUp") c.upgradeWarehouse(a[0], a[1], a[2]);
    else if (op === "advert") for (let i = 0; i < a[1]; i++) c.hireAdVert(a[0]);
    else throw new Error("not an UPGRADE op: " + op);
    out.push("");
  } catch (e) { out.push(String(e?.message ?? e)); }
}
return out;
`;

/**
 * Office size, hires and jobs. setJobAssignment only moves Unassigned staff
 * into a job (OfficeSpace.autoAssignJob), so every job goes to 0 first and is
 * then set - the order the manual gives.
 */
const STAFF = `
import { JOBS } from "/scripts/corp/config.js";
const c = ns.corporation;
const out = [];
for (const [op, ...a] of JSON.parse(args[0])) {
  try {
    if (op === "size") c.upgradeOfficeSize(a[0], a[1], a[2]);
    else if (op === "hire") for (let i = 0; i < a[2]; i++) c.hireEmployee(a[0], a[1]);
    else if (op === "jobs") {
      for (const j of JOBS) c.setJobAssignment(a[0], a[1], j, 0);
      for (const j of JOBS) if (a[2][j] > 0) c.setJobAssignment(a[0], a[1], j, a[2][j]);
    } else throw new Error("not a STAFF op: " + op);
    out.push("");
  } catch (e) { out.push(String(e?.message ?? e)); }
}
return out;
`;

const MORALE = `
const c = ns.corporation;
const out = [];
for (const [op, ...a] of JSON.parse(args[0])) {
  try {
    if (op === "tea") c.buyTea(a[0], a[1]);
    else if (op === "party") c.throwParty(a[0], a[1], a[2]);
    else throw new Error("not a MORALE op: " + op);
    out.push("");
  } catch (e) { out.push(String(e?.message ?? e)); }
}
return out;
`;

/** Per-second buys (boost materials) and sell orders. */
const TRADE = `
const c = ns.corporation;
const out = [];
for (const [op, ...a] of JSON.parse(args[0])) {
  try {
    if (op === "buy") c.buyMaterial(a[0], a[1], a[2], a[3]);
    else if (op === "sell") c.sellMaterial(a[0], a[1], a[2], a[3], a[4]);
    else throw new Error("not a TRADE op: " + op);
    out.push("");
  } catch (e) { out.push(String(e?.message ?? e)); }
}
return out;
`;

const EXPORT = `
const c = ns.corporation;
const out = [];
for (const [op, ...a] of JSON.parse(args[0])) {
  try {
    if (op === "export") c.exportMaterial(a[0], a[1], a[2], a[3], a[4], a[5]);
    else if (op === "unexport") c.cancelExportMaterial(a[0], a[1], a[2], a[3], a[4]);
    else throw new Error("not an EXPORT op: " + op);
    out.push("");
  } catch (e) { out.push(String(e?.message ?? e)); }
}
return out;
`;

/** Design, discontinue, and sell finished products in every city. */
const PRODUCT = `
import { MAIN_CITY } from "/scripts/corp/config.js";
const c = ns.corporation;
const out = [];
for (const [op, ...a] of JSON.parse(args[0])) {
  try {
    if (op === "make") c.makeProduct(a[0], a[1], a[2], a[3], a[4]);
    else if (op === "drop") c.discontinueProduct(a[0], a[1]);
    else if (op === "psell") c.sellProduct(a[0], MAIN_CITY, a[1], a[2], a[3], true);
    else throw new Error("not a PRODUCT op: " + op);
    out.push("");
  } catch (e) { out.push(String(e?.message ?? e)); }
}
return out;
`;

/** Research, and Market-TA.II switched on where it is owned. */
const TA = `
const c = ns.corporation;
const out = [];
for (const [op, ...a] of JSON.parse(args[0])) {
  try {
    if (op === "lab") c.research(a[0], a[1]);
    else if (op === "taMat") c.setMaterialMarketTA2(a[0], a[1], a[2], true);
    else if (op === "taProd") c.setProductMarketTA2(a[0], a[1], true);
    else throw new Error("not a TA op: " + op);
    out.push("");
  } catch (e) { out.push(String(e?.message ?? e)); }
}
return out;
`;

/** The money side: investment offers, the listing, dividends. */
const FINANCE = `
const c = ns.corporation;
const out = [];
for (const [op, ...a] of JSON.parse(args[0])) {
  try {
    if (op === "accept") { if (!c.acceptInvestmentOffer()) throw new Error("the offer was refused"); }
    else if (op === "public") c.goPublic(a[0]);
    else if (op === "dividend") c.issueDividends(a[0]);
    else throw new Error("not a FINANCE op: " + op);
    out.push("");
  } catch (e) { out.push(String(e?.message ?? e)); }
}
return out;
`;

const BODIES = { SETUP, UNLOCK, UPGRADE, STAFF, EXPORT, TRADE, MORALE, PRODUCT, TA, FINANCE };

// -------------------------------------------------------------------- main ---

/** Ops worth a line in the history file - the rest happen every cycle. */
const LOGGED = new Set(["industry", "city", "warehouse", "unlock", "upgrade", "whUp", "advert", "size",
  "export", "unexport", "make", "drop", "lab", "accept", "public", "dividend"]);
/**
 * From round 3 on, these buy every pass, so they are summed and logged once
 * per ROLLUP_PASSES (5 min). Line by line they were 4 lines a pass, and the
 * 500-line history held 20 minutes - a live run lost when TA2 landed.
 */
const ROLLUP = new Set(["upgrade", "whUp", "advert", "size"]);
const ROLLUP_PASSES = 30;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const money = (n) => `$${ns.format.number(n, 2)}`;
  const events = [];
  const say = (line) => {
    ns.print(line);
    events.push(line);
  };
  const flush = () => {
    if (!events.length) return;
    const stamp = new Date().toLocaleString();
    const kept = ns.read(HISTORY_FILE).split("\n").filter(Boolean);
    const all = [...kept, ...events.splice(0).map((e) => `${stamp}  ${e}`)].slice(-HISTORY_KEEP);
    ns.write(HISTORY_FILE, all.join("\n") + "\n", "w");
  };

  // Warn once per body, cleared on its next success - sing's rule: "no free
  // RAM on home" is the expected state for a fresh node's first minutes.
  const warned = {};
  const call = async (tag, body, ...args) => {
    try {
      const v = await rpc(ns, body, ...args);
      delete warned[tag];
      return v;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (warned[tag] !== msg) say(`WARN: ${tag} failed - ${msg}`);
      warned[tag] = msg;
      return null;
    }
  };

  // `p` is the pass's plan: round, offer, profit and waiting are for hud.js.
  const publish = (corp, p) => ns.write(CORP_STATE_FILE, JSON.stringify({
    valuation: corp?.valuation ?? 0, funds: corp?.funds ?? 0, reserveGb: CORP_BODY_GB, homeWant: CORP_HOME_GB,
    round: corp?.offer?.round ?? 0, public: Boolean(corp?.public), offer: corp?.offer?.funds ?? 0,
    profit: (corp?.revenue ?? 0) - (corp?.expenses ?? 0),
    waiting: p?.notes?.[0] ?? (p?.setupDone ? "watching the offer" : ""),
  }), "w");
  // The reserve and the home-RAM priority go up before the first body runs.
  publish(null);

  const mem = { taOn: new Set(), seen: [], seenStage: null, profits: [], rolled: {}, rolledPasses: 0 };
  let parked = "";

  for (;;) {
    if (!ns.corporation.hasCorporation()) {
      const why = await create(ns, call, say);
      flush();
      if (why && why !== parked) {
        parked = why;
        ns.write(STATUS_FILE, `no corporation - ${why}\n`, "w");
      }
      await ns.sleep(10000);
      continue;
    }
    const state = await ns.corporation.nextUpdate();
    if (state !== "START") continue;
    const r = await pass(ns, call, say, mem, money);
    if (r) publish(r.corp, r.p);
    flush();
  }
}

/**
 * Found the corporation: seed money in BN3, the player's own $150b elsewhere
 * once cash is `corp.createMult` x that. Returns what it is waiting on, or "".
 */
async function create(ns, call, say) {
  const seed = ns.corporation.canCreateCorporation(false);
  if (seed === "Success") {
    if (await call("create", CREATE, CORP_NAME, "seed")) say(`founded ${CORP_NAME} with seed money`);
    return "";
  }
  if (seed !== "UseSeedMoneyOutsideBN3") return `the game says ${seed} - not founding one`;
  const want = setting(ns.read(SETTINGS_FILE), "corp.createMult") * SELF_FUND_COST;
  const cash = ns.getServerMoneyAvailable("home");
  if (ns.corporation.canCreateCorporation(true) !== "Success") return "the game refuses a self-funded corporation";
  if (cash < want) return `waiting for $${ns.format.number(want, 2)} cash to self-fund one (corp.createMult)`;
  if (await call("create", CREATE, CORP_NAME, "self")) say(`founded ${CORP_NAME} with $150b of our own`);
  return "";
}

/** One cycle: read, plan, act, report. Returns { corp: READ_CORP's snapshot, p: the plan or null }, or null. */
async function pass(ns, call, say, mem, money) {
  const corp = await call("read corp", READ_CORP);
  if (!corp) return null;
  const apis = APIS.every((a) => corp.unlocks?.[a]);
  const names = corp.divisions ?? [];
  let divs = {};
  if (apis && names.length) {
    divs = await call("read divisions", READ_DIV, JSON.stringify(names.map((n) => [n, !n.startsWith(DUMMY_PREFIX)])));
    if (!divs) return { corp, p: null };
  }
  const s = { ...corp, divs };
  const p = plan(s, mem);
  const profit = (corp.revenue ?? 0) - (corp.expenses ?? 0);

  // The offer: watched from the pass the round's setup is done, taken by takeOffer.
  const offerStage = typeof p.stage === "number" && p.stage <= 4;
  if (offerStage && p.setupDone) {
    if (mem.seenStage !== p.stage) {
      mem.seenStage = p.stage;
      mem.seen = [];
      say(`round ${p.stage}: setup done - watching the offer (target ${money(OFFER_TARGET[p.stage])})`);
    }
    mem.seen.push(corp.offer.funds);
    if (takeOffer(mem.seen, p.stage)) p.ops.push(["accept"]);
  } else if (mem.seenStage === p.stage) mem.seen = [];

  // Dividends, once public: the live `corp.dividend`, or the growth ramp.
  if (p.stage === "public") {
    mem.profits.push(profit);
    if (mem.profits.length > DIV_WINDOW) mem.profits.shift();
    const pinned = setting(ns.read(SETTINGS_FILE), "corp.dividend");
    const rate = pinned >= 0 ? pinned : dividendRate(mem.profits);
    if (Math.abs(rate - (corp.dividendRate ?? 0)) >= DIV_STEP || (pinned >= 0 && rate !== corp.dividendRate)) {
      p.ops.push(["dividend", rate]);
    }
  }

  // What ran, by kind: a kind with a few ops gets a line each, a busy one a
  // count - in the growth stage every pass buys upgrades in every city.
  const done = {};
  const rollup = typeof p.stage !== "number" || p.stage >= 3;
  for (const body of BODY_ORDER) {
    const ops = p.ops.filter((op) => BODY_OF[op[0]] === body);
    if (!ops.length) continue;
    const res = await call(body.toLowerCase(), BODIES[body], JSON.stringify(ops));
    if (!res) continue;
    ops.forEach((op, i) => {
      const err = res[i];
      if (err) {
        say(`WARN: ${op.join(" ")} - ${err}`);
        return;
      }
      if (op[0] === "taMat" || op[0] === "taProd") mem.taOn.add(taKey(op));
      if (op[0] === "accept") {
        const line = `took the round ${p.stage} offer: ${money(corp.offer.funds)}`;
        say(line);
        ns.tprint(`corp: ${line}`);
        mem.seen = [];
      } else if (op[0] === "public") {
        say("went public (0 shares issued)");
        ns.tprint("corp: went public - dividends follow");
      } else if (rollup && ROLLUP.has(op[0])) {
        // upgrade [name, n], advert [div, n], whUp/size [div, city, n]: the count is last.
        const k = op[0] === "upgrade" ? op[1]
          : `${op[1]} ${op[0] === "advert" ? "Advert" : op[0] === "whUp" ? "warehouse levels" : "office size"}`;
        mem.rolled[k] = (mem.rolled[k] ?? 0) + op[op.length - 1];
      } else if (LOGGED.has(op[0])) (done[op[0]] ??= []).push(op);
    });
  }
  if (rollup && ++mem.rolledPasses >= ROLLUP_PASSES) {
    const parts = Object.entries(mem.rolled).map(([k, n]) => `${k} +${n}`);
    if (parts.length) say(`bought over ${mem.rolledPasses} cycles: ${parts.join(", ")}`);
    mem.rolled = {};
    mem.rolledPasses = 0;
  }
  for (const [k, ops] of Object.entries(done)) {
    if (ops.length <= 3) for (const op of ops) say(describe(op, money));
    else say(`${describe(ops[0], money)} - and ${ops.length - 1} more ${k}`);
  }

  const lines = [
    `stage ${p.stage}${p.mode ? ` (${p.mode})` : ""} | funds ${money(corp.funds)} | profit ${money(profit)}/s | ` +
      `valuation ${money(corp.valuation)}${typeof p.stage === "number" && p.stage <= 4
        ? ` | offer ${money(corp.offer.funds)}${mem.seen.length ? ` (watched ${mem.seen.length} cycles)` : ""}` : ""}` +
      (corp.public ? ` | dividend ${ns.format.percent(corp.dividendRate ?? 0, 0)}` : ""),
  ];
  for (const [name, d] of Object.entries(divs)) {
    if (name.startsWith(DUMMY_PREFIX)) continue;
    const staffN = Object.values(d.offices).reduce((n, o) => n + (o.numEmployees ?? 0), 0);
    const prods = d.products?.length
      ? ` | products ${d.products.map((n) => `${n} ${Math.floor(d.prods[n]?.developmentProgress ?? 0)}%`).join(", ")}` : "";
    lines.push(`${name}: ${Object.keys(d.offices).length} cities, ${staffN} staff, RP ${ns.format.number(d.researchPoints, 1)}` +
      `, advert ${d.numAdVerts}${prods}`);
  }
  const dummies = names.filter((n) => n.startsWith(DUMMY_PREFIX)).length;
  if (dummies) lines.push(`dummy divisions: ${dummies}`);
  for (const n of p.notes) lines.push(`waiting: ${n}`);
  ns.write(STATUS_FILE, lines.join("\n") + "\n", "w");
  return { corp, p };
}

/** One history line for an op the plan ran. */
function describe(op, money) {
  const [k, ...a] = op;
  if (k === "industry") return `opened ${a[1]} (${a[0]})`;
  if (k === "city") return `${a[0]}: office in ${a[1]}`;
  if (k === "warehouse") return `${a[0]}: warehouse in ${a[1]}`;
  if (k === "unlock") return `unlocked ${a[0]}`;
  if (k === "upgrade") return `${a[0]} +${a[1]}`;
  if (k === "whUp") return `${a[0]}: ${a[1]} warehouse +${a[2]}`;
  if (k === "advert") return `${a[0]}: Advert +${a[1]}`;
  if (k === "size") return `${a[0]}: ${a[1]} office +${a[2]}`;
  if (k === "export") return `export ${a[4]} ${a[0]} -> ${a[2]} (${a[1]})`;
  if (k === "unexport") return `stopped exporting ${a[4]} ${a[0]} -> ${a[2]} (${a[1]})`;
  if (k === "make") return `${a[0]}: designing ${a[2]} (${money(a[3])} design + ${money(a[4])} marketing)`;
  if (k === "drop") return `${a[0]}: discontinued ${a[1]}`;
  if (k === "lab") return `${a[0]}: researched ${a[1]}`;
  if (k === "dividend") return `dividend rate ${Math.round(a[0] * 100)}%`;
  return op.join(" ");
}
