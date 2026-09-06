import { loadScripts, assert, assertClose } from "./harness.mjs";
import { makeNs } from "./mockNs.mjs";

const HOST = "joesguns";

function baseNs(over = {}) {
  return makeNs({
    hosts: { home: 1024 },
    servers: {
      [HOST]: {
        moneyMax: 62.5e6, moneyAvailable: 62.5e6,
        minDifficulty: 5, hackDifficulty: 5,
        requiredHackingSkill: 1, growBase: 1.0018,
        hackPercentPerThread: 0.0037,
        hackTime: 500, growTime: 1600, weakenTime: 2000,
        ...over,
      },
    },
    files: {
      "/data/calib.json": JSON.stringify({
        weakenPerThread: 0.05, hackSecPerThread: 0.002, growSecPerThread: 0.004,
        written: Date.now(),
        hosts: { [HOST]: { growBase: 1.0018, minSec: 5, measuredAtSec: 5 } },
      }),
    },
  });
}

export const tests = {
  "mathAnalyze satisfies the interface": async () => {
    const { mathAnalyze } = await loadScripts();
    const ns = baseNs();
    const ready = mathAnalyze.prepare(ns);
    assert(ready.ok, `prepare failed: ${ready.error}`);

    const snap = mathAnalyze.snapshot(ns, HOST);
    assert(snap.maxMoney === 62.5e6, "maxMoney wrong");
    assert(snap.moneyOk === true, "moneyOk should be true at max money");
    assert(snap.secOk === true, "secOk should be true at min security");

    assert(mathAnalyze.maxMoneyOf(ns, HOST) === 62.5e6, "maxMoneyOf wrong");
    assertClose(mathAnalyze.hackFractionPerThread(snap), 0.0037, 1e-9, "hack fraction");
    assertClose(mathAnalyze.securityPerHackThread(snap), 0.002, 1e-9, "hack security");
    assertClose(mathAnalyze.securityPerGrowThread(snap), 0.004, 1e-9, "grow security");
    assertClose(mathAnalyze.securityPerWeakenThread(snap), 0.05, 1e-9, "weaken security");

    const t = mathAnalyze.growThreadsToRestore(snap, 50e6, 62.5e6, 5);
    assert(t > 0 && Number.isFinite(t), `grow threads should be positive, got ${t}`);

    const times = mathAnalyze.opTimes(snap);
    assert(times.weaken === 2000 && times.grow === 1600 && times.hack === 500, "op times wrong");
  },

  "mathAnalyze.prepare fails without a calibration cache": async () => {
    const { mathAnalyze } = await loadScripts();
    const ns = makeNs({ servers: { [HOST]: { moneyMax: 1 } }, files: {} });
    const ready = mathAnalyze.prepare(ns);
    assert(!ready.ok, "should refuse without /data/calib.json");
    assert(/calibrate/i.test(ready.error), `error should name calibrate.js, got: ${ready.error}`);
  },

  "mathFormulas satisfies the same interface": async () => {
    const { mathFormulas } = await loadScripts();
    const { withFormulas } = await import("./mockNs.mjs");
    const ns = withFormulas(baseNs());
    const ready = mathFormulas.prepare(ns);
    assert(ready.ok, `prepare failed: ${ready.error}`);

    const snap = mathFormulas.snapshot(ns, HOST);
    assert(snap.maxMoney === 62.5e6, "maxMoney wrong");
    assert(snap.moneyOk === true, "moneyOk should be true at max money");
    assert(mathFormulas.maxMoneyOf(ns, HOST) === 62.5e6, "maxMoneyOf wrong");
    assertClose(mathFormulas.hackFractionPerThread(snap), 0.0037, 1e-9, "hack fraction");
    assertClose(mathFormulas.securityPerWeakenThread(snap), 0.05, 1e-9, "weaken security");

    const times = mathFormulas.opTimes(snap);
    assert(times.weaken === 2000 && times.grow === 1600 && times.hack === 500, "op times wrong");
  },

  "mathFormulas.prepare fails without the program": async () => {
    const { mathFormulas } = await loadScripts();
    const { withFormulas } = await import("./mockNs.mjs");
    const ns = withFormulas(baseNs(), { owned: false });
    const ready = mathFormulas.prepare(ns);
    assert(!ready.ok, "should refuse without Formulas.exe");
    assert(/manager\.js/.test(ready.error), `error should point at manager.js, got: ${ready.error}`);
  },

  // The divergence that justifies the whole feature. Asserting it stops anyone
  // later "fixing" the two implementations into a false equivalence.
  "formulas honours atSecurity; analyze cannot": async () => {
    const { mathFormulas, mathAnalyze } = await loadScripts();
    const { withFormulas } = await import("./mockNs.mjs");

    const nsF = withFormulas(baseNs({ moneyAvailable: 50e6 }));
    mathFormulas.prepare(nsF);
    const snapF = mathFormulas.snapshot(nsF, HOST);
    const atMin = mathFormulas.growThreadsToRestore(snapF, 50e6, 62.5e6, 5);
    const atHigh = mathFormulas.growThreadsToRestore(snapF, 50e6, 62.5e6, 25);
    assert(atHigh > atMin, `growth is worse at high security: ${atHigh} should exceed ${atMin}`);

    const nsA = baseNs({ moneyAvailable: 50e6 });
    mathAnalyze.prepare(nsA);
    const snapA = mathAnalyze.snapshot(nsA, HOST);
    const aMin = mathAnalyze.growThreadsToRestore(snapA, 50e6, 62.5e6, 5);
    const aHigh = mathAnalyze.growThreadsToRestore(snapA, 50e6, 62.5e6, 25);
    assertClose(aMin, aHigh, 1e-9, "analyze cannot honour atSecurity and must return the same");
  },
};
