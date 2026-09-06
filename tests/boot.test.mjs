import { loadScripts, assert } from "./harness.mjs";

const TRANSIENT = ["scripts/root.js", "scripts/deploy.js", "scripts/calibrate.js"];

/**
 * Drive boot for a fixed number of ticks against a fake home.
 * Paths are stored WITHOUT a leading slash, exactly as the game does.
 */
async function runBoot({ args = [], files = {}, running = [], ticks = 3, hasFormulas = false }) {
  const { main } = (await loadScripts())["boot"];
  let procs = running.map((f, i) => ({ filename: f, pid: i + 1, args: [], threads: 1 }));
  let nextPid = procs.length + 1, tick = 0;
  const launched = [];
  const killed = [];
  const store = { ...files };
  if (hasFormulas) store["home:Formulas.exe"] = "x";

  const ns = {
    args, disableLog: () => {}, ui: { openTail: () => {} },
    print: () => {}, tprint: () => {},
    read: (f) => store[f] ?? "",
    write: (f, d) => { store[f] = d; },
    fileExists: (f, host = "home") => Boolean(store[`${host}:${f}`]),
    ps: () => procs.map((p) => ({ ...p })),
    kill: (pid) => { killed.push(procs.find((p) => p.pid === pid)?.filename); procs = procs.filter((p) => p.pid !== pid); return true; },
    run: (file, threads, ...a) => {
      const stored = file.replace(/^\/+/, "");
      launched.push(stored);
      procs.push({ filename: stored, pid: nextPid, life: 2, args: a, threads: 1 });
      return nextPid++;
    },
    sleep: async (ms) => {
      for (const p of procs) if (TRANSIENT.includes(p.filename)) p.life--;
      procs = procs.filter((p) => !TRANSIENT.includes(p.filename) || (p.life ?? 99) > 0);
      if (ms >= 1000) { tick++; if (tick >= ticks) throw new Error("STOP"); }
      await new Promise((r) => setTimeout(r, 1));
    },
  };

  try { await main(ns); } catch (e) { if (e.message !== "STOP") throw e; }
  return { launched, killed, procs, store };
}

const CALIB = JSON.stringify({
  weakenPerThread: 0.05, hackSecPerThread: 0.002, growSecPerThread: 0.004,
  written: Date.now(), hosts: {},
});

export const tests = {
  "without Formulas, boot launches the analyze manager": async () => {
    const r = await runBoot({ files: { "/data/calib.json": CALIB }, hasFormulas: false });
    assert(r.launched.includes("scripts/manager.js"), `expected manager.js, launched: ${r.launched}`);
    assert(!r.launched.includes("scripts/manager-formulas.js"), "should not launch the formulas build");
  },

  "with Formulas, boot launches the formulas manager and skips calibrate": async () => {
    const r = await runBoot({ files: {}, hasFormulas: true });
    assert(r.launched.includes("scripts/manager-formulas.js"), `expected manager-formulas.js, launched: ${r.launched}`);
    assert(!r.launched.includes("scripts/calibrate.js"),
      "calibrate.js feeds only mathAnalyze and must be skipped on the formulas build");
  },

  "buying Formulas swaps the running manager": async () => {
    const r = await runBoot({
      files: { "/data/calib.json": CALIB }, hasFormulas: true,
      running: ["scripts/manager.js"],
    });
    assert(r.killed.includes("scripts/manager.js"), `should kill the analyze manager, killed: ${r.killed}`);
    assert(r.launched.includes("scripts/manager-formulas.js"), "should start the formulas manager");
    const live = r.procs.filter((p) => p.filename.startsWith("scripts/manager"));
    assert(live.length === 1, `exactly one manager must run, found ${live.length}`);
  },

  "--no-formulas forces the analyze build": async () => {
    const r = await runBoot({
      args: ["--no-formulas"], files: { "/data/calib.json": CALIB }, hasFormulas: true,
    });
    assert(r.launched.includes("scripts/manager.js"), "should honour --no-formulas");
    assert(!r.launched.includes("scripts/manager-formulas.js"), "should not launch the formulas build");
  },

  "boot writes the formulas marker": async () => {
    const r = await runBoot({ files: {}, hasFormulas: true });
    assert(/^1/.test(r.store["/data/formulas.txt"] ?? ""),
      `marker should record ownership, got: ${r.store["/data/formulas.txt"]}`);
  },
};
