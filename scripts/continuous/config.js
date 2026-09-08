/**
 * Configuration for the continuous (streaming) HWGW batcher.
 *
 * Plain constants only - no ns calls, no imports. Bitburner charges an importer
 * for every ns function reachable through a module, so this file costs 0 GB to
 * import. Adding one billed call here would tax every file in the folder.
 *
 * Deliberately a SEPARATE file from scripts/config.js, not an import of it.
 * This system is self-contained by requirement, and the two must be free to
 * disagree: the shotgun's numbers were tuned for one volley sized against one
 * snapshot, while a stream re-derives every batch at dispatch. Several values
 * here will want to diverge once Phase 4 measures a live stream.
 *
 * Import style throughout this folder is absolute-from-root and extensionless:
 *
 *     import { ServerPool } from "scripts/continuous/lib/server";
 *
 * Verified against the fork's resolver, not assumed: resolveScriptFilePath in
 * src/Paths/ScriptFilePath.ts does `if (extensionToAdd && !path.endsWith(ext))
 * path = path + ext`, and resolveFilePath treats a path with no leading "./"
 * as absolute from the server root. The existing scripts/ tree uses the
 * relative "./config.js" form; both resolve, and mixing them inside one folder
 * would only make the deploy list harder to reason about.
 */

// -------------------------------------------------------------- batching ----

/**
 * Hard ceiling on the steal fraction. A backstop, not the operating point -
 * the adaptive controller below decides where a target actually runs.
 *
 * The shotgun's ceiling exists because thread counts are sized ONCE per volley
 * and then hundreds of batches land across a whole weaken window while hacking
 * level climbs; a batch landing late steals more than planned, its grow was
 * sized for the smaller take, and it ends below where it started. A measured
 * volley at 98.28% drained a $17.68b target to $166.11k in one window.
 *
 * A stream's exposure is strictly smaller, and by a knowable amount. Every
 * batch is sized at ITS OWN dispatch and lands one weaken window later, so its
 * staleness is exactly W. A volley's batches are all sized at t0 and land from
 * t0+W to t0+W+N*spacing, so the last one is stale by W plus the whole spread -
 * on a 400-batch volley at 400ms spacing that is W + 160s against W. Roughly
 * three times the exposure for the same nominal fraction.
 *
 * The tolerance formula is unchanged:
 *
 *     tolerance = ((GROW_MARGIN - 1) / GROW_MARGIN) * (1 - steal) / steal
 *
 * and past ~0.95 the trade goes bad on efficiency alone, before safety is even
 * considered. Income is linear in steal; grow threads scale with
 * ln(1/(1-steal)):
 *
 *     steal   tolerance   income   grow RAM    income/RAM
 *     0.85       0.84%     0.85      1.90        0.448
 *     0.90       0.53%     0.90      2.30        0.391
 *     0.95       0.25%     0.95      3.00        0.317
 *     0.99       0.05%     0.99      4.61        0.215
 *
 * 0.85 -> 0.95 is +11.8% income for +58% RAM. 0.95 -> 0.99 is +4% income for
 * another +54% RAM at a fifth of the drift tolerance. The knee is at 0.95, so
 * that is the ceiling regardless of how clean the measurements look.
 *
 * Raised from the shotgun's 0.85 once the stream could MEASURE its own drift
 * rather than assume it - see nextSteal in lib/plan.js. A ceiling nothing ever
 * reaches unless the evidence supports it is a much cheaper bet than one picked
 * to be safe in the dark.
 */
export const MAX_STEAL_FRACTION = 0.95;

/**
 * Fraction of a target's MAX money one batch's hack takes - the STARTING value
 * for the adaptive controller, not a fixed setting.
 *
 * Starts AT the ceiling and descends. The controller only ever needs to find
 * the point where a target stops behaving, and starting at the top finds it in
 * one weaken window rather than climbing to it in six.
 *
 * The trade is explicit and worth stating: the first window's batches are
 * dispatched before any evidence exists about this target. If the ceiling is
 * too high for it, roughly one depth's worth of batches under-restore before
 * the first report lands, the drain detector fires, and the target is stopped
 * and re-prepped. That costs a prep cycle, once, against saving five weaken
 * windows of climbing on every target that is fine - and on the evidence so far
 * most are. A conservative start pays its cost every single time.
 *
 * Two things make it recoverable rather than merely fast: the drain shows up in
 * the reports as a negative `over` (see nextSteal), and prep is non-blocking, so
 * one target backing off does not stall the others.
 *
 * A measured 10-minute run at 10%: 1255 batches, 1255 ok, 0 bad, 94% hit rate,
 * $114m/s - and 42 TB of an 11,284 TB pool. Income is linear in steal, so
 * sitting at 10% was leaving roughly 9x on the table.
 */
