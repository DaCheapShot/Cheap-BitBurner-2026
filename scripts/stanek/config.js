/**
 * Stanek's Gift tunables and paths. Constants only, no ns - 0 GB to import.
 *
 * Every figure below is from the fork's src/CotMG and src/NetscriptFunctions/Stanek.ts.
 */

/** The pass boot runs once a tick (runToCompletion). */
export const STANEK_SERVICE = "/scripts/stanek/stanek.js";

/**
 * The charge worker: ONE process on home, never anywhere else. A charge adds
 * the CALLING script's `threads x coreBonus`, and the fragment's effect grows
 * with ln(highestCharge) - the most threads any single call brought - so the
 * worker's thread count is the whole bonus and splitting it across hosts would
 * throw most of it away. Home also has the cores.
 */
export const CHARGE_WORKER = "/scripts/stanek/charge.js";

/** 1.60 base + chargeFragment 0.40. */
export const CHARGE_GB = 2.0;

/** What the pass found and did, overwritten every pass; boot copies it on change. */
export const STATUS_FILE = "/data/stanek.txt";

/**
 * Fragments to place, by id, most wanted first - the user's order, hacking
 * first: BN13 runs hacking at x0.25 and w0r1d_d43m0n at x3 difficulty.
 * Ids rather than types because Hacking has TWO fragments (0, the S, and 1, the
 * Z) and both are wanted. Shapes are read from fragmentDefinitions(), not
 * copied, so a fork that reshapes one is laid out correctly anyway.
 *
 *   0, 1  Hacking        hacking skill and exp
 *   5     HackingSpeed   hack/grow/weaken time
 *   6     HackingMoney   hack() power
 *   7     HackingGrow    grow() power
 *   25    Rep            faction and company rep
 */
export const FRAGMENT_ORDER = [0, 1, 5, 6, 7, 25];

/** Names for the status lines, by id. A hand-placed fragment shows as #id. */
export const FRAGMENT_NAMES = {
  0: "hacking", 1: "hacking", 5: "hack speed", 6: "hack money", 7: "grow power", 25: "rep",
};

/** FragmentTypeEnum.Booster - never charged (the game throws) and not laid out. */
export const BOOSTER_TYPE = 18;

/** Default share of home's RAM the charge worker gets - the live stanek.fraction. */
export const STANEK_FRACTION = 0.25;

/**
 * Relaunch the worker only once it could run this many times its threads. A
 * relaunch costs nothing it has earned (highestCharge is kept by the game,
 * numCharge rescaled), but the bonus is logarithmic in threads, so chasing
 * every few GB the manager frees would restart it all through the ramp-up.
 */
export const RELAUNCH_RATIO = 1.5;
