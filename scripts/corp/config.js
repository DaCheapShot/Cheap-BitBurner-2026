/**
 * Corporation tunables, paths and the recipe. Constants only - no ns anywhere,
 * so boot.js, settings.js and every corp rpc body import it for 0 GB.
 *
 * THE RECIPE is the Corporation manual's standard strategy (section 19, BN3),
 * the numbers the manual's author tested 200+ times headless, and the round
 * scripts in catloversg/bitburner-scripts that produced them. Every number
 * below that looks arbitrary is theirs; what this repo changed is noted.
 *
 * WATCH THE NAMES. Every ns.corporation function is 10 GB (a read) or 20 GB (an
 * action), billed by BARE NAME to any script that so much as mentions it - so
 * nothing in this file, corp/math.js or corp/corp.js may be called `research`,
 * `bribe`, `expandCity`, `makeProduct`... The op names the planner hands the
 * bodies are string literals, which are free.
 */

// The 0 GB contract the manager and sing read, kept where both already look.
export { CORP_STATE_FILE, corpState } from "scripts/config.js";

/** The resident supervisor. boot.js starts it in BN3 or with SF3. */
export const CORP_SERVICE = "/scripts/corp/corp.js";

/**
 * What the corporation is doing now, overwritten every pass, and what HAPPENED
 * (purchases, phase changes, offers taken, refusals), timestamped, the last
 * HISTORY_KEEP kept. The sleeve pattern: `cat /data/corp.txt`.
 */
export const STATUS_FILE = "/data/corp.txt";
export const HISTORY_FILE = "/data/corp.log.txt";
export const HISTORY_KEEP = 500;

/**
 * The largest rpc body, in GB. The manager leaves this much free on home on top
 * of HOME_RESERVE_GB while the corp resident runs (corpReserve in
 * scripts/config.js), because rpc() awaits one body at a time - so the max, not
 * the sum, is what has to fit. tests/ram.test.mjs holds every body under it.
 */
export const CORP_BODY_GB = 62;

/**
 * Home RAM sing upgrades toward at full cash while the corp resident runs - the
 * user's rule: in BN3 the corp is the income, and it cannot run a body until
 * home holds the residents, HOME_RESERVE_GB and CORP_BODY_GB. ~127 GB today.
 */
export const CORP_HOME_GB = 256;

export const CORP_NAME = "DaCheap Holdings";

/** CityName, src/Enums - the six cities every division expands to. */
export const CITIES = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven"];
/** Where products are designed (the "main office"); the other five support it. */
export const MAIN_CITY = "Sector-12";

// Division names are the industry names, as the manual's scripts name them.
export const AGRI = "Agriculture";
export const CHEM = "Chemical";
export const TOBACCO = "Tobacco";
/** Dummy divisions: the cheapest industry, Restaurant at $10b (IndustryData.ts). */
export const DUMMY_INDUSTRY = "Restaurant";
export const DUMMY_PREFIX = "Dummy-";
/** CorporationDivisions in BN3 is 1, so maxDivisions is 20. */
export const MAX_DIVISIONS = 20;

/**
 * IndustryData.ts, transcribed for the industries this plays: starting cost,
 * the four boost factors in BOOST_MATS order, what it makes. The same data
 * getIndustryData returns for 10 GB.
 */
export const INDUSTRY = {
  Agriculture: { cost: 40e9, boost: [0.3, 0.2, 0.72, 0.3], makes: ["Plants", "Food"], needs: ["Water", "Chemicals"] },
  Chemical: { cost: 70e9, boost: [0.2, 0.2, 0.25, 0.25], makes: ["Chemicals"], needs: ["Plants", "Water"] },
  Tobacco: { cost: 20e9, boost: [0.15, 0.15, 0.15, 0.2], makes: [], needs: ["Plants"], products: true },
  Restaurant: { cost: 10e9, boost: [0.25, 0.15, 0.05, 0.3], makes: [], needs: ["Food", "Water"], products: true },
};

/** The boost materials and their sizes (MaterialInfo.ts), in INDUSTRY.boost order. */
export const BOOST_MATS = ["AI Cores", "Hardware", "Real Estate", "Robots"];
export const BOOST_SIZE = [0.1, 0.06, 0.005, 0.5];

// Constants.ts and CorporationUnlocks.ts.
export const OFFICE_COST = 4e9;
export const WAREHOUSE_COST = 5e9;
export const TEA_PER_EMPLOYEE = 500e3;
/** What one party costs per employee - the manual: "fine to spend 500e3". */
export const PARTY_PER_EMPLOYEE = 500e3;
export const UNLOCK_COST = { "Export": 20e9, "Smart Supply": 25e9, "Office API": 50e9, "Warehouse API": 50e9 };
/**
 * Every office and warehouse call throws without these. Free in BN3 and at
 * SF3.3 (PlayerObjectCorporationMethods.ts startCorporation); elsewhere they
 * are the first $100b a new corp spends.
 */
