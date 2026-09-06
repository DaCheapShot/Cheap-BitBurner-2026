import { loadCalibration, calibAgeMs } from "./calib.js";
import { ROOT_MARKER, CLOUD_DONE_MARKER, CLOUD_RECHECK_MS,
         FORMULAS_PROGRAM, FORMULAS_MARKER } from "./config.js";

/**
 * Supervisor: keeps the whole operation running from one script.
 *
 * Each tick, in order:
 *   1. root.js      - open ports and NUKE anything new
 *   2. deploy.js    - push workers, but only if root.js actually rooted something
 *   3. calibrate.js - only when the cache is missing or stale (skipped entirely
 *                     when Formulas.exe is owned - see step 3 below)
 *   4. cloud.js     - kept alive as a service (buys and upgrades servers), but
 *                     only until the fleet is maxed; see CLOUD_DONE_MARKER
 *   5. manager      - kept alive as a service (the volley loop). Two interchangeable
 *                     builds exist - manager.js (*Analyze API, always available)
 *                     and manager-formulas.js (ns.formulas, needs Formulas.exe,
 *                     more accurate) - and boot picks whichever is owned, EVERY
 *                     tick, since Formulas.exe can be bought or lost at any time.
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
 *         run scripts/boot.js --interval 30000
 *
 * RAM: 1.60 base + run 1.00 + ps 0.20 + kill 0.50 + fileExists 0.10 = 3.40 GB
 * (calib.js is 0 GB, ns.read/ns.write are 0 GB, and root.js is imported only
 * for the marker path constant - a plain string, so it adds nothing.)
 */

const ROOT = "/scripts/root.js";
const DEPLOY = "/scripts/deploy.js";
const CALIBRATE = "/scripts/calibrate.js";
const CLOUD = "/scripts/cloud.js";
const MANAGER_ANALYZE = "/scripts/manager.js";
const MANAGER_FORMULAS = "/scripts/manager-formulas.js";

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
 * Ensure exactly one manager runs, and that it is the right one.
 *
 * The two managers are ALTERNATIVES, not separate services. killDuplicates only
 * dedupes by filename, so on its own it would happily leave an analyze manager
 * and a formulas manager running side by side - each believing it owned the RAM
 * pool and the report port, over-committing the same RAM and stealing each
 * other's completion reports.
 *
 * @returns {boolean} true if a manager is running when this returns
 */
function ensureOneManager(ns, wanted, other, args, log) {
  for (const p of instancesOf(ns, other)) {
    ns.kill(p.pid);
    log(`stopped ${other} - switching to ${wanted}`);
  }
  killDuplicates(ns, wanted, log);
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
  ns.ui.openTail();

  const args = ns.args.map(String);
  const once = args.includes("--once");
  const noCloud = args.includes("--no-cloud");
  const noManager = args.includes("--no-manager");
  const noFormulas = args.includes("--no-formulas");
  const tIdx = args.indexOf("--target");
  const target = tIdx >= 0 ? args[tIdx + 1] : null;
  const iIdx = args.indexOf("--interval");
  const tickMs = iIdx >= 0 ? Math.max(5000, Number(args[iIdx + 1]) || DEFAULT_TICK_MS) : DEFAULT_TICK_MS;

  const log = (s) => ns.print(`${new Date().toLocaleTimeString()}  ${s}`);

  ns.print(
    `boot: tick ${Math.round(tickMs / 1000)}s, manager target ` +
      `${target ?? "auto"}${noCloud ? ", cloud off" : ""}${noManager ? ", manager off" : ""}`,
  );

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
    const managerDied = !firstPass && !noManager
      && !isUp(ns, MANAGER_ANALYZE) && !isUp(ns, MANAGER_FORMULAS);
    if (managerDied) log("manager is not running - it exited since the last tick");

    // Re-checked every tick, not once at startup: Formulas.exe is lost on every
    // augment install and can be bought at any time, so the correct build to run
    // changes underneath a long-lived boot.
    const hasFormulas = !noFormulas && ns.fileExists(FORMULAS_PROGRAM, "home");
    ns.write(FORMULAS_MARKER, `${hasFormulas ? 1 : 0}\n${Date.now()}`, "w");

    // -- 1. root ------------------------------------------------------------
    await runToCompletion(ns, ROOT, ["--quiet"], log);

    // -- 2. deploy ----------------------------------------------------------
    // Only when the network actually changed. Deploying every tick would scp to
    // every rooted host for nothing; the marker makes it event-driven.
    const stamp = ns.read(ROOT_MARKER);
    if (firstPass || stamp !== lastRootStamp) {
      lastRootStamp = stamp;
      log(firstPass ? "deploying workers (first pass)" : "new servers rooted - redeploying");
      await runToCompletion(ns, DEPLOY, [], log);
    }

    // -- 3. calibrate -------------------------------------------------------
    // The calibration cache exists only to feed mathAnalyze. On the formulas
    // build it is dead weight, and calibrating costs a 6.20 GB transient.
    const calib = hasFormulas ? null : loadCalibration(ns);
    const age = calib ? calibAgeMs(calib) : Infinity;
    if (!hasFormulas && (!calib || age > CALIB_MAX_AGE_MS || managerDied)) {
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
      const wanted = hasFormulas ? MANAGER_FORMULAS : MANAGER_ANALYZE;
      const other = hasFormulas ? MANAGER_ANALYZE : MANAGER_FORMULAS;
      ensureOneManager(ns, wanted, other, target ? ["--target", target] : [], log);
    }

    firstPass = false;
    if (!once) await ns.sleep(tickMs);
  } while (!once);

  ns.tprint("boot: one pass done.");
}
