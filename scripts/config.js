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

/** Every worker path, for scp. */
export const WORKER_LIST = Object.values(WORKER_FILES);

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
