import { loadScripts, assert, assertClose } from "./harness.mjs";

/**
 * Reports as the workers actually write them: one per exec'd process, with r
 * carrying the op's own return value.
 */
const rep = (op, t, r) => ({ b: "v1c1-0", op, t, p: 1000, a: 1000, r });

export const tests = {
  "batchOutcome sums hack money but MULTIPLIES grow": async () => {
    const { verify } = await loadScripts();
    const o = verify.batchOutcome([
      rep("H", 10, 1000), rep("H", 10, 500),   // hack split across two hosts
      rep("W1", 2, 0.1),
      rep("G", 30, 1.2), rep("G", 20, 1.1),    // grow split across two hosts
      rep("W2", 4, 0.2),
    ]);
    assert(o.stolen === 1500, `hack money should sum, got ${o.stolen}`);
    // 1.2 * 1.1 = 1.32, NOT 2.3. Each grow scales whatever money is present when
    // it runs, so the batch's real multiplier is the product of the parts.
    assertClose(o.growMult, 1.32, 1e-9, "grow multipliers must multiply");
    assertClose(o.weakened, 0.3, 1e-9, "weaken security should sum");
    assert(o.hackThreads === 20 && o.growThreads === 50, "thread counts wrong");
    assert(o.missing === 0, "nothing should be missing");
  },

  "batchOutcome counts reports with no result as missing, not as zero": async () => {
    const { verify } = await loadScripts();
    const o = verify.batchOutcome([
      rep("H", 10, 1000),
      { b: "v1c1-0", op: "G", t: 30, p: 1000, a: 1000 },  // stale worker: no r
    ]);
    assert(o.missing === 1, `expected 1 missing, got ${o.missing}`);
    // Treating the stale grow as 0 would report a batch that grew by nothing.
    assert(o.growMult === 1, `growMult should be untouched by a missing report, got ${o.growMult}`);
    assert(o.stolen === 1000, "the measurable half should still be counted");
  },

  // The bug this whole measurement exists to catch: a volley whose grow falls a
  // few percent short drains its target geometrically, because every batch is
  // planned against max money and nothing feeds back until the volley ends.
  "a small per-batch grow shortfall compounds across a volley": async () => {
    const steal = 0.3274;
    const want = 1 / (1 - steal);        // 1.4868
    const got = 1.4336;                  // measured on the live 397-batch run
    const net = (1 - steal) * got;
    assert(net < 1, "shortfall should make each batch net-negative");
    const after397 = Math.pow(net, 397);
    assert(after397 < 1e-6,
      `397 batches at x${net.toFixed(5)} should leave under 1e-6 of max money, got ${after397}`);
    // And the margin the plan relied on was nowhere near enough to cover it.
    const headroom = Math.pow(want, 1.05) / want - 1;
    assert(headroom < (1 - got / want),
      "GROW_MARGIN 1.05 should be shown insufficient against the observed shortfall");
  },

  "batchOutcome measures hack success rate directly": async () => {
    const { verify } = await loadScripts();
    const o = verify.batchOutcome([
      rep("H", 10, 5000),   // hit
      rep("H", 10, 0),      // miss - hack has a success chance
      rep("H", 10, 3000),   // hit
      rep("G", 30, 1.5),
    ]);
    assert(o.hackTries === 3, `expected 3 tries, got ${o.hackTries}`);
    assert(o.hackHits === 2, `expected 2 hits, got ${o.hackHits}`);
    assert(o.stolen === 8000, "a missed hack contributes 0, not undefined");
  },

  // GROW_MARGIN must buy the SAME money headroom at every steal fraction.
  // Applied to the thread count it decayed toward nothing as steal fell, which
  // is why low-steal volleys drained the target while high-steal ones did not.
  "grow margin gives uniform headroom across steal fractions": async () => {
    const { config } = await loadScripts();
    const M = 1e9, margin = config.GROW_MARGIN;
    for (const steal of [0.10, 0.3274, 0.6931, 0.8227]) {
      const required = 1 / (1 - steal);
      const asked = M / ((M * (1 - steal)) / margin);   // what the manager now asks for
      const headroom = asked / required;
      assertClose(headroom, margin, 1e-9,
        `headroom at steal ${steal} should equal GROW_MARGIN`);
      // The old thread-multiplying form decayed badly at low steal.
      const oldHeadroom = Math.pow(required, 0.05);
      if (steal < 0.4) {
        assert(oldHeadroom < headroom,
          `the old form should be shown thinner at steal ${steal}`);
      }
    }
  },
};