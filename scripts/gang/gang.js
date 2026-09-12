import {
  GANG_TICK, GANG_ASCEND, GANG_EQUIP, GANG_WAR, GANG_MARKER,
  TICK_EVERY, ASCEND_EVERY, EQUIP_EVERY, WAR_EVERY, TRANSIENT_TIMEOUT_MS,
} from "./config.js";

/**
 * The gang supervisor: a cheap resident loop that runs expensive transients.
 *
 * WHY THIS SHAPE. ns.gang is priced off RamCostConstants.GangApiBase = 4, and
 * the whole surface this subsystem needs comes to about 37 GB. Held resident
 * that would not fit a fresh BitNode's 32 GB home beside boot.js (3.60),
 * cloud.js (5.75) and a continuous manager (9.40-13.35). So the API calls live
 * in four short-lived scripts and this one holds none of them: peak is ~15.5 GB
 * for a few hundred milliseconds instead of 37 GB forever.
 *
 * Each transient READS AND ACTS in the same process, so there is no data
 * handoff, no port protocol and no shared state to get out of step. The only
 * thing passed between them is GANG_MARKER, and only to spare ascend.js and
 * equip.js a 2.00 GB getGangInformation each for three numbers.
 *
 * THERE IS NO TICK TO DETECT. ns.gang.nextUpdate() (0 GB) resolves on the next
 * gang update and returns the ms of gang time processed - 2000 normally, up to
 * 5000 while bonus time drains (GangConstants.minCyclesToProcess and
 * maxCyclesToProcess, both defined as milliseconds over CONSTANTS.MilliPerCycle).
 * Watching stats change to infer a timer, which is how this is usually done,
 * measures the same thing worse and drifts.
 *
 * Usage:  run scripts/gang/gang.js
 *         boot.js starts it as a service once ns.gang.inGang() is true.
 *
 * RAM: 1.60 base + run 1.00 + ps 0.20 = 2.80 GB
 * (nextUpdate, inGang and getBonusTime are all 0 GB; config.js holds no ns call
 * and ns.read/ns.write are free.)
 */

/**
 * Run a transient and wait for it to exit.
 *
 * AWAITING IS THE WHOLE RAM ARGUMENT. Fired unawaited, the four transients
 * would stack to ~46 GB and the cheap ones would fail to start behind the
 * expensive one. Serialised, the peak is the single largest of them.
 *
 * Polls ns.ps by pid, like boot.js does, rather than ns.isRunning - ps is
 * needed anyway and isRunning would add 0.10 GB for the same answer.
 */
async function runOne(ns, file, log) {
  const pid = ns.run(file, 1);
  if (pid === 0) {
    // Not fatal, and expected early: on a 32 GB home carrying boot, cloud and a
    // manager there may be no room for a 12 GB transient. The cheaper ones
    // still land, and home grows. tick.js is deliberately among the cheapest so
    // the core loop is the last thing to be squeezed out.
    log(`WARN: could not start ${file} - not enough free RAM on home, or file missing`);
    return false;
  }
  const deadline = Date.now() + TRANSIENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await ns.sleep(50);
    if (!ns.ps("home").some((p) => p.pid === pid)) return true;
  }
  log(`WARN: ${file} still running after ${Math.round(TRANSIENT_TIMEOUT_MS / 1000)}s - moving on`);
  return true;
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  //ns.ui.openTail();

  if (!ns.gang.inGang()) {
    ns.tprint("gang: not in a gang - run scripts/gang/create.js \"<faction>\" first.");
    return;
  }

  const log = (s) => ns.print(`${new Date().toLocaleTimeString()}  ${s}`);
  log("gang supervisor up");

  let updates = 0;
  let lastPhase = "";

  while (true) {
    // 0 GB, and the only clock this subsystem has or needs.
    await ns.gang.nextUpdate();
    updates++;

    // Cadences count UPDATES, not seconds, so every one of them speeds up on
    // its own while bonus time is draining.
    //
    // tick first, always: it is the one that writes GANG_MARKER, which the
    // other three read. On the pass where several coincide, they get numbers
    // from this pass rather than the previous one.
    if (updates % TICK_EVERY === 0) await runOne(ns, GANG_TICK, log);
    if (updates % WAR_EVERY === 0) await runOne(ns, GANG_WAR, log);
    if (updates % ASCEND_EVERY === 0) await runOne(ns, GANG_ASCEND, log);
    if (updates % EQUIP_EVERY === 0) await runOne(ns, GANG_EQUIP, log);

    const phase = ns.read(GANG_MARKER).split("\n")[0];
    if (phase && phase !== lastPhase) {
      lastPhase = phase;
      log(`phase -> ${phase}  (bonus time ${Math.round(ns.gang.getBonusTime() / 1000)}s)`);
    }
  }
}
