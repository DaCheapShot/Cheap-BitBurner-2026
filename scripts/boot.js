import { ROOT_MARKER, CLOUD_DONE_MARKER, CLOUD_RECHECK_MS,
         WORKER_LIST,
         DEPLOY_LIST, DEPLOY_MANIFEST, SHARE_HOLD_MARKER, TARGETS_MARKER } from "./config.js";
// The gang supervisor's path. Same kind of import as the line above - that file
// is constants only, no ns call anywhere in it, so this is 0 GB.
import { GANG_SERVICE } from "./gang/config.js";
import { CONTRACTS_SERVICE } from "./contracts/config.js";
import { SING_SERVICE } from "./sing/config.js";
import { HACKNET_MONEY_SERVICE, HACKNET_HASH_SERVICE, HACKNET_EVERY } from "./hacknet/config.js";

/**
 * Supervisor: keeps the whole operation running from one script.
 *
 * Each tick, in order:
 *   1. root.js      - open ports and NUKE anything new
 *   2. deploy.js    - push workers, but only if root.js actually rooted something
 *   3. cloud.js     - kept alive as a service (buys and upgrades servers), but
 *                     only until the fleet is maxed; see CLOUD_DONE_MARKER
 *   5. manager      - kept alive as a service. One file per SYSTEM
 *                     (continuous or shotgun); each picks its own math backend
 *                     in-process, so Formulas.exe never changes the file.
 *   6. gang         - kept alive as a service, but ONLY once a gang exists.
 *                     ns.gang.inGang() is 0 GB, so the check costs nothing on
 *                     every BitNode that will never have one. The gang
 *                     supervisor holds no gang API itself; it runs transients.
 *   7. sing         - kept alive as a service, ALWAYS. Singularity has no 0 GB
 *                     availability check, so sing.js gates itself: without
 *                     Source-File 4 it parks rather than exits.
 *
 * TWO BATCHERS, ONE POOL. scripts/continuous/ is the JIT batcher - it streams
 * batches at a cadence and sizes its own steal fraction from the server and the
 * RAM it can have. scripts/manager.js is the shotgun - it fires a whole volley
 * per weaken window. They are ALTERNATIVES in the strongest sense: each believes
 * it owns the RAM pool and its report port, so two of them running is silent
 * corruption, not a slow mode. Continuous is the default; --shotgun picks the
 * other. See ensureOneManager, which has to police every manager file, not two.
 *
 * The math backend is not boot's choice for either system - each manager picks
 * its own - so --no-formulas is simply forwarded.
 *
 * TRANSIENTS RUN ONE AT A TIME, and the tick waits for each to exit before
 * starting the next. They all run on home, and the manager reserves everything
 * except HOME_RESERVE_GB - so running root and deploy concurrently
 * could exceed the reserve and fail to launch. Sequential keeps the peak to a
 * single script's footprint.
 *
 * Services are identified by filename in ns.ps("home"), so a manager you
 * started by hand is adopted rather than duplicated. Two managers would be
 * actively harmful: each would believe it owned the pool and the report port.
 *
 * Usage:  run scripts/boot.js
 *         run scripts/boot.js --target joesguns   (pin the manager's target)
 *         run scripts/boot.js --once              (one pass, then exit)
 *         run scripts/boot.js --no-cloud          (don't buy servers)
 *         run scripts/boot.js --no-gang           (don't supervise the gang)
 *         run scripts/boot.js --no-contracts      (don't solve coding contracts)
 *         run scripts/boot.js --no-sing           (don't run the singularity supervisor)
 *         run scripts/boot.js --no-hacknet        (do not buy hacknet nodes or spend hashes)
 *         run scripts/boot.js --no-formulas       (always use the *Analyze math)
 *         run scripts/boot.js --shotgun           (the volley batcher, not the stream)
 *         run scripts/boot.js --targets 5         (continuous only; shotgun ignores it)
 *         run scripts/boot.js --interval 30000
 *
 * RAM: 1.60 base + run 1.00 + ps 0.20 + kill 0.50
 *      + scan 0.20 (killOrphanWorkers must reach the whole network) = 3.50 GB
 * (the deploy manifest check is ns.read/ns.write, 0 GB, and DEPLOY_LIST is a
 * plain array of strings from config.js. gang/config.js is the same kind of
 * file - constants only, no ns call anywhere in it - so importing it adds
 * nothing to this total. ns.gang.inGang() is 0 GB, and the `gang` namespace itself
 * resolves to nothing: findFunc in RamCalculations.ts matches a key only when
 * its value is a function or a number, so a bare `gang` descends into the
 * namespace, finds no leaf of that name, and adds 0.)
 * (ns.read/ns.write are 0 GB, and root.js is imported only for the marker path
 * constant - a plain string, so it adds nothing.)
 */

