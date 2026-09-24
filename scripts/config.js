/**
 * Shared batcher configuration.
 *
 * Plain constants only - no ns calls, no imports. Bitburner charges an importer
 * for the ns functions reachable in a module; this file has none, so importing
 * it costs 0 GB. Everything that needs a tunable reads it from here so the
 * harness, the workers and the manager can never drift apart.
 */

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

/**
 * Port the share fraction is BROADCAST on, for the workers to read.
 *
 * The marker above cannot do this job, and assuming it could cost a live run.
 * ns.read resolves against the server the calling script runs on - from
 * NetscriptFunctions.ts, `const server = ctx.workerScript.getServer()` and then
 * `server.getContentFile(path)?.content ?? ""`. /data/share.txt exists on home
 * alone, so a share worker anywhere else read "", parsed it as OFF, and exited
 * within milliseconds of starting. exec had returned a real pid, so the manager
 * counted 66 hosts sharing while 65 of them had already quit.
 *
 * Ports are shared across every host and cost 0 GB to read or write, which makes
 * them the only channel a worker on a purchased server can actually hear. The
 * file stays the PERSISTENT setting - it survives a restart and is read by the
 * manager and sharemode.js, both of which run on home - and the port is how that
 * setting reaches the fleet. Both writers publish it, so turning share off takes
 * effect within 10s instead of waiting for the manager's next rescan.
 *
 * Deliberately not a report port: those are drained with read(), which REMOVES
 * the message. A setting has to be peeked, and peek leaves it in place.
 */
export const SHARE_PORT = 2;

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
/**
 * sing/sing.js writes "hold" here whenever the player is not doing FACTION work,
 * and "" when they are. A hold turns share off without touching SHARE_MARKER,
 * so the fraction the user chose with sharemode.js survives and comes back the
 * moment faction work resumes.
 *
 * Faction work ONLY, and that is the game's rule, not a preference: the share
 * bonus appears in the three faction formulas in
 * src/PersonObjects/formulas/reputation.ts and nowhere else - company work
 * (calculateCompanyWorkStats) never reads it. Share during company work, crime
 * or the gym is RAM taken from the batcher for nothing.
 *
 * A missing or empty file is NOT a hold: without sing (--no-sing, or outside
 * BN4 without SF4) share follows the marker exactly as before.
 */
export const SHARE_HOLD_MARKER = "/data/share-hold.txt";

/**
 * The share fraction actually in force: SHARE_MARKER's, unless sing holds it.
 * The manager and sharemode.js both read share through this, so they cannot
 * disagree about a hold. Pure, like everything in this file.
 */
export function effectiveShareFraction(markerText, holdText) {
  return shareHeld(holdText) ? 0 : shareFractionFrom(markerText);
}

/** Is SHARE_HOLD_MARKER's content a hold? The one parser, for the logs that say why share is off. */
export function shareHeld(holdText) {
  return String(holdText ?? "").trim() === "hold";
}

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
 * is pure extra headroom for scripts you launch by hand - without it the
 * batcher takes every free byte on home and nothing else will start.
 *
 * WATCH THE SIZE OF HOME. This is subtracted from home's maxRam, so a reserve
 * at or above home's capacity removes home from the pool entirely rather than
 * merely trimming it. The manager prints a warning when that happens.
 */
export const HOME_RESERVE_GB = 32;

// ----------------------------------------------------------------- ports ----
/**
 * Port 1 was the shotgun batcher's report port. Left unused rather than handed
 * to something new: filesync never deletes from the game, so a stale shotgun
 * can still be running there and writing to it. The continuous batcher reports
 * on its own port, 3 (continuous/config.js).
 */

/**
 * The game's port queue length (Settings.MaxPortCapacity, default 50).
 *
 * This is a HARD constraint, not a tunable: when a write would exceed it the
 * port silently discards its OLDEST entry. A batch produces one report per
 * exec'd process - typically 10-20 once grow splits across hosts - so the port
 * holds only three or four batches' worth. The manager therefore drains
 * continuously rather than collecting at the end.
 *
 * You can raise it in-game: Options -> Netscript -> "Max port capacity". Doing
 * so gives the manager more slack, but draining is what actually keeps reports;
 * update this constant if you change the setting.
 */
export const PORT_CAPACITY = 50;

// --------------------------------------------------------------- workers ----

/**
 * Worker script paths, keyed by op KIND (not by batch slot).
 *
 * scripts/continuous/config.js re-exports these. The retired shotgun exec'd the
 * same files, each system passing its own report port as an argument, so boot's
 * orphan kill still covers a stale shotgun's batches with this one list.
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

/** The three batch workers - the ones that report on the port in their argv. */
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
 * before. share.js briefly imported config.js for one constant, ran on home -
 * the one host that happens to have config.js - and returned 0 on all 68 others.
 * It now takes the port number as an argument and imports nothing, which is why
 * this list is empty again.
 *
 * It stays as a mechanism rather than being deleted: adding a worker that
 * imports anything means adding that import here, and the test suite enforces
 * it - DEPLOY_LIST must be closed under imports.
 */
export const WORKER_DEPS = [];

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

/**
 * The hosts the RUNNING batcher is currently working, one per line, richest
 * first. Written by the manager - continuous/core.js at every rescan - and read
 * by scripts/hacknet/hashes.js.
 *
 * It lives here rather than in the batcher's config because it is a contract
 * between parties that do not import each other, which is what this file is
 * for. boot.js CLEARS it whenever a manager swap leaves no manager running: a
 * stale list has hashes bought for a server nobody is hitting, and hash
 * upgrades do not refund.
 *
 * Missing or empty means "spend nothing", never a default - the share.txt rule.
 * A wrong target is silent and compounding, so the failure has to be the inert
 * one.
 */
export const TARGETS_MARKER = "/data/targets.txt";

/**
 * Hostname prefix of a BitNode 9 hacknet server, which both RAM pools skip.
 *
 * calculateHashGainRate (src/Hacknet/formulas/HacknetServers.ts) carries
 * `ramRatio = 1 - ramUsed / maxRam` as a plain factor, and
 * HacknetServer.updateRamUsed recomputes the rate on every change - so a
 * hacknet server filled with batch workers produces LITERALLY ZERO hashes.
 * They are created with adminRights and pushed onto home's network
 * (Player.createHacknetServer), so root.js, deploy.js and both pools reach them
 * without being told to.
 *
 * Testing the prefix is safe by construction rather than a heuristic: Server's
 * own constructor renames any ordinary server starting with "hacknet-node-" or
 * "hacknet-server-", so the namespace is reserved. The alternative test,
 * ns.getServer(host).isHacknetServer, costs 2.00 GB and the pool is 0.35.
 */
export const HACKNET_HOST_PREFIX = "hacknet-server-";

// ---------------------------------------------------------------- report ----

/**
 * Shape of a worker's completion report, written to the port in argv[3]:
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
