/**
 * Shared batcher configuration.
 *
 * Plain constants only - no ns calls, no imports. Bitburner charges an importer
 * for the ns functions reachable in a module; this file has none, so importing
 * it costs 0 GB. Everything that needs a tunable reads it from here so the
 * harness, the workers and the manager can never drift apart.
 */

// -------------------------------------------------------------- batching ----

/** Fraction of a target's MAX money one batch's hack takes. */
export const STEAL_FRACTION = 0.10;

/**
 * Hard ceiling on the auto-chosen steal fraction.
 *
 * The picker maximises money per batch, and when RAM is plentiful and
 * MAX_VOLLEY_BATCHES is the binding constraint, more steal is the only way to
 * more money - so it pushes to whatever wall exists. That wall used to be a
 * bare `steal >= 0.99` in chooseSteal, and a measured volley at 98.28% drained
 * a $17.68b target to $166.11k in one window.
 *
 * The failure is NOT a slow drain. Thread counts are sized once from one
 * snapshot, then the batches land spread across the whole weaken window while
 * hacking level keeps climbing. A batch landing late steals a larger fraction
 * than planned, its grow was sized for the smaller one, and the batch ends
 * below where it started. Measured across two consecutive cycles on alpha-ent,
 * per-thread hack effectiveness rose 2.26x (9.78e-4 -> 2.21e-3) with security
 * pinned at minimum the whole time, so hacking level was the only input moving.
 *
 * How much drift a volley survives, from
 *   net = (1 - actual) * GROW_MARGIN / (1 - planned)  >=  1:
 *
 *     tolerance = ((GROW_MARGIN - 1) / GROW_MARGIN) * (1 - steal) / steal
 *
 * At GROW_MARGIN 1.05:
 *
 *     steal   20%    60%    80%    85%    90%    95%   98.28%
 *     drift    19%  3.17%  1.19%  0.84%  0.53%  0.25%   0.08%
 *
 * The headroom collapses as steal rises, which is why the extreme end is
 * where volleys die rather than merely underperform. Note this is tolerance
 * to EFFECTIVENESS drift, and one batch ending below max compounds into the
 * next.
 *
 * 0.85 is a deliberate ceiling on the cliff edge, not a safe operating point -
 * re-read the table above before raising it, and watch for OFF BASELINE.
 *
 * Applies only to the AUTO picker. An explicit --steal is left alone: pinning a
 * fraction by hand is a deliberate act, and silently overriding it would make
 * the flag lie.
 */
export const MAX_STEAL_FRACTION = 0.85;

/**
 * Gap between the four landings INSIDE one batch, ms.
 *
 * Must exceed the game's scheduling JITTER - the spread of drift within a batch,
 * not its absolute lateness. See scripts/verify.js for why those differ.
 *
 * Measured on joesguns: a single batch (15 workers) jitters 6-7ms, but a
 * 2-batch volley (35 workers) jittered 48ms. Jitter scales with how many
 * workers land at once, so single-batch numbers badly understate what a volley
 * does, and 20ms was comfortably over the first while being half the second.
 *
 * 100ms is deliberately generous. It is very nearly free: the batch count is
 * limited by RAM, not by the weaken window, and spacing only consumes window.
 * A 50s window at 400ms batch spacing still holds ~124 batches, far more than
 * any pool here can fill. Raise it further without hesitation if the manager
 * reports jitter approaching it; only shrink it if the window ever becomes the
 * binding constraint, which capacity.js will say outright.
 */
export const SPACER_MS = 100;

/**
 * Gap between consecutive batches in a volley, ms.
 *
 * Deliberately NOT derived from SPACER_MS. The two solve different problems:
 * the spacer fights millisecond-scale jitter within a batch, while this one
 * decides how densely the volley packs, and a too-dense volley means a mistimed
 * batch collides with its neighbour rather than just reordering inside itself.
 *
 * Hard floor is 4 * SPACER_MS: a batch spans three spacers from its H to its
 * W2, so anything tighter lets the next batch's hack land inside the previous
 * batch's tail. That is exactly what happened at spacer 20 / spacing 80 - the
 * gap between one batch's W2 and the next batch's H was 20ms against 48ms of
 * measured jitter, and a weaken cancelled the wrong batch's op.
 *
 * At the floor with a 100ms spacer, a 50s window still holds ~124 batches,
 * which no realistic RAM pool here can fill - so the window is never the real
 * limit and this can be raised freely for safety.
 */
