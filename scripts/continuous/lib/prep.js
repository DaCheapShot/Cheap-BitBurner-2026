import { collect } from "scripts/continuous/lib/report";
import { isPrepped } from "scripts/continuous/lib/target";
import {
  CONT_REPORT_PORT,
  OP_FILL_ORDER,
  SPACER_MS,
  WORKER_FILES,
} from "scripts/continuous/config";

/**
 * Prep: grow a target to max money and weaken it to minimum security.
 *
 *   ns.exec   1.30
 *
 * plus whatever the pool, the reporter and the math backend already cost. An
 * unprepped target is never streamed - every piece of the batch thread math
 * assumes max money and minimum security, so streaming one is not "slightly
 * off", it is arithmetic against numbers that do not describe the server.
 *
 * ---------------------------------------------------------------------------
 * Waves are sized by NEED, not by capacity
 *
 * Growing past max money does nothing and weakening below minimum security does
 * nothing, so a wave asks for exactly the threads required and no more. One
 * target therefore cannot consume the pool: a server carrying 50 excess
 * security wants 50 / 0.05 = 1000 weaken threads, under 2 TB. That is what
 * makes prepping several targets at once safe rather than greedy.
 *
 * Unlike a batch, a prep wave has no partial-failure mode that loses money.
 * Grow and weaken can only move a server TOWARD prepped, so a wave that gets
 * half of what it asked for is simply slower, never harmful.
 */

/**
 * Reserve one wave's worth of grow and weaken.
 *
 * The order here is the whole subtlety. Grow is placed FIRST, then weaken is
 * sized from grow's RAW thread count - not from the effective count that was
 * asked for. Grow's money effect is core-weighted; its security cost is not
 * (processSingleServerGrowth fortifies by usedCycles, clamped to the call's own
 * thread count), so raw is the exact figure.
 *
 * Sizing off the effective count instead would over-weaken, not under-weaken -
 * coreBonus is always >= 1, so raw <= effective - and weaken clamps at minimum
 * security, so nothing would break. It would just spend up to 44% more weaken
 * RAM per wave on an 8-core host for no effect. Exactness here is an efficiency
 * argument, not a safety one; do not "harden" it by padding.
 *
 * When the pool cannot hold the full wave, grow shrinks and weaken is re-sized
 * against the smaller grow. Weaken is never the thing that shrinks: it is the
 * op that makes irreversible progress toward minimum security, and dropping it
 * to fit more grow would mean growing at a security level we chose not to fix.
 *
 * @returns {{grow, weaken, excessSec, growSec, growWanted} | null} null when
 *   not even a bare weaken fits - a full pool, which is transient.
 */
