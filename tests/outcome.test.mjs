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

  // --- restore rate -------------------------------------------------------

  // The false alarm this exists to kill. At steal 84.48% with a 60.8% hack
  // chance, a PERFECT volley averages 6.44^0.608 * 1^0.392 = x3.10, because
  // missed-hack batches sit at max money and their grow clamps to ~1.0. A live
  // run measured x3.55 - better than perfect - and was told grow was 45% short.
  "the grow mean cannot tell a perfect volley from a sick one": async () => {
    const { verify } = await loadScripts();
    const steal = 0.8448;
    const required = 1 / (1 - steal);

    // Every hacked batch restores fully; every missed one clamps at 1.0.
    const perfect = [];
    for (let i = 0; i < 1000; i++) {
      const hacked = i % 1000 < 608;
      perfect.push(
        hacked
          ? { hackHits: 1, growThreads: 100, growMult: required }
          : { hackHits: 0, growThreads: 100, growMult: 1.0 },
      );
    }

    const geo = Math.exp(
      perfect.reduce((n, o) => n + Math.log(o.growMult), 0) / perfect.length);
    assertClose(geo, Math.pow(required, 0.608), 1e-9,
      "a perfect volley's grow mean should be the clamped restore raised to the hack chance");
    assert(geo < 3.2, `a perfect volley already reads only x${geo.toFixed(2)}`);

    // The clamp-free reading calls the same volley what it is.
    const rs = verify.restoreStats(perfect, required);
    assert(rs.hacked === 608, `only hacked batches count, got ${rs.hacked}`);
    assert(rs.restored === 608, `all 608 restored, got ${rs.restored}`);
  },

  "restoreStats ignores batches whose hack missed": async () => {
    const { verify } = await loadScripts();
    const rs = verify.restoreStats([
      { hackHits: 0, growThreads: 50, growMult: 1.0 },
      { hackHits: 0, growThreads: 50, growMult: 1.0 },
      { hackHits: 2, growThreads: 50, growMult: 6.5 },
    ], 6.4437);
    assert(rs.hacked === 1, `a missed hack is not evidence either way, got ${rs.hacked}`);
    assert(rs.restored === 1, "the one hacked batch did restore");
  },

  "restoreStats catches grow genuinely falling short": async () => {
    const { verify } = await loadScripts();
    const required = 6.4437;
    const rs = verify.restoreStats([
      { hackHits: 1, growThreads: 50, growMult: 6.50 },
      { hackHits: 1, growThreads: 50, growMult: 3.20 },
      { hackHits: 1, growThreads: 50, growMult: 3.00 },
      { hackHits: 1, growThreads: 50, growMult: 2.80 },
    ], required);
    assert(rs.hacked === 4 && rs.restored === 1, `expected 1 of 4, got ${rs.restored} of ${rs.hacked}`);
    assertClose(rs.median, 3.10, 1e-9, "median should sit between the two middle values");
    assertClose(rs.worst, 2.80, 1e-9, "worst should be the smallest multiplier");
  },

  // A batch whose grow reports never arrived is unmeasurable, not a failure -
  // counting it as one would blame grow for a lost report.
  "restoreStats excludes batches with no grow report": async () => {
    const { verify } = await loadScripts();
    const rs = verify.restoreStats([
      { hackHits: 1, growThreads: 0, growMult: 1 },
      { hackHits: 1, growThreads: 40, growMult: 7 },
    ], 6.4437);
    assert(rs.hacked === 1, `a missing grow must not count, got ${rs.hacked}`);
  },

  "restoreStats reports nothing when no batch hacked": async () => {
    const { verify } = await loadScripts();
    const rs = verify.restoreStats([{ hackHits: 0, growThreads: 40, growMult: 1 }], 6.4437);
    assert(rs.hacked === 0 && rs.restored === 0, "no hacked batches means no evidence");
    assert(rs.median === 0 && rs.worst === 0, "and no median to report");
  },

  // --- ordering across batches --------------------------------------------

  // The blind spot. analyzeBatch judges ordering WITHIN a batch, which was
  // deliberate: the game lands whole batches late together and failing them for
  // a common offset is wrong. But the offset is only harmless while it is
  // COMMON. A live run showed 194.8ms of lateness spread against 400ms batch
  // spacing, with every batch passing batchOk and every hacked batch restoring
  // in full - while the target went from $499.68b to $2.71k.
  "crossBatchOrder catches a hack landing inside another batch's gap": async () => {
    const { verify } = await loadScripts();
    // Batch a hacks at 0 and grows at 200. Batch b's hack lands at 100 - inside
    // a's gap, so a's single grow answers two steals.
    const byBatch = new Map([
      ["a", [{ op: "H", a: 0 }, { op: "G", a: 200 }]],
      ["b", [{ op: "H", a: 100 }, { op: "G", a: 300 }]],
    ]);
    const x = verify.crossBatchOrder(byBatch);
    assert(x.batches === 2, `expected 2 batches, got ${x.batches}`);
    assert(x.collided === 1, `only batch a was intruded on, got ${x.collided}`);
    assert(x.intrusions === 1 && x.worst === 1, `expected one intrusion, got ${JSON.stringify(x)}`);
  },

  "properly spaced batches report clean": async () => {
    const { verify } = await loadScripts();
    // Batch spacing 400ms, grow one spacer after the hack: no overlap anywhere.
    const byBatch = new Map();
    for (let i = 0; i < 8; i++) {
      byBatch.set(`v-${i}`, [{ op: "H", a: i * 400 }, { op: "G", a: i * 400 + 200 }]);
    }
    const x = verify.crossBatchOrder(byBatch);
    assert(x.batches === 8, `expected 8 batches, got ${x.batches}`);
    assert(x.collided === 0, `nothing should collide, got ${JSON.stringify(x)}`);
  },

  // Differential lateness is the mechanism: a batch that lands late has its gap
  // straddle the next batch's hack even though both landed in order internally.
  "one late batch collides with the batches that overtake it": async () => {
    const { verify } = await loadScripts();
    const byBatch = new Map();
    for (let i = 0; i < 5; i++) {
      // Batch 1 is 500ms late; everything else is on time.
      const late = i === 1 ? 500 : 0;
      byBatch.set(`v-${i}`, [
        { op: "H", a: i * 400 + late },
        { op: "G", a: i * 400 + 200 + late },
      ]);
    }
    const x = verify.crossBatchOrder(byBatch);
    assert(x.collided > 0, "a 500ms slip across 400ms spacing must be caught");
  },

  // A split hack reports once per host. The earliest is when money actually
  // started leaving, so that is the one the gap is measured from.
  "a split hack is measured from its earliest landing": async () => {
    const { verify } = await loadScripts();
    const byBatch = new Map([
      ["a", [{ op: "H", a: 0 }, { op: "H", a: 40 }, { op: "G", a: 200 }]],
      ["b", [{ op: "H", a: 100 }, { op: "G", a: 300 }]],
    ]);
    const x = verify.crossBatchOrder(byBatch);
    assert(x.collided === 1, `expected batch a to be intruded on, got ${JSON.stringify(x)}`);
    // b's own hack at 100 must not be counted as intruding on itself.
    assert(x.intrusions === 1, `a batch cannot intrude on itself, got ${x.intrusions}`);
  },

  "a batch with no grow report is not judged": async () => {
    const { verify } = await loadScripts();
    const byBatch = new Map([["a", [{ op: "H", a: 0 }]]]);
    const x = verify.crossBatchOrder(byBatch);
    assert(x.batches === 0 && x.collided === 0,
      `an unmeasurable batch must not be judged, got ${JSON.stringify(x)}`);
  },
};
