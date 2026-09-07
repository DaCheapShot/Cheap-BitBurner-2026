import { buildWorkerPool, shareRam } from "./prepper.js";
import {
  SHARE_MARKER, SHARE_PORT, SHARE_FRACTION, SHARE_MAX_FRACTION,
  shareFractionFrom, shareBonusFor,
} from "./config.js";

/**
 * Turn share mode on or off, or retune it, without stopping anything.
 *
 *   run scripts/sharemode.js            status only, changes nothing
 *   run scripts/sharemode.js on         SHARE_FRACTION of the pool
 *   run scripts/sharemode.js off        every share thread exits within 10s
 *   run scripts/sharemode.js 0.5        half the pool, live
 *
 * This writes a fraction to two places, and it needs both. SHARE_MARKER is the
 * persistent setting - it survives a restart, and the manager reads it each
 * cycle to size the top-up. SHARE_PORT is how that setting reaches the workers:
 * ns.read resolves against the server the calling script runs on, so a worker on
 * a purchased server cannot see a file that lives on home. Workers peek the port
 * between share calls and retire themselves when it reads 0.
 *
 * So a change here needs no restart of the manager, and no kill.
 *
 * The value lives in a file rather than in config.js precisely so it can be
 * changed from the terminal: editing config.js means waiting on the filesync
 * extension, which is the least reliable link in this whole setup.
 *
 * RAM: 1.60 base + prepper.js 2.00 + getSharePower 0.20 = 3.80 GB
 *      (ns.read, ns.write and ns.tprint are all 0 GB)
 *
 * It imports the manager's own buildWorkerPool rather than measuring the
 * network itself, which is most of that cost. Worth it: a status screen that
 * reports a different pool from the one the manager will actually divide is a
 * diagnostic that lies, and this repo has already been burned by exactly that.
 * This is a hand-run tool on home, so the GB does not compete with anything.
 */

const pct = (f) => `${(f * 100).toFixed(1)}%`;
const fmtRam = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(2)}TB` : `${gb.toFixed(2)}GB`);

/**
 * What each fraction of the real pool would buy.
 *
 * The bonus is logarithmic, so the interesting number is never the total - it
 * is how little the next doubling adds. Printing the ladder is the only way to
 * make that visible at the point where the decision is taken.
 */
function ladder(poolGb, ramPerThread, current) {
  const rows = [];
  for (const f of [0.05, 0.10, 0.25, 0.50, SHARE_MAX_FRACTION]) {
    const threads = Math.floor((poolGb * f) / ramPerThread);
    const mark = Math.abs(f - current) < 1e-9 ? " <- now" : "";
    rows.push(
      `    ${pct(f).padStart(6)}  ${fmtRam(poolGb * f).padStart(9)}  ` +
        `${String(threads).padStart(9)}t  x${shareBonusFor(threads).toFixed(4)}${mark}`,
    );
  }
  return rows.join("\n");
}

/** @param {NS} ns */
export async function main(ns) {
  const args = ns.args.map(String);
  const current = shareFractionFrom(ns.read(SHARE_MARKER));

  if (args.length > 0) {
    const word = args[0].trim().toLowerCase();
    // Parsed through the same function the workers use, so what this script
    // reports as accepted is exactly what they will act on. A silent
    // disagreement between the two would be invisible until the RAM moved.
    const wanted = shareFractionFrom(word);

    // shareFractionFrom maps anything it cannot read to 0, which is the right
    // answer for a worker but the wrong one for a typo at the terminal: it
    // would silently turn share OFF and look like it had worked. Reject it.
    const meantOff = word === "off" || word === "false" || Number(word) === 0;
    if (wanted === 0 && !meantOff) {
      ns.tprint(
        `ERROR: "${args[0]}" is not on, off, or a fraction in (0, ${SHARE_MAX_FRACTION}]. ` +
          `Nothing changed - share is ${current > 0 ? `on at ${pct(current)}` : "off"}.`,
      );
      return;
    }

    ns.write(SHARE_MARKER, String(wanted), "w");

    // Publish to the gate port as well, not only to the file. The file is the
    // persistent setting, but only home can read it - ns.read resolves against
    // the server the calling script runs on, so a worker out on the fleet never
    // sees it. The port is what they actually hear.
    //
    // Written here rather than left to the manager's next cycle: that is the
    // difference between "off" taking 10 seconds and taking a whole volley,
    // which on ecorp is nearly seven minutes.
    const gate = ns.getPortHandle(SHARE_PORT);
    gate.clear();
    gate.write(wanted);

    const clamped = Number(word) > SHARE_MAX_FRACTION
      ? `  (clamped from ${word} - see SHARE_MAX_FRACTION)`
      : "";

    ns.tprint(
      wanted === 0
        ? `share mode OFF. Every share thread exits within 10s; the manager ` +
          `reclaims the RAM on its next cycle.`
        : `share mode ON at ${pct(wanted)} of the pool${clamped}. The manager picks ` +
          `this up at the top of its next cycle.`,
    );
    return;
  }

  // -- status ---------------------------------------------------------------
  // getSharePower is the only honest reading of the effect: the game scales
  // thread counts by an intelligence bonus and by home's core count before
  // taking the log, and neither is visible to shareBonusFor.
  const power = ns.getSharePower();
  const pool = buildWorkerPool(ns);
  const ram = shareRam(ns);

  ns.tprint(
    `\nshare mode: ${current > 0 ? `ON at ${pct(current)} of the pool` : "OFF"}\n` +
      `  measured power   x${power.toFixed(4)}  (ns.getSharePower, includes the ` +
      `intelligence and home-core bonuses)\n` +
      `  pool             ${fmtRam(pool.usableRam)} usable across ${pool.servers.length} host(s)\n` +
      `  cost per thread  ${fmtRam(ram)}\n` +
      `\n  what each fraction of YOUR pool would buy:\n${ladder(pool.usableRam, ram, current)}\n` +
      `\n  The bonus is 1 + ln(threads)/25, so every doubling of share RAM adds a\n` +
      `  flat 2.77 points however much is already running, while hack income is\n` +
      `  roughly linear in RAM. Default is ${pct(SHARE_FRACTION)}.\n` +
      `\n  run scripts/sharemode.js on | off | <fraction>\n`,
  );
}
