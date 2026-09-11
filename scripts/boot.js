import { loadCalibration, calibAgeMs } from "./calib.js";
import { ROOT_MARKER, CLOUD_DONE_MARKER, CLOUD_RECHECK_MS,
         FORMULAS_PROGRAM, FORMULAS_MARKER, WORKER_LIST,
         DEPLOY_LIST, DEPLOY_MANIFEST } from "./config.js";
// The continuous batcher's worker paths, for killOrphanWorkers. That file holds
// no ns calls and imports nothing, so this is 0 GB - see the RAM note below.
import { WORKER_LIST as CONT_WORKER_LIST } from "./continuous/config.js";

/**
 * Supervisor: keeps the whole operation running from one script.
 *
 * Each tick, in order:
 *   1. root.js      - open ports and NUKE anything new
 *   2. deploy.js    - push workers, but only if root.js actually rooted something
 *   3. calibrate.js - only when the cache is missing or stale, and only for the
 *                     SHOTGUN's analyze build. Skipped entirely when Formulas.exe
 *                     is owned, and skipped entirely under continuous, whose
 *                     analyze backend keeps no cache and never reads one.
 *   4. cloud.js     - kept alive as a service (buys and upgrades servers), but
 *                     only until the fleet is maxed; see CLOUD_DONE_MARKER
 *   5. manager      - kept alive as a service. FOUR files, two independent
 *                     choices: which SYSTEM (continuous or shotgun) and which
 *                     math BACKEND (formulas or analyze).
 *
 * TWO BATCHERS, ONE POOL. scripts/continuous/ is the JIT batcher - it streams
 * batches at a cadence and sizes its own steal fraction from the server and the
 * RAM it can have. scripts/manager.js is the shotgun - it fires a whole volley
 * per weaken window. They are ALTERNATIVES in the strongest sense: each believes
 * it owns the RAM pool and its report port, so two of them running is silent
 * corruption, not a slow mode. Continuous is the default; --shotgun picks the
 * other. See ensureOneManager, which has to police all four files, not two.
 *
 * The backend choice is re-made EVERY tick within whichever system is chosen,
 * since Formulas.exe can be bought or lost at any time.
 *
 * TRANSIENTS RUN ONE AT A TIME, and the tick waits for each to exit before
 * starting the next. They all run on home, and the manager reserves everything
 * except HOME_RESERVE_GB - so running root, deploy and calibrate concurrently
 * could exceed the reserve and fail to launch. Sequential keeps the peak to a
 * single script's footprint.
 *
 * Services are identified by filename in ns.ps("home"), so a manager you
 * started by hand is adopted rather than duplicated. Two managers would be
 * actively harmful: each would believe it owned the pool and the report port.
 * The same is true of the two manager BUILDS - see ensureOneManager.
 *
 * Usage:  run scripts/boot.js
 *         run scripts/boot.js --target joesguns   (pin the manager's target)
 *         run scripts/boot.js --once              (one pass, then exit)
 *         run scripts/boot.js --no-cloud          (don't buy servers)
 *         run scripts/boot.js --no-formulas       (always use the analyze build)
 *         run scripts/boot.js --shotgun           (the volley batcher, not the stream)
 *         run scripts/boot.js --targets 5         (continuous only; shotgun ignores it)
 *         run scripts/boot.js --interval 30000
 *
 * RAM: 1.60 base + run 1.00 + ps 0.20 + kill 0.50 + fileExists 0.10
 *      + scan 0.20 (killOrphanWorkers must reach the whole network) = 3.60 GB
 * (the deploy manifest check is ns.read/ns.write, 0 GB, and DEPLOY_LIST is a
 * plain array of strings from config.js. continuous/config.js is the same kind
 * of file - constants only, no ns call anywhere in it - so importing the
 * continuous worker paths adds nothing to this total.)
 * (calib.js is 0 GB, ns.read/ns.write are 0 GB, and root.js is imported only
 * for the marker path constant - a plain string, so it adds nothing.)
 */

const ROOT = "/scripts/root.js";
const DEPLOY = "/scripts/deploy.js";
const CALIBRATE = "/scripts/calibrate.js";
const CLOUD = "/scripts/cloud.js";
/**
 * The manager files, by system and then by backend.
 *
 * A table rather than four constants because the two choices are INDEPENDENT:
 * --shotgun picks the row, Formulas.exe picks the column, and every one of the
 * other three files is a rival that must not be left running.
 */
