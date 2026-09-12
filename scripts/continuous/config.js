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
 * The tolerance formula is no longer read in that direction. It used to be
 *
 *     tolerance = ((GROW_MARGIN - 1) / GROW_MARGIN) * (1 - steal) / steal
 *
 * with the margin fixed, which made the headroom collapse to 0.25% here. It is
 * now inverted - the headroom is fixed at GROW_DRIFT_TOLERANCE and the margin
 * is solved for - so this ceiling bounds RAM and income, not survival.
 *
 * Past ~0.95 the trade still goes bad on efficiency alone, before safety is
 * even considered. Income is linear in steal; grow threads scale with
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
 * Seed fraction, used only before the first rescan has calculated one.
 *
 * The steal fraction is CALCULATED per target now, not configured - chooseSteal
 * in lib/plan.js derives the largest fraction whose RAM fits that target's
 * budget, capped by MAX_STEAL_FRACTION. Income is linear in steal with no
 * interior optimum, so "largest that fits" IS the optimum; there is no yield
 * curve to search the way the shotgun has to.
 *
 * This value therefore matters for about one tick. It sits at the ceiling
 * because the first rescan runs immediately and will replace it, and starting
 * high means a target that can afford the ceiling never has to climb to it.
 *
 * `--steal F` pins the fraction and disables the calculator. That is for
 * controlled measurement only: a self-sizing, self-adjusting fraction is
 * exactly what confounds a sweep.
 */
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
 * of the tolerance. Stepping up from the edge would be raising the stake
 * precisely when the margin is thinnest.
 *
 * 0.25 came from the era of a FLAT grow margin, where the tolerance was a
 * property of the fraction alone and had nothing to do with what the target had
 * been measured to do. It is incoherent now, and provably so. The budget is
 * DRIFT_SAFETY times the measured drift and the margin is derived from the
 * budget, so in steady state
 *
 *     worstOver / tolerance  ~=  1 / DRIFT_SAFETY  =  0.667
 *
 * whatever the fraction, whatever the target, however well it is behaving. A
 * threshold of 0.25 is therefore one no healthy stream can ever meet: it does
 * not mean "climb when comfortable", it means "never climb". A live run pinned
 * phantasy at 30.4% under an 87% ceiling and iron-gym at 28.0% under 66% for a
 * whole run at $700m/s, with `bad 0` and `hit 98%` throughout.
 *
 * 0.8 restores the intent against the number that is actually being compared.
 * The steady-state 0.667 passes, so a stream whose drift is flat or falling
 * climbs; a window where drift has grown to within 20% of the budget holds; one
 * that exceeds the budget backs off, as before. The real protection against a
 * step up was never this ratio - it is DRIFT_SAFETY, which sizes every batch to
 * survive half again the worst drift yet seen.
 */
export const STEAL_HEADROOM = 0.8;

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
 * Started at 100ms, carried over from the shotgun where it was measured: a
 * single batch jittered 6-7ms but a 2-batch volley jittered 48ms, because
 * jitter scales with how many workers land at once. A stream lands FEWER
 * workers per instant than a volley does by construction, and a live run
 * confirmed it - 10-11ms of jitter against the 100ms spacer, `bad 0`.
 *
 * 80ms spends that measured headroom on cadence: CADENCE_MS is 4 * SPACER_MS,
 * so the stream's heartbeat drops 400ms -> 320ms and in-flight depth (and with
 * it income per target) rises by 25% for the same steal fraction. 80 still
 * leaves ~7x the measured jitter, and LATE_TOLERANCE_MS follows it down to 40ms
 * automatically, so a late op is still caught before it can reorder anything.
 *
 * If jitter ever climbs toward the spacer - more targets, more workers landing
 * per instant - widen this again rather than widening CADENCE_MS alone: the
 * spacer is what protects op ORDER inside a batch.
 */
export const SPACER_MS = 100;