export const BATCH_SPACING_MS = 4 * SPACER_MS;

/**
 * Force a batch's hack threads onto a SINGLE host.
 *
 * Split hack is legal but lossy. All split calls land at the same planned
 * millisecond, and each one takes its fraction of whatever money is left when
 * it resolves, so the batch steals 1 - (1-f1)(1-f2)... instead of f1+f2+...
 * With a 10% steal split four ways that's roughly 2.5% less money per batch.
 *
 * The loss is one-directional and safe: the batch steals slightly LESS than
 * planned, so the grow sized for the planned steal overshoots and the target
 * just re-caps at max money. It never under-refills.
 *
 * Contiguity is usually the binding constraint on volley size, not total RAM -
 * a 25-thread hack needs 42.5GB on ONE host, which may be a single machine in a
 * 755GB pool. Leaving this false trades ~2.5% per batch for roughly 15x the
 * batch count. Set true if you would rather have exact per-batch accounting.
 */
export const HACK_CONTIGUOUS = false;

/**
 * Grow safety margin, as a fraction of MONEY - not of threads.
 *
 * Batches ask for enough grow to climb back from `afterHack / GROW_MARGIN`
 * rather than from `afterHack`, so 1.05 means "size grow as though the hack took
 * 5% more than it did". That gives the same headroom at every steal fraction.
 *
 * It must not be applied to the thread count. Threads relate to the growth
 * multiplier exponentially, so `threads * 1.05` yields `mult^1.05`: 9% of
 * headroom at a x5.64 restore, but 2% at x1.49 and 0.5% at x1.11. Measured
 * volleys bear that out - 77-82% steal held the target at max money, while
 * 32.74% and 69.31% drained it to nothing. Every batch in a volley is planned
 * against the same max-money snapshot, so a per-batch shortfall compounds
 * geometrically over hundreds of batches.
 *
 * Overshooting costs almost nothing: the game clamps money at maxMoney, so
 * surplus grow threads simply do nothing.
 */
export const GROW_MARGIN = 1.05;

/**
 * How much the hack fraction may grow mid-volley without the volley eating
 * itself, as a fraction of the planned steal.
 *
 * Thread counts are sized once per volley from one snapshot, then the batches
 * land across the whole weaken window while hacking level climbs. A batch
 * landing late steals MORE than planned, and its grow was sized for the smaller
 * take, so it ends below where it started - and every batch is planned against
 * max money, so the shortfall compounds geometrically.
 *
 * A FIXED grow margin cannot buy a fixed amount of that protection. At margin m
 * the drift a batch survives is ((m-1)/m) * (1-steal)/steal, which collapses as
 * steal rises: GROW_MARGIN 1.05 is worth 19% at 20% steal but 0.88% at 84%. A
 * measured volley at 84.37% steal opened healthy - its first tenth averaged
 * x3.66 against the x3.33 a perfect volley reads at that hack chance - and then
 * collapsed to $9.36k of $499.68b as level climbed past that 0.88%.
 *
 * So fix the TOLERANCE and solve for the margin instead. Requiring
 *   (1 - steal(1 + D)) * margin / (1 - steal) >= 1
 * gives growMarginFor() below, which delivers the same D at every steal. This is
 * the same correction GROW_MARGIN itself needed once already: it used to
 * multiply the thread count, which made it exponentially weaker exactly where it
 * mattered.
 *
 * 0.05 covers a 5% rise in hack effectiveness across one window. It costs little
 * - grow threads scale with the LOG of the multiplier, so the 1.37x margin it
 * implies at 84% steal is about 14% more grow threads, roughly 7% of a batch.
 */
export const HACK_DRIFT_TOLERANCE = 0.05;

/**
 * The grow margin that buys HACK_DRIFT_TOLERANCE at this steal fraction.
 *
 * Returns Infinity when no margin can survive the drift (steal >= 1/(1+D)) -
 * planThreadsForHack turns that into an error and the steal search stops there,
 * which is the correct answer rather than a number.
 *
 * Pure arithmetic, no ns calls - config.js must stay 0 GB.
 */