// Declared AFTER MAX_STEAL_FRACTION on purpose: `const` is not hoisted, so
// reading it above its declaration is a temporal-dead-zone error at import
// time - which takes down every file in the folder at once.
export const STEAL_FRACTION = MAX_STEAL_FRACTION;

/**
 * How the adaptive steal controller moves, and how fast.
 *
 * The feedback delay is one WEAKEN WINDOW: a change to the steal fraction only
 * shows up in the reports of batches dispatched after it, which land a full W
 * later. So the controller holds after every change until those batches have
 * landed. Without that hold it would ramp through every step before the first
 * piece of evidence arrived, which is not control, it is a countdown.
 *
 * Up is slower than down is fast, on purpose: the cost of being one step too
 * low is a few percent of income, and the cost of being one step too high is a
 * drained target and a re-prep.
 */
export const STEAL_STEP_UP = 1.5;
export const STEAL_STEP_DOWN = 0.6;

/**
 * Batches that must land inside one hold window before a step up is considered.
 *
 * Enough for a hack miss or two not to dominate the sample - at a 94% hit rate,
 * 8 batches average half a miss.
 */
export const STEAL_MIN_SAMPLES = 8;

/**
 * Fraction of the drift tolerance that counts as "comfortably clean".
 *
 * A step up is only taken when the worst measured overshoot is inside this much
 * of the tolerance for the CURRENT fraction. Stepping up while already near the
 * limit would be raising the stake precisely when the margin is thinnest, and
 * the tolerance shrinks as the fraction rises - so the next step would start
 * over the line.
 */
export const STEAL_HEADROOM = 0.25;

/**
 * How many overlapping batches the instantaneous money floor allows for.
 *
 * MULTIPLICATIVE, not subtractive, and that is a bug fix rather than a
 * refinement. The floor used to be `maxMoney * (1 - steal * slack)`, which goes
 * NEGATIVE above 1/slack - so at any steal over ~33% the money check silently
 * passed everything, and it was dead exactly where the stakes are highest.
 *
 * Two hacks landing before either grow leaves `(1 - steal)^2` of the money, so
 * that is the real bound: tight at low steal (0.81 at 10%), permissive at high
 * steal (0.0025 at 95%), and never negative. Permissive is correct there - at
 * 95% the legitimate dip really is almost the whole balance.
 *
 * This only has to cover the first weaken window, before any report has landed.
 * After that the drain detector below is both precise and correctly timed.
 */
export const MONEY_FLOOR_BATCHES = 2;

/**
 * How far below its plan a batch's take may fall before the target counts as
 * draining.
 *
 * `over = stolen / take - 1` and, because money clamps at maxMoney, this is
 * almost exactly `moneyAtLanding / maxMoney - 1`. So -0.25 means the server held
 * less than three quarters of its maximum at the moment the hack landed, which
 * on a healthy stream should never happen: the previous batch's grow lands two
 * spacers after its hack, a full cadence before the next one.
 *
 * Measured where it is actually observable - when the hack lands - rather than
 * sampled at dispatch. Dispatches and landings sit on the same cadence grid, so
 * a snapshot taken at dispatch has a FIXED phase relative to the landings and
 * can systematically miss the recovery it is looking for.
 */
export const DRAIN_UNDER = 0.25;

/**
 * Fraction of dispatch attempts that may fail for want of RAM before the steal
 * fraction is stepped down.
 *
 * The other half of "drops based on RAM availability". A dispatch that cannot
 * place its batch loses a cadence slot it never gets back, and at high steal a
 * batch is over ten times its size at 10% - so on a contended pool the fix is
 * a smaller batch, not a queue.
 *
 * Stepping the fraction down rather than dropping the target keeps the income
 * and lets every stream shrink to fit. Targets only get dropped by admission,
 * which works on a different timescale.
 */
export const NO_ROOM_TOLERANCE = 0.25;

/** Never let the controller drive steal below this. */
export const MIN_STEAL_FRACTION = 0.005;