/**
 * How many thread counts the steal calculator probes per target.
 *
 * A SWEEP rather than a binary search, and the reason is that the objective
 * stopped being monotonic the moment the cadence became a variable. At a fixed
 * cadence income is maxMoney * steal / cadence - linear, so the best fraction is
 * simply the largest that fits and a binary search over "does it fit" is valid.
 * Once a target too big for its budget widens its cadence instead of shrinking
 * its bite, income is
 *
 *     budget * maxMoney * steal / batchRamSeconds(steal)
 *
 * and batchRamSeconds carries a fixed floor (one hack thread, the weakens that
 * cancel it) on top of a grow count that grows like ln(1/(1-steal)). So income
 * rises off the floor, peaks, and falls away again - a binary search on a
 * predicate cannot find that, and would return a wrong answer in silence.
 *
 * Log-spaced, because the interesting range of thread counts spans orders of
 * magnitude and the peak is flat near the top. 20 probes over a 300-thread
 * ceiling step by ~1.35x, which is finer than the curvature.
 */
export const STEAL_PROBES = 20;

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
 *
 * A FLOOR, not a fixed value. chooseSteal widens it per target when the target's
 * pipeline does not fit its RAM budget at this rate - see STEAL_PROBES. Nothing
 * ever runs faster than this.
 */
export const CADENCE_MS = 3 * SPACER_MS;

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
 * How much a hack may overshoot its plan and still be fully repaired by its own
 * grow. The margin is DERIVED from this - see growMarginFor in lib/plan.js.
 *
 * This inverts the relationship a flat GROW_MARGIN gives you, and the inversion
 * is the whole point. A constant margin means a constant COST and a tolerance
 * that collapses as the fraction rises: 42% of headroom at 10% steal, 0.27% at
 * 94.7%. So the setting was generous exactly where nothing could go wrong and
 * absent exactly where everything could.
 *
 * Measured, not assumed. A live run took the-hub from $4723.8m to $9.4m in 18
 * landed batches - net x0.708 each - at a planned 94.7% with margin 1.05. Solve
 * `(1 - actual) * 1.05 / (1 - 0.947) = 0.708` and the actual take was 96.4%: an
 * overshoot of 1.8% against 0.27% of headroom. Nothing exotic happened. The
 * hack got 1.8% better between dispatch and landing, which over one weaken
 * window is ordinary, and the target was gone in three minutes.
 *
 * Fixing the tolerance instead makes the cost scale with the risk. Grow threads
 * go as ln(multiplier), so the headroom is cheap: at 94.9% steal, 2% costs ~13%
 * more grow threads and 4% costs ~19%.
 *
 * 6% because it is the PRE-EVIDENCE default now, not a floor - a stream that
 * has landed hacks budgets from its own measurements instead (see
 * DRIFT_SAFETY), so this only has to cover the first weaken window, which is
 * precisely the window that cannot be measured. nova-med committed 1200
 * batches at 94.3% before its first report and drained on a 4.50% drift; at 6%
 * the ceiling would have held it to 91.7%, which costs 2.8% of income and is
 * the difference between $11039.16b and nothing.
 *
 * 4% rather than 2% because 2% was measured to be too tight. A later run on the
 * same fleet stepped all three targets down within seconds of each other -
 * "overshoot 2.16% past the 2.00% tolerance", 2.13%, 2.13% - so the real drift
 * over one weaken window on this fleet is a little over 2%, and a budget set at
 * exactly the observed value has no margin at all. At 94.9% steal a 2.16%
 * overshoot against a 2.00% budget nets x0.933 per batch, and with 1061 batches
 * in flight the targets were at $0.1m of $17482.0m before the controller's
 * correction could reach a single landing.
 *
 * The drift is hacking level moving between a batch's dispatch and its landing,
 * so it scales with the weaken window rather than being a constant of the
 * fleet. A target with a 20-minute window will drift further than one with a
 * 7-minute window, and a per-target budget derived from `times.weaken` would be
 * the honest version of this number. Not built: one constant with real headroom
 * is enough until a run says otherwise.
 */
