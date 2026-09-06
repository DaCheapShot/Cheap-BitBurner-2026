import { loadScripts, assert, assertClose } from "./harness.mjs";
import { makeNs } from "./mockNs.mjs";

/**
 * Plan-equivalence test (design spec verification item #3).
 *
 * tests/isolation.test.mjs proves the two math backends never load together in
 * the same script - a STRUCTURAL guarantee about imports. It says nothing about
 * whether managerCore's planner treats their OUTPUTS identically. This test
 * proves that half: two stub math objects that reach the same numeric answer by
 * different internal routes must still produce the exact same batch plan, and
 * planThreadsForHack must not be reading anything besides its own arguments to
 * get there.
 *
 * Fixed inputs shared by both stubs. Chosen so the true grow-thread value
 * (~23.45, see below) sits comfortably away from an integer boundary - the two
 * routes differ at the level of floating-point noise, and a boundary-adjacent
 * value could flip which side of Math.ceil they land on for reasons that have
 * nothing to do with the bug this test is meant to catch.
 */
const SNAP = Object.freeze({ maxMoney: 1_000_000, minSec: 5 });
const CONSTS = Object.freeze({ hackSec: 0.002, growSec: 0.004, weakenSec: 0.05 });
const HACK = 25;
const PER_THREAD = 0.02; // steal = 0.5 -> mult = maxMoney / (maxMoney * 0.5) = 2
const GROWTH_BASE = 1.03; // log(2)/log(1.03) ~= 23.45 grow threads before GROW_MARGIN

/**
 * Wrap a math stub in a Proxy that throws on any property access other than
 * growThreadsToRestore - the only method planThreadsForHack should ever touch
 * on its math argument. If a future edit made planThreadsForHack read anything
 * else off `math` (a cached field, a second method, ambient state smuggled
 * through the object), this throws immediately instead of silently passing.
 */
function guardedMath(growThreadsToRestore) {
  return new Proxy(
    { growThreadsToRestore },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        throw new Error(`planThreadsForHack read unexpected math.${String(prop)}`);
      },
    },
  );
}

// Route A: closed-form natural log, the shape mathAnalyze's cached growth base
// uses (t = log(mult) / log(base)).
const mathNaturalLog = () =>
  guardedMath((snap, from, to) => {
    const mult = to / Math.max(from, 1);
    return Math.log(mult) / Math.log(GROWTH_BASE);
  });

// Route B: the same real-valued answer, reached through log2 instead of log -
// a genuinely different function call sequence, standing in for two backends
// (*Analyze vs Formulas) computing the same quantity through different code.
const mathLog2 = () =>
  guardedMath((snap, from, to) => {
    const mult = to / Math.max(from, 1);
    return Math.log2(mult) / Math.log2(GROWTH_BASE);
  });


/**
 * A fat pool against one rich, already-prepped target.
 *
 * Deliberately RAM-rich: that is the condition under which the picker climbs to
 * the ceiling, because with batches capped and RAM to spare, more steal is the
 * only route to more money and nothing else prices the risk. This is the shape
 * of the live run that collapsed - 2708 of 7300 TB used, window allowing 1059
 * batches against a cap of 400.
 */
function stealNs() {
  return makeNs({
    hosts: { home: 1024, p0: 1 << 20, p1: 1 << 20 },
    hackingLevel: 5000,
    servers: {
      fat: {
        moneyMax: 17.68e9, moneyAvailable: 17.68e9,
        minDifficulty: 17, hackDifficulty: 17,
        requiredHackingSkill: 1, growBase: 1.0018,
        // 9.78e-4 per thread, the value measured on alpha-ent's collapsing cycle.
        hackPercentPerThread: 9.78e-4,
        hackTime: 60000, growTime: 160000, weakenTime: 200000,
      },
    },
    files: {
      "/data/calib.json": JSON.stringify({
        weakenPerThread: 0.05, hackSecPerThread: 0.002, growSecPerThread: 0.004,
        written: Date.now(), hosts: {},
      }),
      "/scripts/hack.js": "x",
    },
  });
}

