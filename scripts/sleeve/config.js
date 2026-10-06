/**
 * Every tunable and game constant for the sleeve subsystem, at ZERO RAM cost.
 *
 * Same rule as sing/config.js: no ns call may ever appear here. boot.js imports
 * SLEEVE_SERVICE from this file and is pinned at 3.50 GB. Every ns.sleeve
 * function is 4.00 GB (RamCostConstants.SleeveBase), and the game bills bare
 * NAMES - so `travel`, `getTask` and `getSleeve` are banned as identifiers
 * anywhere this file reaches, and appear only as strings and object keys.
 */

// ------------------------------------------------------------------ paths ---

export const SLEEVE_SERVICE = "/scripts/sleeve/sleeve.js";

/**
 * One line per sleeve, overwritten every run. The entry is a transient, so its
 * log window dies a moment after it exits - this file is where "what is each
 * sleeve doing and why" can still be read. `cat /data/sleeves.txt`.
 */
export const STATUS_FILE = "/data/sleeves.txt";

/**
 * What HAPPENED, since STATUS_FILE only holds the latest pass: task changes,
 * purchases, refusals and warnings, timestamped, oldest first, the last
 * HISTORY_KEEP lines kept. `cat /data/sleeves.log.txt`.
 */
export const HISTORY_FILE = "/data/sleeves.log.txt";
export const HISTORY_KEEP = 500;

/**
 * The two contracts crossing into scripts/: what sing wants worked, and the
 * sleeve half of the share hold. Re-exports spelled the way RamCalculations.ts
 * resolves them - see CLAUDE.md on re-exports.
 */
export { REP_WANT_MARKER, SLEEVE_FACTION_MARKER } from "scripts/config.js";

/** Sing's, so the two subsystems cannot disagree on the bar or the crime list. */
export { GANG_KARMA_TARGET, MONEY_CRIMES } from "scripts/sing/config.js";

// ------------------------------------------------------------- game rules ---

/**
 * Every sleeve recovers shock above this before any other work; at or under it,
 * work finishes the job (any work lowers shock at a third of recovery's rate).
 *
 * Shock scales a sleeve's output by (1 - s/100), and the exp it SHARES twice:
 * once at the sender, once at the receiver (applySleeveGains). With every sleeve
 * at about the same shock, the shared output scales by (1 - s/100)^2. Recover
 * while the future loss it avoids beats the output it gives up now:
 * f(s) > 1/3, where f is the fraction of output lost. Linear f (own rep) gives
 * s > 33.3; squared f (shared exp) gives s > 18.4. 20 is the user's call, at
 * the shared-exp end. Recovering the last 20 points takes ~3.7 h of nothing,
 * against ~1.1 h of output lost by working them off over ~11 h.
 */
export const SHOCK_RECOVER_ABOVE = 0;

/**
 * A karma sleeve with no gym stat left does its best karma crime only at these
 * odds or better; below, it does the best money crime. The user's call, not a
 * derivation: karma and money do not convert, and Homicide at 0.5% earns
 * neither. The four gym trainers lift every sleeve's odds past it in time.
 */
export const KARMA_MIN_CHANCE = 0.25;

// ------------------------------------------------------------------- augs ---

/**
 * Sleeve augs. Priced at the aug's flat base cost - no 1.9x queue ladder, and
 * the player's prices do not move - and they last the whole BitNode: a player
 * install leaves sleeves alone, only a new node resets them.
 *
 * THE CATCH: Sleeve.installAugmentation zeroes the sleeve's exp in every stat,
 * on EVERY purchase. So a sleeve buys in batches - everything the budget covers
 * in one pass, one wipe - and only when the batch reaches the live
 * `sleeve.augMin` - never "whatever is left", which the rep trickle made every
 * unlock. A karma sleeve never buys: see planAugs.
 *
 * `sleeve.augCash` (live) is the fraction of cash one pass may spend across all
 * sleeves, priced once per pass like hacknet's. sing's aug batch, cloud and the
 * hacknet bid for the same wallet.
 */
export const SLEEVE_AUG_CASH = 0.10;
export const SLEEVE_AUG_MIN = 3;

/**
 * What each aug multiplies, keyed by name, from getAugmentationStats. Fixed for
 * the game, so read once and kept - this pass is a transient and forgets.
 */
export const AUG_STATS_FILE = "/data/sleeve-aug-stats.txt";

/**
 * The multipliers each rung's work uses: an aug raising any of them is tier 1
 * for a sleeve on that rung. Keys of getAugmentationStats (Multipliers).
 * No karma entry: a karma sleeve never buys (planAugs).
 *   rep:   faction work's hacking/combat formula, company rep's charisma
 *   money: the money crimes' odds and pay
 */
export const JOB_MULTS = {
  rep: ["faction_rep", "company_rep", "hacking", "hacking_exp", "charisma", "charisma_exp"],
  money: ["crime_money", "crime_success", "dexterity", "agility"],
};

// --------------------------------------------------------------- covenant ---