export const GROW_DRIFT_TOLERANCE = 0.06;

/**
 * Ceiling on the derived margin. As steal approaches 1 the algebra asks for a
 * margin no number of grow threads can deliver, and an unbounded value would
 * size a batch nothing can place.
 *
 * It is not only a guard. Together with GROW_DRIFT_TOLERANCE it DEFINES the
 * highest steal fraction that can still be protected - see maxStealForDrift in
 * lib/plan.js - so raising it buys a higher usable ceiling and costs grow
 * threads, and lowering it does the reverse. At 3.0 and a 4% budget the
 * fraction tops out at 94.3%, which is what MAX_STEAL_FRACTION used to assert
 * on its own with nothing behind it.
 */
export const GROW_MARGIN_CAP = 3.0;

/**
 * Money floor, as a share of one batch's post-hack level.
 *
 * MONEY_FLOOR_BATCHES alone is not enough at the top of the range. `(1-s)^2` is
 * 0.28% of max at 94.7% steal, so a target could lose 99.7% of its money before
 * the check noticed - and in the live run above it did, reporting OFF BASELINE
 * at $9.4m of $4723.8m. A healthy stream's true minimum is `maxMoney * (1-s)`,
 * the instant after a hack lands, so half of that is a floor with real meaning
 * however high the fraction goes.
 *
 * Taken as the MAX of the two, not a replacement: `(1-s)^2` is the tighter of
 * the pair below ~50% steal and stays in charge there.
 */
export const MONEY_FLOOR_SHARE = 0.5;

/**
 * Bad batches tolerated in one evidence window before the fraction backs off.
 *
 * Zero was too strict, and measurably: a live run had alpha-ent judge ONE batch
 * out of 223 badly and cut itself from 94.8% to 56.9%, where it stayed for the
 * remaining ten minutes. rho-construction took the same 1-in-536 and held its
 * fraction, so the two ended a run of near-identical targets 40 points apart on
 * a single event.
 *
 * The response was also aimed at the wrong thing. A bad batch is a SEQUENCING
 * fault - the ops landed in the wrong order or too far apart - and the run that
 * produced it was carrying 132ms of jitter against a 100ms spacer. A smaller
 * steal does not make landings more punctual; it just earns less.
 *
 * A real breakdown is still caught, and by the mechanism built for it:
 * DESYNC_STRIKES consecutive bad batches stop the stream outright for re-prep.
 * This only stops an isolated one from being read as a trend.
 */
export const BAD_BATCH_TOLERANCE = 1;

/**
 * Cap on the anchor's allowance for op times stretching before its ops launch.
 *
 * The allowance is real - a streaming target is at minimum security only about
 * half the time, so an op time measured at the minimum understates what the op
 * will meet. But it was `min(1, (hackSec + growSec) / minSec)`, and 1 means the
 * anchor is placed a whole EXTRA weaken window into the future:
 *
 *     earliest = now + W + MIN_LEAD + W * swing
 *
 * That fraction reaches 1 exactly when a target has drained, because grow is
 * then sized to climb back from almost nothing and `growSec` explodes with it.
 * So a drain does not merely stop the money - it schedules every subsequent
 * batch two weaken windows out, and at 480s per window a live run froze
 * rho-construction and alpha-ent completely: `done` stuck at 970 and 1031 while
 * `sent` kept climbing, depth pinned at MAX_IN_FLIGHT, and pool free RAM rising
 * because nothing was due to launch for sixteen minutes.
 *
 * A quarter is a generous allowance for the real effect and cannot produce that
 * failure. A target that genuinely wants more than this is not prepped, which
 * is the baseline check's business, not the anchor's.
 */
export const MAX_ANCHOR_SWING = 0.25;