export function growMarginFor(steal, tolerance = HACK_DRIFT_TOLERANCE) {
  const survives = 1 - steal * (1 + tolerance);
  if (survives <= 0) return Infinity;
  return (1 - steal) / survives;
}

/**
 * How many EXTRA targets may be prepped alongside the one the manager is
 * waiting on.
 *
 * A prep wave is sized by need, not by capacity: growing past max money does
 * nothing and weakening below minimum security does nothing, so one target can
 * never consume more than a sliver of the pool. The weaken-only case is the
 * worst - a server carrying 50 excess security needs 50/0.05 = 1000 weaken
 * threads, about 1.75TB out of a 3267TB pool - and the manager then blocks on
 * that wave for a whole weaken window earning nothing.
 *
 * The leftover RAM goes to prepping the NEXT targets, so that when the manager
 * retargets (TARGET_SWITCH_MARGIN) the new server is already prepped and the
 * switch costs no stall.
 *
 * Capped rather than "fill the pool" because the benefit flattens fast while
 * the costs do not: each extra costs a math.snapshot every cycle, hundreds of
 * small waves fragment the pool for the primary, and the log stops being
 * readable. Three is roughly how far down the ranking a retarget ever reaches.
 */
export const PREP_FANOUT = 3;

/**
 * How long prep waits for a full pool before calling it a failure.
 *
 * A pool with no placeable thread is usually TRANSIENT. The case that forced
 * this: boot swaps manager builds when Formulas.exe is gained or lost, and the
 * outgoing manager's volley keeps running - hundreds of batches holding 2.7TB
 * for the rest of their weaken window. The incoming manager would plan against
 * that, find nothing fits, and stop; boot then restarted it a tick later into
 * exactly the same wall, once a minute until the workers drained.
 *
 * boot now kills those workers, so this is the belt to that fix's braces - any
 * other script that fills the pool gets waited out instead of taking the
 * manager down with it.
 *
 * Waiting cycles do not count against maxCycles: they do no work, and spending
 * the prep budget on them would turn a busy pool into a failed prep by a
 * different route. The product below is the real bound.
 *
 * 10s x 90 = 15 minutes, chosen to outlast one weaken window on a large target
 * (12.6m measured). Past that the pool is not busy, it is empty - no rooted
 * hosts, or no workers deployed - which is worth stopping for.
 */
export const POOL_WAIT_MS = 10000;
export const POOL_WAIT_CYCLES = 90;

// ------------------------------------------------------------------ share ---

/**
 * Written by scripts/sharemode.js, read by the manager and by every share
 * worker. Holds the FRACTION of the pool to devote to ns.share, not a bare
 * on/off flag, so the amount can be retuned from the terminal without editing
 * this file and waiting on filesync.
 *
 * The workers poll it between share calls, which is what makes "off" work with
 * no kill: see scripts/share.js.
 */
export const SHARE_MARKER = "/data/share.txt";

/** The share worker. A path only - importing it would cost 2.40 GB for ns.share. */
export const SHARE_WORKER = "/scripts/share.js";

/** Per-thread RAM of the share worker: 1.60 base + 2.40 ns.share. */
export const SHARE_RAM_FALLBACK = 4.00;

/**
 * Fraction of the pool `sharemode.js on` asks for.
 *
 * ns.share's bonus is 1 + ln(shareThreads)/25 (src/NetworkShare/Share.ts), so
 * every DOUBLING of share RAM is worth a flat ln(2)/25 = 2.77 percentage points,
 * forever. Hack income is roughly linear in RAM. On a 3267TB pool at 4.00 GB per
 * share thread:
 *
 *     share RAM   threads   bonus
 *          10%      83.6k   x1.453
 *          25%       209k   x1.490
 *          50%       418k   x1.518
 *         100%       837k   x1.546
 *
 * So the last three quarters of the pool buy 5.6 points of reputation and cost
 * three quarters of the income. 25% is chosen to sit near the knee. Raising it
 * is defensible once money is genuinely worthless - that is what the marker is
 * for - but re-read the table first, because the curve does not reward it.
 */
export const SHARE_FRACTION = 0.25;

