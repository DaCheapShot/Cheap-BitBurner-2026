import { loadScripts, assert } from "./harness.mjs";
import { makeNs, withFormulas } from "./mockNs.mjs";

/**
 * Execute a whole manager cycle.
 *
 * Every other test in this suite calls functions. Nothing ran `run()` end to
 * end, and that gap has now cost two runtime ReferenceErrors that `node --check`
 * cannot see:
 *
 *   - a call site updated without its import (`buildWorkerPool`)
 *   - a `const drift` in the verbose block shadowing the outer `drift` for the
 *     whole block, putting an earlier read of it in the temporal dead zone
 *
 * Both threw only when the code actually ran, both reached the live game, and
 * both were on the --verbose path - which is exactly the path a smoke test
 * exercises for free. A shadowing lint was tried first and rejected: matching on
 * indentation flags 14 benign redeclarations across scripts/ because it cannot
 * tell a nested block from a different function.
 *
 * This is deliberately a SMOKE test. It asserts the cycle completes and reports
 * the lines it is supposed to report - not that the numbers are right, which is
 * what every other test in this file's neighbours already covers.
 */

const TARGET = "rich";

/**
 * A prepped target and a pool big enough to seat a few batches, with workers
 * that apply their op to a simulated server and report like the real ones.
 */
function volleyNs({ formulas = false, share = null } = {}) {
  const ns = makeNs({
    args: ["--target", TARGET, "--once", "--verbose"],
    hosts: { home: 4096, p0: 8192, p1: 8192 },
    hackingLevel: 5000,
    servers: {
      [TARGET]: {
        moneyMax: 500e9, moneyAvailable: 500e9,
        minDifficulty: 32, hackDifficulty: 32,
        requiredHackingSkill: 1, growBase: 1.0018,
        hackPercentPerThread: 8e-4,
        // mockNs defaults, restated so the timing here is obvious: a 2000ms
        // weaken window over 400ms batch spacing seats a handful of batches.
        hackTime: 500, growTime: 1600, weakenTime: 2000,
      },
    },
    files: {
      "/data/calib.json": JSON.stringify({
        weakenPerThread: 0.05, hackSecPerThread: 0.002, growSecPerThread: 0.004,
        written: Date.now(), hosts: {},
      }),
      "/scripts/hack.js": "x",
      "/scripts/share.js": "ns.share()",
      ...(share === null ? {} : { "/data/share.txt": String(share) }),
    },
  });

  const srv = ns._servers[TARGET];
  const realExec = ns.exec;
  ns._log = [];

  ns.exec = (file, host, threads, target, delay, batch, port, planned, op) => {
    // Share workers are not batch ops: they apply nothing to the target, report
    // nothing, and - the part that matters here - never hand their RAM back.
    // Routing them through the batch path below would run them as a weaken.
    if (file.includes("share")) {
      ns._used[host] += threads * 1.75;
      return realExec(file, host, threads);
    }

    ns._used[host] += threads * 1.75;

    // Apply the op to the simulated server and report its real return value, so
    // the money, restore and drift readings downstream see coherent numbers
    // rather than placeholders.
    let r = 0;
    if (op === "H") {
      const took = Math.min(1, threads * srv.hackPercentPerThread) * srv.moneyAvailable;
      srv.moneyAvailable -= took;
      srv.hackDifficulty += 0.002 * threads;
      r = took;
    } else if (op === "G") {
      const before = Math.max(srv.moneyAvailable, 1);
      const rate = 1 + 0.0018 * (srv.minDifficulty / srv.hackDifficulty);
      srv.moneyAvailable = Math.min(srv.moneyMax, (before + threads) * Math.pow(rate, threads));
      srv.hackDifficulty += 0.004 * threads;
      r = srv.moneyAvailable / before;
    } else {
      const before = srv.hackDifficulty;
      srv.hackDifficulty = Math.max(srv.minDifficulty, before - 0.05 * threads);
      r = before - srv.hackDifficulty;
    }

    setTimeout(() => { ns._used[host] -= threads * 1.75; }, 1);
    // `a` is derived from the planned landing, not Date.now(): the real game
    // lands ops on schedule, and reporting wall-clock here would make every
    // batch look mistimed and skip the healthy path entirely.
    ns.getPortHandle(port).write({ b: batch, op, t: threads, p: planned, a: planned + 5, r });
    return 1;
  };

  return formulas ? withFormulas(ns) : ns;
}

