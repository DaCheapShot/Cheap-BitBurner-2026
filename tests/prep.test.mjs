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

/**
 * A network of four hackable targets plus one out of reach, all sitting at max
 * money with security drift.
 *
 * That is the weaken-only case, and it is the exact pathology this fan-out
 * exists for: planPrepWave asks for `excess / weakenPerThread` threads and not
 * one more, because weakening below minimum security does nothing. Every target
 * here wants (22.4 - 5) / 0.05 = 348 weaken threads - 609GB against a pool of
 * 8416GB - and the manager would otherwise sit out a whole weaken window at 7%
 * utilisation.
 *
 * Shaped so each fan-out rule has something to bite on:
 *   rich  - richest, so the primary. 200ms weaken window.
 *   mid   - second richest, and FASTER than the primary, so a valid extra.
 *   slow  - third, but a 900ms window. Must be skipped: every placement releases
 *           together, so waiting on it would stretch the primary's own cycle.
 *   poor  - poorest, still valid, so the fanout cap has something to exclude.
 *   toohigh - above hacking level, so it must never be ranked at all.
 */
function fleetNs(hosts = { home: 256, p0: 4096, p1: 4096 }) {
  const target = (moneyMax, weakenTime, requiredHackingSkill = 1) => ({
    moneyMax, moneyAvailable: moneyMax,
    minDifficulty: 5, hackDifficulty: 22.4,
    requiredHackingSkill, growBase: 1.0018, hackPercentPerThread: 0.0037,
    hackTime: weakenTime * 0.3, growTime: weakenTime * 0.8, weakenTime,
  });

  return wireFleet(makeNs({
    hosts,
    hackingLevel: 100,
    servers: {
      rich: target(90e6, 200),
      mid: target(70e6, 120),
      slow: target(50e6, 900),
      poor: target(20e6, 150),
      toohigh: target(900e6, 100, 5000),
    },
    files: {
      "/data/calib.json": JSON.stringify({
        weakenPerThread: 0.05, hackSecPerThread: 0.002, growSecPerThread: 0.004,
        written: Date.now(), hosts: {},
      }),
      // Bare key, so fileExists answers for every host: buildWorkerPool drops
      // any host without workers deployed, which would otherwise leave the pool
      // as home alone and there would be no leftovers to test.
      "/scripts/hack.js": "x",
    },
  }));
}

/**
 * Record every exec and give its RAM back on landing.
 *
 * Deliberately does NOT move the servers: these tests are about which waves get
 * launched and how the pool is divided, and a converging server would change the
 * answer between cycles.
 */
function wireFleet(ns) {
  ns._execs = [];
  ns.exec = (file, host, threads, target, delay, batch, port, land, op) => {
    ns._execs.push({ file, host, threads, target, batch, op });
    ns._used[host] += threads * 1.75;
    setTimeout(() => {
      ns._used[host] -= threads * 1.75;
      ns.getPortHandle(port).write({ b: batch, op, t: threads, p: land, a: Date.now(), r: 1 });
    }, 1);
    return 1;
  };
  return ns;
}

/** Run exactly one prepGroup cycle and hand back what it exec'd, in order. */
async function oneCycle(ns, prepper, math, opts) {
  await prepper.prepGroup(ns, "rich", {
    math, maxCycles: 1, log: () => {}, extras: () => prepper.rankTargets(ns, math), ...opts,
  });
  return ns._execs;
}

/** Distinct targets in exec order. */
const targetsIn = (execs) => [...new Set(execs.map((e) => e.target))];

const sumThreads = (execs, target) =>
  execs.filter((e) => e.target === target).reduce((n, e) => n + e.threads, 0);

