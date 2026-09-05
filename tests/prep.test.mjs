import { loadScripts, assert } from "./harness.mjs";
import { makeNs, withFormulas } from "./mockNs.mjs";

const HOST = "joesguns";

/** A drifted target: 1.6% money, security 22.4 against a minimum of 5. */
function driftedNs() {
  return makeNs({
    hosts: { home: 256, p0: 512, p1: 512 },
    servers: {
      [HOST]: {
        moneyMax: 62.5e6, moneyAvailable: 1e6,
        minDifficulty: 5, hackDifficulty: 22.4,
        requiredHackingSkill: 1, growBase: 1.0018,
        hackPercentPerThread: 0.0037,
        hackTime: 60, growTime: 160, weakenTime: 200,
      },
    },
    files: {
      "/data/calib.json": JSON.stringify({
        weakenPerThread: 0.05, hackSecPerThread: 0.002, growSecPerThread: 0.004,
        written: Date.now(), hosts: {},
      }),
      "home:/scripts/hack.js": "x",
    },
  });
}

/** Apply a launched wave's effects, so prep actually converges. */
function wireExec(ns) {
  const s = ns._servers[HOST];
  ns.exec = (file, host, threads, target, delay, batch, port, land, op) => {
    ns._used[host] += threads * 1.75;
    setTimeout(() => {
      if (op === "G") {
        const rate = 1 + 0.0018 * (s.minDifficulty / s.hackDifficulty);
        s.moneyAvailable = Math.min(s.moneyMax, s.moneyAvailable * Math.pow(rate, threads));
        s.hackDifficulty += 0.004 * threads;
      } else {
        s.hackDifficulty = Math.max(s.minDifficulty, s.hackDifficulty - 0.05 * threads);
      }
      ns._used[host] -= threads * 1.75;
      ns.getPortHandle(1).write({ b: batch, op, t: threads, p: land, a: Date.now(), r: 1 });
    }, 1);
    return 1;
  };
  return ns;
}

export const tests = {
  // Regression: prepper once re-exported its tolerances without importing them,
  // so measure() threw ReferenceError. Static parsing cannot catch that - only
  // calling the function does. measure() now delegates to the injected math
  // module's snapshot(), so the math module (not a bare ns mock) is what
  // exercises the import/export in prepper.js.
  "prepper.measure resolves its tolerance constants": async () => {
    const { prepper, mathAnalyze } = await loadScripts();
    const ns = makeNs({
      servers: { x: { moneyMax: 100, moneyAvailable: 100, minDifficulty: 1, hackDifficulty: 1 } },
      files: {
        "/data/calib.json": JSON.stringify({
          weakenPerThread: 0.05, hackSecPerThread: 0.002, growSecPerThread: 0.004,
          written: Date.now(), hosts: {},
        }),
      },
    });
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");
    const m = prepper.measure(ns, "x", mathAnalyze);
    assert(m.moneyOk === true, "moneyOk should be true at max money");
    assert(m.secOk === true, "secOk should be true at min security");
  },

  "prep converges with mathAnalyze injected": async () => {
    const { prepper, mathAnalyze } = await loadScripts();
    const ns = wireExec(driftedNs());
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");

    const res = await prepper.prep(ns, HOST, { math: mathAnalyze, maxCycles: 60, log: () => {} });
    assert(res.ok, `prep failed: ${res.reason}`);
    const s = ns._servers[HOST];
    assert(s.moneyAvailable >= s.moneyMax * 0.999, "money not restored");
    assert(s.hackDifficulty <= s.minDifficulty + 0.01, "security not at minimum");
    assert(Object.values(ns._used).every((v) => Math.abs(v) < 1e-9), "RAM leaked");
  },

  "prep converges with mathFormulas injected": async () => {
    const { prepper, mathFormulas } = await loadScripts();
    const ns = wireExec(withFormulas(driftedNs()));
    assert(mathFormulas.prepare(ns).ok, "prepare failed");

    const res = await prepper.prep(ns, HOST, { math: mathFormulas, maxCycles: 60, log: () => {} });
    assert(res.ok, `prep failed: ${res.reason}`);
    const s = ns._servers[HOST];
    assert(s.moneyAvailable >= s.moneyMax * 0.999, "money not restored");
    assert(Object.values(ns._used).every((v) => Math.abs(v) < 1e-9), "RAM leaked");
  },

  "prepper never calls a math API directly": async () => {
    const { readScript } = await import("./harness.mjs");
    const src = readScript("prepper");
    for (const fn of ["growthAnalyze", "hackAnalyze", "weakenAnalyze",
                      "getServerMoneyAvailable", "getServerSecurityLevel",
                      "getWeakenTime", "getGrowTime"]) {
      assert(!new RegExp(String.raw`ns\.${fn}\(`).test(src),
        `prepper.js still calls ns.${fn} - it must come from the math module`);
    }
  },
};