/**
 * Hard clamp on the share fraction, whatever the marker says.
 *
 * Not decoration. Share workers are launched before the pool is built and are
 * never released, so at 100% the prep gate finds zero placeable threads, waits
 * out POOL_WAIT_CYCLES (15 minutes), returns a failure, and the manager stops -
 * whereupon boot restarts it into exactly the same wall a tick later. That is
 * the same restart loop the manager build swap produced, arrived at from a
 * different direction, and a typo in a terminal argument is enough to trigger
 * it. Leaving a tenth of the pool means prep always has somewhere to stand.
 */
export const SHARE_MAX_FRACTION = 0.90;

/**
 * Parse SHARE_MARKER's contents into a fraction in [0, SHARE_MAX_FRACTION].
 *
 * Anything unparseable reads as OFF rather than as a default. A share worker
 * decides whether to keep running from this value, and a NaN would compare
 * false against every bound - so garbage in the marker must mean "stop", never
 * "carry on with some number I invented".
 *
 * Pure arithmetic, no ns calls - config.js must stay 0 GB.
 */
export function shareFractionFrom(text) {
  const word = String(text ?? "").trim().split("\n")[0].trim().toLowerCase();
  if (word === "" || word === "off" || word === "false") return 0;
  if (word === "on" || word === "true") return SHARE_FRACTION;
  const n = Number(word);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, SHARE_MAX_FRACTION);
}

/**
 * The reputation multiplier `threads` share threads are worth.
 *
 * Mirrors calculateShareBonus in src/NetworkShare/Share.ts. It is deliberately
 * an UNDERESTIMATE of what the game will actually give: the game scales threads
 * by an intelligence bonus and by getCoreBonus (1 + (cores-1)/16, and only home
 * has more than one core) before taking the log. Neither is knowable from here
 * without paying for getPlayer and getServer, so anything reporting the real
 * figure reads ns.getSharePower() instead and this stays the floor.
 */
export function shareBonusFor(threads) {
  return threads >= 1 ? 1 + Math.log(threads) / 25 : 1;
}

// ------------------------------------------------------------------ ram -----

/**
 * GB withheld on home ON TOP OF whatever is already running there.
 *
 * The manager's own footprint is already counted by getServerUsedRam, so this
 * is pure extra headroom for scripts you launch by hand - without it a volley
 * takes every free byte on home and nothing else will start.
 *
 * WATCH THE SIZE OF HOME. This is subtracted from home's maxRam, so a reserve
 * at or above home's capacity removes home from the pool entirely rather than
 * merely trimming it. The manager prints a warning when that happens.
 *
 * It also costs volley size: whatever is reserved cannot hold batches, and the
 * batch count is a floor() of free RAM over batch RAM, so losing 32GB can cost
 * a whole batch if it was only just fitting. Re-check with --dry-run after
 * changing this, and re-tune --steal if the count dropped.
 */
export const HOME_RESERVE_GB = 32;

// ----------------------------------------------------------------- ports ----

/**
 * Netscript port workers report completion on.
 *
 * Ports are shared across all hosts and cost 0 GB to read or write. Contents
 * reset on game restart.
 */
export const REPORT_PORT = 1;

/**
 * The game's port queue length (Settings.MaxPortCapacity, default 50).
 *
 * This is a HARD constraint on the volley, not a tunable: when a write would
 * exceed it the port silently discards its OLDEST entry. A batch produces one
 * report per exec'd process - typically 10-20 once grow splits across hosts - so
 * the port holds only three or four batches' worth. The manager therefore drains
 * continuously while the volley lands rather than collecting at the end.
 *
 * You can raise it in-game: Options -> Netscript -> "Max port capacity". Doing
 * so gives the manager more slack, but draining is what actually keeps reports;
 * update this constant if you change the setting.
 */
export const PORT_CAPACITY = 50;

/** How often the manager drains the report port while a volley is landing. */
export const REPORT_DRAIN_MS = 25;

// ---------------------------------------------------------------- volley ----

/**
 * Hard ceiling on batches per volley, whatever RAM and the window allow.
 *
 * Every batch costs exec calls at launch and reports at landing, both of which
 * are real wall-clock work. This keeps one cycle bounded so a huge pool can't
 * produce a volley that takes longer to launch than to land.
 */
export const MAX_VOLLEY_BATCHES = 400;