/**
 * The Covenant sells sleeves and sleeve memory - BitNode 10 only, members only
 * (SleeveCovenantPurchases.tsx canPurchaseSleeve / canPurchaseMemoryUpgrade).
 * Both are PERMANENT across every later BitNode, which is why the live
 * `sleeve.covenantCash` defaults to half the cash, against 0.10 for augs.
 *
 * Every price is a formula, transcribed rather than read (4.00 GB each):
 *   sleeve k (0-based, k < 5):  10^k x $10t          getSleeveCost
 *   memory point at memory m:   $1t x 1.02^(m - 1)   Sleeve.getMemoryUpgradeCost
 * Memory is the sync a sleeve starts the next BitNode at - worth less than a
 * sleeve, so it only ever spends the surplus above the next sleeve's price.
 */
export const SLEEVE_COVENANT_CASH = 0.5;
export const COVENANT = "The Covenant";
export const COVENANT_MAX_SLEEVES = 5;
export const COVENANT_SLEEVE_BASE = 10e12;
export const MEMORY_BASE_COST = 1e12;
export const MEMORY_MULT = 1.02;
export const MEMORY_MAX = 100;

/**
 * Where karma sleeves train, and how fast. Powerhouse Gym: expMult 10
 * (LocationsMetadata.ts), and a gym class earns 1 exp per second per 1 of
 * expMult (ClassWork.ts Classes, / gameCPS per cycle) - so 10 exp/s, x the
 * sleeve's <stat>_exp mult, x the node's gym multiplier. That last one is only
 * known through ns.formulas.work.gymGains, which READ uses when Formulas.exe is
 * owned; without it the multiplier is taken as 1. $2,400/s a sleeve.
 */
export const GYM = "Powerhouse Gym";
export const GYM_CITY = "Sector-12";
export const GYM_EXP_PER_SECOND = 10;
/** getSleeve().skills key -> the GymType setToGymWorkout takes, in Homicide weight order. */
export const GYM_STATS = [["strength", "str"], ["defense", "def"], ["dexterity", "dex"], ["agility", "agi"]];

/** CONSTANTS.MaxSkillLevel and IntelligenceCrimeWeight, src/Constants.ts. */
export const MAX_SKILL_LEVEL = 975;
export const INT_CRIME_WEIGHT = 0.025;

/**
 * SleeveSynchroWork: sync += intBonus(PLAYER int, 0.5) x 0.0002 per cycle, and
 * a cycle is 200 ms (CONSTANTS.MilliPerCycle) - so 0.001 per second at int 0.
 */
export const SYNC_PER_SECOND = 0.0002 * (1000 / 200);

/**
 * The crime table, transcribed from src/Crime/Crimes.ts in this fork: time in
 * ms, base money, difficulty, karma, and the success weights Crime.successRate
 * multiplies each skill by. Transcribed rather than read because the reads that
 * price a crime (getCrimeStats, getCrimeChance) are singularity and take the
 * PLAYER, never a sleeve; ns.formulas.work would need Formulas.exe. getSleeve
 * hands back skills and mults, which is exactly successRate's input.
 */
export const CRIMES = {
  "Shoplift": { time: 2e3, money: 15e3, difficulty: 1 / 20, karma: 0.1, w: { dexterity: 1, agility: 1 } },
  "Rob Store": { time: 60e3, money: 400e3, difficulty: 1 / 5, karma: 0.5, w: { hacking: 0.5, dexterity: 2, agility: 1 } },
  "Mug": { time: 4e3, money: 36e3, difficulty: 1 / 5, karma: 0.25,
    w: { strength: 1.5, defense: 0.5, dexterity: 1.5, agility: 0.5 } },
  "Larceny": { time: 90e3, money: 800e3, difficulty: 1 / 3, karma: 1.5, w: { hacking: 0.5, dexterity: 1, agility: 1 } },
  "Deal Drugs": { time: 10e3, money: 120e3, difficulty: 1, karma: 0.5, w: { charisma: 3, dexterity: 2, agility: 1 } },
  "Bond Forgery": { time: 300e3, money: 4.5e6, difficulty: 1 / 2, karma: 0.1, w: { hacking: 0.05, dexterity: 1.25 } },
  "Traffick Arms": { time: 40e3, money: 600e3, difficulty: 2, karma: 1,
    w: { charisma: 1, strength: 1, defense: 1, dexterity: 1, agility: 1 } },
  "Homicide": { time: 3e3, money: 45e3, difficulty: 1, karma: 3,
    w: { strength: 2, defense: 2, dexterity: 0.5, agility: 0.5 } },
  "Grand Theft Auto": { time: 80e3, money: 1.6e6, difficulty: 8, karma: 5,
    w: { hacking: 1, strength: 1, dexterity: 4, agility: 2, charisma: 2 } },
  "Kidnap": { time: 120e3, money: 3.6e6, difficulty: 5, karma: 6,
    w: { charisma: 1, strength: 1, dexterity: 1, agility: 1 } },
  "Assassination": { time: 300e3, money: 12e6, difficulty: 8, karma: 10, w: { strength: 1, dexterity: 2, agility: 1 } },
  "Heist": { time: 600e3, money: 120e6, difficulty: 18, karma: 15,
    w: { hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1 } },
};
