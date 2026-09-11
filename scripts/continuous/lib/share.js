import {
  SHARE_MARKER,
  SHARE_PORT,
  SHARE_RAM_FALLBACK,
  SHARE_WORKER,
  shareFractionFrom,
} from "scripts/continuous/config";

/**
 * Share mode for the continuous batcher.
 *
 *   ns.fileExists   0.10 GB   (the only cost this file ADDS; on the formulas
 *                              build lib/mathFormulas.js already pays it)
 *   ns.exec         1.30      already paid by lib/stream.js
 *   ns.ps           0.20      already paid by core.js findRivals
 *   ns.read         0
 *   ns.getPortHandle 0
 *
 * ---------------------------------------------------------------------------
 * Why this is a port and not a rewrite
 *
 * scripts/managerCore.js has done this for the shotgun for a long time, and
 * every rule below is one it learned the expensive way. This tree may not
 * import from scripts/, so the logic is copied - but the reasoning is copied
 * with it, because a "cleaner" version of any one of these is a bug that
 * already happened:
 *
 *   - placement is PROPORTIONAL, not biggest-host-first
 *   - both passes are PLANNED before anything execs
 *   - noFile and refused are separate buckets
 *   - nothing goes through pool.allocate
 *   - the fraction reaches the fleet on a PORT, never through the marker file
 *
 * ---------------------------------------------------------------------------
 * What is deliberately NOT here
 *
 * ns.getSharePower (0.20 GB). managerCore reads it because the game counts a
 * worker's threads only from its first ns.share() call, so a number derived
 * from the thread count overstates on the cycle that launches. The census below
 * reads ns.ps, which counts PROCESSES THAT ARE STILL RUNNING - so the failure
 * getSharePower would catch here, workers that exec fine and exit a millisecond
 * later, is already caught one line earlier and named more precisely. The bonus
 * is reported as what the running threads are worth, labelled as such.
 *
 * ns.kill (0.50 GB). Share NEVER shrinks from this side. Lowering the fraction
 * or turning share off is the workers' own job - they peek the port between
 * 10 s share calls and retire themselves - which is what makes `sharemode.js
 * off` work in under 10 s even with no manager running at all.
 */

/**
 * The game stores paths WITHOUT a leading slash, so ns.ps reports
 * "scripts/share.js" while SHARE_WORKER carries one. Comparing the two forms
 * directly never matches - which here would mean every census reads zero and
 * the manager launches a fresh set of share workers every rescan until the pool
 * is full. Same rule, and same failure mode, as boot.js's normPath.
 */
const normPath = (p) => String(p).replace(/^\/+/, "");