/**
 * Extra wait past the last planned landing before declaring reports lost.
 *
 * Sized against observed lateness, which has been seen to swing from +2ms to
 * +36ms between otherwise identical batches. This is generous on purpose: ending
 * the wait early would count a late report as a lost one and trigger a needless
 * re-prep.
 */
export const VOLLEY_GRACE_MS = 5000;

/**
 * Consecutive bad volleys before the manager stops and re-preps.
 *
 * One bad batch in a volley is noise - a single late landing does not mean the
 * target drifted. A whole volley going wrong twice running means the model is
 * wrong, and firing more batches at it would dig deeper.
 */
export const DESYNC_STRIKES = 2;

/**
 * Fraction of a volley's batches that must land correctly for it to count as
 * healthy. Below this, the volley is a strike.
 */
export const VOLLEY_OK_FRACTION = 0.9;

/**
 * How much richer a new target must be before the manager switches to it.
 *
 * Switching is not free: the new server has to be prepped from scratch, which
 * costs whole weaken windows during which nothing is earned, and the old
 * server's prepped state is abandoned. A margin stops the manager chasing a
 * marginally better host every time hacking level ticks up - and stops it
 * oscillating between two servers of near-equal worth.
 *
 * Only consulted when no --target is pinned.
 */
export const TARGET_SWITCH_MARGIN = 1.25;

// --------------------------------------------------------------- workers ----

/**
 * Worker script paths, keyed by op KIND (not by batch slot).
 *
 * Per-thread RAM (verified against the fork's docs): 1.60 base plus
 * hack 0.10 / grow 0.15 / weaken 0.15. Port writes and ns.args are free.
 * => hack 1.70, grow 1.75, weaken 1.75.
 */
export const WORKER_FILES = {
  hack: "/scripts/hack.js",
  grow: "/scripts/grow.js",
  weaken: "/scripts/weaken.js",
};

/** Fallback per-thread RAM, used only when a worker file isn't on disk yet. */
export const WORKER_RAM_FALLBACK = { hack: 1.70, grow: 1.75, weaken: 1.75 };

/**
 * The four batch slots, in required landing order.
 *
 * Note W1 and W2 are both weaken.js: the slot tag is passed to the worker as an
 * argument rather than baked into the script, because the manager has to tell
 * the two weakens apart to verify landing order. A per-script tag couldn't.
 */
export const BATCH_OPS = ["H", "W1", "G", "W2"];

/** Which worker file runs each slot. */
export const OP_WORKER = { H: "hack", W1: "weaken", G: "grow", W2: "weaken" };

/** The three batch workers - the ones that report on REPORT_PORT. */
export const WORKER_LIST = Object.values(WORKER_FILES);

/**
 * Modules the workers IMPORT, which must be copied alongside them.
 *
 * This list is not an optimisation, it is a correctness requirement, and
 * omitting it cost three live runs. Bitburner resolves a script's imports on
 * the server it is being started on, and RamCalculations.ts returns
 * `ImportError: "<module>" does not exist on server: <host>` when one is
 * missing. exec cannot price the script, so it returns a bare 0 - the same
 * value it returns when the script itself is absent, which is what made this so
 * hard to see: fileExists said share.js WAS there, and it was.
 *
 * hack.js, grow.js and weaken.js import nothing at all, so this never came up
 * before. share.js imports config.js for the marker path, so it ran on home -
 * the one host that happens to have config.js - and returned 0 on all 68
 * others.
 *
 * Adding a worker that imports anything means adding that import here. The test
 * suite enforces it: DEPLOY_LIST must be closed under imports.
 */
export const WORKER_DEPS = ["/scripts/config.js"];

/**
 * Everything that must exist on a host before the manager can exec it there.
 *
 * Lives here rather than in deploy.js so boot.js can compare it against
 * DEPLOY_MANIFEST without importing deploy.js and paying 0.90 GB (scp, scan,
 * hasRootAccess, getServerMaxRam) for a list of strings.
 */
export const DEPLOY_LIST = [...WORKER_LIST, SHARE_WORKER, ...WORKER_DEPS];

