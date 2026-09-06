import { loadScripts, assert } from "./harness.mjs";

const TRANSIENT = ["scripts/root.js", "scripts/deploy.js", "scripts/calibrate.js"];

/**
 * Drive boot for a fixed number of ticks against a fake network.
 * Paths are stored WITHOUT a leading slash, exactly as the game does.
 *
 * ps() is host-aware here, unlike the shared mock in mockNs.mjs. It has to be:
 * killOrphanWorkers walks the network and kills by host, and a ps that returned
 * every process for every host would report the same worker once per host and
 * make the count meaningless.
 *
 * @param {string[]} running  scripts already alive on home
 * @param {object[]} workers  {filename, host, threads} already alive out on the
 *                            network, as a killed manager's batches would be
 */
async function runBoot({
  args = [], files = {}, running = [], workers = [], ticks = 3, hasFormulas = false,
}) {
  const { main } = (await loadScripts())["boot"];
  let procs = running.map((f, i) => ({ filename: f, host: "home", pid: i + 1, args: [], threads: 1 }));
  let nextPid = procs.length + 1;
  for (const w of workers) {
    procs.push({ filename: w.filename, host: w.host, pid: nextPid++, args: [], threads: w.threads ?? 1 });
  }

  const network = ["home", ...new Set(workers.map((w) => w.host))].filter((h) => h !== undefined);
  let tick = 0;
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
    scan: (h) => (h === "home" ? network.filter((x) => x !== "home") : []),
    ps: (host = "home") => procs.filter((p) => p.host === host).map((p) => ({ ...p })),
    kill: (pid) => { killed.push(procs.find((p) => p.pid === pid)?.filename); procs = procs.filter((p) => p.pid !== pid); return true; },
    run: (file, threads, ...a) => {
      const stored = file.replace(/^\/+/, "");
      launched.push(stored);
      procs.push({ filename: stored, host: "home", pid: nextPid, life: 2, args: a, threads: 1 });
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

/** A killed manager's batches, still running out on the network. */
const ORPHANS = [
  { filename: "scripts/hack.js", host: "p0", threads: 400 },
  { filename: "scripts/grow.js", host: "p0", threads: 900 },
  { filename: "scripts/weaken.js", host: "p1", threads: 200 },
];

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

  // A manager killed mid-volley leaves hundreds of batches running. They hold
  // the RAM the replacement needs - a live swap left 2.7TB reserved, and the new
  // manager could not prep its target - and they keep hacking and growing that
  // target on a plan nobody owns any more.
  "swapping managers kills the workers the old one left behind": async () => {
    const r = await runBoot({
      files: { "/data/calib.json": CALIB }, hasFormulas: true,
      running: ["scripts/manager.js"], workers: ORPHANS,
    });
    assert(r.killed.includes("scripts/manager.js"), "the analyze manager should be stopped");
    for (const w of ORPHANS) {
      assert(r.killed.includes(w.filename), `${w.filename} should have been killed, killed: ${r.killed}`);
    }
    assert(!r.procs.some((p) => p.filename.endsWith("hack.js")), "a worker survived the swap");
    assert(r.launched.includes("scripts/manager-formulas.js"), "the formulas manager should start");
  },

  // The dangerous mistake is killing workers whenever a manager is killed:
  // killDuplicates keeps a survivor whose own volley is in flight, and its
  // workers are indistinguishable from a dead manager's without reading batch
  // ids out of argv. Only a swap that leaves NO manager may clear the network.
  "deduplicating managers leaves the survivor's workers alone": async () => {
    const r = await runBoot({
      files: { "/data/calib.json": CALIB }, hasFormulas: false,
      running: ["scripts/manager.js", "scripts/manager.js"], workers: ORPHANS,
    });
    assert(r.killed.includes("scripts/manager.js"), "the duplicate should be killed");
    assert(r.procs.filter((p) => p.filename === "scripts/manager.js").length === 1,
      "exactly one manager should survive");
    for (const w of ORPHANS) {
      assert(!r.killed.includes(w.filename),
        `${w.filename} belongs to the surviving manager and must not be killed`);
    }
  },

  "a swap with nothing in flight kills nothing extra": async () => {
    const r = await runBoot({
      files: { "/data/calib.json": CALIB }, hasFormulas: true,
      running: ["scripts/manager.js"],
    });
    assert(r.killed.filter(Boolean).join(",") === "scripts/manager.js",
      `only the old manager should be killed, killed: ${r.killed}`);
  },
};
