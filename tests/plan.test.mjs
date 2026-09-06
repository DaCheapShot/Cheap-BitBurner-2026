import { loadScripts, assert } from "./harness.mjs";

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
};
