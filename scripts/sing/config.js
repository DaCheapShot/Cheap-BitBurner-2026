/**
 * Every tunable for the singularity subsystem, in one place and at ZERO RAM cost.
 *
 * Same rule as gang/config.js: no ns call may ever appear in this file. boot.js
 * imports SING_SERVICE from here and is pinned at 3.50 GB, and every rpc body in
 * sing.js that imports a budget is billed for whatever this file names.
 *
 * Names that LOOK like ns functions are safe only as strings and as
 * non-computed object keys - RamCalculations.ts bills bare identifiers.
 */

// ------------------------------------------------------------------ paths ---

export const SING_SERVICE = "/scripts/sing/sing.js";

/**
 * The one contract crossing into scripts/: the share hold both managers read.
 * A re-export, spelled the way RamCalculations.ts can resolve it - see
 * CLAUDE.md on re-exports. scripts/config.js is 0 GB, so this stays 0 GB.
 */
export { SHARE_HOLD_MARKER } from "scripts/config.js";

// ---------------------------------------------------------------- cadence ---

/**
 * Singularity has no nextUpdate() to count, unlike ns.gang, so the supervisor
 * sleeps a fixed interval and counts ticks. The tick is the WORK check - how
 * soon a finished rep target or a new invite turns into the next job - and 20 s
 * is still far over the few hundred ms a body takes.
 *
 * The cadences below are in TICKS and are sized for a 20 s tick, so each keeps
 * its wall-clock period: upgrade and join every 60 s, programs and promotions
 * every 120 s. Change the tick and re-derive these, or they speed up with it.
 * All of these are read by the resident process - a change needs a sing restart.
 */
export const SING_TICK_MS = 20000;
export const UPGRADE_EVERY = 3;
export const PROGS_EVERY = 6;
export const JOIN_EVERY = 3;
export const AUGS_EVERY = 3;
/** How long a parked supervisor (no Source-File 4) sleeps between checks of nothing. */
export const PARKED_MS = 3600000;

// ---------------------------------------------------------------- budgets ---

/**
 * One home RAM upgrade is bought only when it costs at most this fraction of
 * current cash. The aggressive one of the three bidders (cloud.js takes 10%,
 * the gang's equip 15% per sweep) deliberately: home RAM is the only purchase
 * here that compounds into the batcher's own throughput.
 */
export const HOME_RAM_BUDGET_FRACTION = 0.25;
/** Each darkweb program is bought only when it costs at most this fraction of cash. */
export const PROG_BUDGET_FRACTION = 0.10;

// ------------------------------------------------------------------- join ---

/**
 * Invites never accepted. Joining a city faction permanently locks out its
 * enemies (src/Faction/FactionInfo.tsx), and Sector-12 - where every BitNode
 * starts - lists exactly these four. Aevum is Sector-12's ally, so it is not
 * here. Everything else is accepted: phase 1 has no read of invite
 * requirements, which is getFactionInviteRequirements at 3.00 GB.
 */
export const JOIN_DENY = ["Chongqing", "New Tokyo", "Ishima", "Volhaven"];

// ------------------------------------------------------------------- work ---

/**
 * Train a combat stat at the gym while any is below this - ONLY while
 * GRIND_GANG_KARMA is on. Homicide's success and the combat bars on the crime
 * factions' invites are all these stats serve here; hacking and company work
 * never read them. A failed crime still grants exp, so a low floor is slow
 * crime, not a dead end.
 */
export const TRAIN_STAT_FLOOR = 50;
/**
 * gymWorkout returns false outside the gym's own city (Singularity.ts
 * gymWorkout), so the city is checked before choosing the gym, not after.
 */
export const TRAIN_GYM = "Powerhouse Gym";
export const TRAIN_GYM_CITY = "Sector-12";

/**
 * Grind Homicide toward a gang's karma requirement - and train at the gym for
 * it, which is the gym's only purpose here? OFF by default: -54000 is
 * about 18000 successful homicides, ~15 hours at 3 s each even at 100% success,
 * and every one of those hours is not spent on Tian Di Hui, Bachman or any
 * other rep. Turn it on when a gang is actually wanted - it still needs SF2.
 *
 * LIVE: read inside the READ body, which re-imports this file each run, so a
 * change takes effect on the next tick with no restart. Crime work the flag
 * started is replaced by the next job down, not stopped.
 */
export const GRIND_GANG_KARMA = false;
export const CRIME_TYPE = "Homicide";
/** GangConstants.GangKarmaRequirement. */
export const GANG_KARMA_TARGET = -54000;