export const APIS = ["Office API", "Warehouse API"];
/** CorporationUpgrades.ts: base price and multiplier per level. */
export const UPGRADES = {
  "Smart Factories": { base: 2e9, mult: 1.06 },
  "Smart Storage": { base: 2e9, mult: 1.06 },
  "Wilson Analytics": { base: 4e9, mult: 2 },
  "Nuoptimal Nootropic Injector Implants": { base: 1e9, mult: 1.06 },
  "Speech Processor Implants": { base: 1e9, mult: 1.06 },
  "Neural Accelerators": { base: 1e9, mult: 1.06 },
  "FocusWires": { base: 1e9, mult: 1.06 },
  "ABC SalesBots": { base: 1e9, mult: 1.07 },
  "Project Insight": { base: 5e9, mult: 1.07 },
};
export const EMPLOYEE_UPGRADES = ["Nuoptimal Nootropic Injector Implants", "Speech Processor Implants",
  "Neural Accelerators", "FocusWires"];

/** The five working jobs (CorpEmployeeJob). Interns are never used: tea and parties do their job. */
export const JOBS = ["Operations", "Engineer", "Business", "Management", "Research & Development"];
export const RND = "Research & Development";

/**
 * The export string the manual derives (section 18.2): ship what the importer
 * consumes this cycle less a tenth of what it already holds.
 */
export const EXPORT_STRING = "(IPROD+IINV/10)*(-1)";

// ------------------------------------------------------------------ rounds ---

/**
 * Round 1, "without custom Smart Supply" (manual 19.2.2): built-in Smart
 * Supply is the user's choice, at the cost of a ~340b offer against ~550b.
 */
export const ROUND1 = {
  office: 4, rp: 55,
  jobs: { Operations: 1, Engineer: 1, Business: 1, Management: 1 },
  smartStorage: 3, warehouse: 4, advert: 2,
  // 0.84 of a 520 warehouse is the manual's AI 777 / HW 919 / RE 60794 / Rob 0.
  boostRatio: 0.84,
};

/** Round 2 (manual 19.3): Export, Chemical, wait for RP, then boost. */
export const ROUND2 = {
  agri: { office: 8, warehouse: 17, advert: 8, rp: 700, boostRatio: 0.76,
    jobs: { Operations: 3, Engineer: 1, Business: 2, Management: 2 } },
  chem: { office: 3, warehouse: 2, rp: 390, boostRatio: 0.95,
    jobs: { Operations: 1, Engineer: 1, Business: 1 } },
  smartStorage: 25, smartFactories: 17,
};

/**
 * The offer is taken once the round's setup is DONE and then OFFER_WAIT more
 * cycles have passed - valuation is a mean of the last 10 cycles, so the setup
 * needs that long to show - and then as soon as it reaches the round's target,
 * stops rising for OFFER_PLATEAU cycles, or OFFER_MAX_WAIT cycles have gone by.
 * Targets are the manual's medians where its numbers apply (round 1 without
 * custom Smart Supply, round 2) and its stated milestones after.
 */
export const OFFER_TARGET = { 1: 330e9, 2: 10e12, 3: 1e16, 4: 1e20 };
export const OFFER_WAIT = 10;
export const OFFER_PLATEAU = 5;
export const OFFER_MAX_WAIT = 60;

/** Products finished before rounds 3 and 4 are taken - the manual's 1P/2P. */
export const PRODUCTS_FOR_OFFER = { 3: 1, 4: 2 };

// ----------------------------------------------------------- round 3 and on ---

/**
 * Profit per second past which Advert outpays the upgrades (manual 19.4.2,
 * thresholdOfFocusingOnAdvert): Wilson then only from last cycle's profit and
 * ADVERT_FOCUS of funds straight to Advert.
 */
export const ADVERT_FOCUS_PROFIT = 1e18;
export const ADVERT_FOCUS = 0.2;

/** The product division's budget split (manual 19.4.2), before and after the threshold. */
export const PRODUCT_SPLIT = {
  before: { raw: 1, wilsonAdvert: 4, office: 8, employee: 8, sales: 1, insight: 1 },
  after: { raw: 1, wilsonAdvert: 0, office: 8, employee: 8, sales: 1, insight: 1 },
};
/** Main office's share of the product division's office budget, by round. */
export const MAIN_OFFICE_SHARE = { 3: 0.75, 4: 0.5, later: 0.5 };
/** What of each pass's spendable funds the product division gets; support divisions take the rest. */
export const PRODUCT_SHARE = { early: 0.9, later: 0.99 };
/** Support divisions' warehouse vs office split (manual: 10-90). */
export const SUPPORT_WAREHOUSE_SHARE = 0.1;
/** Product design and marketing investment, each, as a fraction of funds (manual: 1%). */
export const PRODUCT_INVEST = 0.01;
/** Boost materials are topped up each pass while they cost at most this of funds. */
export const BOOST_FUNDS_SHARE = 0.5;
/** Round 3+ boost ratio: what of each warehouse boost materials may fill. */
export const LATE_BOOST_RATIO = 0.7;
/** A dummy division is created while its full cost is at most this of funds. */
export const DUMMY_FUNDS_SHARE = 0.02;

