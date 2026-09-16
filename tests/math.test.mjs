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
  });
}

export const tests = {
  "mathAnalyze satisfies the interface": async () => {
    const { mathAnalyze } = await loadScripts();
    const ns = baseNs();
    const ready = await mathAnalyze.prepare(ns);
    assert(ready.ok, `prepare failed: ${ready.error}`);

    const snap = await mathAnalyze.snapshot(ns, HOST);
    assert(snap.maxMoney === 62.5e6, "maxMoney wrong");
    assert(snap.moneyOk === true, "moneyOk should be true at max money");
    assert(snap.secOk === true, "secOk should be true at min security");

    assert((await mathAnalyze.maxMoneyOfAll(ns, [HOST]))[HOST] === 62.5e6, "maxMoneyOfAll wrong");
    assertClose(mathAnalyze.hackFractionPerThread(snap), 0.0037, 1e-9, "hack fraction");
    assertClose(mathAnalyze.securityPerHackThread(snap), 0.002, 1e-9, "hack security");
    assertClose(mathAnalyze.securityPerGrowThread(snap), 0.004, 1e-9, "grow security");
    assertClose(mathAnalyze.securityPerWeakenThread(snap), 0.05, 1e-9, "weaken security");

    const t = mathAnalyze.growThreadsToRestore(snap, 50e6, 62.5e6, 5);
    assert(t > 0 && Number.isFinite(t), `grow threads should be positive, got ${t}`);

    const times = mathAnalyze.opTimes(snap);
    assert(times.weaken === 2000 && times.grow === 1600 && times.hack === 500, "op times wrong");
  },

  "mathAnalyze.prepare refuses when the constants cannot be measured": async () => {
    const { mathAnalyze } = await loadScripts();
    // ns.run returning 0 is what a full home looks like, and it is silent.
    const ns = makeNs({ servers: { [HOST]: { moneyMax: 1 } }, extra: { run: () => 0 } });
    const ready = await mathAnalyze.prepare(ns);
    assert(!ready.ok, "should refuse when the rpc could not run");
    assert(/security constants/i.test(ready.error), `error should name what failed, got: ${ready.error}`);
  },

  "mathAnalyze.prepare refuses a partial answer rather than propagating NaN": async () => {
    const { mathAnalyze } = await loadScripts();
    const ns = baseNs();
    // weakenAnalyze answering 0 is the shape a drifted or stubbed API gives.
    ns.weakenAnalyze = () => 0;
    const ready = await mathAnalyze.prepare(ns);
    assert(!ready.ok, "a zero constant must stop the manager at startup");
    assert(/unusable/i.test(ready.error), `error should say so, got: ${ready.error}`);
  },

  "mathFormulas satisfies the same interface": async () => {
    const { mathFormulas } = await loadScripts();
    const { withFormulas } = await import("./mockNs.mjs");
    const ns = withFormulas(baseNs());
    const ready = await mathFormulas.prepare(ns);
    assert(ready.ok, `prepare failed: ${ready.error}`);

    const snap = await mathFormulas.snapshot(ns, HOST);
    assert(snap.maxMoney === 62.5e6, "maxMoney wrong");
    assert(snap.moneyOk === true, "moneyOk should be true at max money");
    assert((await mathFormulas.maxMoneyOfAll(ns, [HOST]))[HOST] === 62.5e6, "maxMoneyOfAll wrong");
    assertClose(mathFormulas.hackFractionPerThread(snap), 0.0037, 1e-9, "hack fraction");
    assertClose(mathFormulas.securityPerWeakenThread(snap), 0.05, 1e-9, "weaken security");

    const times = mathFormulas.opTimes(snap);
    assert(times.weaken === 2000 && times.grow === 1600 && times.hack === 500, "op times wrong");
  },

  "mathFormulas.prepare fails without the program": async () => {
    const { mathFormulas } = await loadScripts();
    const { withFormulas } = await import("./mockNs.mjs");
    const ns = withFormulas(baseNs(), { owned: false });
    const ready = await mathFormulas.prepare(ns);
    assert(!ready.ok, "should refuse without Formulas.exe");
    assert(/manager\.js/.test(ready.error), `error should point at manager.js, got: ${ready.error}`);
  },

  // The divergence that justifies the whole feature. Asserting it stops anyone
  // later "fixing" the two implementations into a false equivalence.
  "formulas honours atSecurity; analyze cannot": async () => {
    const { mathFormulas, mathAnalyze } = await loadScripts();
    const { withFormulas } = await import("./mockNs.mjs");

    const nsF = withFormulas(baseNs({ moneyAvailable: 50e6 }));
    await mathFormulas.prepare(nsF);
    const snapF = await mathFormulas.snapshot(nsF, HOST);
    const atMin = mathFormulas.growThreadsToRestore(snapF, 50e6, 62.5e6, 5);
    const atHigh = mathFormulas.growThreadsToRestore(snapF, 50e6, 62.5e6, 25);
    assert(atHigh > atMin, `growth is worse at high security: ${atHigh} should exceed ${atMin}`);

    const nsA = baseNs({ moneyAvailable: 50e6 });
    await mathAnalyze.prepare(nsA);
    const snapA = await mathAnalyze.snapshot(nsA, HOST);
    const aMin = mathAnalyze.growThreadsToRestore(snapA, 50e6, 62.5e6, 5);
    const aHigh = mathAnalyze.growThreadsToRestore(snapA, 50e6, 62.5e6, 25);
    assertClose(aMin, aHigh, 1e-9, "analyze cannot honour atSecurity and must return the same");
  },
};