/**
 * Rep work, in priority order: the first step with work left wins. Joined
 * factions not listed here are worked after these, in join order.
 *
 * A step is a FACTION, worked to the highest rep requirement among its augs the
 * player neither owns nor has queued (0 once they are all bought, and then it
 * is skipped), or a COMPANY, worked to `rep` company reputation. A faction step
 * is skipped until the faction is joined.
 *
 * - Tian Di Hui first, for the Neuroreceptor Management Implant it alone sells:
 *   it removes the unfocused-work penalty (CONSTANTS.BaseFocusBonus 0.8), so
 *   every later hour of work is worth 25% more.
 * - Then Bachman & Associates the COMPANY, for its faction's rep-gain augs. The
 *   invite needs employment there AND CorpFactionRepRequirement = 400e3
 *   company rep (FactionInfo.tsx). `hacking` is the entry job's requirement:
 *   the software intern's reqdHacking 1 plus Bachman's jobStatReqOffset 224
 *   (CompanyPosition.requiredSkills). Below it the step is skipped rather than
 *   applied for every tick. applyToCompany and workForCompany check no city,
 *   so Bachman being in Aevum does not matter. The company's name is also its
 *   faction's, which is how the step learns the faction's augs are all owned
 *   and skips the company too.
 * - Then the hacking factions, HIGHEST first: each one's shop largely covers
 *   the lower ones' augs, so rep earned high up buys what CyberSec sells too,
 *   and the lower factions' targets drop as those augs are bought. An aug is
 *   bought from whichever joined faction has the most rep (planAugBuys).
 */
export const WORK_ORDER = [
  { faction: "Tian Di Hui" },
  { company: "Bachman & Associates", field: "Software", rep: 400e3, hacking: 225 },
  { faction: "Bachman & Associates" },
  { faction: "Daedalus" },
  { faction: "BitRunners" },
  { faction: "The Black Hand" },
  { faction: "NiteSec" },
  { faction: "CyberSec" },
];
/**
 * Re-apply to an employer every this many ticks while working there. It is the
 * only way to be promoted: applyForJob hands out the highest position the
 * player qualifies for, and each rung raises the company rep rate.
 */
export const PROMOTE_EVERY = 6;
/** FactionWorkType values, most preferred first. */
export const WORK_TYPE_ORDER = ["hacking", "field", "security"];
/**
 * The rep target for a faction whose augs have not been read yet - the first
 * AUGS pass after a join replaces it with the real one.
 */
export const FACTION_REP_TARGET = 1e6;

// ------------------------------------------------------------------- augs ---

/**
 * Augs are bought as a BATCH or not at all: only when every aug that is both
 * affordable and rep-unlocked, plus NeuroFlux levels to fill, reaches
 * MIN_AUG_BATCH counting those already queued - and only when cash covers the
 * whole batch. An install resets money but keeps home RAM, so whatever the
 * batch leaves is spent on home RAM in the same pass. Installing stays manual.
 */
export const MIN_AUG_BATCH = 10;
export const NFG = "NeuroFlux Governor";
/**
 * Each queued aug multiplies every later price by this
 * (getGenericAugmentationPriceMultiplier). CONSTANTS.MultipleAugMultiplier is
 * 1.9 and Source-File 11 only LOWERS it, so planning at 1.9 over-states a batch
 * and can never plan one the cash cannot cover.
 */
export const AUG_PRICE_MULT = 1.9;
/** NeuroFlux's price AND rep requirement grow by CONSTANTS.NeuroFluxGovernorLevelMult per level. */
export const NFG_LEVEL_MULT = 1.14;
/**
 * Never bought from. Shadows of Anarchy's augs price off their own SoACostMult
 * ladder, not the generic multiplier above, so the batch arithmetic is wrong
 * for them (AugmentationHelpers.ts getAugCost).
 */
export const AUG_SKIP_FACTIONS = ["Shadows of Anarchy"];

// ----------------------------------------------------------------- donate ---

/**
 * A faction whose favor has reached getFavorToDonate() (150 in BN4) sells rep
 * for money, so it is DONATED to its rep target rather than worked for it - the
 * work moves on down WORK_ORDER. Favor only changes at an install
 * (Faction.prestigeAugmentation), so what is read once per cycle holds for it.
 *
 * Donations spend at most this fraction of cash per AUGS pass, and only while
 * rep is what the batch lacks: once queued + rep-unlocked augs reach
 * MIN_AUG_BATCH, cash is the constraint and it is saved for the batch.
 */
export const DONATE_BUDGET_FRACTION = 0.5;
/**
 * rep = $ / DonateMoneyToRepDivisor * mults.faction_rep * FactionWorkRepGain
 * (src/Faction/formulas/donation.ts). The divisor is CONSTANTS' 1e6.
 */
export const DONATE_MONEY_PER_REP = 1e6;
// FactionWorkRepGain (BN4: 0.75) is read from the game by the BN_MULTS body,
// not configured - see sing.js.

// ----------------------------------------------------------------- travel ---

/**
 * Tian Di Hui invites only a player standing in Chongqing, New Tokyo or Ishima
 * with hacking 50 and $1m (FactionInfo.tsx). So: fly out from Sector-12 once
 * both hold with the fare home in hand, wait there for the invite, fly back once
 * joined - the gym and Sector-12's own invite are Sector-12-only. Chongqing's
 * own invite, which would arrive while waiting, is in JOIN_DENY.
 */
export const TDH_FACTION = "Tian Di Hui";
export const TDH_CITY = "Chongqing";
export const TDH_HACKING = 50;
export const TDH_MONEY = 1e6;
export const HOME_CITY = "Sector-12";
/** CONSTANTS.TravelCost. */
export const TRAVEL_COST = 200e3;
/** Unfocused work earns CONSTANTS.BaseFocusBonus = 0.8 without the Neuroreceptor implant. */
export const WORK_FOCUS = true;