const BOOT = "/scripts/boot.js";
const ROOT = "/scripts/root.js";
const DEPLOY = "/scripts/deploy.js";
const CLOUD = "/scripts/cloud.js";
/**
 * The manager file for each system. One each: both math backends now live in
 * one module per system (scripts/math.js, scripts/continuous/lib/math.js),
 * which picks per process - so buying or losing Formulas.exe changes a branch
 * inside the running manager, never which file boot runs.
 */
const MANAGERS = {
  continuous: "/scripts/continuous/manager.js",
  shotgun: "/scripts/manager.js",
};

/**
 * Files that were managers once and are gone from disk - but NOT from the
 * game. filesync never deletes, so the last copy stays on home and may still be
 * RUNNING from before the upgrade. The continuous manager aborts beside any
 * rival, so one of these left alive would stop the new manager starting, once a
 * tick, forever. Killed like any other rival; never started.
 */
const RETIRED_MANAGERS = [
  "/scripts/continuous/manager-formulas.js",
  "/scripts/manager-formulas.js",
];

const ALL_MANAGERS = [...Object.values(MANAGERS), ...RETIRED_MANAGERS];

const DEFAULT_TICK_MS = 60000;

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
 * BOTH SYSTEMS' WORKERS, always, whichever one is being started - and that is
 * one list, because both batchers exec the same scripts/{hack,grow,weaken}.js
 * and tell their reports apart by the port number in argv. When they had
 * separate files, a set covering only the incoming system's left the outgoing
 * one's batches running network-wide.
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
  const workers = new Set(WORKER_LIST.map(normPath));
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
 * guard - findRivals refuses to start beside any other manager - so a surviving
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
  if (swapped && !isUp(ns, wanted)) {
    killOrphanWorkers(ns, log);
    // The outgoing manager's targets are nobody's now. A stale list has
    // scripts/hacknet/hashes.js buying Increase Maximum Money for a server the
    // incoming manager may never touch, and a purchase the game ACCEPTS is not
    // refunded - refundUpgrade fires only when the effect itself fails. The
    // incoming manager republishes within a rescan; until then, spend nothing.
    ns.write(TARGETS_MARKER, "", "w");
  }

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
  const noGang = args.includes("--no-gang");
  const noContracts = args.includes("--no-contracts");
  const noSing = args.includes("--no-sing");
  const noHacknet = args.includes("--no-hacknet");
  // sing.js holds share off whenever the player is not doing faction work. With
  // sing opted out nothing would ever release that hold, so clear it here.
  if (noSing) ns.write(SHARE_HOLD_MARKER, "", "w");
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
    // Forwarded, not interpreted. Both managers' math modules read it off
    // ns.args and pick the *Analyze path.
    ...(noFormulas ? ["--no-formulas"] : []),
  ];
  const iIdx = args.indexOf("--interval");
  const tickMs = iIdx >= 0 ? Math.max(5000, Number(args[iIdx + 1]) || DEFAULT_TICK_MS) : DEFAULT_TICK_MS;

  const log = (s) => ns.print(`${new Date().toLocaleTimeString()}  ${s}`);

  ns.print(
    `boot: ${mode}, tick ${Math.round(tickMs / 1000)}s, manager target ` +
      `${target ?? "auto"}${noCloud ? ", cloud off" : ""}${noManager ? ", manager off" : ""}`,
  );
  // ONE BOOT. Two supervisors with different flags each read the other's
  // manager as a rival and kill it, every tick, forever - a live run swapped
  // shotgun and continuous once a minute and killed 262 worker threads each
  // time. The NEWEST wins, not the oldest as killDuplicates keeps for services:
  // the boot just typed is the one carrying the flags the user wants now. The
  // older boot's manager is then an ordinary swap for the loop below.
  for (const p of instancesOf(ns, BOOT)) {
    if (p.pid !== ns.pid && ns.kill(p.pid)) log(`stopped an older boot (pid ${p.pid}) - this one supersedes it`);
  }

  let lastRootStamp = ns.read(ROOT_MARKER);
  let firstPass = true;
  let ticks = 0;
  // Say "fleet is maxed" once, not every tick - the whole point of this change
  // is to stop boot from producing a line a minute about nothing happening.
  let cloudMaxedLogged = false;

  do {
    // -- 0. did the manager die? -------------------------------------------
    // The CHOSEN system's file. A manager of the other system running is not
    // this one surviving - it is a rival that ensureOneManager is about to kill,
    // so counting it here would report a live manager on exactly the tick it
    // exited.
    const wanted = MANAGERS[mode];
    const managerDied = !firstPass && !noManager && !isUp(ns, wanted);
    if (managerDied) log("manager is not running - it exited since the last tick");

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

    // -- 3. services --------------------------------------------------------
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
      ensureOneManager(ns, wanted, ALL_MANAGERS.filter((f) => f !== wanted), managerArgs, log);
    } else if (firstPass && !ALL_MANAGERS.some((f) => isUp(ns, f))) {
      // --no-manager with nothing already up means no manager will publish
      // targets this run - the same terminal state ensureOneManager reaches once
      // no manager survives a swap, so clear the marker the same way, once,
      // rather than leaving a previous boot's list stale.
      //
      // THE LIVENESS CHECK IS LOAD-BEARING. --no-manager kills nothing:
      // killDuplicates for managers lives inside ensureOneManager, which this
      // branch skips. So a boot run beside a live batcher - which is the point
      // of the flag - would blank the list that manager owns. managerCore
      // publishes only on its initial pick and on a retarget, so a stable target
      // never republishes and hashes.js would report "no targets published - no
      // manager is running" for the life of that manager, with one running. The
      // continuous side republishes every rescan and would self-heal; the
      // shotgun would not.
      ns.write(TARGETS_MARKER, "", "w");
    }
    // The gang supervisor. Gated on inGang() rather than started unconditionally
    // because the script exits immediately without a gang, and ensureService
    // would then relaunch it every tick forever - the same trap CLOUD_DONE_MARKER
    // exists to avoid. inGang() is 0 GB, so the gate is free on every BitNode
    // that never founds one.
    if (!noGang && ns.gang.inGang()) {
      killDuplicates(ns, GANG_SERVICE, log);
      ensureService(ns, GANG_SERVICE, [], log);
    }
    // The singularity supervisor. NOT gated like the gang: there is no 0 GB
    // way to ask whether singularity is available (getResetInfo is 1.00, and
    // boot is pinned at 3.50). It does not need a gate, because sing.js never
    // exits - without Source-File 4 it parks, so ensureService finds it up and
    // there is no relaunch loop to prevent.
    if (!noSing) {
      killDuplicates(ns, SING_SERVICE, log);
      ensureService(ns, SING_SERVICE, [], log);
    }
    // The hacknet, money sweep then hash sweep, every HACKNET_EVERY ticks.
    //
    // TRANSIENTS, not services: both exit on their own, so ensureService would
    // relaunch them every tick forever - the trap CLOUD_DONE_MARKER closes for
    // cloud and inGang() for the gang. This is the contracts.js shape.
    //
    // SEQUENTIAL, not together: the two files carry disjoint sets of the 21
    // ns.hacknet names, so run one after the other the subsystem's peak is the
    // larger (6.60 GB) rather than the sum.
    //
    // The isUp checks are about STACKING rather than duplicates: a hand-run
    // --dry-run can still be going, and a second sweep on top of it would plan
    // against cash the first is about to spend.
    if (!noHacknet && ticks % HACKNET_EVERY === 0) {
      if (!isUp(ns, HACKNET_MONEY_SERVICE)) {
        await runToCompletion(ns, HACKNET_MONEY_SERVICE, [], log);
      }
      // BOTH services, not just this one: runToCompletion RETURNS TRUE on its
      // timeout without killing anything, so a wedged money sweep would be
      // joined rather than waited for and the subsystem's peak would become
      // 5.45 + 6.60 = 12.05 instead of the larger of the two.
      if (!isUp(ns, HACKNET_MONEY_SERVICE) && !isUp(ns, HACKNET_HASH_SERVICE)) {
        await runToCompletion(ns, HACKNET_HASH_SERVICE, [], log);
      }
    }

    // The contract solver, and it is a TRANSIENT, not a service - one sweep per
    // tick, holding nothing in between. As a resident it pinned 4.10 GB forever
    // to re-read a clock that only matters once every ten minutes.
    //
    // It does its own gating and exits in about 300 ms while the gate is shut,
    // so running it every tick costs almost nothing. It is last in the tick
    // because runToCompletion BLOCKS until it exits.
    //
    // The isUp check is not about duplicates but about STACKING: a hand-run
    // --dummy can still be going, and starting a second sweep on top of it would
    // have both attempting the same contracts.
    if (!noContracts && !isUp(ns, CONTRACTS_SERVICE)) {
      await runToCompletion(ns, CONTRACTS_SERVICE, [], log);
    }

    firstPass = false;
    ticks++;
    if (!once) await ns.sleep(tickMs);
  } while (!once);

  ns.tprint("boot: one pass done.");
}