/**
 * How much of the drift a target has actually shown to budget for, and how fast
 * a past reading fades.
 *
 * GROW_DRIFT_TOLERANCE is a floor, not an answer: drift is hacking level moving
 * between a batch's dispatch and its landing, so it scales with the weaken
 * window and differs per target. One run measured 4.41% on a 266s window and
 * 6.37% on a 473s one, against a 4.00% budget - and the 473s target, nova-med,
 * earned $49.97b while holding a third of the RAM budget that alpha-ent turned
 * into $17271.56b.
 *
 * So the budget is measured instead of assumed. `worstOver` is already recorded
 * every window for the controller; this reuses it. The safety factor is the
 * margin between "the drift we saw" and "the drift the next window will bring",
 * and the decay stops one bad window pinning a target low forever.
 */
export const DRIFT_SAFETY = 1.5;
export const DRIFT_DECAY = 0.9;

/**
 * Floor under a MEASURED budget, so one lucky window cannot claim a target has
 * no drift at all. MAX_STEAL_FRACTION bounds the ceiling anyway; this stops the
 * arithmetic from being asked a degenerate question.
 */
export const MIN_DRIFT_TOLERANCE = 0.005;

/**
 * Ceiling on a MEASURED budget, and not decoration either.
 *
 * The budget is DRIFT_SAFETY times the worst overshoot yet seen, and the grow
 * margin is derived from the budget - so a single absurd window widens the
 * tolerance to match, and the back-off that would have caught the NEXT one
 * cannot fire. The budget grows to excuse the very thing it exists to detect.
 *
 * 0.25 is three times the worst drift ever measured on this fleet (9.7%), so it
 * cannot bind on real evidence. Past it the arithmetic has stopped describing
 * drift anyway: at a 25% budget maxStealForDrift already holds the fraction
 * under 73%, and a batch overshooting by more than a quarter is a broken batch,
 * to be judged bad rather than accommodated.
 */
export const MAX_DRIFT_TOLERANCE = 0.25;

/**
 * Where the supervisor mirrors its log.
 *
 * The in-game log window holds a bounded number of lines, so by the time a run
 * has produced something worth reading it has already thrown away its own
 * start - the rescan that chose the targets, the first OFF BASELINE, the ramp.
 * ns.write is 0 GB, so keeping the whole thing costs nothing but disk.
 *
 * Overwritten at startup rather than appended to: a file that grows across
 * every run is one nobody reads. `--log <path>` picks another, `--log ""`
 * turns it off.
 */
export const CONT_LOG_FILE = "/data/continuous.log.txt";

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

// ----------------------------------------------------------------- share ----

/**
 * Share mode, mirrored from scripts/config.js.
 *
 * EVERY VALUE BELOW MUST EQUAL THE SHOTGUN'S. This is not a copy that may
 * diverge - it is the same protocol read from a second place. scripts/
 * sharemode.js writes the marker and broadcasts the port, and scripts/share.js
 * peeks that port to decide whether to keep running; neither of them knows
 * which batcher is up. A different port number here would leave `sharemode.js
 * on` looking simply broken under continuous - workers launched and exiting a
 * millisecond later - so tests/continuous.test.mjs pins the equality.
 *
 * They are duplicated rather than imported because this tree may not import
 * from scripts/, and because doing so would drag the shotgun's config into
 * every continuous entry point. Only the values cross the boundary, never a
 * module.
 */

/**
 * Written by scripts/sharemode.js, read by the manager and by every share
 * worker. Holds the FRACTION of the pool to devote to ns.share, not a bare
 * on/off flag, so the amount is retunable from the terminal.
 */
export const SHARE_MARKER = "/data/share.txt";

