/**
 * Stanek's Gift tunables and paths. Constants only, no ns - 0 GB to import.
 *
 * Every figure below is from the fork's src/CotMG and src/NetscriptFunctions/Stanek.ts.
 */

/** The pass boot runs once a tick (runToCompletion). */
export const STANEK_SERVICE = "/scripts/stanek/stanek.js";

/**
 * The charge worker: ONE process on ONE host. A charge adds the CALLING
 * script's `threads x coreBonus`, and the fragment's effect grows with
 * ln(highestCharge) - the most threads any single call brought - so the
 * worker's thread count is the whole bonus and splitting it across hosts would
 * throw most of it away.
 *
 * NOT HOME, though home has the cores. Cores enter the charge inside the log:
 * 8 cores (x1.4375) are worth ln(1.4375)/60 x 2 = +1.2 points on a Hacking
 * fragment. The batcher gets the same x1.4375 LINEARLY on every grow and
 * weaken thread it puts on home, so a GB reserved there costs it ~1.44 GB of
 * 1-core RAM. The cores stay with the batcher.
 */
export const CHARGE_WORKER = "/scripts/stanek/charge.js";

/** 1.60 base + chargeFragment 0.40. */
export const CHARGE_GB = 2.0;

/** What the pass found and did, overwritten every pass; boot copies it on change. */
export const STATUS_FILE = "/data/stanek.txt";

/**
 * The signature of the last board the pass judged best (w, h, every fragment's
 * id and root and rotation), so the layout search runs once per board change and
 * not every tick. Any edit - by hand, an install's new node - misses it.
 */
export const LAYOUT_FILE = "/data/stanek-layout.txt";

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

/**
 * The cells FRAGMENT_ORDER leaves free: every fragment but the boosters is a
 * tetromino, so BN13.1's 6x5 board holds six with 6 cells spare - room for one
 * more, never two. The FIRST of these that fits what is left goes in (plan.js
 * fill), on a fresh board and on one already laid out, hand layouts included.
 * Never moves anything placed. The user's order:
 *
 *   20  HacknetMoney   hacknet production (I)
 *   28  Crime          crime success (L) - sing's money crimes, sleeve karma
 *   27  WorkMoney      work money (J)
 */
export const FILL_ORDER = [20, 28, 27];

/**
 * Boosters (ids 100-107, 5 cells) go on a FRESH board only, and only once every
 * FRAGMENT_ORDER piece is on it. Each multiplies the power of every distinct
 * non-booster it touches by 1.1 (StaneksGift.effect), so where it sits is the
 * whole value. A spot scores the summed weights of the pieces it touches - the
 * user's: Hacking 3, speed/money/grow 2, rep 1 - and must touch at least
 * BOOST_MIN_TOUCH of them: a booster on one piece is 10% of one bonus, less
 * than a FILL_ORDER piece's whole one.
 */
export const BOOST_WEIGHTS = { 0: 3, 1: 3, 5: 2, 6: 2, 7: 2, 25: 1 };
export const BOOST_MIN_TOUCH = 2;

/**
 * Search steps for the booster layout, which runs once per BitNode. Measured
 * on the real shapes: 50k is within ~10% of 1M's best score on 6x6 to 7x7 and
 * under half a second on 7x7 (1M took 7.5 s - the game freezes while it runs).
 */
export const BOOST_SEARCH_NODES = 50000;

/** Names for the status lines, by id. A hand-placed fragment shows as #id. */
export const FRAGMENT_NAMES = {
  0: "hacking", 1: "hacking", 5: "hack speed", 6: "hack money", 7: "grow power", 25: "rep",
  20: "hacknet", 27: "work money", 28: "crime",
};

/** FragmentTypeEnum.Booster - never charged (the game throws) and not laid out. */
export const BOOSTER_TYPE = 18;

/**
 * The most RAM the worker takes, default of the live stanek.maxGb: 64 TB. It
 * takes the whole of the largest host up to this. Each DOUBLING of threads adds
 * a flat ln2/60 x 2 x ~1.5 = +3.5 points per Hacking fragment, while the
 * batcher's income is ~linear in RAM - so past a fixed size the bonus stops
 * paying for the RAM (the user's call: 64 TB, about x2.4 hacking from the two
 * Hacking fragments).
 */
export const STANEK_MAX_GB = 65536;

/**
 * Relaunch the worker only once it could run this many times its threads. A
 * relaunch costs nothing it has earned (highestCharge is kept by the game,
 * numCharge rescaled), but the bonus is logarithmic in threads, so chasing
 * every few GB the manager frees would restart it all through the ramp-up.
 */
export const RELAUNCH_RATIO = 1.5;