/**
 * Gap between the four landings INSIDE one batch, ms.
 *
 * Must exceed the game's scheduling JITTER - the spread of drift within a
 * batch, not its absolute lateness. Whole batches land tens of ms late
 * together, and a common offset cannot reorder anything.
 *
 * 100ms carried over from the shotgun, where it was measured: a single batch
 * jittered 6-7ms but a 2-batch volley jittered 48ms, because jitter scales with
 * how many workers land at once. A stream lands FEWER workers per instant than
 * a volley does by construction, so this should prove generous here. Do not
 * shrink it before Phase 4 reports real jitter.
 */
export const SPACER_MS = 100;

/**
 * Gap between the anchors of consecutive batches, ms. The stream's heartbeat.
 *
 * This is the constant that makes the batcher a stream rather than a shotgun:
 * batch n is anchored at t0 + n * CADENCE_MS, so landings interleave into a
 * continuous sequence instead of arriving as one burst per window.
 *
 * Hard floor is 4 * SPACER_MS. A batch spans three spacers from its H to its
 * W2, so anything tighter lets the next batch's hack land inside the previous
 * batch's tail - which in the shotgun (spacer 20 / spacing 80, against 48ms of
 * measured jitter) had a weaken cancel the wrong batch's op.
 *
 * Cadence sets in-flight depth, since depth is roughly weakenTime / cadence.
 * Tightening it buys more concurrent batches and more income, and spends
 * safety margin against jitter. Start at the floor and widen if Phase 4
 * reports jitter approaching SPACER_MS.
 */
export const CADENCE_MS = 4 * SPACER_MS;

/**
 * Grow safety margin, as a fraction of MONEY - not of threads.
 *
 * Batches size grow to climb back from `afterHack / GROW_MARGIN` rather than
 * from `afterHack`, so 1.05 means "size grow as though the hack took 5% more
 * than it did", giving the same headroom at every steal fraction.
 *
 * It must NOT be applied to the thread count. Threads relate to the growth
 * multiplier exponentially, so `threads * 1.05` yields `mult^1.05`: 9% of
 * headroom at a x5.64 restore but 0.5% at x1.11. Overshooting is nearly free -
 * the game clamps money at moneyMax, so surplus grow threads do nothing.
 */
export const GROW_MARGIN = 1.05;

/**
 * Ops of a batch, in LANDING order.
 *
 * Also the planning order, with one exception documented where it happens:
 * weaken-2 is sized from grow's PLACED raw thread count, so grow must be
 * placed before W2 can be sized.
 */
export const BATCH_OPS = ["H", "W1", "G", "W2"];

/** Which worker file each op runs. */
export const OP_WORKER = { H: "hack", W1: "weaken", G: "grow", W2: "weaken" };

// ----------------------------------------------------------------- cores ----

/**
 * Ops that get the multi-core bonus. Hack does not.
 *
 * From the fork's src/Server/ServerHelpers.ts, one shared helper serves both:
 *
 *     getCoreBonus(cores) = 1 + (cores - 1) / 16
 *     getWeakenEffect(threads, cores)
 *       = ServerWeakenAmount * threads * coreBonus * rate
 *
 * and src/Server/formulas/grow.ts puts the same factor inside the growth log:
 *
 *     calculateServerGrowthLog(...)
 *       = adjGrowthLog * pct * mults.hacking_grow * coreBonus * threads
 *
 * Both are therefore exactly LINEAR in `threads * coreBonus`, which is what
 * lets an op be sized once in effective threads and then split across hosts
 * with different core counts. Hack appears in neither, so a hack thread is
 * worth the same everywhere.
 *
 * The bonus itself is never hardcoded - it is measured from weakenAnalyze /
 * weakenEffect at runtime. This list only records WHICH ops it applies to.
 */
export const CORE_BOOSTED_OPS = ["W1", "G", "W2"];

/**
 * Fill order per op, passed to ServerPool.allocate as `order`.
 *
 * Grow and weaken take the best-cored hosts first, because a thread there does
 * more work for the same RAM. Hack takes the worst-cored hosts first, because
 * it gains nothing from cores and every core-bearing GB it squats on is RAM
 * that would have multiplied under a grow.
 *
 * This works only because hack is planned FIRST: by the time grow asks for the
 * high-core hosts, hack has already taken what it needs from the low-core end,
 * so the two orders never fight over the same machines.
 */
export const OP_FILL_ORDER = { H: "coresAsc", W1: "coresDesc", G: "coresDesc", W2: "coresDesc" };