/**
 * Port the share fraction is BROADCAST on, for the workers to read.
 *
 * The marker cannot do this job, and assuming it could cost the shotgun a live
 * run: ns.read resolves against the server the CALLING script runs on, and
 * /data/share.txt exists on home alone - so a share worker anywhere else read
 * "", parsed it as off, and exited within milliseconds of a perfectly valid
 * pid. Ports are the only channel a worker on a purchased server can hear.
 *
 * This is also why CONT_REPORT_PORT is 3 and not 2: the share gate is peeked,
 * never drained, and a drain loop on it would consume the setting.
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
 * forever, while hack income is roughly linear in RAM. The last three quarters
 * of a pool buy 5.6 points and cost three quarters of the income. 25% sits near
 * the knee.
 */
export const SHARE_FRACTION = 0.25;

/**
 * Hard clamp on the share fraction, whatever the marker says.
 *
 * The shotgun needs this to stop a 100% marker starving its prep gate into a
 * boot restart loop. Continuous fails more gently - a stream that cannot fit
 * simply refuses its batches and says so - but the clamp is kept identical
 * anyway, because sharemode.js reports what it wrote against SHARE_MAX_FRACTION
 * and a second, larger bound here would make that report a lie.
 */
export const SHARE_MAX_FRACTION = 0.90;

/**
 * Parse SHARE_MARKER's contents into a fraction in [0, SHARE_MAX_FRACTION].
 *
 * Anything unparseable reads as OFF rather than as a default. A NaN would
 * compare false against every bound, so garbage in the marker must mean "stop",
 * never "carry on with some number I invented".
 *
 * Pure arithmetic, no ns calls - this file must stay 0 GB.
 */
export function shareFractionFrom(text) {
  const word = String(text ?? "").trim().split("\n")[0].trim().toLowerCase();
  if (word === "" || word === "off" || word === "false") return 0;
  if (word === "on" || word === "true") return SHARE_FRACTION;
  const n = Number(word);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, SHARE_MAX_FRACTION);
}

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
 * A stream needs weakenTime / cadence batches in the air to land continuously.
 * Below that it does not merely earn less - it stops being a stream. A measured
 * run on a 360s-weaken target capped at 400 dispatched its 400 batches over
 * 160s, then STALLED for ~200s with nothing left to land and no free slot to
 * dispatch into, and repeated. That is shotgun behaviour, arrived at from the
 * inside, and it is what this whole design exists to avoid.
 *
 * 1200 covers a weaken of 480s at the current 400ms cadence. Targets slower
 * than that - computek's weaken is ~20 minutes - still cap, and still fall back
 * into waves; the honest fix for those is a wider cadence for that target, not
 * a bigger number here.
 *
 * Raised from 400 once two things made depth cheap. JIT: a queued op reserves
 * nothing, so depth costs bookkeeping rather than RAM - a live run held ~1000
 * batches across five targets against 0.00TB reserved. And retire() no longer
 * walks the whole in-flight map every tick, which at this depth across several
 * streams would have been hundreds of thousands of iterations a second inside a
 * game loop.
 *
 * What still bounds it is RAM, and the steal calculator already enforces that -
 * it sizes each target's fraction to fit the budget, so a deeper pipeline
 * arrives as a smaller bite rather than as an over-commitment.
 */
export const MAX_IN_FLIGHT = 1200;

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
 * How often the JIT scheduler re-measures op times for its due-ness scan, ms.
 *
 * The scan runs every tick against every queue head, and a fresh snapshot per
 * stream per tick is 40/s per target - on the formulas backend that is a
 * getServer each time. So the SCAN uses a cached reading.
 *
 * The delay an op actually launches with is measured fresh regardless. A stale
 * value there would reintroduce exactly the error JIT exists to remove, and
 * launches are only ~4 per cadence per target, so measuring them properly is
 * cheap.
 */
export const OPTIME_REFRESH_MS = 250;