const MANAGERS = {
  continuous: {
    analyze: "/scripts/continuous/manager.js",
    formulas: "/scripts/continuous/manager-formulas.js",
  },
  shotgun: {
    analyze: "/scripts/manager.js",
    formulas: "/scripts/manager-formulas.js",
  },
};

const ALL_MANAGERS = Object.values(MANAGERS).flatMap((m) => [m.analyze, m.formulas]);

const DEFAULT_TICK_MS = 60000;

/**
 * Re-calibrate when the cache is older than this.
 *
 * The cached constants are linear and do not drift on their own, but per-host
 * growth bases are only recorded for servers at minimum security, so a cache
 * written before you rooted today's best target simply won't mention it.
 */
const CALIB_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** How long to wait for a transient before giving up and moving on. */
const TRANSIENT_TIMEOUT_MS = 5 * 60 * 1000;

const fmtAge = (ms) =>
  ms >= 3600000 ? `${(ms / 3600000).toFixed(1)}h` : `${Math.round(ms / 60000)}m`;

/**
 * Strip leading slashes before comparing script paths.
 *
 * The game stores file paths WITHOUT a leading slash - src/Paths/FilePath.ts
 * rule 3 is "Must not contain a leading /", and resolveFilePath removes one if
 * given. So ns.run("/scripts/manager.js") starts fine, but ns.ps() reports it
 * as "scripts/manager.js". Comparing the two forms directly never matches,
 * which makes every running service look dead and spawns a duplicate per tick.
 */
const normPath = (p) => String(p).replace(/^\/+/, "");

/** Processes on home matching this script path, in start order. */
function instancesOf(ns, file) {
  const want = normPath(file);
  return ns.ps("home").filter((p) => normPath(p.filename) === want);
}

/** Is a script with this filename running on home? */
function isUp(ns, file) {
  return instancesOf(ns, file).length > 0;
}

/**
 * Kill all but the oldest instance of a service.
 *
 * Two managers is not merely wasteful, it is incorrect: each believes it owns
 * the RAM pool and the report port, so they over-commit the same RAM and steal
 * each other's completion reports. Lowest PID wins because it started first and
 * its volley is already in flight.
 */
function killDuplicates(ns, file, log) {
  const live = instancesOf(ns, file).sort((a, b) => a.pid - b.pid);
  if (live.length <= 1) return 0;
  let killed = 0;
  for (const p of live.slice(1)) if (ns.kill(p.pid)) killed++;
  log(`killed ${killed} duplicate instance(s) of ${file} - kept pid ${live[0].pid}`);
  return killed;
}

/**
 * Every host reachable from home, breadth first.
 *
 * A deliberate fourth copy of this walk rather than an import of ram.js's
 * ServerPool.scanAll: importing it would drag getServerMaxRam, getServerUsedRam
 * and hasRootAccess along with ns.scan and cost boot 0.35GB for a list of
 * names. The walk itself is four lines.
 */
function reachableHosts(ns) {
  const seen = new Set(["home"]);
  const queue = ["home"];
  for (let i = 0; i < queue.length; i++) {
    for (const host of ns.scan(queue[i])) if (!seen.has(host)) { seen.add(host); queue.push(host); }
  }
  return queue;
}

/**
 * Kill every worker still running anywhere on the network.
 *
 * Call ONLY when no manager survives to own them. A manager that is killed
 * mid-volley leaves hundreds of batches in flight, and they do two kinds of
 * damage: they hold the RAM the replacement needs - a live swap left 2.7TB
 * reserved against a target the new manager then could not prep - and they keep
 * hacking and growing that target on a plan nobody owns any more, so the new
 * manager's first snapshot measures a server being churned by ghosts.
 *
 * Killing them costs nothing that was not already lost. ns.hack credits money
 * the instant it lands, so a killed grow forfeits only the restore - which prep
 * performs anyway, and which the new manager was going to have to perform
 * regardless. One prep cycle beats a weaken window of thrash.
 *
 * Workers are identified by filename, so anything else running on the network
 * is left alone. ps reports paths without a leading slash while WORKER_LIST
 * carries one, hence normPath on both sides.
 *
 * BOTH SYSTEMS' WORKERS, always, whichever one is being started. The two use
 * different worker files - scripts/hack.js against scripts/continuous/hack.js -
 * so a set covering only the incoming system's would leave the outgoing one's
 * batches running network-wide, which is the exact damage described above and
 * the reason a swap kills anything at all. Killing a set that happens to be
 * empty costs one ps per host, which this walk is already paying.
 *
 * SHARE WORKERS ARE DELIBERATELY SPARED. They are not in WORKER_LIST, and that
 * is not an oversight: none of the reasoning above applies to them. They are
 * tied to no target, so they cannot churn a server nobody owns; they hold a
 * bounded fraction of the pool by design rather than a whole volley's worth;
 * and the incoming manager ADOPTS them through shareCensus instead of launching
 * duplicates. Killing them would drop the reputation bonus for a tick and buy
 * nothing. Turning share off is the marker's job - see scripts/sharemode.js.
 */