// ------------------------------------------------------------------- ram ----

/**
 * GB withheld on home for the manager itself and whatever you run by hand.
 *
 * The manager, its imports and a terminal script or two live here. Too low and
 * the stream starves the process steering it; too high and the pool's largest
 * and best-cored host is mostly wasted.
 */
export const HOME_RESERVE_GB = 32;

/**
 * Fraction of each host's RAM the pool is willing to plan against.
 *
 * 1.00 - trust our own accounting - is the honest default: the pool tracks the
 * game's own getServerUsedRam plus its own pending ledger, so there is no
 * modelled slack that needs padding.
 *
 * It exists as a knob because the failure it guards against is real but not yet
 * observed here: something outside this manager (a hand-run script, the old
 * shotgun's leftovers) taking RAM between the instant we reserve and the
 * instant we exec. Lower it to ~0.98 if live runs start logging exec-returned-0
 * on hosts the pool believed were free. Do not lower it speculatively - every
 * point costs income on every host, forever.
 */
export const RAM_SAFETY_FRACTION = 1.00;

// ----------------------------------------------------------------- ports ----

/**
 * Port workers report landings on.
 *
 * Deliberately NOT the shotgun's port 1. The two systems are alternatives, and
 * killing one leaves its reports in flight for up to a whole weaken window; on
 * a shared port those land in this drain loop and get credited to batch ids
 * that never existed here. Port 2 is the shotgun's share gate.
 */
export const CONT_REPORT_PORT = 3;

/**
 * Netscript port capacity, entries.
 *
 * Not exposed by the API - the .d.ts documents no number - so it is recorded
 * here for the drain loop's own sizing and checked against the game by watching
 * port.full(). A full port DISCARDS THE OLDEST entry, so an overflowing report
 * port silently loses the earliest landings of a batch, which is exactly the
 * data an order check needs.
 */
export const PORT_CAPACITY = 50;

// --------------------------------------------------------------- workers ----

/**
 * Worker paths, absolute in-game.
 *
 * On disk these are scripts/continuous/*.js, and filesync's `scriptsFolder: "."`
 * preserves that path verbatim, so the in-game path keeps the scripts/ prefix.
 */
export const WORKER_FILES = {
  hack: "/scripts/continuous/hack.js",
  grow: "/scripts/continuous/grow.js",
  weaken: "/scripts/continuous/weaken.js",
};

/**
 * Every file this system must scp to a host before it can exec there.
 *
 * scripts/deploy.js broadcasts only DEPLOY_LIST from scripts/config.js, which
 * this system may not edit, so it copies its own workers. Without that, exec
 * returns a bare 0 on every host but home - the same value it returns when the
 * script is absent, which is why that failure took two live runs to diagnose in
 * the shotgun.
 *
 * The workers import nothing, so this list needs no dependency closure. Keep it
 * that way: a worker pays its RAM cost PER THREAD, and an import that reaches
 * one ns call would multiply across tens of thousands of threads.
 */
export const WORKER_LIST = Object.values(WORKER_FILES);

/**
 * Per-thread RAM to assume when a worker file does not exist yet.
 *
 * Phase 1 runs before the workers are written, so getScriptRam returns 0 and
 * the harness would report infinite capacity without these. Values are the
 * shotgun's measured ones for identical single-op workers; Phase 2 replaces
 * them with the real reading, and the harness says which it used.
 */
export const WORKER_RAM_FALLBACK = { hack: 1.70, grow: 1.75, weaken: 1.75 };

// ---------------------------------------------------------------- stream ----

/**
 * Hard ceiling on concurrent in-flight batches per target.
 *
 * The natural depth is weakenTime / cadence, and on a late-game target that is
 * enormous - a 6.4 minute weaken at a 400ms cadence wants 959 batches in the
 * air at once. That is not automatically wrong, but it is a lot of state, a lot
 * of reservations, and a lot of reports to keep straight, and the marginal
 * batch at that depth is worth the same as the first.
 *
 * This caps the count without changing the cadence: the stream simply stops
 * adding depth once it is this deep, and the RAM it does not take is available
 * to the next target.
 */
export const MAX_IN_FLIGHT = 400;