export function placePrepWave(pool, ram, math, snap) {
  const weakenPer = math.weakenPerThread();
  const bonus = math.coreBonusFor;
  const excessSec = Math.max(0, snap.sec - snap.minSec);

  // Grow is sized against the security prep is HEADING for, not the one the
  // server currently has. On the formulas backend that is a real question and
  // it answers it; the analyze backend ignores the argument and answers for
  // current security, which over-estimates. Over-supply is the safe direction.
  const growWanted = snap.moneyOk
    ? 0
    : math.growThreadsToRestore(snap, snap.money, snap.maxMoney, snap.minSec);

  const empty = { placements: [], rawThreads: 0, effective: 0 };
  let growEff = growWanted;

  // 0.7 per step reaches 1 thread from a million in about 40 attempts; 30 is
  // plenty for any realistic wave, and the loop is bounded so a pathological
  // pool cannot hang the manager.
  for (let attempt = 0; attempt < 30; attempt++) {
    const grow = growEff > 0
      ? pool.allocateEffective(ram.grow, growEff, bonus, { order: OP_FILL_ORDER.G })
      : empty;

    if (!grow) {
      if (growEff <= 1) { growEff = 0; continue; }
      growEff = Math.floor(growEff * 0.7);
      continue;
    }

    const growSec = grow.rawThreads * math.securityPerGrowThread();
    const weakenEff = Math.ceil((excessSec + growSec) / weakenPer);

    const weaken = weakenEff > 0
      ? pool.allocateEffective(ram.weaken, weakenEff, bonus, { order: OP_FILL_ORDER.W1 })
      : empty;

    if (!weaken) {
      pool.release(grow.placements);
      if (growEff > 0) {
        growEff = growEff <= 1 ? 0 : Math.floor(growEff * 0.7);
        continue;
      }
      // Grow is already gone and the pool still cannot cover the excess
      // security. Take what it CAN hold rather than nothing.
      //
      // "Sized by need" means never asking for more than is useful. It does not
      // mean refusing to do less: a partial weaken is strictly progress, it can
      // only move the target toward prepped, and there is no partial-failure
      // mode the way there is for a batch that hacks but fails to grow. Bailing
      // out here would have prep sit and wait for RAM on exactly the targets
      // that are furthest from ready.
      const affordable = Math.floor(pool.maxEffectiveThreadsFor(ram.weaken, bonus));
      if (affordable < 1) return null;

      const partial = pool.allocateEffective(ram.weaken, affordable, bonus, {
        order: OP_FILL_ORDER.W1,
      });
      if (!partial) return null;

      return { grow: empty, weaken: partial, excessSec, growSec: 0, growWanted, partial: true };
    }

    if (grow.rawThreads === 0 && weaken.rawThreads === 0) return null;

    return { grow, weaken, excessSec, growSec, growWanted, partial: false };
  }

  return null;
}

/**
 * Launch a placed wave. Grow lands one spacer before weaken.
 *
 * Both ops exec at the same instant and separate purely through additionalMsec.
 * Never sleep between them: a sleep-then-op recomputes its duration from the
 * security level at wake-up and lands somewhere else entirely.
 *
 * @returns {{batch, landAt, launched, expected, failed}}
 */
export function launchPrepWave(ns, snap, wave, batch, opts = {}) {
  const { times, port = CONT_REPORT_PORT, log = () => {}, pad = 500 } = opts;

  const W = times.weaken;
  const G = times.grow;

  const landWeaken = Date.now() + W + pad;
  const landGrow = landWeaken - SPACER_MS;

  const jobs = [
    { op: "G", worker: WORKER_FILES.grow, land: landGrow, opTime: G, placements: wave.grow.placements },
    { op: "W1", worker: WORKER_FILES.weaken, land: landWeaken, opTime: W, placements: wave.weaken.placements },
  ];

  let launched = 0;
  let expected = 0;
  const failed = [];

  for (const job of jobs) {
    for (const p of job.placements) {
      // Recomputed at THIS exec, not once per wave. A wave is many exec calls
      // spanning real wall time, and one delay computed up front is correct
      // only for the first worker out of the door.
      const delay = Math.max(0, job.land - Date.now() - job.opTime);

      const pid = ns.exec(
        job.worker, p.host, p.threads,
        snap.host, delay, batch, port, job.land, job.op, p.threads,
      );

      if (pid === 0) {
        // scp already succeeded for this host at startup, so this is a refusal,
        // not a missing file. Say which, with the numbers - a diagnostic that
        // names the wrong cause is worse than none, because it gets acted on.
        failed.push(p.host);
        log(
          `    exec REFUSED on ${p.host}: ${job.op} x${p.threads}t, ` +
            `${p.gb.toFixed(2)}GB the pool had already reserved there. ` +
            `The worker is present (startup scp'd it), so this is the host ` +
            `saying no - not a deploy problem.`,
        );
        continue;
      }
      launched++;
      expected++;
    }
  }

  return { batch, landAt: landWeaken, launched, expected, failed };
}