/**
 * Job ratios over NON-R&D employees, manual 19.4.2. Support divisions put
 * SUPPORT_RND of their staff on R&D; product support offices as listed.
 */
export const SUPPORT_RND = 0.2;
export const SUPPORT_JOBS = { Operations: 0.22, Engineer: 0.632, Management: 0.148 };
export const MAIN_JOBS = {
  progress3: { Operations: 0.037, Engineer: 0.513, Business: 0.011, Management: 0.44 },
  progress4: { Operations: 0.03, Engineer: 0.531, Business: 0.003, Management: 0.436 },
  profitProgressLow: { Operations: 0.032, Engineer: 0.462, Business: 0.067, Management: 0.439 },
  profitProgressHigh: { Operations: 0.064, Engineer: 0.317, Business: 0.298, Management: 0.321 },
  profit3: { Operations: 49, Engineer: 5, Business: 51, Management: 33 },
  profit4: { Operations: 68, Engineer: 12, Business: 244, Management: 45 },
};
/** Profit per second where the main office switches profit-progress setups. */
export const PROFIT_HIGH = 1e30;

// ----------------------------------------------------------------- research ---

/** ResearchMap costs and tree parents (BaseResearchTree.ts), for what this buys. */
export const RESEARCH = {
  "Hi-Tech R&D Laboratory": { cost: 5000, parent: null },
  "Market-TA.I": { cost: 20000, parent: "Hi-Tech R&D Laboratory" },
  "Market-TA.II": { cost: 50000, parent: "Market-TA.I" },
  "Overclock": { cost: 15000, parent: "Hi-Tech R&D Laboratory" },
  "Sti.mu": { cost: 30000, parent: "Overclock" },
  "Automatic Drug Administration": { cost: 10000, parent: "Hi-Tech R&D Laboratory" },
  "Go-Juice": { cost: 25000, parent: "Automatic Drug Administration" },
  "CPH4 Injections": { cost: 25000, parent: "Automatic Drug Administration" },
  "Drones": { cost: 5000, parent: "Hi-Tech R&D Laboratory" },
  "Drones - Assembly": { cost: 25000, parent: "Drones" },
  "Self-Correcting Assemblers": { cost: 25000, parent: "Hi-Tech R&D Laboratory" },
  "Drones - Transport": { cost: 30000, parent: "Drones" },
  "uPgrade: Fulcrum": { cost: 10000, parent: "Hi-Tech R&D Laboratory", products: true },
};
export const LAB = "Hi-Tech R&D Laboratory";
export const TA = ["Market-TA.I", "Market-TA.II"];
/**
 * The manual's order after the lab and TA: energy/morale and employee stats
 * first, each bought while it costs under STAT_SHARE of the pool; production
 * after, under PRODUCTION_SHARE. TA is bought both at once, once the pool holds
 * TA_POOL_MULT x their cost - depleting RP wrecks the next product's rating.
 */
export const STAT_RESEARCH = ["Overclock", "Sti.mu", "Automatic Drug Administration", "Go-Juice", "CPH4 Injections"];
export const PRODUCTION_RESEARCH = ["Drones", "Drones - Assembly", "Self-Correcting Assemblers",
  "Drones - Transport", "uPgrade: Fulcrum"];
export const STAT_SHARE = 0.2;
export const PRODUCTION_SHARE = 0.1;
export const TA_POOL_MULT = 2;
/** A support division buys the lab once it costs at most this of its pool. */
export const SUPPORT_LAB_SHARE = 0.5;

// ---------------------------------------------------------------- dividends ---

/**
 * Dividends ramp with growth - the user's rule. Profit that multiplied by
 * DIV_FAST or more over the last DIV_WINDOW passes pays DIV_MIN; flat profit pays
 * DIV_MAX; in between, log-linear. Retained earnings are what grow the corp, so
 * the rate rises only as reinvesting stops paying. `corp.dividend` pins it.
 */
export const DIV_MIN = 0.1;
export const DIV_MAX = 0.9;
export const DIV_FAST = 10;
export const DIV_WINDOW = 360;
/** Don't reissue dividends for a change smaller than this. */
export const DIV_STEP = 0.02;

/** Valuation at which bribes open (Constants.ts bribeThreshold) and their price per rep. */
export const BRIBE_VALUATION = 100e12;
export const BRIBE_PER_REP = 1e9;
/** Default share of corp funds sing may bribe with (`corp.bribeCash`). */
export const BRIBE_CASH = 0.5;
/** Outside BN3 a corp costs $150b of the player's own; created at this multiple of it (`corp.createMult`). */
export const SELF_FUND_COST = 150e9;
export const CREATE_MULT = 2;