/**
 * Minimum head start between deciding a batch's landing time and its hack
 * having to leave, ms.
 *
 * A batch is dispatched as four execs spanning real wall time, and hack is the
 * op with the least slack - it lands one spacer BEFORE the anchor and its own
 * runtime is the shortest, so its additionalMsec is the first to go negative.
 * This is the cushion that keeps it positive.
 *
 * Too small and batches get skipped for arriving late to their own dispatch;
 * too large and the stream runs further ahead of itself than it needs to. Two
 * spacers is a starting point.
 */
export const MIN_LEAD_MS = 2 * SPACER_MS;

/**
 * How long the dispatch loop sleeps between ticks, ms.
 *
 * Must be well under CADENCE_MS or the stream cannot hit its cadence: the loop
 * can only dispatch on a tick, so tick granularity is jitter added to every
 * anchor. A quarter of the cadence keeps that under 25ms against a 100ms
 * spacer.
 */
export const STREAM_TICK_MS = 25;

/**
 * Extra time past a batch's last landing before it is given up for lost, ms.
 *
 * Reports can be late - the game lands whole batches tens of ms late together -
 * and a batch retired too early is recorded as incomplete when it was merely
 * slow, which would trip the desync detector on a healthy stream.
 */
export const BATCH_GRACE_MS = 3000;

/**
 * How many batches' worth of in-flight transient the baseline check tolerates.
 *
 * A streaming target is NEVER at rest. Money dips by one batch's steal between
 * a hack landing and its grow two spacers later, and security sits above
 * minimum between a hack and the weaken one spacer behind it. Demanding
 * moneyOk / secOk at dispatch - the prep-time definition of prepped - is a test
 * a healthy stream can never pass, and the first live run duly reported
 * "unprepped" against a target holding steady at max money.
 *
 * So the gate is a BASELINE check instead: the target may sit this many
 * batches' worth of steal below max money, and this many batches' worth of
 * uncancelled security above minimum, before it counts as drifted.
 *
 * With cadence at 4 spacers, the hack-to-grow window is half a cadence, so at
 * most one batch is normally mid-restore. Three leaves room for a late landing
 * without excusing a real drift, which compounds and would blow past this
 * within a few cadences.
 */
export const BASELINE_SLACK_BATCHES = 3;

/**
 * Consecutive bad batches before a target's stream is stopped and re-prepped.
 *
 * One bad batch is noise: a report can be dropped by a full port, and a single
 * out-of-order landing costs one batch's grow. A run of them means the stream
 * has genuinely desynced, and continuing to fire into it turns a recoverable
 * drift into a drained server.
 */
export const DESYNC_STRIKES = 3;

// --------------------------------------------------------------- targets ----

/**
 * How many targets stream at once. A hard limit, not a budget-driven guess.
 *
 * Kept small on purpose. More streams is not more income past the point where
 * the pool stops being the constraint: depth is capped by weakenTime / cadence
 * and steal by MAX_STEAL_FRACTION, so three targets at the ceiling already earn
 * everything three servers can be made to yield. What extra streams buy is
 * churn - more preps to keep finished, more sets to re-evaluate, and a longer
 * list for the admission ordering to shuffle between rescans.
 *
 * The RAM left over is genuinely idle, and that is the honest state of things:
 * a fully-fed target at 95% steal and full depth cannot absorb another byte.
 * Spending it needs a smaller cadence (SPACER_MS) or more targets, and those
 * are separate decisions with their own evidence.
 */
export const MAX_TARGETS = 3;

/**
 * Fraction of the pool's free RAM to commit across all streams at full depth.
 *
 * Targets are admitted down the priced ranking until their combined estimated
 * commitment - depth x batch RAM - reaches this. The headroom that is left over
 * is not waste: batch RAM is an ESTIMATE priced at one core, prep waves need
 * room, and a stream whose dispatch fails for want of RAM skips a cadence slot
 * it never gets back.
 *
 * Note the estimate errs high - the live run placed 0.21 TB against a 0.25 TB
 * estimate, because core-aware placement uses fewer raw threads - so the real
 * commitment lands under this figure rather than over it.
 */
export const TARGET_RAM_BUDGET = 0.85;

/**
 * Prep a candidate ahead of everything else when it would DISPLACE a target
 * that is currently streaming.
 *
 * Without this, prep works down the same ranking as everything else, so the one
 * unprepped server that is worth more than a stream already running waits its
 * turn behind targets that will never be admitted. With only three slots that
 * is the difference between finding the best three servers and keeping whichever
 * three happened to be ready first.
 *
 * The streams already running are NOT held back or shrunk to make room. They
 * keep their RAM and keep earning until the newcomer is actually prepped and
 * admission swaps it in - a target that is not ready yet is worth nothing, and
 * trading real income for a maybe is the wrong bet.
 */