const fmtRam = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(2)}TB` : `${Math.round(gb)}GB`);

/** From src/NetworkShare/Share.ts: calculateShareBonus is 1 + ln(threads)/25. */
const bonusFor = (threads) => (threads > 0 ? 1 + Math.log(threads) / 25 : 1);

/**
 * How many share threads are already running on the network.
 *
 * This is what makes a manager restart - or a swap between the two batchers -
 * safe. Share workers are not tied to a batch and do not die with the process
 * that started them, so a new manager finds them still running; without
 * counting them it would launch a second full set on top, doubling the RAM
 * share holds for no extra bonus. The bonus is logarithmic, so double the
 * threads is worth 2.77 points. Counting them ADOPTS them instead.
 *
 * Only hosts in the pool are inspected. A share worker on a host that has since
 * dropped out goes uncounted, which can over-launch by that host's worth - but
 * re-scanning the whole network to catch it would cost another 0.20 GB for a
 * case that requires losing root mid-run.
 *
 * byHost is what lets the top-up size each host against its OWN quota rather
 * than a single network-wide number, so a host already carrying its share is
 * not handed more.
 *
 * @param {NS} ns
 * @param {string[]} hosts
 * @returns {{threads: number, hosts: number, procs: number,
 *            hostList: string[], byHost: Map<string, number>}}
 */
export function shareCensus(ns, hosts) {
  const want = normPath(SHARE_WORKER);
  let threads = 0;
  let procs = 0;
  const live = [];
  const byHost = new Map();

  for (const host of hosts) {
    let n = 0;
    for (const p of ns.ps(host)) {
      if (normPath(p.filename) !== want) continue;
      n += p.threads;
      procs++;
    }
    if (n > 0) {
      live.push(host);
      byHost.set(host, n);
    }
    threads += n;
  }
  return { threads, hosts: live.length, procs, hostList: live, byHost };
}

/**
 * How many share threads there SHOULD be, and how many are missing.
 *
 * Sized against usableRam rather than freeRam, and under continuous that
 * matters MORE than it did for the shotgun, not less. A healthy stream holds
 * nearly the whole pool by design - free RAM is near zero whenever things are
 * going well - so a fraction of freeRam would read "share wants nothing"
 * exactly when the batcher is working, and "share wants everything" during the
 * gap after a rescan evicts a target.
 *
 * Alive threads already occupy part of usableRam, so `want - alive` converges
 * instead of compounding: asking for the same fraction repeatedly is
 * idempotent, which is what makes a per-rescan call safe.
 *
 * The deficit is floored at zero. Share never shrinks from here - see the file
 * header.
 */
export function planShare(pool, ramPerThread, fraction, alive) {
  if (!(fraction > 0) || !(ramPerThread > 0)) return { want: 0, deficit: 0 };
  const want = Math.floor((pool.usableRam * fraction) / ramPerThread);
  return { want, deficit: Math.max(0, want - alive) };
}

/**
 * Launch the missing share threads.
 *
 * Two passes, and the first one is the point.
 *
 * PASS 1 gives every host the SAME fraction of ITSELF, so share scales the pool
 * down uniformly instead of eating whole hosts. The shotgun's first live run of
 * this did the opposite - filled home first and to the brim - and on a 2PB home
 * that swallowed the pool's largest host for a benefit that barely registers:
 * getCoreBonus is 1 + (cores - 1)/16, and because the bonus is ln(threads)/25,
 * moving EVERY share thread onto an 8-core home is worth ln(1.4375)/25 = 1.45
 * points. Home still goes first so the rounding remainder lands where the cores
 * are.
 *
 * Losing the biggest host matters more here than it did there. The continuous
 * pool sizes a target's steal fraction against placeableRam, which floors per
 * host - so a hole punched in one large host does not merely remove its bytes,
 * it can drop the fraction the calculator will commit to.
 *
 * PASS 2 places whatever pass 1 could not - hosts too small for their quota, or
 * hosts that refuse the exec - anywhere it fits. Honouring the requested
 * fraction matters more than the pool's shape, and SHARE_MAX_FRACTION still
 * bounds the total.
 *
 * Hosts without the worker are found with fileExists rather than discovered
 * through a failed exec, because exec returns a bare 0 for BOTH causes and the
 * remedies are opposite.
 *
 * Deliberately does NOT go through pool.allocate. A pool reservation is
 * released at the end of a cycle, but a share worker outlives every cycle - it
 * runs until the port says stop. Reserving would leave `pending` set on a pool
 * the caller then refreshes, and refresh() re-reads the game's used RAM without
 * clearing it, so the same bytes would be subtracted twice.
 */
export function topUpShare(ns, pool, ramPerThread, fraction, alive, aliveByHost = new Map()) {
  const { want, deficit } = planShare(pool, ramPerThread, fraction, alive);
  if (deficit <= 0) {
    return { want, deficit: 0, launched: 0, placements: [], noFile: [], refused: [] };
  }

  // Home first purely so the rounding remainder lands on the multi-core host.
  const order = [...pool.servers].sort((a, b) => {
    if (a.hostname === b.hostname) return 0;
    if (a.hostname === "home") return -1;
    if (b.hostname === "home") return 1;
    return b.freeRam - a.freeRam;
  });

  // Two failures, kept apart on purpose. Merging them into one "cannot run it"
  // bucket wasted two live runs on the shotgun: deploy.js was current, had
  // copied share.js to all 68 hosts, and the manager still reported them as
  // missing the file - because the same list was also collecting hosts whose
  // exec returned 0 for entirely different reasons, and it carried the deploy
  // remedy. A diagnostic that names the wrong cause is worse than none.
  const noFile = [];
  const refused = [];
  const ready = [];
  for (const s of order) {
    if (ns.fileExists(SHARE_WORKER, s.hostname)) ready.push(s);
    else noFile.push(s.hostname);
  }

  // PLAN both passes first, exec once per host afterwards.
  //
  // The other way round left TWO share processes on home: pass 1 places each
  // host's quota, but a sum of floors falls short of the floor of the sum, so
  // pass 2 always has a handful of threads over and home - being first - took
  // them in a second exec. Harmless arithmetic, confusing to read, and the
  // stray process muddies the census for no gain.
  const plan = new Map();
  let remaining = deficit;

  // freeRam comes from the pool's cached usage, which does not move while we
  // are planning, so what this loop has already promised must be subtracted by
  // hand.
  const room = (s) => s.threadsFor(ramPerThread) - (plan.get(s.hostname) ?? 0);
  const promise = (s, n) => {
    if (n <= 0) return;
    plan.set(s.hostname, (plan.get(s.hostname) ?? 0) + n);
    remaining -= n;
  };

  for (const s of ready) {
    if (remaining <= 0) break;
    const quota = Math.floor((s.usableRam * fraction) / ramPerThread) - (aliveByHost.get(s.hostname) ?? 0);
    promise(s, Math.min(quota, room(s), remaining));
  }

  for (const s of ready) {
    if (remaining <= 0) break;
    promise(s, Math.min(room(s), remaining));
  }

  let launched = 0;
  const placements = [];

  for (const s of ready) {
    const n = plan.get(s.hostname) ?? 0;
    if (n <= 0) continue;
    if (ns.exec(SHARE_WORKER, s.hostname, n, SHARE_PORT) === 0) {
      // fileExists already said the script IS here, so this is something else.
      // Record what was asked against what the pool believed was free: equal-ish
      // means the pool's view is stale, wildly different means something outside
      // this process is holding the host. Guessing cost two live runs.
      //
      // The threads this host was promised are simply not placed. They are not
      // re-homed, because that means a second exec somewhere and puts the double
      // process back. The next rescan re-measures and tops up - the top-up is
      // idempotent, which is what makes that safe.
      refused.push({ host: s.hostname, threads: n, freeGb: s.freeRam });
      continue;
    }
    placements.push({ host: s.hostname, threads: n });
    launched += n;
  }

  return { want, deficit, launched, placements, noFile, refused };
}

/**
 * Read the marker, publish it, adopt what is running, launch what is missing.
 *
 * Called once per rescan, BEFORE the RAM budget is computed. The order is not
 * cosmetic: share workers exec outside the reservation system and are never
 * released, so a budget taken first would price RAM that share is about to take
 * and the calculator would commit a steal fraction it cannot place.
 *
 * One call site is enough here, unlike the shotgun's two. managerCore needs a
 * second hook inside prep because a shotgun prep BLOCKS for up to ten minutes,
 * so a toggle would look broken until it finished. Continuous rescans on a
 * fixed timer regardless of what prep is doing.
 *
 * Silent when share is off and nothing is running, which is the normal case for
 * the whole early game.
 *
 * @returns {{fraction: number, threads: number, launched: number} | null}
 */
export function serviceShare(ns, pool, log, opts = {}) {
  const { ramPerThread = SHARE_RAM_FALLBACK, indent = "  " } = opts;
  const fraction = shareFractionFrom(ns.read(SHARE_MARKER));

  // Broadcast BEFORE anything is launched, and unconditionally - including when
  // share is off, so any worker still running sees the 0 and retires.
  //
  // The marker is read here, on home, and republished on a port because that is
  // the only channel the fleet can hear. clear-then-write keeps exactly one
  // value in the queue for the workers to peek at.
  const gate = ns.getPortHandle(SHARE_PORT);
  gate.clear();
  gate.write(fraction);

  const census = shareCensus(ns, pool.servers.map((s) => s.hostname));

  if (fraction <= 0) {
    if (census.threads === 0) return null;
    // The workers are already on their way out - they poll the port between 10 s
    // share calls. Nothing to do but report it, so RAM that looks busy for one
    // more rescan is not mistaken for a leak.
    log(
      `${indent}share OFF - ${census.threads}t still winding down, gone within 10s ` +
        `(${fmtRam(census.threads * ramPerThread)} returns to the pool)`,
    );
    return { fraction, threads: census.threads, launched: 0 };
  }

  const res = topUpShare(ns, pool, ramPerThread, fraction, census.threads, census.byHost);
  const total = census.threads + res.launched;
  const held = total * ramPerThread;
  // Union, not a sum: a host already sharing that then took more would be
  // counted twice, and the count would drift up every rescan.
  const hosts = new Set([...census.hostList, ...res.placements.map((p) => p.host)]).size;

  log(
    `${indent}share ${total}t on ${hosts} host(s) ` +
      `(${fmtRam(held)}, ${((held / pool.usableRam) * 100).toFixed(1)}% of pool)  ` +
      `worth x${bonusFor(total).toFixed(4)}` +
      (res.launched > 0 ? `  +${res.launched}t this rescan` : ""),
  );

  // Report the two failures SEPARATELY, with the numbers behind each. This line
  // has been wrong twice in the shotgun - once blaming a busy pool for a missing
  // file, once blaming a missing file on a fleet that demonstrably had it.
  if (total < res.want) {
    const some = (xs) => `${xs.slice(0, 3).join(", ")}${xs.length > 3 ? ", ..." : ""}`;
    log(`${indent}      short of ${res.want}t (asked for ${fraction * 100}% of the pool)`);

    if (res.noFile.length) {
      log(
        `${indent}      ${res.noFile.length} host(s) have no ${SHARE_WORKER}: ` +
          `${some(res.noFile)}. Run scripts/deploy.js.`,
      );
    }
    if (res.refused.length) {
      // fileExists says the script IS on these hosts, so this is not a deploy
      // problem and saying so would send the reader the wrong way again.
      const r = res.refused[0];
      log(
        `${indent}      ${res.refused.length} host(s) HAVE ${SHARE_WORKER} but refused the exec: ` +
          `${some(res.refused.map((x) => x.host))}`,
      );
      log(
        `${indent}      e.g. ${r.host}: asked ${r.threads}t x ${fmtRam(ramPerThread)} = ` +
          `${fmtRam(r.threads * ramPerThread)}, pool saw ${fmtRam(r.freeGb)} free`,
      );
    }
    if (!res.noFile.length && !res.refused.length) {
      log(`${indent}      every host is full; the next rescan retries`);
    }
  }

  return { fraction, threads: total, launched: res.launched };
}
