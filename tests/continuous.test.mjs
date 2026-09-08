import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { assert, assertClose } from "./harness.mjs";
import { makeNs, withFormulas } from "./mockNs.mjs";

/**
 * Tests for the continuous (streaming) batcher in scripts/continuous/.
 *
 * This file carries its own loader instead of using harness.mjs's loadScripts().
 * That one reads scripts/ with a flat readdirSync and rewrites only
 * `from "./name.js"`, so it cannot see a subfolder and cannot rewrite the
 * absolute, extensionless import style this folder uses:
 *
 *     import { ServerPool } from "scripts/continuous/lib/server";
 *
 * Rewriting on a copy keeps the game files untouched and means the tests always
 * run against what is actually on disk, not a hand-maintained duplicate.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "scripts", "continuous");

/** Every .js under scripts/continuous, as paths relative to that folder. */
function sourceFiles(dir = SRC, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...sourceFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".js")) out.push(rel);
  }
  return out;
}

let loaded = null;

/**
 * Mirror scripts/continuous/ into a temp dir as .mjs so Node can import it.
 *
 * Cached: every test would otherwise re-copy and re-import the tree, and Node
 * caches modules by URL so a fresh temp dir per test would also defeat the
 * module-level core cache the tests need to reason about.
 *
 * @returns {{mods: Record<string, object>, files: string[], sources: Map<string, string>}}
 */
async function loadContinuous() {
  if (loaded) return loaded;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbcont-"));
  const files = sourceFiles();
  const sources = new Map();

  for (const rel of files) {
    const src = fs.readFileSync(path.join(SRC, rel), "utf8");
    sources.set(rel, src);

    const fromDir = path.posix.dirname(rel);
    const rewritten = src.replace(
      /from\s+"scripts\/continuous\/([\w\-/]+)"/g,
      (_match, target) => {
        let spec = path.posix.relative(fromDir === "." ? "" : fromDir, `${target}.mjs`);
        if (!spec.startsWith(".")) spec = `./${spec}`;
        return `from "${spec}"`;
      },
    );

    const dest = path.join(dir, rel.replace(/\.js$/, ".mjs"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, rewritten);
  }

  const mods = {};
  for (const rel of files) {
    const bare = rel.replace(/\.js$/, "");
    mods[bare] = await import(pathToFileURL(path.join(dir, bare + ".mjs")).href);
  }

  loaded = { mods, files, sources };
  return loaded;
}

// ------------------------------------------------------------------ mock ----

/**
 * The game's real core bonus, from src/Server/ServerHelpers.ts:
 *
 *     getCoreBonus(cores) = 1 + (cores - 1) / 16
 *     getWeakenEffect(threads, cores) = ServerWeakenAmount * threads * coreBonus * rate
 *
 * Reproduced here so the tests can check that the code DERIVES this rather than
 * containing it. tests/mockNs.mjs's weakenAnalyze ignores its cores argument -
 * correct for the shotgun, which never passes one, and useless here - so this
 * overrides it rather than changing a file the shotgun's tests depend on.
 */
const gameCoreBonus = (cores) => 1 + (cores - 1) / 16;

/**
 * Source with comments removed, for the tests that assert what a file may not
 * REACH. Without this they read the prose: config.js documents the folder's
 * import style by showing an import statement, and lib/server.js explains at
 * length why it refuses to call ns.getServer - both of which a naive grep
 * reports as the very thing being banned.
 *
 * Naive on purpose. It would mangle a "//" inside a string literal; no file in
 * this folder has one, and a checker with its own parser is a worse trade than
 * a checker that is obviously correct at a glance.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/**
 * makeNs plus the two things the cores path needs: a weakenAnalyze that honours
 * its cores argument, and a getServer that reports cpuCores.
 */
function makeCoreNs(hosts, cores = {}) {
  return makeNs({
    hosts,
    extra: {
      weakenAnalyze: (t, c = 1) => 0.05 * t * gameCoreBonus(c),
      getServer: (h) => ({ hostname: h, cpuCores: cores[h] ?? 1 }),
    },
  });
}

/** Build a pool over `hosts` with the cores read through lib/cores.js. */
async function makePool(hosts, cores = {}, opts = {}) {
  const { mods } = await loadContinuous();
  const { ServerPool } = mods["lib/server"];
  const { coreMap, resetCoreCache } = mods["lib/cores"];

  // The core cache is module-level and lives for the whole test run, so a test
  // that reuses a hostname with different cores would otherwise read the
  // previous test's answer.
  resetCoreCache();

  const ns = makeCoreNs(hosts, cores);
  const pool = ServerPool.build(ns, { cores: coreMap(ns, Object.keys(hosts)), ...opts });
  return { ns, pool, mods };
}

async function makeBonus(ns) {
  const { mods } = await loadContinuous();
  return mods["lib/cores"].makeCoreBonus((t, c) => ns.weakenAnalyze(t, c));
}

/**
 * An ns wired for the math backends.
 *
 * mockNs covers the shotgun's needs; these are the gaps for this folder:
 * weakenAnalyze must honour its cores argument, the two security-analyze
 * functions are not mocked at all, and getServer has to report cpuCores.
 * Overriding here rather than editing tests/mockNs.mjs keeps the shotgun's
 * 112 tests running against the mock they were written for.
 */
function mathNs({ hosts = { home: 4096 }, servers = {}, cores = {}, formulas = false } = {}) {
  const ns = makeNs({
    hosts,
    servers,
    files: formulas ? { "Formulas.exe": "x" } : {},
    extra: {
      weakenAnalyze: (t, c = 1) => 0.05 * t * gameCoreBonus(c),
      hackAnalyzeSecurity: (t) => 0.002 * t,
      growthAnalyzeSecurity: (t) => 0.004 * t,
      hackAnalyzeChance: (h) => servers[h]?.hackChance ?? 1,
    },
  });

  if (formulas) {
    withFormulas(ns);
    ns.formulas.hacking.weakenEffect = (t, c = 1) => 0.05 * t * gameCoreBonus(c);
    ns.formulas.hacking.hackChance = (s) => s.hackChance ?? 1;
  }

  // withFormulas installs its own getServer, so this must come after it. Cores
  // win over anything in the server fixture.
  ns.getServer = (h) => ({
    hostname: h,
    ...(servers[h] ?? {}),
    cpuCores: cores[h] ?? servers[h]?.cpuCores ?? 1,
  });

  return ns;
}

/** A prepared math backend plus a pool over the same ns. */
async function makeMath(which, opts = {}) {
  const { mods } = await loadContinuous();
  const { ServerPool } = mods["lib/server"];
  const { coreMap, resetCoreCache } = mods["lib/cores"];

  resetCoreCache();
  const ns = mathNs({ ...opts, formulas: which === "formulas" });
  const math = mods[which === "formulas" ? "lib/mathFormulas" : "lib/mathAnalyze"];

  const ready = math.prepare(ns);
  assert(ready.ok, `${which} backend failed to prepare: ${ready.error}`);

  const pool = ServerPool.build(ns, {
    cores: coreMap(ns, Object.keys(opts.hosts ?? { home: 4096 })),
  });

  return { ns, math, pool, mods, ram: { hack: 1.7, grow: 1.75, weaken: 1.75 } };
}

/**
 * A stream over a big single-core pool against a prepped target, with exec
 * recorded rather than run.
 *
 * The default fixture is deliberately prepped and roomy: most stream tests are
 * about ORDER and accounting, and a fixture that fails to place would pass them
 * for the wrong reason.
 */
async function makeStream(over = {}) {
  const fixture = {
    hosts: { home: 262144 },
    servers: {
      t: {
        moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
        hackPercentPerThread: 0.003, growBase: 1.0018,
        weakenTime: 20000, growTime: 16000, hackTime: 5000,
      },
    },
    ...over,
  };

  const { ns, math, pool, mods, ram } = await makeMath("analyze", fixture);
  const calls = [];
  ns.exec = (file, host, threads, ...args) => {
    calls.push({ file, host, threads, args });
    return calls.length; // a non-zero pid
  };

  // Steal is pinned rather than left to the config default. These fixtures are
  // sized around a specific batch shape, and a test that silently tracks a
  // tuning constant starts failing the day someone tunes it - which is exactly
  // what happened when the default moved from 10% to the ceiling.
  const s = mods["lib/stream"].createStream(ns, math, {
    host: "t", pool, ram, log: () => {}, steal: over.steal ?? 0.1,
  });
  return { s, ns, pool, math, mods, ram, calls };
}

/** Every module an entry point can reach, transitively. */
function importClosure(entry, sources) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const src = stripComments(sources.get(`${cur}.js`) ?? "");
    for (const m of src.matchAll(/from\s+"scripts\/continuous\/([\w\-/]+)"/g)) {
      queue.push(m[1]);
    }
  }
  return seen;
}

// ----------------------------------------------------------------- tests ----