/**
 * Prep every target in `hosts` until all are prepped or the cycle budget runs
 * out.
 *
 * All targets share one pool and one drain loop. The single drain matters:
 * port.read() REMOVES the message, so two loops on one port silently destroy
 * each other's reports and every wave looks half-landed forever.
 *
 * @returns {Promise<{prepped: string[], pending: string[], cycles: number, reason: string}>}
 */
export async function prepTargets(ns, math, hosts, opts) {
  const {
    pool,
    ram,
    port = CONT_REPORT_PORT,
    maxCycles = 50,
    poolWaitCycles = 90,
    poolWaitMs = 10000,
    idPrefix = "prep",
    log = () => {},
    graceMs = 5000,
  } = opts;

  let cycles = 0;
  let waited = 0;

  while (cycles < maxCycles) {
    pool.refresh();

    const snaps = hosts.map((h) => math.snapshot(ns, h));
    const todo = snaps.filter((s) => !isPrepped(s));

    if (todo.length === 0) {
      return { prepped: hosts, pending: [], cycles, reason: "all prepped" };
    }

    // Place first, launch second, for every target - so a later target can only
    // ever take RAM that an earlier one did not want. Reversing this would let
    // the lowest-value target outbid the one the stream is waiting on.
    const waves = [];
    for (const snap of todo) {
      const wave = placePrepWave(pool, ram, math, snap);
      if (wave) waves.push({ snap, wave });
    }

    if (waves.length === 0) {
      // A full pool is TRANSIENT, not a failure. Returning an error here would
      // stop the manager and have the supervisor restart it into the same wall
      // a tick later. Waiting cycles deliberately do not spend maxCycles.
      waited++;
      if (waited > poolWaitCycles) {
        return {
          prepped: hosts.filter((h) => !todo.some((s) => s.host === h)),
          pending: todo.map((s) => s.host),
          cycles,
          reason: `pool stayed full for ${((poolWaitCycles * poolWaitMs) / 60000).toFixed(0)} minutes`,
        };
      }
      log(`  pool full, waiting (${waited}/${poolWaitCycles})`);
      await ns.sleep(poolWaitMs);
      continue;
    }

    waited = 0;
    cycles++;

    let expected = 0;
    let deadline = 0;
    for (const w of waves) {
      const batch = `${idPrefix}${cycles}:${w.snap.host}`;
      const times = math.opTimes(w.snap);
      const res = launchPrepWave(ns, w.snap, w.wave, batch, { port, log, math, times });
      expected += res.expected;
      deadline = Math.max(deadline, res.landAt);

      log(
        `  ${w.snap.host}: grow ${w.wave.grow.rawThreads}t ` +
          `(${w.wave.grow.effective.toFixed(0)} eff of ${w.wave.growWanted} wanted), ` +
          `weaken ${w.wave.weaken.rawThreads}t ` +
          `(-${w.wave.excessSec.toFixed(2)} excess, -${w.wave.growSec.toFixed(2)} from grow), ` +
          `${res.launched} workers` +
          // Worth naming: a run of partial waves means the pool cannot cover
          // even this target's excess security in one go, so prep will take
          // several waves that each look like they under-delivered.
          (w.wave.partial ? "   [PARTIAL - pool too small for the full excess]" : ""),
      );
    }

    // ONE drain for every wave in flight, matching on batch id.
    if (expected > 0) await collect(ns, port, expected, deadline + graceMs);

    // The game frees a worker's RAM when it exits; our ledger has to stop
    // counting it too. These were reserved, never committed, because prep
    // waits for its own landings - so release is the right verb here.
    for (const w of waves) {
      pool.release(w.wave.grow.placements);
      pool.release(w.wave.weaken.placements);
    }
  }

  const snaps = hosts.map((h) => math.snapshot(ns, h));
  return {
    prepped: snaps.filter(isPrepped).map((s) => s.host),
    pending: snaps.filter((s) => !isPrepped(s)).map((s) => s.host),
    cycles,
    reason: `hit maxCycles (${maxCycles})`,
  };
}