export const PROMOTE_PREP_FIRST = true;

/**
 * Extra wall time past a repair wave's landing before its RAM is handed back
 * and the target re-checked, ms.
 *
 * A re-prep runs INSIDE the stream loop, not by blocking it. Blocking would
 * freeze every other stream for a whole weaken window - minutes - to fix one
 * target, which is a far worse outcome than the drift being repaired.
 */
export const REPREP_GRACE_MS = 2000;

/**
 * How often to re-evaluate which targets should be streaming, ms.
 *
 * The target set is NOT fixed at startup, and treating it as fixed threw away
 * most of what the batcher is for. Things that change under a running stream:
 *
 *   - hacking level rises, so hackChance climbs on the hard targets. computek
 *     at 23% chance is a poor target; the same server at 80% is a very good one.
 *   - servers get rooted, by root.js or by hand.
 *   - cloud servers get bought, so the pool grows and the budget with it.
 *   - a target finishes prepping and becomes streamable.
 *   - weaken times fall with level, so depth requirements fall and more
 *     targets fit the same budget.
 *
 * A minute is far shorter than any of those move, and a rescan costs one
 * ranking pass over the candidate list - no placement, no exec.
 */
export const RESCAN_MS = 60000;

/**
 * How many unprepped targets to prep at once, alongside the running streams.
 *
 * Prep waves are sized by need and so are individually small, but each one
 * competes with the streams for pool RAM. This bounds that competition without
 * a separate RAM budget: the streams commit TARGET_RAM_BUDGET, and prep works
 * in the headroom left over.
 *
 * Prep runs CONCURRENTLY with streaming, never before it. Blocking the whole
 * run until every target was prepped meant the already-prepped ones - the good
 * ones, which is why they were picked - sat idle earning nothing while a deep,
 * dirty target was brought up. That is backwards.
 */
export const PREP_CONCURRENCY = 4;

/** Money must be within this fraction of max for a target to count as prepped. */
export const MONEY_TOLERANCE = 0.999;

/**
 * Security may sit this far above minimum and still count as prepped.
 *
 * Not zero: security is a float and a weaken lands on the exact minimum only by
 * luck. Demanding equality would leave prep spinning forever on a target that
 * is, for every practical purpose, prepped.
 */
export const SEC_TOLERANCE = 0.01;

/**
 * Give up on prepping a target after this many waves.
 *
 * A wave is sized by NEED, so a healthy prep converges in a handful of them.
 * Hitting this ceiling means something is wrong - the target is being drained
 * by another process, or grow is too weak to outrun the security it adds - and
 * grinding on forever would hold pool RAM that other targets could use.
 */
export const PREP_MAX_CYCLES = 50;

/**
 * How long to wait, and how many times, when the pool has no room for a prep
 * wave.
 *
 * A full pool is TRANSIENT, not a failure. The stream releases RAM continuously
 * as batches land, so waiting is almost always the right answer. Returning an
 * error instead would stop the manager and have it restarted into the same wall
 * a tick later - a restart loop that looks like a crash.
 *
 * 10s x 90 = 15 minutes, which is far longer than any single weaken window.
 */
export const POOL_WAIT_MS = 10000;
export const POOL_WAIT_CYCLES = 90;

// -------------------------------------------------------------- formulas ----

/**
 * Unlocks ns.formulas.hacking.*, which the precise math backend needs.
 *
 * Checked once, at backend prepare(). There is deliberately no periodic
 * re-check here: gaining or losing the program means swapping between
 * manager.js and manager-formulas.js, and swapping entry points is the
 * supervisor's job, not a running manager's. boot.js owns that in production.
 */
export const FORMULAS_PROGRAM = "Formulas.exe";

// --------------------------------------------------------------- harness ----

/**
 * Nominal HWGW thread split, for Phase 1 capacity reporting only.
 *
 * Batch shape is a property of the TARGET and cannot be known before the math
 * backends land in Phase 3. This is a stand-in so placement can be exercised
 * against a realistically lopsided batch - grow dominates - because a profile
 * of four equal ops would hide exactly the fragmentation the harness exists to
 * find. Override with --threads h,w1,g,w2.
 */
export const NOMINAL_BATCH = { H: 25, W1: 2, G: 60, W2: 5 };