/**
 * Written by deploy.js recording WHICH files it actually broadcast.
 *
 * Exists because adding a worker file is invisible to everything else. deploy.js
 * runs only when root.js roots something new, so a new file sits on home while
 * every host runs without it - and the only symptom is exec returning a bare 0
 * somewhere far away. That is exactly how share.js reached one host out of 69.
 *
 * It also catches the failure that outlasted the first fix. If boot runs
 * deploy.js and the manifest still does not match DEPLOY_LIST, then the copy of
 * deploy.js INSIDE THE GAME is older than the one on disk - the filesync
 * extension has not delivered it - and no amount of re-running it will help.
 * That is this repo's most expensive recurring failure and it has never had a
 * detector; this is one.
 */
export const DEPLOY_MANIFEST = "/data/deployed.txt";

// ------------------------------------------------------------ supervisor ----

/**
 * Stamped by root.js whenever a pass roots something new; polled by boot.js to
 * decide whether deploy.js needs to run.
 *
 * It lives here rather than in root.js so boot.js can read it without importing
 * root.js - an import would charge boot.js for every ns function root.js can
 * reach (scan, nuke, hasRootAccess and five crackers, 0.55 GB) to obtain one
 * string. config.js has no ns calls at all, so importing it stays free.
 */
export const ROOT_MARKER = "/data/rooted.txt";

/**
 * Stamped by cloud.js when the fleet is fully maxed - every slot filled and
 * every server at getRamLimit(). Read by boot.js, which then stops relaunching
 * a service that has nothing left to do.
 *
 * cloud.js clears this at startup and writes it only on the terminal state, so
 * a run that merely could not AFFORD anything never stamps it.
 */
export const CLOUD_DONE_MARKER = "/data/cloud-maxed.txt";

/**
 * How long boot.js trusts CLOUD_DONE_MARKER before re-running cloud.js anyway.
 *
 * "Maxed" is terminal for a given BitNode, but the limits themselves can change
 * underneath us - a new BitNode, or a server deleted by hand - and boot cannot
 * check that itself without importing the cloud API and paying for it. A slow
 * re-check costs one short-lived script per interval and self-heals.
 */
export const CLOUD_RECHECK_MS = 30 * 60 * 1000;

/** The program that unlocks ns.formulas. */
export const FORMULAS_PROGRAM = "Formulas.exe";

/**
 * Written by boot.js so other scripts can learn which build boot is currently
 * running without paying 0.10 GB for fileExists. This is the EFFECTIVE build
 * choice, not raw ownership: with --no-formulas it records 0 even though the
 * program is owned. Advisory only - boot re-checks every tick, so a stale
 * value corrects itself within one tick and nothing that matters is decided
 * from it.
 */
export const FORMULAS_MARKER = "/data/formulas.txt";

// ---------------------------------------------------------------- report ----

/**
 * Shape of a worker's completion report, written to REPORT_PORT:
 *
 *   { b: batchId, op: "H"|"W1"|"G"|"W2", t: threads,
 *     p: plannedLandMs, a: actualMs, r: opReturnValue }
 *
 * p and a are absolute epoch milliseconds (Date.now()), so drift is a - p.
 *
 * r is what the op itself returned: money stolen (hack), the achieved growth
 * multiplier (grow), or security removed (weaken). A report arriving WITHOUT r
 * came from a worker deployed before workers reported results - the in-game
 * copies are behind the ones on disk, and scripts/deploy.js needs re-running.
 * The manager identifies which RAM reservation to release from b + op, which is
 * why the host isn't in the message - the manager already knows the placement.
 *
 * Data is passed through structuredClone by writePort, so this stays a plain
 * object; no JSON encoding on either side.
 *
 * Worker argv order, shared by all three workers:
 *   [0] target host
 *   [1] additionalMsec delay
 *   [2] batch id
 *   [3] report port
 *   [4] planned land time (absolute epoch ms)
 *   [5] slot tag ("H" | "W1" | "G" | "W2")
 *   [6] thread count
 */
export const WORKER_ARGV = ["target", "delay", "batch", "port", "planned", "op", "threads"];

// ------------------------------------------------------------ tolerances ----

/**
 * How close to max money counts as "prepped".
 *
 * Lives here rather than in prepper.js because both math implementations
 * compute snapshot().moneyOk, and a difference between them would mean
 * "prepped" silently meant two different things depending on which one loaded.
 */
export const MONEY_TOLERANCE = 0.999;

/** How far above minimum security still counts as "at minimum". */
export const SEC_TOLERANCE = 0.01;