function killOrphanWorkers(ns, log) {
  const workers = new Set([...WORKER_LIST, ...CONT_WORKER_LIST].map(normPath));
  let killed = 0;
  let threads = 0;

  for (const host of reachableHosts(ns)) {
    for (const p of ns.ps(host)) {
      if (!workers.has(normPath(p.filename))) continue;
      if (ns.kill(p.pid)) {
        killed++;
        threads += p.threads;
      }
    }
  }

  if (killed > 0) {
    log(
      `killed ${killed} orphaned worker(s), ${threads} thread(s) - they belonged to the ` +
        `manager just stopped and would have held its RAM for a whole weaken window`,
    );
  }
  return killed;
}

/**
 * Ensure exactly one manager runs, and that it is the right one.
 *
 * All four manager files are ALTERNATIVES, not separate services. killDuplicates
 * only dedupes by filename, so on its own it would happily leave an analyze
 * manager and a formulas manager running side by side - each believing it owned
 * the RAM pool and the report port, over-committing the same RAM and stealing
 * each other's completion reports.
 *
 * `others` is a LIST rather than the single other build, and that is what makes
 * the two systems switchable at all. scripts/continuous/core.js has its own
 * guard - findRivals refuses to start beside any of the four - so a surviving
 * shotgun manager does not merely coexist with an incoming continuous one, it
 * makes it ABORT and exit. Boot would then see no manager next tick, start it
 * again, and watch it abort again, once a minute forever. Killing every rival
 * before the launch is the whole fix.
 *
 * @param {string[]} others every manager file that is not `wanted`
 * @returns {boolean} true if a manager is running when this returns
 */
function ensureOneManager(ns, wanted, others, args, log) {
  let swapped = false;
  for (const other of others) {
    for (const p of instancesOf(ns, other)) {
      ns.kill(p.pid);
      log(`stopped ${other} - switching to ${wanted}`);
      swapped = true;
    }
  }
  killDuplicates(ns, wanted, log);

  // Only after a real swap, and only once no manager of any build survives:
  // every worker still running then belongs to the manager just killed. Doing
  // this whenever a manager is killed would be wrong - killDuplicates keeps a
  // survivor whose own volley is in flight, and its workers are indistinguishable
  // from the dead one's without reading batch ids out of their argv.
  if (swapped && !isUp(ns, wanted)) killOrphanWorkers(ns, log);

  return isUp(ns, wanted) || ensureService(ns, wanted, args, log);
}

/**
 * Run a script and wait for it to exit.
 *
 * Polls ns.ps rather than ns.isRunning purely to avoid paying for a second API
 * (ps is already needed for the service checks; isRunning would add 0.10 GB for
 * something ps can already answer).
 */
async function runToCompletion(ns, file, args, log) {
  const pid = ns.run(file, 1, ...args);
  if (pid === 0) {
    log(`WARN: could not start ${file} - not enough free RAM on home, or file missing`);
    return false;
  }
  // Poll by PID, which needs no path normalisation and cannot collide.
  const deadline = Date.now() + TRANSIENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await ns.sleep(200);
    if (!ns.ps("home").some((p) => p.pid === pid)) return true;
  }
  log(`WARN: ${file} still running after ${fmtAge(TRANSIENT_TIMEOUT_MS)} - moving on`);
  return true;
}

