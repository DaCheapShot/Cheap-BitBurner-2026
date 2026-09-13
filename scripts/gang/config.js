/**
 * Every tunable for the gang subsystem, in one place and at ZERO RAM cost.
 *
 * Same rule as scripts/config.js: no ns call may ever appear in this file. It is
 * imported by the resident scheduler AND by all four transients, so one billed
 * function here is charged five times over - and the transients are the things
 * that have to fit beside boot, cloud and a manager on the smallest home a
 * fresh BitNode hands you.
 *
 * Names that LOOK like ns functions are safe only as strings and as
 * non-computed object keys. src/Script/RamCalculations.ts bills bare
 * identifiers, so `hack` as a variable would cost 0.10 GB here and in every
 * importer; that is why stats are addressed through STAT_KEYS below and never
 * written as `m.hack`.
 */

// ------------------------------------------------------------------ paths ---

export const GANG_SERVICE = "/scripts/gang/gang.js";
export const GANG_TICK = "/scripts/gang/tick.js";
export const GANG_ASCEND = "/scripts/gang/ascend.js";
export const GANG_EQUIP = "/scripts/gang/equip.js";
export const GANG_WAR = "/scripts/gang/war.js";

/**
 * Status marker, written by tick.js and read by the other transients.
 *
 * Flat lines, the repo's usual marker shape (see ROOT_MARKER, FORMULAS_MARKER):
 *   1 phase
 *   2 respect
 *   3 respectForNextRecruit
 *   4 member count
 *   5 territory
 *   6 timestamp
 *
 * It exists to keep ns.gang.getGangInformation (2.00 GB) out of ascend.js and
 * equip.js, which need only three numbers from it and would otherwise each pay
 * full price for the call. The numbers are at most one tick stale, which is
 * irrelevant to an ascension guard and a purchase budget.
 *
 * Written on home and read on home - the transients never leave it - so the
 * ns.read host-resolution trap that share.js documents does not apply. Do not
 * copy this pattern to anything that runs off home.
 */
export const GANG_MARKER = "/data/gang.txt";

// ---------------------------------------------------------------- cadence ---

/**
 * Cadences are counted in GANG UPDATES, not milliseconds.
 *
 * ns.gang.nextUpdate() resolves once per gang update - 2 s of game time
 * normally, up to 5 s worth per update while bonus time is draining
 * (GangConstants.minCyclesToProcess / maxCyclesToProcess). Counting updates
 * therefore makes every cadence here track bonus time for free: when the gang
 * is processing three times as fast, so are we.
 */
export const TICK_EVERY = 5;
/** Territory and power update every 100 cycles = 20 s, so checking faster buys nothing. */
export const WAR_EVERY = 10;
export const ASCEND_EVERY = 15;
export const EQUIP_EVERY = 15;

/** How long to wait for a transient before giving up on it and moving on. */
export const TRANSIENT_TIMEOUT_MS = 60 * 1000;

// ----------------------------------------------------------------- phases ---

export const PHASE_TRAIN = "train";
export const PHASE_RESPECT = "respect";
export const PHASE_TERRITORY = "territory";
export const PHASE_MONEY = "money";

/** GangConstants.MaximumGangMembers in src/Gang/data/Constants.ts. */
export const MAX_MEMBERS = 12;

export const MEMBER_PREFIX = "goon-";

/**
 * Combat-stat floor below which a member trains instead of earning.
 *
 * This is not a preference. Every gain formula subtracts a multiple of the
 * task's difficulty from the weighted stat sum and returns 0 when the result is
 * non-positive - 4x for respect, 3.2x for money, 3.5x for wanted. Human
 * Trafficking has difficulty 36, so a member under roughly 150 weighted stats
 * earns literally nothing from it. Training is the only thing that pays below
 * the floor.
 */
export const TRAIN_STAT_FLOOR = 150;
/**
 * Charisma is NOT decoration in a combat gang: Deal Drugs weights it 60%,
 * Run a Con 40%, Human Trafficking 30%, Traffick Illegal Arms 25%.
 *
 * A lower floor than the combat one because Train Charisma has difficulty 8
 * against Train Combat's 100, so charisma arrives far faster than it is spent.
 */
export const TRAIN_CHA_FLOOR = 80;

/** Territory share at which the TERRITORY phase is considered done. */
export const TERRITORY_TARGET = 0.95;

// -------------------------------------------------------- wanted governor ---

/**
 * The hard floor the game clamps wanted level to.
 *
 * Gang.ts, processGains: `if (this.wanted < 1 || ...) { this.wanted = 1; }`,
 * and the whole block is wrapped in
 * `if (this.wanted !== 1 || wantedLevelGainPerCycle >= 0)` - so at wanted
 * exactly 1 with negative gain, penance is not merely wasted, it is skipped.
 */
export const WANTED_MIN_LEVEL = 1;

