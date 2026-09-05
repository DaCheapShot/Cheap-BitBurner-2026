import { REPORT_PORT } from "./config.js";
import { prep, measure, pickTarget, DEFAULT_MAX_CYCLES } from "./prepper.js";
import * as math from "./mathFormulas.js";

/**
 * Phase 3 CLI: bring one target to max money and minimum security.
 *
 * All the logic lives in scripts/prepper.js so the manager can call it in-process
 * - only one process may own the ServerPool and the report port at a time. This
 * file is just argument parsing and the tail window.
 *
 * Identical to prep.js except for which math module it injects - this one uses
 * ns.formulas.hacking, which is exact but requires Formulas.exe on home.
 *
 * Usage:  run scripts/prep-formulas.js --target foodnstuff
 *         run scripts/prep-formulas.js                      (auto: richest server you can hack)
 *         run scripts/prep-formulas.js --target n00dles --max-cycles 5
 *
 * RAM: 1.60 base + prepper.js 2.00 + mathFormulas 2.50 = 6.10 GB
 * Requires Formulas.exe on home.
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

  const ready = math.prepare(ns);
  if (!ready.ok) {
    ns.tprint(`ERROR: ${ready.error}`);
    return;
  }

  const host = tIdx >= 0 ? args[tIdx + 1] : pickTarget(ns, math);
  if (!host) {
    ns.tprint("ERROR: no rooted, money-bearing target found. Pass --target <host>.");
    return;
  }

  // Drop anything stale so old batch ids can't be counted as this run's reports.
  // Safe here because this process owns the port; the manager clears its own.
  ns.getPortHandle(REPORT_PORT).clear();

  const start = measure(ns, host, math);
  ns.print(
    `prep ${host}: money ${fmtMoney(start.money)}/${fmtMoney(start.maxMoney)}  ` +
      `sec ${start.sec.toFixed(2)}/${start.minSec.toFixed(2)}`,
  );

  const res = await prep(ns, host, { math, maxCycles });

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
