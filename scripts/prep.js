import { REPORT_PORT } from "./config.js";
import { loadCalibration } from "./calib.js";
import { prep, measure, pickTarget, DEFAULT_MAX_CYCLES } from "./prepper.js";

/**
 * Phase 3 CLI: bring one target to max money and minimum security.
 *
 * All the logic lives in scripts/prepper.js so the manager can call it in-process
 * - only one process may own the ServerPool and the report port at a time. This
 * file is just argument parsing and the tail window.
 *
 * Usage:  run scripts/prep.js --target foodnstuff
 *         run scripts/prep.js                      (auto: richest rooted server)
 *         run scripts/prep.js --target n00dles --max-cycles 5
 *
 * RAM: 1.60 base + prepper.js 3.25 = 4.85 GB
 * (was 6.85 - weakenAnalyze and growthAnalyzeSecurity are now cache reads.)
 * Requires /data/calib.json: run scripts/calibrate.js first.
 */

function fmtMoney(m) {
  for (const [div, suf] of [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]]) {
    if (Math.abs(m) >= div) return `$${(m / div).toFixed(2)}${suf}`;
  }
  return `$${m.toFixed(0)}`;
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();

  const args = ns.args.map(String);
  const tIdx = args.indexOf("--target");
  const cIdx = args.indexOf("--max-cycles");
  const maxCycles = cIdx >= 0 ? Number(args[cIdx + 1]) : DEFAULT_MAX_CYCLES;

  const host = tIdx >= 0 ? args[tIdx + 1] : pickTarget(ns);
  if (!host) {
    ns.tprint("ERROR: no rooted, money-bearing target found. Pass --target <host>.");
    return;
  }

  const calib = loadCalibration(ns);
  if (!calib) {
    ns.tprint(
      "ERROR: /data/calib.json missing or invalid. Run scripts/calibrate.js first - " +
        "prep reads its weaken and grow-security constants from there.",
    );
    return;
  }

  // Drop anything stale so old batch ids can't be counted as this run's reports.
  // Safe here because this process owns the port; the manager clears its own.
  ns.getPortHandle(REPORT_PORT).clear();

  const start = measure(ns, host);
  ns.print(
    `prep ${host}: money ${fmtMoney(start.money)}/${fmtMoney(start.maxMoney)}  ` +
      `sec ${start.sec.toFixed(2)}/${start.minSec.toFixed(2)}`,
  );

  const res = await prep(ns, host, { calib, maxCycles });

  if (res.ok) {
    ns.tprint(
      `SUCCESS: ${host} prepped in ${res.cycles} cycle(s) - ` +
        `${fmtMoney(res.m.money)} at security ${res.m.sec.toFixed(2)}`,
    );
  } else {
    ns.tprint(
      `WARN: ${host} not prepped after ${res.cycles} cycle(s) - ${res.reason}. ` +
        `${fmtMoney(res.m.money)}/${fmtMoney(res.m.maxMoney)}, ` +
        `sec ${res.m.sec.toFixed(2)}/${res.m.minSec.toFixed(2)}`,
    );
  }
}