const logOf = (ns) => ns._log.join("\n");

export const tests = {
  "a full manager cycle runs to completion on the analyze build": async () => {
    const { managerCore, mathAnalyze } = await loadScripts();
    const ns = volleyNs();
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");

    // Any ReferenceError, TDZ error or bad call site inside run() surfaces here
    // and nowhere else in this suite.
    await managerCore.run(ns, mathAnalyze);

    const log = logOf(ns);
    assert(/cycle\s+1/.test(log), `no cycle was reported:\n${log}`);
    assert(/landed \d+ ok/.test(log), `no landing summary:\n${log}`);
  },

  "the same cycle runs on the formulas build": async () => {
    const { managerCore, mathFormulas } = await loadScripts();
    const ns = volleyNs({ formulas: true });
    assert(mathFormulas.prepare(ns).ok, "prepare failed");

    await managerCore.run(ns, mathFormulas);
    assert(/landed \d+ ok/.test(logOf(ns)), "the formulas build produced no landing summary");
  },

  // The path both ReferenceErrors were on. Naming the lines individually means a
  // future one fails here with the line that broke, not a bare stack.
  "--verbose reports every diagnostic line": async () => {
    const { managerCore, mathAnalyze } = await loadScripts();
    const ns = volleyNs();
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");

    await managerCore.run(ns, mathAnalyze);

    const log = logOf(ns);
    for (const line of [
      "[v] plan:", "[v] state:", "[v] sec/thread:", "[v] exposure:",
      "[v] take:", "[v] drift:", "[v] money at hack:", "[v] cross-batch:",
      "[v] restore:", "[v] grow:", "[v] trend:", "[v] hack:", "[v] weaken:",
      "[v] money:",
    ]) {
      assert(log.includes(line), `--verbose never printed "${line}":\n${log}`);
    }
  },

  // The share top-up sits on this path, and its whole contract is that the RAM
  // it takes disappears from the volley by itself - no reserve mechanism, just
  // getServerUsedRam reading workers that are already running. Nothing short of
  // an executed cycle can show that actually happens.
  //
  // Measured on the volley POOL, not on its batch count. The batch count here is
  // capped by the weaken window rather than by RAM, so the manager absorbs a
  // smaller pool by lowering the steal fraction instead and the count does not
  // move - which is correct behaviour and a useless assertion.
  "share mode takes its slice out of the volley": async () => {
    const { managerCore, mathAnalyze } = await loadScripts();
    const poolIn = (log) => Number(/volley \d+ batches[\s\S]*?of ([\d.]+)TB/.exec(log)?.[1] ?? -1);

    const off = volleyNs();
    assert(mathAnalyze.prepare(off).ok, "prepare failed");
    await managerCore.run(off, mathAnalyze);
    const offLog = logOf(off);

    const on = volleyNs({ share: 0.25 });
    assert(mathAnalyze.prepare(on).ok, "prepare failed");
    await managerCore.run(on, mathAnalyze);
    const onLog = logOf(on);

    assert(!/share \d+t on/.test(offLog), `share is off but a share line was printed:
${offLog}`);
    assert(/share \d+t on \d+ host/.test(onLog), `share is on but nothing was launched:
${onLog}`);

    assert(poolIn(offLog) > 0 && poolIn(onLog) > 0, `no volley pool was reported:
${offLog}
${onLog}`);
    const taken = 1 - poolIn(onLog) / poolIn(offLog);
    assert(Math.abs(taken - 0.25) < 0.02,
      `share should have taken about 25% of the volley pool, took ${(taken * 100).toFixed(1)}% ` +
        `(${poolIn(onLog)}TB with share vs ${poolIn(offLog)}TB without)`);
  },

  "a cycle leaks no RAM": async () => {
    const { managerCore, mathAnalyze } = await loadScripts();
    const ns = volleyNs();
    assert(mathAnalyze.prepare(ns).ok, "prepare failed");

    await managerCore.run(ns, mathAnalyze);
    // Workers hand their RAM back on landing, so anything still held is a
    // reservation the cycle failed to release.
    assert(Object.values(ns._used).every((v) => v < 1e-6),
      `RAM leaked: ${JSON.stringify(ns._used)}`);
  },
};
