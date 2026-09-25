export { TARGETS_MARKER, HACKNET_HOST_PREFIX, STUDY_MARKER } from "scripts/config.js";

/**
 * Hacknet tunables. No ns call anywhere in this file, and it must stay that
 * way: boot.js imports the two service paths out of it, and boot is pinned at
 * 3.50 GB.
 *
 * Game constants below are cited to the fork file they came from. Each is one
 * the API does not expose, so there is nothing to read them from at runtime.
 */

export const HACKNET_MONEY_SERVICE = "/scripts/hacknet/hacknet.js";
export const HACKNET_HASH_SERVICE = "/scripts/hacknet/hashes.js";

/**
 * Boot ticks between sweeps. The tick is 60 s, so this is every two minutes.
 *
 * Both sweeps are transients: they cost 5.45 and 6.60 GB for a few hundred ms
 * and nothing in between, so the cadence is about not bidding for home RAM
 * against the gang's equip body (14.70) and the contract find body (12.00),
 * not about the work itself.
 */
export const HACKNET_EVERY = 2;

/**
 * Buy an upgrade only if it repays its own cost within this long.
 *
 * This is the whole off switch. The hacknet's marginal gain does not move as
 * the batcher grows, so paybacks blow out on their own and the sweep stops
 * buying without anyone deciding it should.
 */
export const PAYBACK_SECONDS = 3600;

/**
 * Share of cash one sweep may spend, priced once at the start of the sweep.
 *
 * cloud.js is bidding for the same wallet capped at 10%, and sing's aug batch
 * wants all of it at once. The server fleet is the batcher's growth path;
 * the hacknet is not.
 */
export const HACKNET_CASH_FRACTION = 0.05;

/**
 * What a hash is worth in cash, and it is not a modelling choice.
 *
 * HashUpgradesMetadata.tsx gives Sell for Money BOTH `cost: 4` and
 * `costPerLevel: 4` - the rate is flat only because HashUpgrade.getCost
 * early-returns on `cost` when it is set, and that field's own doc comment
 * says "This property overrides the 'costPerLevel' property". So the price
 * never rises with level, at `value: 1e6`. Overflow hashes are auto-sold at
 * exactly this rate too (processAllHacknetServerEarnings computes
 * `wastedHashes / upgrade.cost * upgrade.value`), which is why spending
 * nothing is a correct null action rather than a leak - and why every other
 * upgrade has to beat this number.
 */
export const HASH_SALE_VALUE = 1e6;
export const HASH_SALE_COST = 4;
export const HASH_PRICE = HASH_SALE_VALUE / HASH_SALE_COST;

/** How far ahead a hash upgrade's income gain is counted. */
export const HASH_HORIZON_S = 3600;

/** How far a hash upgrade must beat the sale price before it is bought. */
export const HASH_VALUE_MARGIN = 2;

/**
 * Where Server.changeMaximumMoney starts damping the +2%. Above it the game
 * applies `1 + (n-1)/Math.log(moneyMax - softCap)/Math.log(8)` - two divisions
 * by logs, which is what the source does.
 */
export const MONEY_SOFTCAP = 10e12;

/**
 * Spelled as HashUpgradeEnum spells them. spendHashes() resolves the name
 * through getEnumHelper().nsGetMember and THROWS on a miss, so a fold or a
 * typo here is a thrown sweep, not a quiet no-op.
 */
export const MAX_MONEY_UPGRADE = "Increase Maximum Money";
export const MIN_SECURITY_UPGRADE = "Reduce Minimum Security";

/**
 * The fallback: turn hashes into cash when nothing else is worth buying.
 *
 * WHY THIS IS NOT REDUNDANT WITH THE AUTO-SALE. The game auto-sells only the
 * OVERFLOW - storeHashes() caps the balance at capacity and returns the
 * remainder, and only that remainder is paid out. Everything at or below
 * capacity simply sits, and a hacknet server's capacity is
 * `32 * 2^cache` (HacknetServer.updateHashCapacity), so a cache-1 server parks
 * 64 hashes = $16m that nothing will ever collect while there are no targets to
 * spend on. Selling at the same $250k/hash releases it, and money compounds
 * into home RAM where a parked hash does not.
 */
export const SELL_MONEY_UPGRADE = "Sell for Money";

/**
 * +20% class exp per level (HashManager.getStudyMult: 1 + 20 * level / 100),
 * costPerLevel 50, so level L costs 50 * (L+1). Bought only while sing holds
 * the player in a class (STUDY_MARKER), and ahead of any sale: it pays in exp,
 * which no dollar figure here can be weighed against, so it is capped by a
 * level count rather than priced. Measured in BN9, Algorithms ~96 exp/s, so a
 * level is ~+19 exp/s. Resets at an install, like every hash upgrade.
 */
export const STUDY_UPGRADE = "Improve Studying";
/** Default of the live `hacknet.studyLevels` - 10 levels is 2750 hashes in all. */
export const STUDY_LEVELS = 10;