export const tests = {
  // Regression: prepper once used a bare `export { X } from "./config.js"`, which
  // forwards names to importers without binding them locally - measure() then threw
  // ReferenceError. measure() no longer uses the constants directly, so this asserts
  // the re-export itself resolves: a bare re-export of a name prepper never imported
  // would surface here as undefined.
  "prepper re-exports its tolerance constants as real values": async () => {
    const { prepper } = await loadScripts();
    assert(typeof prepper.MONEY_TOLERANCE === "number",
      `MONEY_TOLERANCE should be a number, got ${typeof prepper.MONEY_TOLERANCE}`);
    assert(typeof prepper.SEC_TOLERANCE === "number",
      `SEC_TOLERANCE should be a number, got ${typeof prepper.SEC_TOLERANCE}`);
    assert(prepper.MONEY_TOLERANCE > 0 && prepper.MONEY_TOLERANCE <= 1,
      "MONEY_TOLERANCE should be a fraction");
  },

  // NOT a guard on the import/export binding above - measure() just forwards to
  // the injected math module's snapshot() and never touches MONEY_TOLERANCE or
  // SEC_TOLERANCE itself, so a broken re-export would not be caught here. This
  // only checks that measure() plumbs an ns/host/math triple through to a sane
  // moneyOk/secOk result.
  "prepper.measure delegates to the injected math module": async () => {
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

  // --- fan-out ------------------------------------------------------------

  "pickTarget is the head of rankTargets, so the two cannot disagree": async () => {
    const { prepper, mathAnalyze } = await loadScripts();
    const ns = fleetNs();
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");
    const ranked = prepper.rankTargets(ns, mathAnalyze);
    assert(ranked[0] === "rich", `richest should lead, got ${ranked.join(",")}`);
    assert(prepper.pickTarget(ns, mathAnalyze) === ranked[0], "pickTarget diverged from the ranking");
    // Ordering is by max money descending, and nothing above hacking level or
    // without money is listed at all.
    assert(ranked.join(",") === "rich,mid,slow,poor", `bad ranking: ${ranked.join(",")}`);
  },

  // The ordering guarantee: the primary is launched before any extra is even
  // planned, so an extra can never take RAM the primary wanted. Without it,
  // fanning out would slow down the one server the manager is blocked on.
  "the primary launches first and at full size, whatever the extras want": async () => {
    const { prepper, mathAnalyze } = await loadScripts();
    const ns = fleetNs();
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");

    const alone = await oneCycle(ns, prepper, mathAnalyze, { fanout: 0 });
    const withExtras = await oneCycle(fleetNs(), prepper, mathAnalyze, { fanout: 3 });

    assert(withExtras[0].target === "rich", `primary should exec first, got ${withExtras[0].target}`);
    const threadsAlone = sumThreads(alone, "rich");
    const threadsShared = sumThreads(withExtras, "rich");
    assert(threadsAlone === threadsShared,
      `primary got ${threadsShared}t alongside extras but ${threadsAlone}t alone`);
    assert(targetsIn(withExtras).length > 1, "no extras were prepped at all");
  },

  "extras stop at the fanout cap even with RAM to spare": async () => {
    const { prepper, mathAnalyze } = await loadScripts();
    const ns = fleetNs();
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");

    const execs = await oneCycle(ns, prepper, mathAnalyze, { fanout: 1 });
    const targets = targetsIn(execs);
    assert(targets.length === 2, `expected primary + 1 extra, got ${targets.join(",")}`);
    assert(targets[0] === "rich", "primary should still be first");
  },

  // Every placement releases together at the end of a cycle, so a wave with a
  // longer window would hold the cycle open past the primary's landing - making
  // prep of the target we are blocked on slower, which is the opposite of the point.
  "an extra whose weaken window outlasts the primary's is skipped": async () => {
    const { prepper, mathAnalyze } = await loadScripts();
    const ns = fleetNs();
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");

    const targets = targetsIn(await oneCycle(ns, prepper, mathAnalyze, { fanout: 3 }));
    assert(targets.includes("rich"), "primary missing");
    assert(!targets.includes("slow"),
      `slow has a 900ms weaken against the primary's 200ms and must be skipped, got ${targets.join(",")}`);
    assert(targets.includes("mid"), "mid is faster than the primary and should have been taken");
  },

  "extras stop early when the pool has nothing left": async () => {
    const { prepper, mathAnalyze } = await loadScripts();
    // 609GB seats exactly the primary's 348 weaken threads at 1.75GB each
    // and not one more, so there is genuinely nothing left for an extra.
    const ns = fleetNs({ home: 0, p0: 609 });
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");

    const targets = targetsIn(await oneCycle(ns, prepper, mathAnalyze, { fanout: 3 }));
    assert(targets.length === 1 && targets[0] === "rich",
      `a full pool should leave the primary alone, got ${targets.join(",")}`);
  },

  // Two drains on one port cannot coexist: port.read() REMOVES the message, so
  // the old per-wave loop destroyed any report it did not recognise. One loop
  // for all waves is what makes fan-out possible at all.
  "awaitWaves credits every wave from one drain and cross-counts nothing": async () => {
    const { prepper } = await loadScripts();
    const ns = makeNs({});
    const port = ns.getPortHandle(1);

    const waves = [
      { batch: "a-1", launched: 2 },
      { batch: "b-1", launched: 1 },
    ];
    port.write({ b: "b-1", op: "W1", t: 5, r: 0.25 });
    port.write({ b: "a-1", op: "G", t: 9, r: 1.4 });
    port.write({ b: "ghost-1", op: "W1", t: 1, r: 0.05 });  // nobody is waiting on this
    port.write({ b: "a-1", op: "W1", t: 3, r: 0.15 });

    const seen = await prepper.awaitWaves(ns, 1, waves, Date.now() + 200);
    assert(seen.get("a-1") === 2, `a-1 should see 2 reports, got ${seen.get("a-1")}`);
    assert(seen.get("b-1") === 1, `b-1 should see 1 report, got ${seen.get("b-1")}`);
    assert(!seen.has("ghost-1"), "an unknown batch must not appear in the result");
  },

  "a fanned-out cycle leaks no RAM": async () => {
    const { prepper, mathAnalyze } = await loadScripts();
    const ns = fleetNs();
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");
    await oneCycle(ns, prepper, mathAnalyze, { fanout: 3 });
    // wireFleet gives every worker back its RAM on landing, so anything left
    // pending is a placement the cycle failed to release.
    assert(Object.values(ns._used).every((v) => Math.abs(v) < 1e-9),
      `RAM leaked: ${JSON.stringify(ns._used)}`);
  },

  // --- a full pool is transient, not fatal --------------------------------

  // The case that forced this: boot swaps manager builds when Formulas.exe is
  // gained or lost, and the outgoing manager's volley keeps running. The
  // incoming manager planned against a pool full of those workers, found
  // nothing fit, and STOPPED - so boot restarted it a tick later into the same
  // wall, once a minute until the workers drained.
  "prep waits out a full pool instead of failing": async () => {
    const { prepper, mathAnalyze } = await loadScripts();
    const ns = fleetNs();
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");

    // Occupy every host, as a killed manager's batches in flight would.
    for (const h of Object.keys(ns._hosts)) ns._used[h] = ns._hosts[h];

    let waits = 0;
    const sleep = ns.sleep;
    ns.sleep = (ms) => {
      // Free the pool partway through, the way workers finishing would.
      if (++waits === 3) for (const h of Object.keys(ns._hosts)) ns._used[h] = 0;
      return sleep(ms);
    };

    const res = await prepper.prepGroup(ns, "rich", {
      math: mathAnalyze, maxCycles: 2, log: () => {}, poolWait: 30,
    });

    assert(waits >= 3, `should have waited for RAM, slept ${waits} time(s)`);
    assert(ns._execs.length > 0, "should have launched once the pool freed");
    assert(res.reason !== undefined && !/nothing fits/.test(res.reason),
      `should not report a full pool as failure, got: ${res.reason}`);
  },

  // Waiting cycles must not spend the prep budget, or a busy pool would fail the
  // prep by simply exhausting maxCycles - the same outcome by a slower route.
  "waiting for RAM does not consume the cycle budget": async () => {
    const { prepper, mathAnalyze } = await loadScripts();
    const ns = fleetNs();
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");
    for (const h of Object.keys(ns._hosts)) ns._used[h] = ns._hosts[h];

    let waits = 0;
    const sleep = ns.sleep;
    ns.sleep = (ms) => {
      if (++waits === 5) for (const h of Object.keys(ns._hosts)) ns._used[h] = 0;
      return sleep(ms);
    };

    // One cycle of budget, but five waits before any of it can be used.
    await prepper.prepGroup(ns, "rich", {
      math: mathAnalyze, maxCycles: 1, log: () => {}, poolWait: 30,
    });
    assert(ns._execs.length > 0,
      "the single cycle should have survived five waits and still launched");
  },

  // The wait is bounded: a pool that is empty rather than busy - no rooted
  // hosts, or workers never deployed - is a real failure worth surfacing.
  "the wait is bounded and still reports a genuinely empty pool": async () => {
    const { prepper, mathAnalyze } = await loadScripts();
    const ns = fleetNs();
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");
    for (const h of Object.keys(ns._hosts)) ns._used[h] = ns._hosts[h];

    const res = await prepper.prepGroup(ns, "rich", {
      math: mathAnalyze, maxCycles: 5, log: () => {}, poolWait: 3,
    });
    assert(res.ok === false, "an ever-full pool must eventually fail");
    assert(/nothing fits/.test(res.reason), `expected a nothing-fits reason, got: ${res.reason}`);
    assert(ns._execs.length === 0, "nothing should have been launched");
  },
};