/** Start a long-running script if it isn't already up. */
function ensureService(ns, file, args, log) {
  if (isUp(ns, file)) return false;
  const pid = ns.run(file, 1, ...args);
  if (pid === 0) {
    log(`WARN: could not start ${file} - not enough free RAM on home`);
    return false;
  }
  log(`started ${file} ${args.join(" ")}`.trim());
  return true;
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  //ns.ui.openTail();

  const args = ns.args.map(String);
  const once = args.includes("--once");
  const noCloud = args.includes("--no-cloud");
  const noManager = args.includes("--no-manager");
  const noFormulas = args.includes("--no-formulas");
  // Continuous by default. It is the measured better earner - $947m/s average
  // against the shotgun on the same save - and it prices its own steal fraction
  // per target instead of needing one chosen for it. --continuous is accepted
  // and does nothing, so the command can say which system it means out loud.
  const mode = args.includes("--shotgun") ? "shotgun" : "continuous";
  const tIdx = args.indexOf("--target");
  const target = tIdx >= 0 ? args[tIdx + 1] : null;
  // Continuous supervises several targets at once and takes a count; the shotgun
  // works one at a time and ignores the flag. Passed through rather than
  // interpreted, so boot does not have to know which is which.
  const nIdx = args.indexOf("--targets");
  const targets = nIdx >= 0 ? args[nIdx + 1] : null;
  const managerArgs = [
    ...(target ? ["--target", target] : []),
    ...(targets ? ["--targets", targets] : []),
  ];
  const iIdx = args.indexOf("--interval");
  const tickMs = iIdx >= 0 ? Math.max(5000, Number(args[iIdx + 1]) || DEFAULT_TICK_MS) : DEFAULT_TICK_MS;

  const log = (s) => ns.print(`${new Date().toLocaleTimeString()}  ${s}`);

  ns.print(
    `boot: ${mode}, tick ${Math.round(tickMs / 1000)}s, manager target ` +
      `${target ?? "auto"}${noCloud ? ", cloud off" : ""}${noManager ? ", manager off" : ""}`,
  );
  // Said once, at startup, rather than as a skipped-step line every tick. The
  // continuous analyze backend reads no calibration cache at all - see
  // scripts/continuous/lib/mathAnalyze.js - so calibrating for it would be a
  // 6.20 GB transient buying nothing.
  if (mode === "continuous") ns.print("boot: continuous needs no calibration cache - skipping calibrate.js");

  let lastRootStamp = ns.read(ROOT_MARKER);
  let firstPass = true;
  // Say "fleet is maxed" once, not every tick - the whole point of this change
  // is to stop boot from producing a line a minute about nothing happening.
  let cloudMaxedLogged = false;

  do {
    // -- 0. did the manager die? -------------------------------------------
    // Checked BEFORE calibrating, not after restarting it. A manager that exits
    // on its own has almost always hit a target with no cached growth base - a
    // newly rooted, richer server it auto-picked - so the cache must be
    // refreshed in THIS tick, before the restart, or it just dies again.
    // Of the CHOSEN system's pair. A manager of the other system running is not
    // this one surviving - it is a rival, and ensureOneManager is about to kill
    // it - so counting it here would suppress the calibration refresh on exactly
    // the tick that needs it.
    const pair = MANAGERS[mode];
    const managerDied = !firstPass && !noManager
      && !isUp(ns, pair.analyze) && !isUp(ns, pair.formulas);
    if (managerDied) log("manager is not running - it exited since the last tick");

    // Re-checked every tick, not once at startup: Formulas.exe is lost on every
    // augment install and can be bought at any time, so the correct build to run
    // changes underneath a long-lived boot.
    const hasFormulas = !noFormulas && ns.fileExists(FORMULAS_PROGRAM, "home");
    ns.write(FORMULAS_MARKER, `${hasFormulas ? 1 : 0}\n${Date.now()}`, "w");

    // -- 1. root ------------------------------------------------------------
    await runToCompletion(ns, ROOT, ["--quiet"], log);

    // -- 2. deploy ----------------------------------------------------------
    // Two triggers, and the second one exists because the first is not enough.
    //
    // Newly rooted hosts are the obvious case, and the marker makes that
    // event-driven rather than scp-ing to every host once a minute for nothing.
    //
    // A new WORKER FILE is the case that bit. Adding one roots nothing, so the
    // root marker never moves, so deploy never runs, and the file sits on home
    // while every host runs without it. The only symptom is exec returning a
    // bare 0 far away: share.js ran on one host out of 69 that way.
    const stamp = ns.read(ROOT_MARKER);
    const wantWorkers = DEPLOY_LIST.join(" ");
    const haveWorkers = ns.read(DEPLOY_MANIFEST).trim();
    const workersChanged = haveWorkers !== wantWorkers;

    if (firstPass || stamp !== lastRootStamp || workersChanged) {
      lastRootStamp = stamp;
      log(
        firstPass
          ? "deploying workers (first pass)"
          : workersChanged
            ? `worker set changed - redeploying (${haveWorkers || "nothing recorded"} -> ${wantWorkers})`
            : "new servers rooted - redeploying",
      );
      await runToCompletion(ns, DEPLOY, [], log);

      // Ran deploy, and it STILL did not record the file set this boot expects.
      // deploy.js writes the list it actually broadcast, so a mismatch that
      // survives a run means the copy of deploy.js inside the game is older than
      // the one on disk - the filesync extension has not delivered it. Re-running
      // it cannot help, and without this the loop above would try once a minute
      // forever while the batcher quietly ran short of workers.
      const broadcast = ns.read(DEPLOY_MANIFEST).trim();
      if (broadcast !== wantWorkers) {
        ns.tprint(
          `ERROR: deploy.js ran but broadcast "${broadcast || "nothing"}" ` +
            `instead of "${wantWorkers}". The copy of deploy.js IN THE GAME is older than the one ` +
            `on disk - filesync has not delivered it. Re-save scripts/deploy.js with the extension ` +
            `connected, or the batcher will keep exec-ing workers that are not there.`,
        );
      }
    }

    // -- 3. calibrate -------------------------------------------------------
    // The calibration cache exists only to feed mathAnalyze. On the formulas
    // build it is dead weight, and calibrating costs a 6.20 GB transient.
    //
    // Skipped outright under continuous. The cache exists to feed scripts/
    // mathAnalyze.js; scripts/continuous/lib/mathAnalyze.js deliberately has no
    // cache and never reads /data/calib.json, so under continuous this whole
    // step is a 6.20 GB transient whose output nothing will open.
    const wantsCalib = mode === "shotgun" && !hasFormulas;
    const calib = wantsCalib ? loadCalibration(ns) : null;
    const age = calib ? calibAgeMs(calib) : Infinity;
    if (wantsCalib && (!calib || age > CALIB_MAX_AGE_MS || managerDied)) {
      log(
        !calib
          ? "no calibration cache - calibrating"
          : managerDied
            ? "refreshing calibration before restarting the manager"
            : `calibration is ${fmtAge(age)} old - refreshing`,
      );
      await runToCompletion(ns, CALIBRATE, [], log);
    }

    // -- 4. services --------------------------------------------------------
    // Sweep duplicates first. If an earlier build (or a hand-started copy) left
    // extras running, they are cleaned up before anything else is decided.
    if (!noCloud) {
      killDuplicates(ns, CLOUD, log);
      // cloud.js EXITS once the fleet is fully maxed - it is a service with a
      // finish line, unlike the manager. Without this check, ensureService sees
      // it missing every tick and relaunches it forever just to watch it exit.
      // The marker is re-checked periodically in case the limits move.
      const maxedAt = Number(ns.read(CLOUD_DONE_MARKER).split("\n")[0]);
      const maxedFor = Number.isFinite(maxedAt) && maxedAt > 0 ? Date.now() - maxedAt : Infinity;
      // A fresh boot re-evaluates everything, so ignore the marker on pass one.
      if (!firstPass && maxedFor < CLOUD_RECHECK_MS) {
        if (!cloudMaxedLogged) {
          log(`cloud fleet is maxed - not relaunching (re-checking in ${fmtAge(CLOUD_RECHECK_MS - maxedFor)})`);
          cloudMaxedLogged = true;
        }
      } else {
        cloudMaxedLogged = false;
        ensureService(ns, CLOUD, ["--loop"], log);
      }
    }
    if (!noManager) {
      const wanted = hasFormulas ? pair.formulas : pair.analyze;
      ensureOneManager(ns, wanted, ALL_MANAGERS.filter((f) => f !== wanted), managerArgs, log);
    }

    firstPass = false;
    if (!once) await ns.sleep(tickMs);
  } while (!once);

  ns.tprint("boot: one pass done.");
}
