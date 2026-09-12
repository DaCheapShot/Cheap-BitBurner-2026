import { ServerPool } from "scripts/continuous/lib/server";
import { candidates, isPrepped } from "scripts/continuous/lib/target";
import { chooseSteal } from "scripts/continuous/lib/plan";
import { fmtMoney } from "scripts/continuous/lib/fmt";
import * as math from "scripts/continuous/lib/mathAnalyze";
import {
  HOME_RESERVE_GB,
  MAX_TARGETS,
  TARGET_RAM_BUDGET,
  WORKER_FILES,
  WORKER_RAM_FALLBACK,
} from "scripts/continuous/config";

/**
 * Per-target state report: prepped or not, money, security, and the steal
 * fraction the continuous batcher's own calculator would pick right now.
 *
 * Launches nothing, allocates nothing, touches no port - safe to run beside a
 * manager of either system.
 *
 *   run scripts/continuous/servers.js                 one pass, then exit
 *   run scripts/continuous/servers.js --loop           redraw every 5s
 *   run scripts/continuous/servers.js --loop 15000     redraw every 15s
 *
 * Output goes to the SCRIPT LOG (ns.ui.openTail), not the terminal. That is the
 * point of it: the table is wide and is meant to be left open and re-read - and
 * with --loop it re-reads itself. The loop clears the log each pass rather than
 * appending, so the window shows the current state instead of a scrollback that
 * has to be hunted through for the newest table.
 *
 * The steal figure is `chooseSteal` - the same function the batcher calls, at
 * the same provisional slice rescan prices targets against
 * (placeableRam * TARGET_RAM_BUDGET / MAX_TARGETS). It is what the calculator
 * would choose for a target admitted NOW; a live stream then adapts up or down
 * from there on its own reports, so a running manager's log is the authority on
 * where a stream actually sits.
 *
 * Analyze backend only, deliberately: it always works, and the formulas build
 * would differ only in pricing UNPREPPED hosts, where growthAnalyze reads
 * current security and so over-states grow threads (and therefore under-states
 * steal). Unprepped rows are flagged for that reason.
 *
 * RAM cost is the same looping or not - clearLog, sleep and args are all 0 GB.
 * Base 1.60 + lib/server.js 0.35 + lib/mathAnalyze.js (hackAnalyze,
 * growthAnalyze, weakenAnalyze, hackAnalyzeSecurity, growthAnalyzeSecurity,
 * hackAnalyzeChance at 1.00 each is the bulk) + getServerRequiredHackingLevel
 * 0.10 + getHackingLevel 0.05 + getScriptRam 0.10. Cores are NOT read:
 * lib/cores.js costs 2.00 GB for ns.getServer and would change nothing here
 * except the placement detail this report does not print.
 */

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const fmtRam = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(2)}TB` : `${gb.toFixed(2)}GB`);

/**
 * Per-thread worker RAM, measured where the worker exists.
 *
 * Copied rather than imported from core.js: that module reaches exec, kill, ps
 * and scp through the stream, prep and share libraries, which would add ~2.5 GB
 * to a report that launches nothing.
 */
function workerRam(ns) {
  const out = {};
  for (const [op, file] of Object.entries(WORKER_FILES)) {
    out[op] = ns.getScriptRam(file, "home") || WORKER_RAM_FALLBACK[op];
  }
  return out;
}

/** What a row earns per second at the calculator's fraction, hack chance included. */
export const incomePerSec = (row) => row.fit.income * 1000 * row.chance;

/**
 * One row per snapshot, richest first.
 *
 * Sorted on income rather than on money-per-GB-second: that is what rescan now
 * admits on, and a report that ranks differently from the thing it describes is
 * a report that gets misread.
 */
export function buildRows(math, snaps, ram, slice) {
  const rows = [];
  for (const snap of snaps) {
    const fit = chooseSteal(math, snap, ram, slice);
    if (!fit) continue; // hacking level too low, or no root - not a target yet
    rows.push({
      snap,
      prepped: isPrepped(snap),
      chance: math.hackChance(snap),
      weakenMs: math.opTimes(snap).weaken,
      fit,
    });
  }
  rows.sort((a, b) => incomePerSec(b) - incomePerSec(a));
  return rows;
}

/**
 * One pass: measure, price, print.
 *
 * The pool is REBUILT each pass rather than refreshed. cloud.js buys servers and
 * root.js roots them while this runs, and build is the only path that picks up a
 * host that did not exist before - a refresh would keep reporting a slice priced
 * against the network as it stood when the script started. It allocates nothing
 * and touches no port either way, so it stays safe beside a running manager.
 */
function render(ns, ram) {
  const pool = ServerPool.build(ns, { homeReserve: HOME_RESERVE_GB });
  const slice = (pool.placeableRam(ram.grow) * TARGET_RAM_BUDGET) / MAX_TARGETS;
  const rows = buildRows(math, candidates(ns).map((h) => math.snapshot(ns, h)), ram, slice);

  ns.print("");
  // Stamped so a window left open is visibly stale when the script has died -
  // a frozen table and a live one look identical otherwise.
  ns.print(
    `=== TARGETS (${rows.length} hackable) ${new Date().toLocaleTimeString()} ` +
      "=".repeat(18),
  );
  ns.print(
    `pool ${fmtRam(pool.totalRam)}, placeable ${fmtRam(pool.placeableRam(ram.grow))}, ` +
      `free ${fmtRam(pool.freeRam)}  =>  slice ${fmtRam(slice)} ` +
      `(x${TARGET_RAM_BUDGET} / ${MAX_TARGETS} targets)`,
  );
  ns.print("");
  ns.print(
    pad("HOST", 20) + padL("PREP", 5) + padL("MAX $", 10) + padL("AT%", 8) +
      padL("SEC", 8) + padL("MIN", 7) + padL("CHANCE", 8) + padL("STEAL", 8) +
      padL("H", 7) + padL("BATCH", 10) + padL("CAD", 8) + padL("$/SEC", 11),
  );

  for (const r of rows) {
    const s = r.snap;
    const f = r.fit;
    ns.print(
      pad(s.host, 20) +
        padL(r.prepped ? "yes" : "NO", 5) +
        padL(fmtMoney(s.maxMoney), 10) +
        padL(`${((s.money / s.maxMoney) * 100).toFixed(1)}%`, 8) +
        padL(s.sec.toFixed(2), 8) +
        padL(s.minSec.toFixed(2), 7) +
        padL(`${(r.chance * 100).toFixed(0)}%`, 8) +
        padL(`${(f.steal * 100).toFixed(2)}%`, 8) +
        padL(f.hack, 7) +
        padL(fmtRam(f.peak), 10) +
        padL(`${(f.cadence / 1000).toFixed(2)}s`, 8) +
        padL(f.fitsPeak ? fmtMoney(incomePerSec(r)) : "-", 11) +
        // Three things worth knowing that a number cannot say: the batch does
        // not fit the slice at all (earns NOTHING - it places weakens and never
        // places its grow), the target had to widen its pace to fit, and the
        // fraction is at its protectable ceiling rather than RAM-bound.
        (f.fitsPeak ? "" : "  NO ROOM") +
        (f.fits || !f.fitsPeak ? "" : "  paced") +
        (f.capped ? "  capped" : ""),
    );
  }

  const dirty = rows.filter((r) => !r.prepped).length;
  ns.print("");
  if (dirty > 0) {
    ns.print(
      `${dirty} target(s) NOT prepped: growthAnalyze sizes grow at CURRENT security, ` +
        `so their STEAL is under-stated and their BATCH over-stated.`,
    );
  }
  ns.print(
    `STEAL is what chooseSteal picks for a target admitted now at the slice above. ` +
      `A live stream adapts from there - its own log is the authority.`,
  );
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();

  const args = ns.args.map(String);
  const lIdx = args.indexOf("--loop");
  const loopMs = lIdx >= 0 ? Math.max(1000, Number(args[lIdx + 1]) || 5000) : 0;

  // Outside the loop on purpose. prepare() caches game constants that do not
  // move - weakenAnalyze(1,1) and the two security-per-thread figures - so
  // re-calling it every pass would re-pay 3 GB of analyze calls for an answer
  // that cannot have changed.
  const ready = math.prepare(ns);
  if (!ready.ok) {
    ns.print(`ERROR: ${ready.error}`);
    return;
  }

  const ram = workerRam(ns);

  // do/while, so no flag runs exactly one pass and exits - the behaviour every
  // existing invocation of this script expects.
  do {
    if (loopMs) ns.clearLog();
    render(ns, ram);
    if (loopMs) await ns.sleep(loopMs);
  } while (loopMs);
}
