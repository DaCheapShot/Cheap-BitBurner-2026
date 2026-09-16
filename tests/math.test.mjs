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
  "without Formulas, math takes the analyze path and satisfies the interface": async () => {
    const { math } = await loadScripts();
    const ns = baseNs();
    const ready = await math.prepare(ns);
    assert(ready.ok, `prepare failed: ${ready.error}`);

    const snap = await math.snapshot(ns, HOST);
    assert(snap.maxMoney === 62.5e6, "maxMoney wrong");
    assert(snap.moneyOk === true, "moneyOk should be true at max money");
    assert(snap.secOk === true, "secOk should be true at min security");

    assert((await math.maxMoneyOfAll(ns, [HOST]))[HOST] === 62.5e6, "maxMoneyOfAll wrong");
    assertClose(math.hackFractionPerThread(snap), 0.0037, 1e-9, "hack fraction");
    assertClose(math.securityPerHackThread(snap), 0.002, 1e-9, "hack security");
    assertClose(math.securityPerGrowThread(snap), 0.004, 1e-9, "grow security");
    assertClose(math.securityPerWeakenThread(snap), 0.05, 1e-9, "weaken security");

    const t = math.growThreadsToRestore(snap, 50e6, 62.5e6, 5);
    assert(t > 0 && Number.isFinite(t), `grow threads should be positive, got ${t}`);

    const times = math.opTimes(snap);
    assert(times.weaken === 2000 && times.grow === 1600 && times.hack === 500, "op times wrong");
  },

  "math.prepare refuses when the constants cannot be measured": async () => {
    const { math } = await loadScripts();
    // ns.run returning 0 is what a full home looks like, and it is silent.
    const ns = makeNs({ servers: { [HOST]: { moneyMax: 1 } }, extra: { run: () => 0 } });
    const ready = await math.prepare(ns);
    assert(!ready.ok, "should refuse when the rpc could not run");
    assert(/security constants/i.test(ready.error), `error should name what failed, got: ${ready.error}`);
  },

  "math.prepare refuses a partial answer rather than propagating NaN": async () => {
    const { math } = await loadScripts();
    const ns = baseNs();
    // weakenAnalyze answering 0 is the shape a drifted or stubbed API gives.
    ns.weakenAnalyze = () => 0;
    const ready = await math.prepare(ns);
    assert(!ready.ok, "a zero constant must stop the manager at startup");
    assert(/unusable/i.test(ready.error), `error should say so, got: ${ready.error}`);
  },

  "with Formulas, math takes the formulas path and satisfies the same interface": async () => {
    const { math } = await loadScripts();
    const { withFormulas } = await import("./mockNs.mjs");
    const ns = withFormulas(baseNs());
    const ready = await math.prepare(ns);
    assert(ready.ok, `prepare failed: ${ready.error}`);

    const snap = await math.snapshot(ns, HOST);
    assert(snap.maxMoney === 62.5e6, "maxMoney wrong");
    assert(snap.moneyOk === true, "moneyOk should be true at max money");
    assert((await math.maxMoneyOfAll(ns, [HOST]))[HOST] === 62.5e6, "maxMoneyOfAll wrong");
    assertClose(math.hackFractionPerThread(snap), 0.0037, 1e-9, "hack fraction");
    assertClose(math.securityPerWeakenThread(snap), 0.05, 1e-9, "weaken security");

    const times = math.opTimes(snap);
    assert(times.weaken === 2000 && times.grow === 1600 && times.hack === 500, "op times wrong");
  },

  // There is no longer a build to be on the wrong one of. Missing the program
  // is an ordinary fallback, not a refusal - which is what deleted
  // manager-formulas.js and boot's swap between the two files.
  "without the program, prepare falls back to analyze instead of refusing": async () => {
    const { math } = await loadScripts();
    const { withFormulas } = await import("./mockNs.mjs");
    const ns = withFormulas(baseNs(), { owned: false });
    const ready = await math.prepare(ns);
    assert(ready.ok, `should fall back, not refuse: ${ready.error}`);
    assert(math.backend() === "analyze", `expected the analyze path, got ${math.backend()}`);
  },

  // The flag has to reach the MATH now rather than pick a filename, so boot
  // forwards it to the one manager instead of choosing between two files.
  "--no-formulas forces analyze even when the program is owned": async () => {
    const { math } = await loadScripts();
    const { withFormulas } = await import("./mockNs.mjs");
    const ns = withFormulas(baseNs());
    ns.args = ["--no-formulas"];
    const ready = await math.prepare(ns);
    assert(ready.ok, `prepare failed: ${ready.error}`);
    assert(math.backend() === "analyze", `--no-formulas ignored, got ${math.backend()}`);
  },

  "with the program and no flag, prepare chooses formulas": async () => {
    const { math } = await loadScripts();
    const { withFormulas } = await import("./mockNs.mjs");
    const ready = await math.prepare(withFormulas(baseNs()));
    assert(ready.ok, `prepare failed: ${ready.error}`);
    assert(math.backend() === "formulas", `expected formulas, got ${math.backend()}`);
  },

  // The divergence that justifies keeping both paths. It is now a difference
  // between two MODES of one module rather than two files, which makes it
  // easier to "tidy away" by accident - so it is pinned with two separate
  // instances, loadScripts() being fresh per call.
  "formulas honours atSecurity; analyze cannot": async () => {
    const { math: mathF } = await loadScripts();
    const { math: mathA } = await loadScripts();
    const { withFormulas } = await import("./mockNs.mjs");

    const nsF = withFormulas(baseNs({ moneyAvailable: 50e6 }));
    await mathF.prepare(nsF);
    const snapF = await mathF.snapshot(nsF, HOST);
    const atMin = mathF.growThreadsToRestore(snapF, 50e6, 62.5e6, 5);
    const atHigh = mathF.growThreadsToRestore(snapF, 50e6, 62.5e6, 25);
    assert(atHigh > atMin, `growth is worse at high security: ${atHigh} should exceed ${atMin}`);

    const nsA = baseNs({ moneyAvailable: 50e6 });
    await mathA.prepare(nsA);
    const snapA = await mathA.snapshot(nsA, HOST);
    const aMin = mathA.growThreadsToRestore(snapA, 50e6, 62.5e6, 5);
    const aHigh = mathA.growThreadsToRestore(snapA, 50e6, 62.5e6, 25);
    assertClose(aMin, aHigh, 1e-9, "analyze cannot honour atSecurity and must return the same");
  },
};