export const tests = {
  "every scripts/continuous import resolves to a file that exists": async () => {
    const { files, sources } = await loadContinuous();
    const have = new Set(files.map((f) => f.replace(/\.js$/, "")));

    for (const [rel, raw] of sources) {
      const src = stripComments(raw);
      for (const m of src.matchAll(/from\s+"scripts\/continuous\/([\w\-/]+)"/g)) {
        assert(have.has(m[1]), `${rel} imports "${m[1]}" which does not exist in scripts/continuous/`);
      }
      // The absolute form is the folder's rule. A relative "./x.js" would still
      // run in game but would break this loader silently, and mixing the two
      // makes the worker deploy list harder to reason about.
      assert(
        !/from\s+"\.\.?\//.test(src),
        `${rel} uses a relative import - this folder uses "scripts/continuous/..." throughout`,
      );
    }
  },

  "config.js reaches no ns function, so importing it stays free": async () => {
    const { sources } = await loadContinuous();
    const src = stripComments(sources.get("config.js"));
    assert(!/\bns\./.test(src), "config.js must contain no ns calls - it is imported everywhere");
    assert(!/\bimport\b/.test(src), "config.js must import nothing");
  },

  "lib/server.js never reaches ns.getServer, which would cost it 2GB": async () => {
    const { sources } = await loadContinuous();
    const src = stripComments(sources.get("lib/server.js"));
    // getServer is the only source of cpuCores and costs 2GB - six times this
    // module's whole budget. Cores arrive as a plain map instead.
    assert(!/ns\.getServer\b/.test(src), "lib/server.js must not call ns.getServer");
    for (const fn of ["hackAnalyze", "growthAnalyze", "weakenAnalyze", "formulas"]) {
      assert(!new RegExp(`ns\\.${fn}`).test(src), `lib/server.js must not reach ns.${fn}`);
    }
  },

  "coreBonus is measured from weakenAnalyze, not hardcoded": async () => {
    const ns = makeCoreNs({ home: 64 });
    const coreBonus = await makeBonus(ns);

    for (const cores of [1, 2, 4, 8, 15]) {
      assertClose(
        coreBonus(cores),
        gameCoreBonus(cores),
        1e-9,
        `coreBonus(${cores}) disagrees with the game's 1 + (cores-1)/16`,
      );
    }
    // Below 1 core is not a thing; it must not produce a penalty multiplier.
    assert(coreBonus(0) === 1, "coreBonus(0) must fall back to 1, not scale work down");
  },

  "pool build carries cpuCores through, defaulting unknown hosts to 1": async () => {
    const { pool } = await makePool(
      { home: 1024, "big-core": 512, plain: 256 },
      { home: 8, "big-core": 15 },
    );

    assert(pool.get("home").cores === 8, "home cores not carried");
    assert(pool.get("big-core").cores === 15, "big-core cores not carried");
    // Defaulting to 1 under-states a host, so an op sized against it
    // over-provisions rather than falling short.
    assert(pool.get("plain").cores === 1, "unknown host must default to 1 core, got " + pool.get("plain").cores);
  },

  "allocate is all-or-nothing: an oversized request reserves nothing": async () => {
    const { pool } = await makePool({ home: 100, a: 50 });
    const before = pool.freeRam;

    const got = pool.allocate(10, 100); // 1000GB against 150GB of pool
    assert(got === null, "an unplaceable request must return null");
    assert(pool.freeRam === before, `failed allocate leaked RAM: ${before} -> ${pool.freeRam}`);
    assert(pool.pendingRam === 0, "failed allocate left a reservation behind");
  },

  "allocate never hands a host more threads than it can hold": async () => {
    const { pool } = await makePool({ home: 100, a: 50, b: 25 });
    const placements = pool.allocate(10, 17); // 170GB across 175GB of pool

    assert(placements !== null, "17 threads should place across the pool");
    for (const p of placements) {
      const s = pool.get(p.host);
      // freeRam is already net of this reservation, so add it back to compare.
      assert(
        p.threads * 10 <= s.maxRam - s.usedRam + 1e-9,
        `${p.host} was given ${p.threads}t (${p.threads * 10}GB) but holds ${s.maxRam}GB`,
      );
    }
    assertClose(pool.pendingRam, 170, 1e-9, "pending should equal what was reserved");
  },

  "allocateEffective delivers at least the effective threads asked for": async () => {
    const { ns, pool } = await makePool(
      { home: 1024, mid: 512, plain: 256 },
      { home: 8, mid: 4 },
    );
    const coreBonus = await makeBonus(ns);

    for (const want of [1, 7, 50, 300]) {
      const got = pool.allocateEffective(1.75, want, coreBonus);
      assert(got !== null, `${want} effective threads should place`);
      // Rounding up per host means over-delivery, never under. Both boosted ops
      // clamp at the far end (moneyMax, minDifficulty), so surplus is free.
      assert(
        got.effective >= want - 1e-9,
        `asked ${want} effective, got ${got.effective.toFixed(3)} - UNDER-delivered`,
      );
      pool.release(got.placements);
    }
  },

  "allocateEffective spends fewer raw threads than a core-blind count would": async () => {
    const { ns, pool } = await makePool({ home: 4096 }, { home: 8 });
    const coreBonus = await makeBonus(ns);

    const want = 160;
    const got = pool.allocateEffective(1.75, want, coreBonus);

    assert(got !== null, "should place");
    // 8 cores is x1.4375, so 160 effective threads want ceil(160/1.4375) = 112 raw.
    assert(
      got.rawThreads < want,
      `core-aware placement used ${got.rawThreads} raw threads for ${want} effective - no saving`,
    );
    assertClose(got.rawThreads, Math.ceil(want / gameCoreBonus(8)), 0, "raw thread count is off");
  },

  "allocateEffective is all-or-nothing too": async () => {
    const { ns, pool } = await makePool({ home: 100 }, { home: 8 });
    const coreBonus = await makeBonus(ns);
    const before = pool.freeRam;

    const got = pool.allocateEffective(1.75, 100000, coreBonus);
    assert(got === null, "an unplaceable effective request must return null");
    assert(pool.freeRam === before, "failed allocateEffective leaked RAM");
    assert(pool.pendingRam === 0, "failed allocateEffective left a reservation behind");
  },

  "hack fills away from the cored hosts that grow wants": async () => {
    const { pool } = await makePool(
      { big: 1024, small: 1024 },
      { big: 8, small: 1 },
    );

    // Both hosts hold the request comfortably, so only the fill order decides.
    const hack = pool.allocate(1.7, 10, { order: "coresAsc" });
    assert(hack[0].host === "small", `hack took the ${hack[0].host}, leaving cores unused`);

    const grow = pool.allocate(1.75, 10, { order: "coresDesc" });
    assert(grow[0].host === "big", `grow took the ${grow[0].host} instead of the cored host`);
  },

  "commit stops the pool double-counting a worker it just launched": async () => {
    const { ns, pool } = await makePool({ home: 100 });

    const placements = pool.allocate(10, 5); // 50GB of 100GB
    assertClose(pool.freeRam, 50, 1e-9, "free RAM after reserve");
    assertClose(pool.pendingRam, 50, 1e-9, "pending after reserve");

    // What exec does: the game now counts the worker itself.
    ns._used.home += 50;
    pool.commit(placements);

    // The whole point. Dropping `pending` WITHOUT re-reading usedRam would put
    // freeRam back to 100 and the next dispatch would place a second batch into
    // RAM the first one is already using - silently, until exec started
    // returning 0 across the fleet.
    assertClose(pool.freeRam, 50, 1e-9, "commit double-counted: free RAM jumped back up");
    assertClose(pool.pendingRam, 0, 1e-9, "commit should clear the reservation");

    // And the pool must still refuse to over-commit afterwards.
    assert(pool.allocate(10, 6) === null, "pool over-committed after a commit");
    assert(pool.allocate(10, 5) !== null, "pool under-reported free RAM after a commit");
  },

  "release returns the pool to exactly where it started": async () => {
    const { ns, pool } = await makePool({ home: 512, a: 256, b: 128 }, { home: 8 });
    const coreBonus = await makeBonus(ns);
    const before = pool.freeRam;

    const hack = pool.allocate(1.7, 20, { order: "coresAsc" });
    const grow = pool.allocateEffective(1.75, 90, coreBonus);
    assert(hack && grow, "setup should place");
    assert(pool.freeRam < before, "reservations should reduce free RAM");

    pool.release(hack);
    pool.release(grow.placements);
    assertClose(pool.freeRam, before, 1e-9, "release did not restore free RAM");
    assertClose(pool.pendingRam, 0, 1e-9, "release left pending behind");
  },

  "RAM_SAFETY_FRACTION withholds a slice of every host": async () => {
    const { pool } = await makePool({ home: 100, a: 100 }, {}, { safetyFraction: 0.9 });
    // The knob is 1.00 in config by default; this proves it is wired, so that
    // lowering it after a live run of exec-returned-0 actually does something.
    assertClose(pool.freeRam, 180, 1e-9, "safety fraction not applied to free RAM");
    assert(pool.get("home").threadsFor(10) === 9, "safety fraction not applied to thread counts");
  },

  // ------------------------------------------------------------- workers ----

  "the workers import nothing at all": async () => {
    const { sources } = await loadContinuous();
    for (const w of ["hack", "grow", "weaken"]) {
      const src = stripComments(sources.get(`${w}.js`));
      // A worker pays its RAM PER THREAD, so one import reaching one 1GB
      // analyze function would add that GB to every one of tens of thousands of
      // threads. And a missing import makes exec return a bare 0 - the same
      // value it returns when the script is absent - on every host but home.
      assert(!/\bimport\b/.test(src), `${w}.js must import nothing`);
    }
  },

  "each worker runs one op and writes the port exactly once": async () => {
    const { sources } = await loadContinuous();
    const ops = { hack: "hack", grow: "grow", weaken: "weaken" };

    for (const [file, op] of Object.entries(ops)) {
      const src = stripComments(sources.get(`${file}.js`));

      const awaits = [...src.matchAll(/await\s+ns\.(hack|grow|weaken)\(/g)].map((m) => m[1]);
      assert(awaits.length === 1, `${file}.js should await exactly one op, found ${awaits.length}`);
      assert(awaits[0] === op, `${file}.js awaits ns.${awaits[0]} - should be ns.${op}`);

      const writes = [...src.matchAll(/ns\.writePort\(/g)].length;
      // Never retried: a full port DISCARDS THE OLDEST entry, so a second write
      // evicts another worker's report rather than making room.
      assert(writes === 1, `${file}.js should write the port once, found ${writes}`);
    }
  },

  "no worker reads a file, because ns.read is host-local": async () => {
    const { sources } = await loadContinuous();
    for (const w of ["hack", "grow", "weaken"]) {
      const src = stripComments(sources.get(`${w}.js`));
      // ns.read resolves against the server the CALLING script runs on, so a
      // worker reading a file that exists only on home gets "" and acts on it.
      // Everything a worker needs arrives as an argument.
      assert(!/ns\.read\b/.test(src), `${w}.js must not call ns.read`);
      assert(/ns\.args/.test(src), `${w}.js should take its settings from ns.args`);
    }
  },

  // -------------------------------------------------------------- report ----

  "drain buckets reports by batch id and empties the port": async () => {
    const { mods } = await loadContinuous();
    const { drain } = mods["lib/report"];

    const ns = makeNs({ hosts: { home: 64 } });
    const port = ns.getPortHandle(3);
    port.write({ b: "a", op: "H", t: 1, p: 100, a: 105, r: 5 });
    port.write({ b: "b", op: "W1", t: 2, p: 200, a: 200, r: 0.1 });
    port.write({ b: "a", op: "G", t: 3, p: 300, a: 310, r: 1.5 });

    const byBatch = new Map();
    const got = drain(port, byBatch);

    assert(got === 3, `drain took ${got} messages, expected 3`);
    assert(port.empty(), "drain must leave the port empty");
    assert(byBatch.get("a").length === 2, "batch a should hold 2 reports");
    assert(byBatch.get("b").length === 1, "batch b should hold 1 report");
  },

  "drain skips NULL PORT DATA and other junk": async () => {
    const { mods } = await loadContinuous();
    const { drain } = mods["lib/report"];

    const ns = makeNs({ hosts: { home: 64 } });
    const port = ns.getPortHandle(3);
    port.write("NULL PORT DATA");
    port.write(42);
    port.write({ b: "a", op: "H", t: 1, p: 1, a: 2, r: 0 });

    const byBatch = new Map();
    const got = drain(port, byBatch);

    assert(got === 1, `drain credited ${got} messages, expected 1 real one`);
    assert(byBatch.size === 1 && byBatch.has("a"), "only the real report should be bucketed");
  },

  "collect notices the port filling, because a full port drops the OLDEST": async () => {
    const { mods } = await loadContinuous();
    const { collect } = mods["lib/report"];
    const { PORT_CAPACITY } = mods["config"];

    const ns = makeNs({ hosts: { home: 64 } });
    const port = ns.getPortHandle(3);
    for (let i = 0; i < PORT_CAPACITY; i++) {
      port.write({ b: "a", op: "H", t: 1, p: i, a: i, r: 0 });
    }
    assert(port.full(), "mock port should be full at capacity");

    // Overflow does not merely delay reports - it destroys the EARLIEST
    // landings of a batch, which is exactly the data an order check needs. So
    // it has to be surfaced rather than shrugged off as a short read.
    const res = await collect(ns, 3, PORT_CAPACITY, Date.now() + 200);
    assert(res.sawFull, "collect must report that the port hit capacity");
    assert(res.got === PORT_CAPACITY, `collect got ${res.got}, expected ${PORT_CAPACITY}`);
  },

  "collect gives up at the deadline instead of hanging": async () => {
    const { mods } = await loadContinuous();
    const { collect } = mods["lib/report"];

    const ns = makeNs({ hosts: { home: 64 } });
    ns.getPortHandle(3).write({ b: "a", op: "H", t: 1, p: 1, a: 2, r: 0 });

    const res = await collect(ns, 3, 5, Date.now() + 120); // 5 expected, 1 sent
    assert(res.got === 1, `collect got ${res.got}, expected the 1 that arrived`);
  },

  "jitter is the spread of drift, not the lateness": async () => {
    const { mods } = await loadContinuous();
    const { analyzeLandings } = mods["lib/report"];

    // A whole batch landing 500ms late TOGETHER is benign - a common offset
    // cannot reorder anything. Reporting lateness as the error would condemn a
    // perfectly healthy stream and hide the case that actually matters.
    const late = analyzeLandings([
      { p: 1000, a: 1500 }, { p: 1100, a: 1600 }, { p: 1200, a: 1700 },
    ]);
    assertClose(late.lateness, 500, 1e-9, "mean drift");
    assertClose(late.jitter, 0, 1e-9, "a uniformly late batch has NO jitter");

    // Landing on time on average, but smeared - this is the dangerous one.
    const smeared = analyzeLandings([
      { p: 1000, a: 940 }, { p: 1100, a: 1100 }, { p: 1200, a: 1260 },
    ]);
    assertClose(smeared.lateness, 0, 1e-9, "mean drift should cancel");
    assertClose(smeared.jitter, 120, 1e-9, "jitter should catch the smear");
  },

  "analyzeBatch judges landing order by ACTUAL time, not planned": async () => {
    const { mods } = await loadContinuous();
    const { analyzeBatch } = mods["lib/report"];
    const ops = ["H", "W1", "G", "W2"];

    const good = analyzeBatch([
      { op: "H", p: 1000, a: 1000 },
      { op: "W1", p: 1100, a: 1100 },
      { op: "G", p: 1200, a: 1200 },
      { op: "W2", p: 1300, a: 1300 },
    ], ops, 100);
    assert(good.orderOk && good.ok, "an in-order batch should pass");

    // Planned order is perfect; the game landed grow before its weaken. Sorting
    // by plan would answer the question by assumption and call this healthy.
    const swapped = analyzeBatch([
      { op: "H", p: 1000, a: 1000 },
      { op: "W1", p: 1100, a: 1210 },
      { op: "G", p: 1200, a: 1190 },
      { op: "W2", p: 1300, a: 1300 },
    ], ops, 100);
    assert(!swapped.orderOk, "a batch that landed out of order must fail");
    assert(swapped.orderSeen.join(",") === "H,G,W1,W2", `saw ${swapped.orderSeen}`);
  },

  "an incomplete batch is never judged ok": async () => {
    const { mods } = await loadContinuous();
    const { analyzeBatch } = mods["lib/report"];

    // Three of four reports, in order. Without the completeness check this
    // reads as a clean batch, and a dropped W2 is exactly how security starts
    // ratcheting up unnoticed.
    const partial = analyzeBatch([
      { op: "H", p: 1000, a: 1000 },
      { op: "W1", p: 1100, a: 1100 },
      { op: "G", p: 1200, a: 1200 },
    ], ["H", "W1", "G", "W2"], 100);

    assert(!partial.complete, "3 of 4 reports is not complete");
    assert(!partial.ok, "an incomplete batch must not pass");
  },

  // -------------------------------------------------------------- deploy ----

  "deployWorkers copies to every host except home": async () => {
    const { mods } = await loadContinuous();
    const { deployWorkers } = mods["lib/deploy"];

    const seen = [];
    const ns = makeNs({
      hosts: { home: 64, a: 32, b: 32 },
      extra: { scp: (_files, dest) => { seen.push(dest); return true; } },
    });

    const res = deployWorkers(ns, ["home", "a", "b"]);
    assert(res.copied === 2, `copied ${res.copied}, expected 2`);
    assert(res.skipped === 1, "home should be skipped");
    // scp'ing home to itself reports failure and would poison the diagnostic
    // that distinguishes a missing source from a refusing host.
    assert(!seen.includes("home"), "home must not be an scp destination");
  },

  "a refusing host is reported without stopping the rest": async () => {
    const { mods } = await loadContinuous();
    const { deployWorkers } = mods["lib/deploy"];

    const ns = makeNs({
      hosts: { home: 64, a: 32, bad: 32, c: 32 },
      extra: { scp: (_f, dest) => dest !== "bad" },
    });

    const res = deployWorkers(ns, ["home", "a", "bad", "c"]);
    assert(res.copied === 2, `copied ${res.copied}, expected 2`);
    assert(res.failed.join() === "bad", `failed list was ${res.failed}`);
  },

  "when every host fails, the diagnostic blames the source not the hosts": async () => {
    const { mods } = await loadContinuous();
    const { deployWorkers, describeDeploy } = mods["lib/deploy"];

    const ns = makeNs({
      hosts: { home: 64, a: 32, b: 32 },
      extra: { scp: () => false },
    });

    const hosts = ["home", "a", "b"];
    const res = deployWorkers(ns, hosts);
    const text = describeDeploy(res, hosts.length);

    // scp returns false rather than throwing when the SOURCE file is missing,
    // so a total failure means the workers never reached home - the filesync
    // extension, not the network. Telling the user to check the hosts here is
    // the "diagnostic names the wrong cause" failure that gets acted on.
    assert(text.includes("filesync"), `total failure should name filesync, got:\n${text}`);
    assert(text.includes("SOURCE"), "total failure should point at the source");

    const partial = describeDeploy({ copied: 1, failed: ["b"], skipped: 1 }, 3);
    assert(!partial.includes("filesync"), "a partial failure must NOT blame filesync");
  },

  "a clean deploy says nothing": async () => {
    const { mods } = await loadContinuous();
    const { describeDeploy } = mods["lib/deploy"];
    assert(describeDeploy({ copied: 5, failed: [], skipped: 1 }, 6) === null, "silence on success");
  },

  // ---------------------------------------------------------- backends -----

  "no entry point can reach both math backends": async () => {
    const { sources } = await loadContinuous();

    // Bitburner charges for every ns function reachable through imports, so a
    // script touching both backends pays ~7GB for two complete sets of maths
    // and can use exactly one of them.
    for (const entry of ["manager", "manager-formulas", "core", "capacity"]) {
      const closure = importClosure(entry, sources);
      const both = closure.has("lib/mathAnalyze") && closure.has("lib/mathFormulas");
      assert(!both, `${entry}.js reaches BOTH math backends`);
    }

    // And each manager must actually reach its own, or the binding is broken.
    assert(importClosure("manager", sources).has("lib/mathAnalyze"), "manager.js lost mathAnalyze");
    assert(
      importClosure("manager-formulas", sources).has("lib/mathFormulas"),
      "manager-formulas.js lost mathFormulas",
    );
  },

  "core.js reaches no math backend of its own": async () => {
    const { sources } = await loadContinuous();
    const closure = importClosure("core", sources);
    // core.js takes `math` as an argument. If it ever imports one directly,
    // both entry points inherit it and the isolation above becomes untestable.
    assert(!closure.has("lib/mathAnalyze"), "core.js imported mathAnalyze");
    assert(!closure.has("lib/mathFormulas"), "core.js imported mathFormulas");
  },

  "both backends expose the same interface": async () => {
    const { mods } = await loadContinuous();
    const wanted = [
      "NAME", "prepare", "snapshot", "hackFractionPerThread", "hackChance",
      "securityPerHackThread", "securityPerGrowThread", "weakenPerThread",
      "coreBonusFor", "growThreadsToRestore", "opTimes",
    ];
    for (const name of wanted) {
      assert(name in mods["lib/mathAnalyze"], `mathAnalyze is missing ${name}`);
      assert(name in mods["lib/mathFormulas"], `mathFormulas is missing ${name}`);
    }
  },

  "formulas honours atSecurity for grow threads and analyze cannot": async () => {
    const fixture = {
      hosts: { home: 4096 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 5e8, minDifficulty: 5, hackDifficulty: 50, growBase: 1.0018 },
      },
    };

    const f = await makeMath("formulas", fixture);
    const fs = f.math.snapshot(f.ns, "t");
    const atMin = f.math.growThreadsToRestore(fs, fs.money, fs.maxMoney, fs.minSec);
    const atNow = f.math.growThreadsToRestore(fs, fs.money, fs.maxMoney, fs.sec);
    // Growth degrades as security rises, so the same restore costs more threads
    // at security 50 than at 5. The formulas backend can be asked; that matters
    // because what sets a grow's effect is the state when it FINISHES, and in a
    // batch a weaken has already pulled security down by then.
    assert(atNow > atMin, `formulas ignored atSecurity: ${atNow} vs ${atMin}`);

    const a = await makeMath("analyze", fixture);
    const as = a.math.snapshot(a.ns, "t");
    const aMin = a.math.growThreadsToRestore(as, as.money, as.maxMoney, as.minSec);
    const aNow = a.math.growThreadsToRestore(as, as.money, as.maxMoney, as.sec);
    // growthAnalyze reads security at call time and takes no hypothetical, so
    // this backend answers for the server as it stands whatever it is asked.
    // That asymmetry is deliberate - do not "fix" it into an equivalence.
    assert(aMin === aNow, `analyze pretended to honour atSecurity: ${aMin} vs ${aNow}`);
  },

  "a target already at max money needs no grow threads": async () => {
    const { math, ns } = await makeMath("analyze", {
      servers: { t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5 } },
    });
    const snap = math.snapshot(ns, "t");
    assert(snap.moneyOk && snap.secOk, "fixture should read as prepped");
    assert(math.growThreadsToRestore(snap, snap.money, snap.maxMoney, snap.minSec) === 0, "no grow needed");
  },

  // -------------------------------------------------------------- prep -----

  "a prep wave sizes weaken from grow's RAW threads, not its effective ones": async () => {
    const { math, pool, ram, ns } = await makeMath("analyze", {
      hosts: { home: 65536 },
      cores: { home: 8 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 5e8, minDifficulty: 5, hackDifficulty: 5, growBase: 1.0018 },
      },
    });
    const { placePrepWave } = (await loadContinuous()).mods["lib/prep"];

    const snap = math.snapshot(ns, "t");
    const wave = placePrepWave(pool, ram, math, snap);
    assert(wave, "the wave should place on a 64TB host");

    // 8 cores is x1.4375, so the raw thread count is well under the effective
    // one - and grow's security cost tracks RAW threads, because
    // processSingleServerGrowth fortifies by usedCycles clamped to the call's
    // own thread count.
    assert(wave.grow.rawThreads < wave.growWanted, "cores should have cut the raw thread count");
    assertClose(
      wave.growSec,
      wave.grow.rawThreads * math.securityPerGrowThread(),
      1e-9,
      "growSec must come from RAW grow threads",
    );

    // Sizing it off the effective count would over-weaken - safe, but ~44%
    // more weaken RAM than the grow can justify on this host.
    const ifEffective = Math.ceil(
      (wave.excessSec + wave.growWanted * math.securityPerGrowThread()) / math.weakenPerThread(),
    );
    const asPlaced = Math.ceil((wave.excessSec + wave.growSec) / math.weakenPerThread());
    assert(asPlaced < ifEffective, `raw sizing (${asPlaced}) should undercut effective (${ifEffective})`);
  },

  "a prep wave always cancels the security it will add": async () => {
    const { math, pool, ram, ns } = await makeMath("analyze", {
      hosts: { home: 65536, a: 8192 },
      cores: { home: 8, a: 4 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 2e8, minDifficulty: 5, hackDifficulty: 42, growBase: 1.0018 },
      },
    });
    const { placePrepWave } = (await loadContinuous()).mods["lib/prep"];

    const snap = math.snapshot(ns, "t");
    const wave = placePrepWave(pool, ram, math, snap);
    assert(wave, "the wave should place");

    // Weaken has to cover the excess security AND everything this wave's grow
    // is about to add, or prep converges slower than it dirties the target.
    const covered = wave.weaken.effective * math.weakenPerThread();
    assert(
      covered >= wave.excessSec + wave.growSec - 1e-9,
      `weaken covers ${covered.toFixed(3)} of ${(wave.excessSec + wave.growSec).toFixed(3)} needed`,
    );
    assertClose(wave.excessSec, 37, 1e-9, "excess security");
  },

  "under RAM pressure the wave shrinks grow, never weaken": async () => {
    const { math, pool, ram, ns } = await makeMath("analyze", {
      // Deliberately tiny: nowhere near enough for the full restore.
      hosts: { home: 256 },
      servers: {
        t: { moneyMax: 1e12, moneyAvailable: 1e6, minDifficulty: 5, hackDifficulty: 20, growBase: 1.0018 },
      },
    });
    const { placePrepWave } = (await loadContinuous()).mods["lib/prep"];

    const snap = math.snapshot(ns, "t");
    const wave = placePrepWave(pool, ram, math, snap);
    assert(wave, "a shrunken wave should still place");

    assert(wave.grow.effective < wave.growWanted, "grow should have been cut down");
    // Weaken is the op that makes irreversible progress toward minimum
    // security. Trading it away to fit more grow would mean growing at a
    // security level we chose not to fix.
    const covered = wave.weaken.effective * math.weakenPerThread();
    assert(
      covered >= wave.excessSec + wave.growSec - 1e-9 || wave.partial,
      "the shrunken wave still has to cancel its own security",
    );
  },

  "a pool too small even to clear the excess still weakens what it can": async () => {
    const { math, pool, ram, ns } = await makeMath("analyze", {
      // 256GB holds 146 weaken threads; clearing 15 excess security needs 300.
      hosts: { home: 256 },
      servers: {
        t: { moneyMax: 1e12, moneyAvailable: 1e6, minDifficulty: 5, hackDifficulty: 20, growBase: 1.0018 },
      },
    });
    const { placePrepWave } = (await loadContinuous()).mods["lib/prep"];

    const wave = placePrepWave(pool, ram, math, math.snapshot(ns, "t"));
    assert(wave, "a partial weaken should still be offered");

    // Sized by need means never asking for MORE than is useful; it does not
    // mean refusing to do less. Waiting for RAM here would stall prep on
    // exactly the targets furthest from ready, and a weaken has no
    // partial-failure mode - it can only move the target toward prepped.
    assert(wave.partial === true, "this wave should be flagged partial");
    assert(wave.grow.rawThreads === 0, "no grow while security is still uncovered");
    assert(wave.weaken.rawThreads > 0, "it should still place some weaken");
    const covered = wave.weaken.effective * math.weakenPerThread();
    assert(covered < wave.excessSec, "this fixture cannot cover the excess - that is the point");
    assert(covered > 0, "partial progress is still progress");
  },

  "a full pool yields no wave and leaves no reservation behind": async () => {
    const { math, pool, ram, ns } = await makeMath("analyze", {
      hosts: { home: 1 }, // less than one worker thread
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e6, minDifficulty: 5, hackDifficulty: 40, growBase: 1.0018 },
      },
    });
    const { placePrepWave } = (await loadContinuous()).mods["lib/prep"];

    const before = pool.freeRam;
    const wave = placePrepWave(pool, ram, math, math.snapshot(ns, "t"));

    assert(wave === null, "an unplaceable wave must return null");
    // A full pool is transient, not an error - but a failed attempt that leaked
    // reservations would make it permanent.
    assertClose(pool.pendingRam, 0, 1e-9, "failed wave leaked a reservation");
    assertClose(pool.freeRam, before, 1e-9, "failed wave leaked RAM");
  },

  "a target at max money but dirty gets weaken only": async () => {
    const { math, pool, ram, ns } = await makeMath("analyze", {
      hosts: { home: 4096 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 30, growBase: 1.0018 },
      },
    });
    const { placePrepWave } = (await loadContinuous()).mods["lib/prep"];

    const wave = placePrepWave(pool, ram, math, math.snapshot(ns, "t"));
    assert(wave, "a weaken-only wave should place");
    // Growing past max money does nothing, so asking for it would be pure
    // waste - this is what "sized by need, not capacity" means in practice.
    assert(wave.growWanted === 0 && wave.grow.rawThreads === 0, "no grow on a money-full target");
    assertClose(wave.weaken.effective * math.weakenPerThread(), 25, 0.05, "weaken sized to the excess");
  },

  "grow lands exactly one spacer before its weaken": async () => {
    const { math, pool, ram, ns, mods } = await makeMath("analyze", {
      hosts: { home: 65536 },
      servers: {
        t: {
          moneyMax: 1e9, moneyAvailable: 5e8, minDifficulty: 5, hackDifficulty: 20,
          growBase: 1.0018, weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
      },
    });
    const { placePrepWave, launchPrepWave } = mods["lib/prep"];
    const { SPACER_MS } = mods["config"];

    const calls = [];
    ns.exec = (file, host, threads, ...args) => {
      calls.push({ file, host, threads, args });
      return calls.length; // a non-zero pid
    };

    const snap = math.snapshot(ns, "t");
    const wave = placePrepWave(pool, ram, math, snap);
    const res = launchPrepWave(ns, snap, wave, "b1", { times: math.opTimes(snap) });

    assert(res.launched === calls.length && res.launched > 0, "every placement should exec");

    // args are [target, delay, batch, port, planned, op, threads]
    const planned = (op) => calls.filter((c) => c.args[5] === op).map((c) => Number(c.args[4]));
    const growLand = planned("G")[0];
    const weakenLand = planned("W1")[0];

    assertClose(weakenLand - growLand, SPACER_MS, 1e-9, "grow should land one spacer early");
    // Every op of a wave execs at the same instant; separation is additionalMsec
    // alone, because a sleep-then-op recomputes its duration at wake-up.
    for (const c of calls) {
      assert(Number(c.args[1]) >= 0, `negative additionalMsec for ${c.args[5]} on ${c.host}`);
    }
    // All grow workers share one landing time, likewise all weakens - a split
    // op is still one op.
    assert(new Set(planned("G")).size === 1, "grow placements disagree on their landing time");
    assert(new Set(planned("W1")).size === 1, "weaken placements disagree on their landing time");
  },

  "prepTargets hands every reservation back": async () => {
    const { math, pool, ram, ns, mods } = await makeMath("analyze", {
      hosts: { home: 65536 },
      servers: {
        // Static fixture: the mock server never actually grows, so prep can
        // never finish. That is the point - it forces the cycle budget path.
        t: {
          moneyMax: 1e9, moneyAvailable: 5e8, minDifficulty: 5, hackDifficulty: 20,
          growBase: 1.0018, weakenTime: 20, growTime: 16, hackTime: 5,
        },
      },
    });
    const { prepTargets } = mods["lib/prep"];

    const res = await prepTargets(ns, math, ["t"], { pool, ram, maxCycles: 2, log: () => {} });

    assert(res.cycles === 2, `expected 2 cycles, got ${res.cycles}`);
    assert(res.pending.includes("t"), "a target that never grows should stay pending");
    // Reservations are released after each wave lands. Leaking them would
    // shrink the pool a wave at a time until nothing places.
    assertClose(pool.pendingRam, 0, 1e-9, "prep leaked reservations");
  },

  // ------------------------------------------------------------ ranking ----

  "ranking discounts a target by its hack chance": async () => {
    const { mods } = await loadContinuous();
    const { rankTargets } = mods["lib/target"];
    const math = mods["lib/mathAnalyze"];

    const servers = {
      sure: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5, hackChance: 1.0, weakenTime: 20000 },
      dicey: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5, hackChance: 0.25, weakenTime: 20000 },
    };
    const ns = mathNs({ hosts: { home: 4096 }, servers });
    math.prepare(ns);

    const ranked = rankTargets(ns, math);
    assert(ranked[0].host === "sure", `ranked ${ranked.map((r) => r.host)} - chance was ignored`);
    // A failed hack takes nothing while its grow and weakens still run, so
    // chance is a straight multiplier on income, not a rounding detail.
    assertClose(ranked[0].perBatch / ranked[1].perBatch, 4, 1e-9, "chance should scale income 4x here");
  },

  "ranking prefers the target that earns more per unit of in-flight depth": async () => {
    const { mods } = await loadContinuous();
    const { rankTargets } = mods["lib/target"];
    const math = mods["lib/mathAnalyze"];

    const servers = {
      // Twice the money, but eight times the weaken time - so it needs roughly
      // eight times the batches in flight to keep its cadence fed. On a shared
      // pool that is the wrong first pick.
      slowrich: { moneyMax: 2e9, moneyAvailable: 2e9, minDifficulty: 5, hackDifficulty: 5, weakenTime: 160000 },
      quick: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5, weakenTime: 20000 },
    };
    const ns = mathNs({ hosts: { home: 4096 }, servers });
    math.prepare(ns);

    const ranked = rankTargets(ns, math);
    assert(ranked[0].host === "quick", `ranked ${ranked.map((r) => r.host)} on raw money, not per depth`);
    assert(ranked[0].depth < ranked[1].depth, "the quick target should need less depth");
  },

  // --------------------------------------------------------- plan (pure) ---

  "the first anchor is a full weaken plus the lead away": async () => {
    const { mods } = await loadContinuous();
    const { nextAnchor } = mods["lib/plan"];

    assertClose(nextAnchor(null, 1000, 20000, 400, 200), 21200, 1e-9, "first anchor");
  },

  "anchors march one cadence apart": async () => {
    const { mods } = await loadContinuous();
    const { nextAnchor } = mods["lib/plan"];

    let anchor = nextAnchor(null, 0, 20000, 400, 200);
    for (let i = 0; i < 10; i++) {
      const next = nextAnchor(anchor, 0, 20000, 400, 200);
      assertClose(next - anchor, 400, 1e-9, `batch ${i} is not one cadence on`);
      anchor = next;
    }
  },

  "an anchor never moves backwards when weaken time SHRINKS": async () => {
    const { mods } = await loadContinuous();
    const { nextAnchor } = mods["lib/plan"];

    // This is the streaming-specific hazard, and it is the reverse of the
    // shotgun's. As hacking level rises weakenTime falls, so a batch dispatched
    // LATER finishes SOONER - and can land its hack inside an older batch's
    // hack-to-grow gap, stealing money that batch's grow was never sized to
    // replace. Anchors must be monotonic whatever the op times do.
    let anchor = nextAnchor(null, 0, 60000, 400, 200);
    let now = 0;
    let weaken = 60000;

    for (let i = 0; i < 200; i++) {
      now += 400;
      weaken = Math.max(500, weaken * 0.97); // level climbing hard
      const next = nextAnchor(anchor, now, weaken, 400, 200);
      assert(next > anchor, `anchor went backwards at step ${i}: ${next} <= ${anchor}`);
      anchor = next;
    }
  },

  "hack threads round DOWN so the batch never over-steals": async () => {
    const { math, ns } = await makeMath("analyze", {
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018 },
      },
    });
    const { planThreads } = (await loadContinuous()).mods["lib/plan"];

    const snap = math.snapshot(ns, "t");
    const th = planThreads(math, snap, 0.10);

    // 0.10 / 0.003 = 33.33. Rounding UP would take 34 threads = 10.2%, and the
    // grow is sized for the PLANNED figure - so the batch would end a hair
    // below where it started, every time, and compound over hundreds of them.
    assert(th.hack === 33, `expected 33 hack threads, got ${th.hack}`);
    assert(th.actualSteal <= 0.10 + 1e-9, `actual steal ${th.actualSteal} exceeds the plan`);
  },

  "the grow margin is applied to money, never to the thread count": async () => {
    const { math, ns } = await makeMath("analyze", {
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018 },
      },
    });
    const { mods } = await loadContinuous();
    const { planThreads } = mods["lib/plan"];
    const { GROW_MARGIN } = mods["config"];

    const snap = math.snapshot(ns, "t");
    const th = planThreads(math, snap, 0.10);

    // Sizing grow as "restore from remaining/margin" gives the same headroom at
    // every steal fraction. Multiplying the THREAD count by the margin instead
    // raises the multiplier to a power - 9% of headroom at a x5.64 restore but
    // 0.5% at x1.11 - so it would evaporate exactly where a small steal needs
    // it. Check against the un-margined figure to prove which was done.
    const bare = math.growThreadsToRestore(
      snap, snap.maxMoney * (1 - th.actualSteal), snap.maxMoney, snap.minSec,
    );
    assert(th.grow > bare, "the margin did not widen the restore at all");
    assert(th.grow < Math.ceil(bare * GROW_MARGIN * 1.5), "the margin looks like it hit the threads");
  },

  "weaken-2 is sized from grow's raw threads": async () => {
    const { math } = await makeMath("analyze");
    const { weaken2For } = (await loadContinuous()).mods["lib/plan"];

    const raw = 100;
    const want = Math.ceil((raw * math.securityPerGrowThread()) / math.weakenPerThread());
    assert(weaken2For(math, raw) === want, "weaken2For disagrees with the security arithmetic");
    // Fewer raw threads means less security, means less weaken. Monotone.
    assert(weaken2For(math, 50) < weaken2For(math, 100), "weaken2 should scale with raw threads");
  },

  "an op that cannot reach its slot is refused, not launched late": async () => {
    const { mods } = await loadContinuous();
    const { delayFor, reachable } = mods["lib/plan"];

    // Comfortable: land in 5s, op takes 2s.
    assert(reachable(5000, 2000, 0), "should be reachable");
    assertClose(delayFor(5000, 2000, 0), 3000, 1e-9, "additionalMsec");

    // Impossible: land in 1s, op takes 2s. Launching anyway would put the op
    // somewhere in the sequence nobody chose.
    assert(!reachable(1000, 2000, 0), "should be unreachable");
    assertClose(delayFor(1000, 2000, 0), 0, 1e-9, "delay clamps at zero");
  },

  "a batch verdict counts a missed hack separately from a fault": async () => {
    const { mods } = await loadContinuous();
    const { batchVerdict } = mods["lib/plan"];

    const inOrder = (stolen) => [
      { op: "H", p: 1000, a: 1000, r: stolen },
      { op: "W1", p: 1100, a: 1100, r: 0.05 },
      { op: "G", p: 1200, a: 1200, r: 1.1 },
      { op: "W2", p: 1300, a: 1300, r: 0.05 },
    ];

    const hit = batchVerdict(inOrder(5e6), 100);
    assert(hit.ok && hit.hackHit && hit.stolen === 5e6, "a clean landing batch");

    // A hack that misses returns 0. That is hack chance showing up, not a
    // fault: the grow was sized for a hit, so the target ends ABOVE where it
    // started, which money clamping makes harmless.
    const miss = batchVerdict(inOrder(0), 100);
    assert(miss.ok, "a missed hack is still a well-formed batch");
    assert(!miss.hackHit && miss.stolen === 0, "a miss should not count as income");
  },

  "a split op reports once per placement and is still a clean batch": async () => {
    const { mods } = await loadContinuous();
    const { batchVerdict } = mods["lib/plan"];

    // Live run, phantasy: grow placed on two hosts, so the batch reported
    // [H, W1, G, G, W2] - five messages for four ops. Counting messages against
    // BATCH_OPS.length condemned it as incomplete, and three of those stopped a
    // stream that was landing at 15ms of jitter with the money restored.
    const split = batchVerdict([
      { op: "H", p: 1000, a: 1005, r: 6e7 },
      { op: "W1", p: 1100, a: 1105, r: 0.05 },
      { op: "G", p: 1200, a: 1205, r: 1.11 },
      { op: "G", p: 1200, a: 1206, r: 1.11 },
      { op: "W2", p: 1300, a: 1305, r: 0.05 },
    ], 100, 5);

    assert(split.complete, "a split batch is not incomplete");
    assert(split.orderOk, `order read as ${split.orderSeen.join(",")}`);
    assert(split.ok, "a split batch that landed correctly must pass");
    assert(split.orderSeen.length === 4, "ops should be grouped, not listed per worker");
  },

  "a split hack's take is summed across its workers": async () => {
    const { mods } = await loadContinuous();
    const { batchVerdict } = mods["lib/plan"];

    // Each split hack call takes its fraction of whatever is left when it
    // resolves, so the batch's take is the sum - reading one worker's return
    // value would under-count the income by however many ways it split.
    const v = batchVerdict([
      { op: "H", p: 1000, a: 1000, r: 3e6 },
      { op: "H", p: 1000, a: 1001, r: 2e6 },
      { op: "W1", p: 1100, a: 1100, r: 0.05 },
      { op: "G", p: 1200, a: 1200, r: 1.1 },
      { op: "W2", p: 1300, a: 1300, r: 0.05 },
    ], 100, 5);

    assert(v.stolen === 5e6, `expected 5e6 stolen, got ${v.stolen}`);
    assert(v.hackHit, "a split hack that took money is a hit");
  },

  "a batch missing one worker of a split op is not complete": async () => {
    const { mods } = await loadContinuous();
    const { batchVerdict } = mods["lib/plan"];

    // All four OPS are present, so an ops-only check would pass this. The exec
    // count is what says a worker went missing.
    const v = batchVerdict([
      { op: "H", p: 1000, a: 1000, r: 1e6 },
      { op: "W1", p: 1100, a: 1100, r: 0.05 },
      { op: "G", p: 1200, a: 1200, r: 1.1 },
      { op: "W2", p: 1300, a: 1300, r: 0.05 },
    ], 100, 5);

    assert(v.allOps, "all four ops did report");
    assert(!v.complete, "one of the two grow workers never reported");
    assert(!v.ok, "an incomplete batch must not pass");
  },

  "a genuinely out-of-order split batch still fails": async () => {
    const { mods } = await loadContinuous();
    const { batchVerdict } = mods["lib/plan"];

    // Grouping by op must not blur a real fault: here the earliest grow landed
    // before the weaken that was supposed to precede it.
    const v = batchVerdict([
      { op: "H", p: 1000, a: 1000, r: 1e6 },
      { op: "W1", p: 1100, a: 1190, r: 0.05 },
      { op: "G", p: 1200, a: 1150, r: 1.1 },
      { op: "G", p: 1200, a: 1210, r: 1.1 },
      { op: "W2", p: 1300, a: 1300, r: 0.05 },
    ], 500, 5);

    assert(!v.orderOk, `grouping hid a real reorder: ${v.orderSeen.join(",")}`);
    assert(v.orderSeen.join(",") === "H,G,W1,W2", `saw ${v.orderSeen.join(",")}`);
  },

  // ---------------------------------------------------------- baseline ----

  "a target mid-batch is on baseline, not drifted": async () => {
    const { mods } = await loadContinuous();
    const { baselineDrift } = mods["lib/plan"];

    // A streaming target is never at rest: money dips one batch's steal between
    // a hack landing and its grow, and security sits above minimum between a
    // hack and its weaken. The live run's gate demanded the prep-time
    // moneyOk/secOk and reported "unprepped" against a target holding steady.
    const th = { actualSteal: 0.10, hackSec: 0.13, growSec: 0.43 };
    const midBatch = {
      maxMoney: 1e9, money: 0.9e9,     // exactly one batch's steal low
      minSec: 7, sec: 7.5,             // one batch's uncancelled security high
    };

    const d = baselineDrift(midBatch, th, 3);
    assert(!d.off, `a mid-batch snapshot read as drifted: money ${d.moneyOff} sec ${d.secOff}`);
  },

  "the money floor still works at a high steal fraction": async () => {
    const { mods } = await loadContinuous();
    const { baselineDrift } = mods["lib/plan"];

    // The floor was `maxMoney * (1 - steal * slack)`, which at 95% steal and a
    // slack of 3 is NEGATIVE - so the drain detector silently passed everything
    // above roughly 33% steal, dead exactly where the stakes are highest. The
    // multiplicative form (1-steal)^2 is the real bound and never goes below 0.
    const th = { actualSteal: 0.95, hackSec: 0.5, growSec: 5 };
    const drained = { maxMoney: 1e9, money: 1e6, minSec: 5, sec: 5 };

    const d = baselineDrift(drained, th, 3);
    assert(d.moneyFloor > 0, `floor went to ${d.moneyFloor} - the check is dead`);
    assert(d.off && d.moneyOff, "a target at 0.1% of max must be caught at 95% steal");

    // And the legitimate dip at that fraction is still allowed: one batch just
    // took 95%, so 5% of max is exactly where a healthy target sits.
    const midBatch = { maxMoney: 1e9, money: 0.05e9, minSec: 5, sec: 5 };
    assert(!baselineDrift(midBatch, th, 3).off, "a legitimate 95% dip must pass");
  },

  "the money floor is tight at a low steal fraction": async () => {
    const { mods } = await loadContinuous();
    const { baselineDrift } = mods["lib/plan"];

    // Permissive at 95% is correct; permissive at 10% would not be. Two
    // overlapping batches leave 0.81 of the balance, so anything under that is
    // a real drift.
    const th = { actualSteal: 0.10, hackSec: 0.13, growSec: 0.43 };
    assert(!baselineDrift({ maxMoney: 1e9, money: 0.85e9, minSec: 5, sec: 5 }, th).off, "0.85 is fine");
    assert(baselineDrift({ maxMoney: 1e9, money: 0.70e9, minSec: 5, sec: 5 }, th).off, "0.70 is not");
  },

  "a target that really has drifted is caught": async () => {
    const { mods } = await loadContinuous();
    const { baselineDrift } = mods["lib/plan"];
    const th = { actualSteal: 0.10, hackSec: 0.13, growSec: 0.43 };

    // Drained well past what three batches in flight could explain.
    const drained = baselineDrift(
      { maxMoney: 1e9, money: 0.4e9, minSec: 7, sec: 7 }, th, 3,
    );
    assert(drained.off && drained.moneyOff, "a drained target must be caught");
    assert(drained.moneyShortfall > 0, "the shortfall should be reported for the log");

    // Security climbing is the other failure: weakens are not cancelling.
    const dirty = baselineDrift(
      { maxMoney: 1e9, money: 1e9, minSec: 7, sec: 12 }, th, 3,
    );
    assert(dirty.off && dirty.secOff, "a security ratchet must be caught");
    assert(dirty.secExcess > 0, "the excess should be reported for the log");
  },

  // ------------------------------------------------------------- stream ----

  "a batch launches weakens and grow BEFORE its hack": async () => {
    const { s, calls } = await makeStream();
    const res = s.dispatch();
    assert(res.dispatched, `dispatch failed: ${res.why}`);

    const ops = calls.map((c) => c.args[5]);
    const firstHack = ops.indexOf("H");
    assert(firstHack === ops.length - 1, `hack was not last: ${ops.join(",")}`);
    for (const op of ["W1", "G", "W2"]) {
      assert(ops.indexOf(op) < firstHack, `${op} launched after hack`);
    }
  },

  "landing order is still H, W1, G, W2 whatever the launch order": async () => {
    const { s, calls, mods } = await makeStream();
    const { SPACER_MS } = mods["config"];
    s.dispatch();

    // args: [target, delay, batch, port, planned, op, threads]
    const landOf = (op) => Number(calls.find((c) => c.args[5] === op).args[4]);
    const w1 = landOf("W1");

    assertClose(landOf("H"), w1 - SPACER_MS, 1e-9, "hack lands one spacer early");
    assertClose(landOf("G"), w1 + SPACER_MS, 1e-9, "grow lands one spacer late");
    assertClose(landOf("W2"), w1 + 2 * SPACER_MS, 1e-9, "weaken-2 lands two spacers late");
    for (const c of calls) assert(Number(c.args[1]) >= 0, `negative delay on ${c.args[5]}`);
  },

  "an aborted dispatch never leaves a hack running": async () => {
    const { s, calls, ns } = await makeStream();

    // Refuse the exec for grow. Because hack launches LAST, an abort anywhere
    // can only ever leave grow and weaken in the air - and those can only move
    // the target toward prepped. There is no ordering that strands a hack
    // without its grow, which is the batch that steals money and never puts it
    // back.
    ns.exec = (file, host, threads, ...args) => {
      calls.push({ file, host, threads, args });
      return args[5] === "G" ? 0 : calls.length;
    };

    const res = s.dispatch();
    assert(!res.dispatched, "the dispatch should have aborted");
    assert(!calls.some((c) => c.args[5] === "H"), "a hack was launched despite the abort");
    assert(s.depth === 0, "an aborted batch must not be registered as in flight");
  },

  "a failed placement reserves nothing": async () => {
    const { s, pool } = await makeStream({ hosts: { home: 12 } }); // far too small
    const before = pool.freeRam;

    const res = s.dispatch();
    assert(!res.dispatched, "dispatch should fail on a tiny pool");
    assert(res.why.startsWith("no room"), `expected a placement failure, got "${res.why}"`);
    // A batch is all-or-nothing. A partial reservation left behind would shrink
    // the pool on every failed attempt until nothing placed at all.
    assertClose(pool.pendingRam, 0, 1e-9, "failed dispatch leaked a reservation");
    assertClose(pool.freeRam, before, 1e-9, "failed dispatch leaked RAM");
  },

  "an unprepped target is never streamed": async () => {
    const { s } = await makeStream({
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 3e8, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });

    const res = s.dispatch();
    assert(!res.dispatched && res.why === "money off baseline", `got "${res.why}"`);
  },

  "a batch whose grow splits across hosts retires clean": async () => {
    // Two hosts, neither able to hold the whole grow. This is the shape that
    // desynced the first live run: the split produced five reports for four ops
    // and the verdict condemned it.
    const { s, calls } = await makeStream({ hosts: { a: 130, b: 130 } });

    const res = s.dispatch();
    assert(res.dispatched, `dispatch failed: ${res.why}`);
    const growWorkers = calls.filter((c) => c.args[5] === "G").length;
    assert(growWorkers > 1, `grow did not split (${growWorkers} worker) - fixture is wrong`);

    for (const c of calls) {
      s.credit({
        b: c.args[2], op: c.args[5], t: c.threads,
        p: Number(c.args[4]), a: Number(c.args[4]), r: c.args[5] === "H" ? 6e7 : 1,
      });
    }

    assert(s.retire() === 1, "the batch should retire");
    assert(s.stats.ok === 1, "a split batch that landed correctly must be judged ok");
    assert(s.stats.bad === 0, `judged bad: ${s.stats.bad}`);
    assert(s.strikes === 0, "a clean split batch must not earn a strike");
  },

  "a target that drifts off baseline stops its own stream": async () => {
    const { s, mods } = await makeStream({
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e6, minDifficulty: 5, hackDifficulty: 40,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });
    const { DESYNC_STRIKES } = mods["config"];

    for (let i = 0; i < DESYNC_STRIKES; i++) s.dispatch();

    // Continuing to fire into a drifted target turns a recoverable drift into a
    // drained server - every batch hacks against money that is not there and
    // grows from a base the plan did not assume.
    assert(s.stopped === "off baseline", `expected a stop, got ${s.stopped}`);
    assert(s.dispatch().dispatched === false, "a stopped stream must not dispatch");

    s.resume();
    assert(s.stopped === null && s.strikes === 0, "resume should clear the stop");
  },

  "reports are credited to their own batch and retired in order": async () => {
    const { s, calls } = await makeStream();
    const res = s.dispatch();
    assert(res.dispatched, "setup dispatch");
    assert(s.depth === 1, "one batch in flight");

    // Feed back exactly what the workers would have written, landing in order.
    const byOp = {};
    for (const c of calls) {
      const op = c.args[5];
      byOp[op] = { b: c.args[2], op, t: c.threads, p: Number(c.args[4]), a: Number(c.args[4]), r: op === "H" ? 7e6 : 1 };
    }
    for (const op of ["H", "W1", "G", "W2"]) assert(s.credit(byOp[op]), `${op} was not credited`);

    // A batch whose reports are all in retires immediately rather than waiting
    // out its deadline - at depth the in-flight map holds hundreds of these and
    // walking it is the loop's only real work.
    assert(s.retire() === 1, "the complete batch should retire at once");
    assert(s.depth === 0, "nothing should still be in flight");
    assert(s.stats.ok === 1 && s.stats.bad === 0, "a clean batch should be judged ok");
    assert(s.stats.stolen === 7e6, `income not credited: ${s.stats.stolen}`);
  },

  "an unknown batch id is refused rather than silently absorbed": async () => {
    const { s } = await makeStream();
    s.dispatch();
    assert(!s.credit({ b: "not-a-batch", op: "H", p: 1, a: 1, r: 0 }), "a foreign id was accepted");
  },

  "the steal ceiling is enforced, not merely documented": async () => {
    const { mods } = await loadContinuous();
    const { clampSteal } = mods["lib/plan"];
    const { MAX_STEAL_FRACTION } = mods["config"];

    // MAX_STEAL_FRACTION used to exist only in prose - nothing read it - so
    // `--steal 0.99` was accepted and so was `--steal 5`, which sizes a hack to
    // take five times the server's money and a grow to restore from a balance
    // that cannot occur. A mistyped terminal argument was enough.
    assert(clampSteal(0.99) === MAX_STEAL_FRACTION, "0.99 should clamp to the ceiling");
    assert(clampSteal(5) === MAX_STEAL_FRACTION, "5 should clamp to the ceiling");
    assert(clampSteal(0.1) === 0.1, "a sane fraction passes through untouched");

    // NaN compares false against every bound, so treating garbage as a default
    // would let it straight through the check meant to stop it.
    for (const bad of [NaN, "abc", 0, -1, Infinity, undefined, null]) {
      assert(clampSteal(bad) === null, `clampSteal(${String(bad)}) should be null`);
    }
  },

  "planThreads refuses a steal fraction it cannot use": async () => {
    const { math, ns } = await makeMath("analyze", {
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018 },
      },
    });
    const { mods } = await loadContinuous();
    const { planThreads } = mods["lib/plan"];
    const { MAX_STEAL_FRACTION } = mods["config"];

    const snap = math.snapshot(ns, "t");
    assert(planThreads(math, snap, "nonsense") === null, "garbage steal must not produce a plan");

    // Clamped, not rejected: a too-large number costs the difference rather
    // than the whole run.
    const over = planThreads(math, snap, 0.99);
    const capped = planThreads(math, snap, MAX_STEAL_FRACTION);
    assert(over.hack === capped.hack, "an over-cap steal should plan as the cap does");
  },

  // -------------------------------------------------- adaptive steal ------

  "the drift tolerance collapses as the steal fraction rises": async () => {
    const { mods } = await loadContinuous();
    const { stealTolerance } = mods["lib/plan"];

    // ((margin-1)/margin) * (1-steal)/steal. This curve is the whole reason a
    // ceiling exists: the top of the range is where a batcher dies rather than
    // merely underperforms.
    assertClose(stealTolerance(0.20, 1.05), 0.1905, 1e-4, "20%");
    assertClose(stealTolerance(0.85, 1.05), 0.0084, 1e-4, "85%");
    assertClose(stealTolerance(0.95, 1.05), 0.0025, 1e-4, "95%");
    assert(stealTolerance(0, 1.05) === 0, "a zero fraction has no tolerance");
    assert(stealTolerance(1, 1.05) === 0, "taking everything leaves no headroom");
  },

  "a clean window steps the steal fraction up": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal } = mods["lib/plan"];
    const { STEAL_STEP_UP } = mods["config"];

    const d = nextSteal(0.10, { batches: 20, bad: 0, worstOver: 0 }, 0.95);
    assert(d.changed, "a clean window should step up");
    assertClose(d.steal, 0.10 * STEAL_STEP_UP, 1e-9, "step size");
  },

  "an overshoot past tolerance steps it down hard": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal, stealTolerance } = mods["lib/plan"];
    const { STEAL_STEP_DOWN } = mods["config"];

    // Took more than the grow was sized to put back. The batch ends below where
    // it started, and at high steal that compounds into the next one.
    const over = stealTolerance(0.80) * 2;
    const d = nextSteal(0.80, { batches: 20, bad: 0, worstOver: over }, 0.95);

    assert(d.changed && d.steal < 0.80, "an overshoot must step down");
    assertClose(d.steal, 0.80 * STEAL_STEP_DOWN, 1e-9, "step size");
    assert(d.reason.includes("overshoot"), `reason was "${d.reason}"`);
  },

  "down is faster than up, because the costs are not symmetric": async () => {
    const { mods } = await loadContinuous();
    const { STEAL_STEP_UP, STEAL_STEP_DOWN } = mods["config"];

    // A step too low costs a few percent of income. A step too high costs a
    // drained target and a re-prep - and the tolerance shrinks as the fraction
    // rises, so an overshoot compounds into the next step.
    assert(STEAL_STEP_UP > 1 && STEAL_STEP_DOWN < 1, "directions");
    assert(1 / STEAL_STEP_DOWN > STEAL_STEP_UP, "a step down must undo more than a step up adds");
  },

  "an undershoot backs the fraction off - the server was not full": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal } = mods["lib/plan"];
    const { STEAL_STEP_DOWN, DRAIN_UNDER } = mods["config"];

    // `over` is (money/maxMoney) * (stealAtLanding/stealAtPlan) - 1, and money
    // clamps at maxMoney - so a NEGATIVE value can only mean the server was not
    // full when the hack landed. The batch before it did not restore.
    const d = nextSteal(0.95, { batches: 20, bad: 0, worstUnder: -(DRAIN_UNDER + 0.1) }, 0.95);
    assert(d.changed, "a drain must step down");
    assertClose(d.steal, 0.95 * STEAL_STEP_DOWN, 1e-9, "step size");
    assert(d.reason.includes("full"), `reason was "${d.reason}"`);

    // The normal dip is not a drain: at 95% steal a hack lands on a server its
    // predecessor's grow has already refilled, so `over` sits near zero.
    assert(!nextSteal(0.95, { batches: 20, bad: 0, worstUnder: -0.02 }, 0.95).changed, "no false alarm");
  },

  "RAM pressure backs the fraction off instead of dropping the target": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal } = mods["lib/plan"];
    const { NO_ROOM_TOLERANCE } = mods["config"];

    // A dispatch that cannot place loses a cadence slot it never gets back, and
    // at 95% a batch is over ten times its size at 10%. The fix is a smaller
    // bite - keeping the income and letting every stream shrink to fit - not a
    // queue, and not evicting the target.
    const squeezed = { batches: 20, bad: 0, attempts: 20, noRoom: Math.ceil(20 * NO_ROOM_TOLERANCE) + 1 };
    const d = nextSteal(0.95, squeezed, 0.95);
    assert(d.changed && d.steal < 0.95, "RAM pressure should step down");
    assert(d.reason.includes("no room"), `reason was "${d.reason}"`);

    // A few misses are normal on a busy pool and must not move it.
    const occasional = { batches: 20, bad: 0, attempts: 20, noRoom: 1 };
    assert(!nextSteal(0.95, occasional, 0.95).changed, "occasional misses are not pressure");
  },

  "a window missing fields still yields a sane decision": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal } = mods["lib/plan"];

    // Defaults fill in "nothing seen" so a caller tracking only some signals is
    // not silently comparing against undefined - which would make every
    // threshold test false and the controller inert.
    const d = nextSteal(0.5, { batches: 20, bad: 0 }, 0.95);
    assert(d.steal > 0.5, "a clean window with no other evidence should step up");
  },

  "a bad batch backs the fraction off even with no overshoot": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal } = mods["lib/plan"];

    // A sequencing fault is not a sizing fault, but the response is the same: a
    // smaller steal makes every later batch cheaper to get wrong and buys back
    // tolerance while the cause is still unknown.
    const d = nextSteal(0.50, { batches: 20, bad: 1, worstOver: 0 }, 0.95);
    assert(d.changed && d.steal < 0.50, "a bad batch should back off");
    assert(d.reason.includes("bad batch"), `reason was "${d.reason}"`);
  },

  "it will not step up from the edge of tolerance": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal, stealTolerance } = mods["lib/plan"];

    // Inside tolerance, but only just. Stepping up here raises the stake
    // precisely when the margin is thinnest - and the tolerance SHRINKS as the
    // fraction rises, so the next step would start over the line.
    const edge = stealTolerance(0.50) * 0.9;
    const d = nextSteal(0.50, { batches: 20, bad: 0, worstOver: edge }, 0.95);
    assert(!d.changed, `stepped up from the edge: ${d.steal}`);
  },

  "it holds until it has enough samples": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal } = mods["lib/plan"];
    const { STEAL_MIN_SAMPLES } = mods["config"];

    const few = nextSteal(0.10, { batches: STEAL_MIN_SAMPLES - 1, bad: 0, worstOver: 0 }, 0.95);
    assert(!few.changed, "too few samples to step up on");

    // But a fault acts immediately - waiting for a quorum to react to damage
    // would mean taking the damage repeatedly first.
    const bad = nextSteal(0.10, { batches: 1, bad: 1, worstOver: 0 }, 0.95);
    assert(bad.changed, "a fault should not wait for a full window");
  },

  "the ceiling and the floor both hold": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal } = mods["lib/plan"];
    const { MIN_STEAL_FRACTION } = mods["config"];

    const atCap = nextSteal(0.95, { batches: 50, bad: 0, worstOver: 0 }, 0.95);
    assert(!atCap.changed && atCap.reason === "at the ceiling", `got "${atCap.reason}"`);

    const atFloor = nextSteal(MIN_STEAL_FRACTION, { batches: 9, bad: 5, worstOver: 1 }, 0.95);
    assert(atFloor.steal === MIN_STEAL_FRACTION, "must not drive the fraction below the floor");
  },

  "a backed-off fraction can still climb back to the ceiling": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal } = mods["lib/plan"];
    const { MAX_STEAL_FRACTION } = mods["config"];

    // Each step costs one weaken window of holding, so the step count is the
    // ramp time. Unbounded or very slow would mean the controller never
    // actually arrives.
    // Deliberately NOT from STEAL_FRACTION: that now starts at the ceiling, so
    // reading it here would make this test vacuous. The climb still has to work
    // for a target the controller has backed off and is recovering.
    let steal = 0.05;
    let steps = 0;
    while (steal < MAX_STEAL_FRACTION && steps < 100) {
      const d = nextSteal(steal, { batches: 20, bad: 0, worstOver: 0 }, MAX_STEAL_FRACTION);
      if (!d.changed) break;
      steal = d.steal;
      steps++;
    }
    assert(steal === MAX_STEAL_FRACTION, `climb stalled at ${steal}`);
    assert(steps <= 8, `took ${steps} steps - too slow to be useful`);
  },

  "a missed hack is not counted as a huge undershoot": async () => {
    const { s, calls } = await makeStream();
    assert(s.dispatch().dispatched, "setup");
    const id = calls[0].args[2];

    // A miss returns 0, so stolen/take - 1 is -1. Folding that into the sample
    // would drag the worst-case the wrong way and license a step up on a window
    // that contained no successful hack at all.
    for (const c of calls) {
      s.credit({
        b: id, op: c.args[5], t: c.threads,
        p: Number(c.args[4]), a: Number(c.args[4]), r: c.args[5] === "H" ? 0 : 1,
      });
    }
    s.retire();

    assert(s.stats.ok === 1, "a missed hack is still a well-formed batch");
    assert(s.stats.hackHits === 0, "and not a hit");
    assert(s.steal === 0.1, "one miss must not move the fraction");
  },

  // ----------------------------------------------------------- intrusion ---

  "a hack landing inside another batch's restore is an intrusion": async () => {
    const { s, calls } = await makeStream();

    // Two batches in flight. Batch A hacks, and before A's grow lands, B hacks
    // the same server - so A's grow was sized against money B has just taken,
    // and A under-refills. Every op of BOTH batches landed in perfect order, so
    // the per-batch verdict cannot see this at all.
    assert(s.dispatch().dispatched, "batch A");
    const a = calls[0].args[2];
    calls.length = 0;
    assert(s.dispatch().dispatched, "batch B");
    const b = calls[0].args[2];
    assert(a !== b, "the two batches need distinct ids");

    s.credit({ b: a, op: "H", t: 1, p: 1000, a: 1000, r: 5e7 });
    s.credit({ b: b, op: "H", t: 1, p: 1400, a: 1400, r: 5e7 }); // A has not grown
    assert(s.stats.intrusions === 1, `expected 1 intrusion, got ${s.stats.intrusions}`);
  },

  "the normal cadence produces no intrusions": async () => {
    const { s, calls } = await makeStream();

    assert(s.dispatch().dispatched, "batch A");
    const a = calls[0].args[2];
    calls.length = 0;
    assert(s.dispatch().dispatched, "batch B");
    const b = calls[0].args[2];

    // A batch is mid-restore for two spacers (200ms); batches are one cadence
    // apart (400ms). So in a healthy stream A has always grown before B hacks,
    // and the detector sees nothing - which is what makes an occupant of that
    // window a real signal rather than noise.
    s.credit({ b: a, op: "H", t: 1, p: 1000, a: 1000, r: 5e7 });
    s.credit({ b: a, op: "G", t: 1, p: 1200, a: 1200, r: 1.1 });
    s.credit({ b: b, op: "H", t: 1, p: 1400, a: 1400, r: 5e7 });

    assert(s.stats.intrusions === 0, `false positive: ${s.stats.intrusions}`);
  },

  "an intruded batch is judged bad even though its own ops were in order": async () => {
    const { s, calls } = await makeStream();

    assert(s.dispatch().dispatched, "batch A");
    const a = calls[0].args[2];
    const aCalls = [...calls];
    calls.length = 0;
    assert(s.dispatch().dispatched, "batch B");
    const b = calls[0].args[2];

    // A's own four ops land in perfect order at zero drift...
    s.credit({ b: a, op: "H", t: 1, p: 1000, a: 1000, r: 5e7 });
    // ...but B's hack arrives before A's grow.
    s.credit({ b: b, op: "H", t: 1, p: 1100, a: 1100, r: 5e7 });
    s.credit({ b: a, op: "W1", t: 1, p: 1100, a: 1100, r: 0.05 });
    s.credit({ b: a, op: "G", t: 1, p: 1200, a: 1200, r: 1.1 });
    s.credit({ b: a, op: "W2", t: 1, p: 1300, a: 1300, r: 0.05 });

    // Only A has all its reports, so only A retires.
    assert(aCalls.length === 4, "fixture should place each op on one host");
    s.retire();
    assert(s.stats.bad >= 1, "an intruded batch must not be judged ok");
    assert(s.strikes >= 1, "an intrusion should earn a strike");
  },

  // ----------------------------------------------------------- admission ---

  "targets are admitted until the RAM budget runs out": async () => {
    const { mods } = await loadContinuous();
    const { admitTargets } = mods["core"];

    const t = (host, gb, weaken) => ({ host, gb, times: { weaken } });
    const priced = [t("a", 100, 40000), t("b", 100, 40000), t("c", 100, 40000)];

    // depth = ceil(40000/400) = 100, so each target wants 10000GB.
    const { admitted, committed } = admitTargets(priced, 25000, 12);
    assert(admitted.length === 2, `expected 2 admitted, got ${admitted.length}`);
    assert(committed === 20000, `committed ${committed}`);
    assert(admitted[0].depth === 100 && admitted[0].want === 10000, "depth/want recorded");
  },

  "a cheap target still gets in behind one that did not fit": async () => {
    const { mods } = await loadContinuous();
    const { admitTargets } = mods["core"];

    const priced = [
      { host: "rich", gb: 100, times: { weaken: 40000 } },  // wants 10000
      { host: "huge", gb: 5000, times: { weaken: 40000 } }, // wants 500000
      { host: "cheap", gb: 10, times: { weaken: 40000 } },  // wants 1000
    ];

    // `continue`, not `break`: one unaffordable entry must not end the search,
    // or a cheap target that fits comfortably in the leftovers is lost.
    const { admitted } = admitTargets(priced, 12000, 12);
    assert(admitted.map((a) => a.host).join(",") === "rich,cheap", `got ${admitted.map((a) => a.host)}`);
  },

  "the best target runs even when the budget cannot afford it": async () => {
    const { mods } = await loadContinuous();
    const { admitTargets } = mods["core"];

    // Streaming nothing earns nothing. An over-budget stream just fails some
    // dispatches for want of RAM and reports the skips, which is strictly
    // better than an idle pool.
    const { admitted } = admitTargets(
      [{ host: "only", gb: 1e6, times: { weaken: 40000 } }], 10, 12,
    );
    assert(admitted.length === 1, "the first target is admitted unconditionally");
  },

  "MAX_TARGETS caps admission however much RAM there is": async () => {
    const { mods } = await loadContinuous();
    const { admitTargets } = mods["core"];

    const priced = Array.from({ length: 20 }, (_, i) => ({
      host: `h${i}`, gb: 1, times: { weaken: 40000 },
    }));
    const { admitted } = admitTargets(priced, Infinity, 5);
    assert(admitted.length === 5, `ceiling ignored: ${admitted.length}`);
  },

  "in-flight depth is capped by MAX_IN_FLIGHT, not just by cadence": async () => {
    const { mods } = await loadContinuous();
    const { admitTargets } = mods["core"];
    const { MAX_IN_FLIGHT, CADENCE_MS } = mods["config"];

    // A 6.4 minute weaken at a 400ms cadence wants 959 batches in the air.
    const slow = { host: "slow", gb: 1, times: { weaken: 960 * CADENCE_MS } };
    const { admitted } = admitTargets([slow], Infinity, 12);
    assert(admitted[0].depth === MAX_IN_FLIGHT, `depth ${admitted[0].depth} ignored the cap`);
  },

  // ---------------------------------------------------------- supervisor ---

  "a wound-down stream stops dispatching but keeps its batches": async () => {
    const { s } = await makeStream();
    assert(s.dispatch().dispatched, "setup");
    assert(s.depth === 1, "one in flight");

    s.windDown();

    // Killed outright, this would lose money: ns.hack credits when it LANDS,
    // so a batch whose hack has landed and whose grow has not is money taken
    // and never put back. Draining costs one weaken window and loses nothing.
    assert(s.retiring, "windDown should mark it retiring");
    assert(!s.isDue(), "a retiring stream must not start new batches");
    assert(s.depth === 1, "the in-flight batch must survive");
    assert(!s.dispatch().dispatched, "dispatch must refuse while retiring");
  },

  "a retiring stream is not mistaken for one needing repair": async () => {
    const { s } = await makeStream();
    s.windDown();
    // `stopped` means drifted and needs a re-prep; `retiring` means replaced on
    // purpose. Sharing one flag would have the supervisor prep targets it is in
    // the middle of dropping.
    assert(s.retiring && !s.stopped, "retiring must be distinct from stopped");
  },

  "a streaming target mid-batch is not dropped from the ranking": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        // Money one batch's steal below max and security one batch high -
        // exactly where a healthy streaming target sits most of the time.
        busy: {
          moneyMax: 1e9, moneyAvailable: 0.9e9, minDifficulty: 5, hackDifficulty: 5.5,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
      },
    });
    const { priceTargets } = mods["core"];

    const ranked = [{ host: "busy", chance: 1 }];

    // Judged as a fresh candidate, the strict prep-time test rejects it.
    assert(priceTargets(ns, math, ram, 0.1, ranked).length === 0, "strict test should reject");

    // Judged as a live stream, baselineDrift accepts it - and it must, because
    // this rejection is what dropped targets from the ranking, wound them down,
    // and rebuilt them at the default steal. It got WORSE as the controller
    // succeeded: a bigger steal means a deeper dip between hack and grow.
    const live = priceTargets(ns, math, ram, 0.1, ranked, new Set(["busy"]));
    assert(live.length === 1, "a live stream mid-batch must stay in the ranking");
  },

  "a genuinely drained streaming target IS dropped": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        drained: {
          moneyMax: 1e9, moneyAvailable: 1e8, minDifficulty: 5, hackDifficulty: 5,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
      },
    });
    const { priceTargets } = mods["core"];

    // The looser test must not become no test: far past what batches in flight
    // could explain is still a drift.
    const live = priceTargets(ns, math, ram, 0.1, [{ host: "drained", chance: 1 }], new Set(["drained"]));
    assert(live.length === 0, "a drained target must be dropped even while streaming");
  },

  "a re-admitted stream is reinstated, not rebuilt": async () => {
    const { s } = await makeStream();
    assert(s.dispatch().dispatched, "setup");
    s.windDown();
    assert(!s.isDue(), "wound down");

    s.reinstate();
    assert(!s.retiring, "reinstate should clear the flag");
    assert(s.isDue() || s.depth > 0, "a reinstated stream is usable again");
  },

  "a prepped target is picked up by rescan": async () => {
    const { ns, math, pool, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        good: {
          moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
      },
    });
    const { rescan } = mods["core"];

    const preps = new Map();
    const streams = rescan(ns, math, {
      pool, ram, steal: 0.1, maxTargets: 4, forced: null,
      streams: [], preps, log: () => {}, verbose: false,
    });

    assert(streams.length === 1 && streams[0].host === "good", `got ${streams.map((s) => s.host)}`);
  },

  "an unprepped target is priced on what it would be worth once prepped": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        dirty: {
          moneyMax: 1e9, moneyAvailable: 1e6, minDifficulty: 5, hackDifficulty: 40,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
      },
    });
    const { pricePotential, priceTargets } = mods["core"];

    // priceTargets refuses it outright - it is not prepped, so there is nothing
    // honest to say about a batch against it.
    assert(priceTargets(ns, math, ram, 0.1, [{ host: "dirty", chance: 1 }]).length === 0, "not prepped");

    // pricePotential answers the different question: what would it be worth if
    // it WERE prepped? With only a few slots that is the question that decides
    // whether the batcher ever finds the best targets or just keeps whichever
    // ones happened to be ready first.
    const pot = pricePotential(ns, math, ram, 0.1, [{ host: "dirty", chance: 1 }]);
    assert(pot.length === 1, "potential pricing should produce a score");
    assert(pot[0].score > 0, "and a usable one");
    // Priced at max money, not the $1m it actually holds.
    assertClose(pot[0].th.take, 1e9 * pot[0].th.actualSteal, 1e-6, "take should assume max money");
  },

  "a candidate worth more than a running stream is prepped with priority": async () => {
    const { ns, math, pool, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        // Prepped and streamable, but modest.
        small: {
          moneyMax: 1e8, moneyAvailable: 1e8, minDifficulty: 5, hackDifficulty: 5,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
        // Ten times the money, but filthy - so it is not streamable yet.
        rich: {
          moneyMax: 1e9, moneyAvailable: 1e7, minDifficulty: 5, hackDifficulty: 45,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
      },
    });
    const { rescan } = mods["core"];
    ns.exec = () => 1;

    const preps = new Map();
    const streams = rescan(ns, math, {
      pool, ram, steal: 0.1, maxTargets: 1, forced: null,
      streams: [], preps, learned: new Map(), log: () => {}, verbose: false,
    });

    // The modest one streams now, because it is ready now - a target that is
    // not prepped is worth nothing, and holding RAM back for a maybe would
    // trade real income for it.
    assert(streams.length === 1 && streams[0].host === "small", `streaming ${streams.map((s) => s.host)}`);
    // And the richer one is queued, because once prepped it displaces.
    assert(preps.has("rich"), "the displacing candidate should be queued for prep");
  },

  "a re-created stream starts from what was learned, not the default": async () => {
    const { ns, math, pool, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        good: {
          moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
      },
    });
    const { rescan } = mods["core"];

    // Each step up costs a full weaken window of holding, so re-climbing from
    // the default is minutes of measurement thrown away every time a target is
    // dropped for RAM and later re-admitted.
    const learned = new Map([["good", 0.6]]);
    const streams = rescan(ns, math, {
      pool, ram, steal: 0.1, maxTargets: 4, forced: null,
      streams: [], preps: new Map(), learned, log: () => {}, verbose: false,
    });

    assert(streams.length === 1, "the target should be admitted");
    assert(streams[0].steal === 0.6, `started at ${streams[0].steal}, expected the learned 0.6`);
  },

  "an unprepped target is queued for prep instead of streamed": async () => {
    const { ns, math, pool, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        dirty: {
          moneyMax: 1e9, moneyAvailable: 2e8, minDifficulty: 5, hackDifficulty: 40,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
      },
    });
    const { rescan } = mods["core"];

    const preps = new Map();
    const streams = rescan(ns, math, {
      pool, ram, steal: 0.1, maxTargets: 4, forced: null,
      streams: [], preps, log: () => {}, verbose: false,
    });

    // Never stream an unprepped target - the thread math assumes max money and
    // minimum security. But it must not be forgotten either: queuing it is what
    // makes a target that is not ready today eligible tomorrow.
    assert(streams.length === 0, "an unprepped target must not be streamed");
    assert(preps.has("dirty"), "an unprepped candidate should be queued for prep");
  },

  "the stream set does not shrink as the streams fill the pool": async () => {
    const { ns, math, pool, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        a: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
        b: { moneyMax: 9e8, moneyAvailable: 9e8, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });
    const { rescan } = mods["core"];
    ns.exec = () => 1;

    const preps = new Map();
    const opts = {
      pool, ram, steal: 0.1, maxTargets: 4, forced: null,
      preps, log: () => {}, verbose: false,
    };

    let streams = rescan(ns, math, { ...opts, streams: [] });
    const first = streams.length;
    assert(first === 2, `expected both targets, got ${first}`);

    // Fill most of the pool the way running streams would.
    ns._used.home = 200000;
    pool.refresh();

    streams = rescan(ns, math, { ...opts, streams });

    // Budgeting from freeRam would shrink the budget every rescan as the
    // streams filled it, evicting the very streams that were using it - a
    // feedback loop that ratchets the target count to zero. The budget comes
    // from pool CAPACITY for exactly that reason.
    assert(streams.length === first, `stream set shrank to ${streams.length} as the pool filled`);
    assert(streams.every((s) => !s.retiring), "no stream should have been dropped");
  },

  // ------------------------------------------------------------- pricing ---

  "money per GB-second demotes a target whose grow costs a fortune": async () => {
    const { mods } = await loadContinuous();
    const { moneyPerGbSec } = mods["lib/plan"];

    // The foodnstuff trap, recorded in the shotgun's capacity.js: $50m of max
    // money, 0.0175% growth per thread, 634 grow threads, 1.08TB per batch.
    // Ranking on income alone puts it above targets that actually fit.
    const trap = moneyPerGbSec(50e6, 1.0, 1080, 20000);
    const modest = moneyPerGbSec(10e6, 1.0, 60, 20000);

    assert(modest > trap, `the cheap target should win: ${modest} vs ${trap}`);
    assert(moneyPerGbSec(1e6, 1, 0, 20000) === 0, "a zero-RAM batch scores zero, not Infinity");
    assert(moneyPerGbSec(1e6, 1, 100, 0) === 0, "a zero weaken time scores zero");
  },

  // -------------------------------------------------------------- guard ----

  "the manager refuses to start beside another pool owner": async () => {
    const { mods } = await loadContinuous();
    const { findRivals } = mods["core"];

    const ns = makeNs({ hosts: { home: 4096 } });
    ns.self = () => ({ pid: 99 });
    ns.ps = () => [
      { filename: "scripts/continuous/manager.js", pid: 99, threads: 1, args: [] }, // self
      { filename: "scripts/manager.js", pid: 4, threads: 1, args: [] },
      { filename: "scripts/continuous/hack.js", pid: 5, threads: 1, args: [] },
    ];

    const rivals = findRivals(ns);
    // Two owners is silent corruption in two directions: each drain loop eats
    // the other's reports, and each pool treats the other's reservations as
    // free RAM.
    assert(rivals.length === 1, `expected 1 rival, got ${rivals.length}: ${rivals}`);
    assert(rivals[0].includes("scripts/manager.js"), `wrong rival: ${rivals[0]}`);
  },

  "the guard does not mistake the running manager for its own rival": async () => {
    const { mods } = await loadContinuous();
    const { findRivals } = mods["core"];

    const ns = makeNs({ hosts: { home: 4096 } });
    ns.self = () => ({ pid: 7 });
    ns.ps = () => [{ filename: "scripts/continuous/manager.js", pid: 7, threads: 1, args: [] }];

    assert(findRivals(ns).length === 0, "the manager reported itself as a rival");
  },

  "maxEffectiveThreadsFor exceeds the raw count on a multi-core pool": async () => {
    const { ns, pool } = await makePool(
      { home: 1024, mid: 512, plain: 512 },
      { home: 8, mid: 4 },
    );
    const coreBonus = await makeBonus(ns);

    const raw = pool.maxThreadsFor(1.75);
    const eff = pool.maxEffectiveThreadsFor(1.75, coreBonus);
    assert(eff > raw, `effective capacity ${eff} should exceed raw ${raw} on a cored pool`);

    // And it must be the weighted sum, not a flat fudge factor.
    const expected = pool.servers.reduce(
      (n, s) => n + s.threadsFor(1.75) * gameCoreBonus(s.cores),
      0,
    );
    assertClose(eff, expected, 1e-9, "effective capacity is not the core-weighted sum");
  },
};