/**
 * How much of the ACHIEVABLE wanted penalty the gang must be keeping.
 *
 * A ratio, not an absolute penalty. The absolute form deadlocked a live gang:
 * the penalty is respect/(respect + wanted), so a fresh gang at 5 respect and
 * wanted already clamped to 1 reads 0.833 - under any sensible absolute floor -
 * while having nothing whatsoever to fix. The governor posted vigilantes,
 * vigilantes earn no respect, respect is the only term that could raise the
 * penalty, and the gang sat there.
 *
 * Measuring against the penalty at WANTED_MIN_LEVEL instead makes the trigger
 * mean what it was always supposed to mean - "how much of the attainable
 * multiplier is wanted level costing us" - and is right at the clamp by
 * construction rather than by a special case: the ratio is exactly 1 there.
 *
 * Deliberately no hysteresis, unlike the war thresholds. Flipping earners onto
 * Vigilante Justice drops wanted, which lifts the ratio back over the floor,
 * which releases them - a limit cycle around it is the correct steady state
 * here. Flapping costs nothing in this loop; flapping a territory clash costs
 * members.
 */
export const WANTED_PENALTY_FLOOR = 0.95;

// -------------------------------------------------------------- ascension ---

/**
 * Ascend when the multiplier factor on a stat the member's task actually uses
 * clears this.
 *
 * getAscensionResult returns newMult/oldMult per stat, so 1.15 is "15% better
 * forever". Lower is more aggressive: ascension wipes exp and all non-
 * augmentation equipment, so each one costs a re-train. 1.15 is roughly where
 * the re-train pays for itself inside a phase.
 */
export const ASCEND_MULT_THRESHOLD = 1.15;

// -------------------------------------------------------------- equipment ---

/**
 * Spend at most this fraction of current cash on ONE equipment sweep.
 *
 * Per sweep, and a sweep runs every EQUIP_EVERY gang updates (~30 s) - so this
 * is far more aggressive than it reads. It is also self-limiting: the next
 * sweep prices against whatever is left.
 *
 * Kept low because cloud.js is the other bidder for the same cash and is capped
 * at 10% of it. At 0.9 the gang wins nearly every race and the server fleet,
 * which is the batcher's whole growth path, stops growing.
 */
export const EQUIP_BUDGET_FRACTION = 0.25;

/**
 * Gear is bought only in these phases; AUGMENTATIONS are bought in all of them.
 *
 * GangMember.ascend() clears every upgrade and then reapplies only the
 * augmentations, so a Weapon bought the tick before an ascension is money set
 * on fire, while an Augmentation is permanent.
 *
 * TRAIN is excluded for that reason and RESPECT is not, which looks
 * inconsistent and is not. In TRAIN nobody has cleared the stat floor, so gear
 * buys stats that are about to be wiped and earns nothing in the meantime. In
 * RESPECT the members are already working: gear raises their stats now, that
 * raises respect now, and respect is what gates the roster. Losing the gear to
 * a later ascension costs the purchase price, not the earnings it made first.
 */
export const BUY_GEAR_PHASES = [PHASE_RESPECT, PHASE_TERRITORY, PHASE_MONEY];
export const EQUIP_AUGMENTATION = "Augmentation";

// ------------------------------------------------------------------- war ----

/**
 * Engage clashes only when the WORST win chance across rivals holding territory
 * clears this, and disengage below the lower one.
 *
 * Hysteresis here and nowhere else: losing a clash kills a member, and a gang
 * that toggles warfare around a single threshold will sit exactly on it.
 */
export const WAR_WIN_THRESHOLD = 0.60;
export const WAR_DISENGAGE_THRESHOLD = 0.55;

/** Fraction of the gang put on Territory Warfare during the TERRITORY phase. */
export const WAR_MEMBER_FRACTION = 0.5;

// ----------------------------------------------------------------- tasks ----

export const TASK_UNASSIGNED = "Unassigned";
export const TASK_TRAIN_COMBAT = "Train Combat";
export const TASK_TRAIN_CHARISMA = "Train Charisma";
export const TASK_VIGILANTE = "Vigilante Justice";
export const TASK_WARFARE = "Territory Warfare";

/** Tasks that are never chosen as an EARNER, whatever they score. */
export const NON_EARNING_TASKS = [
  TASK_UNASSIGNED,
  TASK_TRAIN_COMBAT,
  TASK_TRAIN_CHARISMA,
  "Train Hacking",
  TASK_VIGILANTE,
  TASK_WARFARE,
];

// ------------------------------------------------------------------ math ----

/**
 * Stat keys, in the order the weight keys below match.
 *
 * Addressed as m[STAT_KEYS[i]] rather than m.hack / m.str / ... because a bare
 * `hack` identifier is charged 0.10 GB by the game wherever it appears, even as
 * a property read. String literals are Literal nodes and cost nothing, so this
 * loop is free where the obvious spelling is not.
 */
export const STAT_KEYS = ["hack", "str", "def", "dex", "agi", "cha"];
export const WEIGHT_KEYS = [
  "hackWeight", "strWeight", "defWeight", "dexWeight", "agiWeight", "chaWeight",
];
/** The four stats Train Combat raises. */
export const COMBAT_STAT_KEYS = ["str", "def", "dex", "agi"];
export const CHA_KEY = "cha";

/**
 * BitNodeMultipliers.GangSoftcap, which appears only in the gain exponent:
 *   pow(11 * baseRespect * statWeight * territoryMult * penalty, (0.2*T + 0.8) * softcap)
 *
 * It CANCELS OUT of task ranking - pow is monotonic, so the ordering of tasks by
 * respect (or by money) is the same for any positive exponent. It matters only
 * for predicting an absolute rate, which nothing here does. The real
 * per-BitNode value comes from ns.getBitNodeMultipliers, which costs 4.00 GB
 * and needs Source-File 5; not worth buying for a constant that cancels.
 */
export const GANG_SOFTCAP = 1;