export const tests = {
  "planThreadsForHack: two math backends agreeing numerically produce an identical plan": async () => {
    const { managerCore } = await loadScripts();

    const a = managerCore.planThreadsForHack(mathNaturalLog(), SNAP, HACK, PER_THREAD, CONSTS);
    const b = managerCore.planThreadsForHack(mathLog2(), SNAP, HACK, PER_THREAD, CONSTS);

    assert(!a.error && !b.error, `unexpected error: ${a.error ?? "-"} / ${b.error ?? "-"}`);

    // Every field of the plan, not just grow - a plan that differs anywhere is
    // not the "identical batch plan" the spec asks for.
    for (const field of ["hack", "weaken1", "grow", "weaken2", "perThread", "steal", "hackAmount"]) {
      assert(
        Object.is(a[field], b[field]),
        `plan.${field} differs between backends: ${a[field]} vs ${b[field]}`,
      );
    }

    // Sanity check the fixture actually exercises a nontrivial grow count,
    // rather than both routes vacuously agreeing on 0 or 1.
    assert(a.grow > 1, `fixture is not exercising real grow math: grow=${a.grow}`);
  },

  "planThreadsForHack touches nothing on its math argument but growThreadsToRestore": async () => {
    const { managerCore } = await loadScripts();
    // guardedMath's Proxy throws on any other property access, so a passing
    // run here is itself the proof; a stray math.hackFractionPerThread() or
    // similar inside planThreadsForHack would surface as a thrown error and
    // fail this test.
    const th = managerCore.planThreadsForHack(mathNaturalLog(), SNAP, HACK, PER_THREAD, CONSTS);
    assert(!th.error, `unexpected error: ${th.error}`);
    assert(Number.isFinite(th.grow) && th.grow > 0, "grow threads should be a positive number");
  },

  // --- steal ceiling ------------------------------------------------------

  // A measured volley at 98.28% steal drained a $17.68b target to $166.11k in
  // one window. The picker maximises money per batch, so with RAM plentiful and
  // the batch count capped it climbs to whatever ceiling exists.
  "the auto picker never exceeds MAX_STEAL_FRACTION": async () => {
    const { managerCore, mathAnalyze, config, ram: ramMod } = await loadScripts();
    const ns = stealNs();
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");

    const snap = mathAnalyze.snapshot(ns, "fat");
    const pool = ramMod.ServerPool.build(ns, { homeReserve: 0 });
    const perThread = mathAnalyze.hackFractionPerThread(snap);
    const consts = {
      hackSec: mathAnalyze.securityPerHackThread(snap),
      growSec: mathAnalyze.securityPerGrowThread(snap),
      weakenSec: mathAnalyze.securityPerWeakenThread(snap),
    };

    const pick = managerCore.chooseSteal(
      pool, { hack: 1.7, grow: 1.75, weaken: 1.75 }, mathAnalyze, snap, perThread, consts, 400,
    );
    assert(pick && pick.chosen, "the picker found nothing at all");
    assert(pick.chosen.steal <= config.MAX_STEAL_FRACTION,
      `picked ${(pick.chosen.steal * 100).toFixed(2)}% against a ${(config.MAX_STEAL_FRACTION * 100).toFixed(0)}% cap`);
    // The pool here is deliberately huge, so without a cap the picker would run
    // right up to the old bare 0.99 - if this ever passes trivially the fixture
    // has stopped exercising the ceiling.
    assert(pick.chosen.steal > 0.9,
      `the cap is no longer the binding constraint - picked only ${(pick.chosen.steal * 100).toFixed(2)}%`);
  },

  // The number the cap is chosen against. A batch that steals more than planned
  // has its grow sized for the smaller take, so it ends BELOW where it started
  // and compounds into the next batch. Solving
  //   (1 - actual) * GROW_MARGIN / (1 - planned) >= 1
  // gives the drift a volley survives, and it collapses as steal rises - which
  // is why the extreme end is where volleys die rather than merely underperform.
  "drift tolerance collapses as steal rises": async () => {
    const { config } = await loadScripts();
    const m = config.GROW_MARGIN;
    const tolerance = (s) => ((m - 1) / m) * ((1 - s) / s);

    // Derivation check: the closed form must agree with solving directly.
    for (const s of [0.2, 0.6, 0.8, 0.95]) {
      const maxActual = 1 - (1 - s) / m;
      assertClose(tolerance(s), maxActual / s - 1, 1e-12,
        `closed form disagrees with the direct solve at steal ${s}`);
    }

    assert(tolerance(0.95) < tolerance(0.8), "tolerance must shrink as steal rises");
    assert(tolerance(0.95) < 0.005,
      `95% steal should survive well under 0.5% drift, got ${(tolerance(0.95) * 100).toFixed(2)}%`);
    // The measured collapse: 98.28% planned had essentially no room at all.
    assert(tolerance(0.9828) < 0.001,
      `98.28% steal should have under 0.1% headroom, got ${(tolerance(0.9828) * 100).toFixed(3)}%`);
  },
};