/**
 * How late an op may land before its batch is abandoned, ms.
 *
 * NOT zero, which is what the first JIT build effectively used - it aborted on
 * any negative slack at all. A batch is expensive to lose and a few ms of
 * lateness costs nothing: the ops are a spacer apart, so the sequence only
 * breaks when lateness approaches SPACER_MS. Abandoning a whole batch to avoid
 * landing 3ms late is the wrong trade by a wide margin.
 *
 * Half a spacer keeps a clear margin against reordering while absorbing the
 * op-time drift that made the strict check fire constantly.
 */
export const LATE_TOLERANCE_MS = SPACER_MS / 2;

/**
 * How early an op may be launched ahead of its computed due time, ms.
 *
 * The scheduler can only act on a tick, and its due-ness scan uses a cached op
 * time, so it cannot hit `land - opTime` exactly. It launches slightly early
 * and additionalMsec absorbs the difference - which is exact, because the game
 * fixes an op's duration at the moment of the call.
 *
 * This is the only RAM the JIT dispatcher wastes: each op holds its bytes for
 * its own duration plus at most this. Against a weaken window measured in
 * minutes it does not register.
 *
 * Sized against how fast op times MOVE, not against tick granularity, which is
 * what a first attempt at 300ms got wrong. calculateHackingTime is proportional
 * to hackDifficulty, and a streaming target's security oscillates - so on a
 * target with a 160s weaken (hack 40s) a 1% security swing is 400ms. Launch
 * with less slack than that and the fresh measurement at launch comes out past
 * the landing, which cost a live run ~1450 abandoned batches out of 1826.
 *
 * Larger than MIN_LEAD_MS on purpose, which has a visible consequence: the
 * anchor sits at `now + W + MIN_LEAD_MS`, so weaken-1 (due at A - W) is inside
 * this window the instant its batch is planned and goes out immediately. That
 * is not a bug and not a regression - the all-at-once dispatcher launched it at
 * exactly the same moment, with delay 0. Weaken-1 holds RAM for a full weaken
 * either way; it is hack and grow that JIT actually saves.
 */
export const LAUNCH_LEAD_MS = 2000;

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
 * MAXIMUM unprepped targets to prep at once, alongside the running streams.
 *
 * A ceiling, not a target - see PREP_SPARE_SHARE for what actually decides the
 * number. "Prep waves are sized by need and so are individually small" is true
 * only relative to the pool they are placed in, and that assumption was written
 * against a 26 PB one.
 *
 * Prep runs CONCURRENTLY with streaming, never before it. Blocking the whole
 * run until every target was prepped meant the already-prepped ones - the good
 * ones, which is why they were picked - sat idle earning nothing while a deep,
 * dirty target was brought up. That is backwards.
 *
 * This is now the REAL ceiling. It used to be unreachable: rescan queued only
 * the top maxTargets * 2 candidates, and the streams occupied most of those, so
 * the queue ran out before the slots did however much RAM was spare. The queue
 * is the whole ranking now, which makes this number and PREP_SPARE_SHARE the
 * only two things deciding the count.
 */
export const PREP_CONCURRENCY = 4;

/**
 * How much of the pool must be FREE to earn each prep slot beyond the first.
 *
 * The flat PREP_CONCURRENCY above is right on a large pool and ruinous on a
 * small one, because a wave sized "by need" takes whatever the pool has when
 * need exceeds it. On a 1.6 TB pool four queued preps reserved 1.58 TB, held it
 * for a weaken window each, and left `pool 0.00TB free` on every report - the
 * one live stream aborted 169 of 170 batches for want of RAM, and none of the
 * four targets finished prepping either, because each was crawling at a quarter
 * of the rate one alone would have had.
 *
 * So: one prep always, and one more per quarter of the pool that is genuinely
 * idle. That reproduces today's behaviour exactly where it was measured - an
 * idle pool at startup still grants all four - and collapses to serial prep
 * when the pool is full, which is the case that was broken.
 */
export const PREP_SPARE_SHARE = 0.25;

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
