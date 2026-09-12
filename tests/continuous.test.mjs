import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { assert, assertClose, loadScripts } from "./harness.mjs";
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

/** A prep entry as rescan would queue it: marked, with no wave placed yet. */
const freshPrepEntry = () => ({ wave: null, deadline: 0, waves: 0, shrunk: false });

/**
 * Two equally drained targets over a pool of the given size, with exec recorded.
 *
 * Both want far more grow than a small pool can hold, which is the situation at
 * the start of a BitNode: prep need is set by the target's deficit, not by the
 * pool, so one target's ask can exceed the whole of it.
 *
 * `targets()` returns the target hosts prep actually exec'd against, in order -
 * launchPrepWave passes it as the fourth argument. That, not the prep map, is
 * what proves no RAM went to a second target.
 */
async function prepFixture(homeRam) {
  const drained = {
    moneyMax: 1e9, moneyAvailable: 1e3, minDifficulty: 5, hackDifficulty: 5,
    hackPercentPerThread: 0.003, growBase: 1.0018,
    weakenTime: 20000, growTime: 16000, hackTime: 5000,
  };

  const made = await makeMath("analyze", {
    hosts: { home: homeRam },
    servers: { a: { ...drained }, b: { ...drained } },
  });

  const seen = [];
  made.ns.exec = (...args) => {
    if (!seen.includes(args[3])) seen.push(args[3]);
    return 1;
  };

  return { ...made, targets: () => seen };
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

  // Plan a batch AND launch every op of it.
  //
  // Under JIT a dispatch only ENQUEUES; ops go out at `land - opTime`, spread
  // across most of a weaken window. Handing tick() a far-future `now` makes the
  // due-ness scan fire them all at once. launchOp still uses the real clock for
  // reachability and for the delay, so the timing assertions stay honest.
  const fire = (n = 1) => {
    for (let i = 0; i < n; i++) {
      s.dispatch();
      s.tick(Date.now() + 1e9);
    }
  };

  return { s, ns, pool, math, mods, ram, calls, fire };
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

  // ----------------------------------------------------------------- fmt ----

  // Money formatting failed SILENTLY: the old formatters stopped their suffix
  // list at "t" or earlier and the mantissa then grew without bound instead of
  // rolling over, so a live report read "$2219301.35b" for what the game calls
  // $2.22q. The number stays correct and becomes unreadable, which nothing but
  // a check on the output can catch.
  //
  // Expected strings are the GAME's, from the suffix list in
  // src/ui/formatNumber.ts: ["", k, m, b, t, q, Q, s, S, o, n], powers of 1000.

  "the money suffix rolls over instead of growing the mantissa": async () => {
    const { mods } = await loadContinuous();
    const { fmtMoney } = mods["lib/fmt"];

    // The three figures from the live report that prompted this.
    assert(fmtMoney(2219301.35e9) === "$2.22q", `got ${fmtMoney(2219301.35e9)}`);
    assert(fmtMoney(309727.81e9) === "$309.73t", `got ${fmtMoney(309727.81e9)}`);
    assert(fmtMoney(1939158.48e6) === "$1.94t", `got ${fmtMoney(1939158.48e6)}`);
  },

  "every suffix in the game's list is reachable": async () => {
    const { mods } = await loadContinuous();
    const { fmtMoney } = mods["lib/fmt"];

    const want = ["", "k", "m", "b", "t", "q", "Q", "s", "S", "o", "n"];
    for (let i = 0; i < want.length; i++) {
      const got = fmtMoney(1000 ** i);
      assert(got === `$1.00${want[i]}`, `10^${3 * i} formatted as ${got}`);
    }
    // Past the end of the list the mantissa DOES grow - there is no suffix left
    // - but it must not print "undefined".
    assert(fmtMoney(1000 ** 11) === "$1000.00n", `got ${fmtMoney(1000 ** 11)}`);
  },

  "no money is printed without going through the formatter": async () => {
    const { sources } = await loadContinuous();

    // Not a style rule. Every figure that overflowed its suffix did so because
    // the call site scaled and labelled the number by hand - "/1e9" with a
    // literal "b" glued on - and that is invisible until the value outgrows the
    // label. Two separate passes over this file missed sites, which is exactly
    // the kind of miss a grep catches and a reader does not: $/GB-s looked too
    // small to matter right up until a live log printed $72614.35k/GB-s.
    const offenders = [];
    for (const [rel, src] of sources) {
      if (rel === "lib/fmt.js") continue; // the formatter itself, obviously
      src.split(/\r?\n/).forEach((line, i) => {
        if (line.includes("$${")) offenders.push(`${rel}:${i + 1} ${line.trim()}`);
      });
    }
    assert(
      offenders.length === 0,
      `format these with fmtMoney from lib/fmt.js: ${offenders.join(" | ")}`,
    );
  },

  "a money figure that is not a number prints a dash, never NaN": async () => {
    const { mods } = await loadContinuous();
    const { fmtMoney } = mods["lib/fmt"];

    // Rates are divided by elapsed seconds and by depth, both of which can be
    // zero before the first batch lands.
    assert(fmtMoney(NaN) === "$-", `got ${fmtMoney(NaN)}`);
    assert(fmtMoney(Infinity) === "$-", `got ${fmtMoney(Infinity)}`);
    assert(fmtMoney(0) === "$0.00", `got ${fmtMoney(0)}`);
    assert(fmtMoney(-5e9) === "$-5.00b", `got ${fmtMoney(-5e9)}`);
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

  "the manager entries cost what the architecture says they do": async () => {
    const { sources } = await loadContinuous();

    // Verified against src/Netscript/RamCostGenerator.ts in this fork. Only the
    // functions this folder actually reaches; an unlisted one shows up as a
    // total that no longer matches, which is the point.
    const COST = {
      hack: 0.1, grow: 0.15, weaken: 0.15, scan: 0.2, exec: 1.3, scp: 0.6,
      kill: 0.5, ps: 0.2, hasRootAccess: 0.05, getHostname: 0.05,
      getHackingLevel: 0.05, getServer: 2, getServerMoneyAvailable: 0.1,
      getServerSecurityLevel: 0.1, getServerMinSecurityLevel: 0.1,
      getServerMaxMoney: 0.1, getServerRequiredHackingLevel: 0.1,
      getServerGrowth: 0.1, getServerMaxRam: 0.05, getServerUsedRam: 0.05,
      getServerNumPortsRequired: 0.1, fileExists: 0.1, getScriptRam: 0.1,
      getHackTime: 0.05, getGrowTime: 0.05, getWeakenTime: 0.05,
      hackAnalyze: 1, hackAnalyzeSecurity: 1, hackAnalyzeChance: 1,
      growthAnalyze: 1, growthAnalyzeSecurity: 1, weakenAnalyze: 1,
      getPlayer: 0.5, share: 2.4,
      // Free, and load-bearing that they stay free: config.js is imported by
      // every module in the folder and core.js mirrors its whole log to disk.
      read: 0, write: 0, print: 0, tprint: 0, args: 0,
    };

    const ramOf = (entry) => {
      const fns = new Set();
      for (const mod of importClosure(entry, sources)) {
        const src = stripComments(sources.get(mod + ".js"));
        for (const m of src.matchAll(/ns\.(\w+)\s*\(/g)) {
          if (COST[m[1]] !== undefined) fns.add(m[1]);
        }
      }
      return 1.6 + [...fns].reduce((n, f) => n + COST[f], 0);
    };

    // The two backends must stay apart, and the totals are how that shows up as
    // a number rather than as a graph walk.
    // 12.85 -> 12.95 when lib/share.js arrived: ns.fileExists, 0.10, which the
    // top-up needs to tell a host that HAS NOT GOT share.js from one that has it
    // and refused the exec. Those two return the same bare 0 from exec and have
    // opposite remedies, and merging them cost the shotgun two live runs.
    //
    // The formulas total does not move at all - lib/mathFormulas.js already pays
    // for fileExists to check for Formulas.exe - which is why share is the rare
    // addition that is free on one build and cheap on the other.
    const analyze = ramOf("manager");
    const formulas = ramOf("manager-formulas");
    assert(Math.abs(analyze - 12.95) < 0.011, `manager.js: expected 12.95 GB, got ${analyze.toFixed(2)}`);
    assert(Math.abs(formulas - 9.00) < 0.011, `manager-formulas.js: expected 9.00 GB, got ${formulas.toFixed(2)}`);
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

  "a batch sizes weaken-2 at plan time, from grow's effective count": async () => {
    const { math, ns, mods } = await makeMath("analyze", {
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018 },
      },
    });
    const { planThreads, weaken2For } = mods["lib/plan"];

    // Forced by the JIT launch order, not chosen: weaken-2 goes out before grow
    // (due_W2 - due_G = s - 0.2W, negative for any weaken over half a second),
    // so grow's placed raw count does not exist yet when W2 has to be sized.
    const th = planThreads(math, math.snapshot(ns, "t"), 0.3);
    assert(th.weaken2 > 0, "the plan must carry its own weaken-2 count");
    assert(
      th.weaken2 === weaken2For(math, th.grow),
      `weaken2 ${th.weaken2} should come from the effective grow count`,
    );
  },

  "sizing weaken-2 from the effective count over-weakens, never under": async () => {
    const { math, ns, mods } = await makeMath("analyze", {
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018 },
      },
    });
    const { planThreads, weaken2For } = mods["lib/plan"];

    const th = planThreads(math, math.snapshot(ns, "t"), 0.3);

    // coreBonus >= 1 always, so a placement's raw thread count is never more
    // than the effective one it was asked for. Sizing from effective therefore
    // buys MORE weaken than the grow can justify - wasteful, and safe, because
    // weaken clamps at minimum security. The dangerous direction is impossible.
    const rawOn8Core = Math.ceil(th.grow / gameCoreBonus(8));
    assert(rawOn8Core < th.grow, "an 8-core placement uses fewer raw threads");
    assert(
      th.weaken2 >= weaken2For(math, rawOn8Core),
      "plan-time sizing must cover what the placement actually adds",
    );

    // And quantify the waste, so the trade stays visible: ~44% on 8 cores.
    const exact = weaken2For(math, rawOn8Core);
    assert(th.weaken2 / exact < 1.5, `over-provision ${th.weaken2 / exact} is larger than expected`);
  },

  "prep still sizes its weaken from grow's RAW placed threads": async () => {
    const { math, pool, ram, ns } = await makeMath("analyze", {
      hosts: { home: 65536 },
      cores: { home: 8 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 5e8, minDifficulty: 5, hackDifficulty: 5,
             growBase: 1.0018 },
      },
    });
    const { placePrepWave } = (await loadContinuous()).mods["lib/prep"];

    // A prep wave launches grow and weaken TOGETHER and places grow first, so
    // the exact raw count is available and there is no reason to over-provision.
    // The batch path had to give that up; prep did not, and must not be
    // "made consistent" with it.
    const wave = placePrepWave(pool, ram, math, math.snapshot(ns, "t"));
    assert(wave, "the wave should place");
    assertClose(
      wave.growSec,
      wave.grow.rawThreads * math.securityPerGrowThread(),
      1e-9,
      "prep must still size from RAW grow threads",
    );
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

  "stepping the fraction down does not make the target look drained": async () => {
    const { mods } = await loadContinuous();
    const { baselineDrift } = mods["lib/plan"];

    // Measured on a live run: the controller stepped 84.9% -> 50.9% under RAM
    // pressure, which tightened the floor to (1-0.509)^2 = 24.1% of max
    // instantly - while batches sized at 84.9% went on landing for another
    // weaken window and left the server at 15.1%. The stream stopped itself for
    // a drain that was its own arithmetic, and every step DOWN would repeat it.
    const now = { actualSteal: 0.509, hackSec: 0.3, growSec: 3 };
    const midBatch = { maxMoney: 100e6, money: 15.1e6, minSec: 5, sec: 5.3 };

    assert(baselineDrift(midBatch, now).off, "the fixture must reproduce the false alarm");

    // Told what is actually in the air, it is not a drain at all: one hack at
    // 84.9% leaves exactly 15.1%.
    const withInFlight = baselineDrift(midBatch, now, undefined, { floorSteal: 0.849 });
    assert(!withInFlight.off, `still flagged: floor ${withInFlight.moneyFloor}`);

    // And it must not become a blanket excuse - a genuine drain is still caught
    // even allowing for the largest bite in flight.
    const drained = baselineDrift(
      { maxMoney: 100e6, money: 0.5e6, minSec: 5, sec: 5 }, now, undefined, { floorSteal: 0.849 },
    );
    assert(drained.off && drained.moneyOff, "a real drain must still be caught");
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

  "ops launch in the order W1, W2, G, H - hack always last": async () => {
    const { s, calls, fire } = await makeStream();
    fire();

    // Under JIT this order is not chosen, it falls out of the due times:
    // due = land - opTime, so W1 (A-W), W2 (A+2s-W), G (A+s-0.8W), H (A-s-0.25W).
    // Hack being last is what makes aborting a batch part-way safe.
    const ops = calls.map((c) => c.args[5]);
    assert(ops.length > 0, "nothing launched");
    assert(ops[ops.length - 1] === "H", `hack was not last: ${ops.join(",")}`);
    const firstOf = (op) => ops.indexOf(op);
    assert(firstOf("W1") < firstOf("W2"), `W1 after W2: ${ops.join(",")}`);
    assert(firstOf("W2") < firstOf("G"), `W2 after G: ${ops.join(",")}`);
    assert(firstOf("G") < firstOf("H"), `G after H: ${ops.join(",")}`);
  },

  "landing order is still H, W1, G, W2 whatever the launch order": async () => {
    const { s, calls, mods, fire } = await makeStream();
    const { SPACER_MS } = mods["config"];
    fire();

    // args: [target, delay, batch, port, planned, op, threads]
    const landOf = (op) => Number(calls.find((c) => c.args[5] === op).args[4]);
    const w1 = landOf("W1");

    assertClose(landOf("H"), w1 - SPACER_MS, 1e-9, "hack lands one spacer early");
    assertClose(landOf("G"), w1 + SPACER_MS, 1e-9, "grow lands one spacer late");
    assertClose(landOf("W2"), w1 + 2 * SPACER_MS, 1e-9, "weaken-2 lands two spacers late");
    for (const c of calls) assert(Number(c.args[1]) >= 0, `negative delay on ${c.args[5]}`);
  },

  "an aborted dispatch never leaves a hack running": async () => {
    const { s, calls, ns, fire } = await makeStream();

    // Refuse the exec for grow. Because hack launches LAST, an abort anywhere
    // can only ever leave grow and weaken in the air - and those can only move
    // the target toward prepped. There is no ordering that strands a hack
    // without its grow, which is the batch that steals money and never puts it
    // back.
    ns.exec = (file, host, threads, ...args) => {
      calls.push({ file, host, threads, args });
      return args[5] === "G" ? 0 : calls.length;
    };

    fire();
    assert(!calls.some((c) => c.args[5] === "H"), "a hack was launched despite the abort");
    assert(s.stats.aborted === 1, `expected one abort, got ${s.stats.aborted}`);
    s.retire(Date.now() + 1e9);
    assert(s.depth === 0, "an aborted batch must not linger in flight");
    assert(s.stats.bad === 0, "an abort is a dispatch fault, not a landing fault");
  },

  "a failed placement reserves nothing": async () => {
    // Enough BYTES for the batch, on hosts too small to hold a single weaken
    // thread. That is the only shape that still reaches a placement failure now
    // that dispatch refuses a batch the pool cannot hold - and it is a real one,
    // since every host floors its own thread count and the byte total always
    // overstates what can be seated.
    const crumbs = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`h${i}`, 1.7]),
    );
    const { s, pool, calls, fire } = await makeStream({ hosts: crumbs });
    const before = pool.freeRam;

    // Placement happens at LAUNCH now, not at dispatch - so a pool too fragmented
    // to seat an op shows up when tick() tries to place it, and aborts the batch.
    fire();
    assert(s.stats.aborted === 1, `expected an abort, got ${s.stats.aborted}`);
    assert(!calls.some((c) => c.args[5] === "H"), "hack must not launch after an abort");
    // A batch is all-or-nothing. A partial reservation left behind would shrink
    // the pool on every failed attempt until nothing placed at all.
    assertClose(pool.pendingRam, 0, 1e-9, "failed launch leaked a reservation");
    assertClose(pool.freeRam, before, 1e-9, "failed launch leaked RAM");
  },

  "a batch too big for the pool is never enqueued": async () => {
    const { s, calls, fire } = await makeStream({ hosts: { home: 12 } });

    // The assertion that matters is the OP count, not the skip. Under JIT the
    // ops are placed at their own launch times, so a pool this tight used to
    // accept W1 and refuse G a hundred seconds later - leaving weakens squatting
    // their RAM for a full window against a batch that could never land. A live
    // run on a 1.6 TB pool aborted 169 of 170 batches that way and never
    // recovered, because the wreckage was what filled the pool.
    fire();
    assert(calls.length === 0, `nothing may launch, ${calls.length} ops went out`);
    assert(s.stats.aborted === 0, `a refused batch is not an abort, got ${s.stats.aborted}`);
    assert(
      s.stats.skips["no room for batch"] === 1,
      `expected one refusal, got ${JSON.stringify(s.stats.skips)}`,
    );
  },

  "the pipeline cannot over-commit the pool": async () => {
    // Sized for a handful of batches, not one and not hundreds.
    const { s, pool } = await makeStream({ hosts: { home: 1024 } });
    const free = pool.freeRam;

    // Dispatched WITHOUT ticking, which is the shape of the failure: a queued op
    // reserves nothing, so the pool reads free right up until the grows come due
    // together. Checking one batch against freeRam catches a batch too big on
    // its own and does nothing about seventy that are each affordable and
    // collectively are not - a live run held `depth 70 sent 70 done 0` and
    // logged `no room for G x69` against 0.03 TB of free RAM.
    let placed = 0;
    for (let i = 0; i < 50; i++) if (s.dispatch(Date.now()).dispatched) placed++;

    assert(placed > 0, "the fixture must fit at least one batch");
    assert(placed < 50, `the pipeline must stop before the pool is gone, took all ${placed}`);
    assert(
      s.queuedRam <= free,
      `queued ${s.queuedRam.toFixed(0)}GB against a ${free.toFixed(0)}GB pool`,
    );
  },

  "launching an op pays down what the pipeline owes": async () => {
    const { s, fire } = await makeStream({ hosts: { home: 1024 } });

    s.dispatch(Date.now());
    const owed = s.queuedRam;
    assert(owed > 0, "a planned batch owes the pool its RAM");

    // Once an op is placed the pool counts it, so counting it here too would
    // charge it twice and the gate would refuse batches that fit.
    fire();
    assertClose(s.queuedRam, 0, 1e-6, "RAM still owed after every op launched");
  },

  "a refused batch waits a cadence before trying again": async () => {
    const { s, mods } = await makeStream({ hosts: { home: 12 } });
    const { CADENCE_MS } = mods["config"];

    const now = Date.now();
    const res = s.dispatch(now);
    assert(!res.dispatched && res.why === "no room for batch", `got "${res.why}"`);

    // dueAt only advances on a SUCCESSFUL dispatch, so without this a stream
    // against a full pool re-plans every tick - a snapshot each time, 40 a
    // second - and reports "150/149 dispatches found no room" against a ratio
    // that is supposed to count one attempt per cadence slot.
    assert(!s.isDue(now + 10), "a refused batch must not retry on the next tick");
    assert(s.isDue(now + CADENCE_MS + 1), "it must retry once the slot comes round");
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
    const { s, calls, fire } = await makeStream({ hosts: { a: 130, b: 130 } });

    fire();
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
    const { s, calls, fire } = await makeStream();
    fire();
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
    const { s, fire } = await makeStream();
    fire();
    assert(!s.credit({ b: "not-a-batch", op: "H", p: 1, a: 1, r: 0 }), "a foreign id was accepted");
  },

  "the steal ceiling is enforced, not merely documented": async () => {
    const { mods } = await loadContinuous();
    const { clampSteal, maxStealForDrift, stealTolerance } = mods["lib/plan"];
    const { MAX_STEAL_FRACTION, GROW_DRIFT_TOLERANCE } = mods["config"];

    // MAX_STEAL_FRACTION used to exist only in prose - nothing read it - so
    // `--steal 0.99` was accepted and so was `--steal 5`, which sizes a hack to
    // take five times the server's money and a grow to restore from a balance
    // that cannot occur. A mistyped terminal argument was enough.
    const ceiling = Math.min(MAX_STEAL_FRACTION, maxStealForDrift());
    assert(clampSteal(0.99) === ceiling, `0.99 should clamp to ${ceiling}`);
    assert(clampSteal(5) === ceiling, `5 should clamp to ${ceiling}`);
    assert(clampSteal(0.1) === 0.1, "a sane fraction passes through untouched");

    // And the derived ceiling is the one that means something: every fraction
    // it admits gets the full drift budget, where MAX_STEAL_FRACTION on its own
    // admitted fractions the margin cap could only half-protect. A live run
    // took three targets to $0.1m in that gap.
    assertClose(stealTolerance(ceiling), GROW_DRIFT_TOLERANCE, 1e-9, "at the ceiling");
    assert(
      stealTolerance(ceiling + 0.01) < GROW_DRIFT_TOLERANCE,
      "just above it the cap must bind, which is why the ceiling exists",
    );

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

  "repeated bad batches back the fraction off even with no overshoot": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal } = mods["lib/plan"];
    const { BAD_BATCH_TOLERANCE } = mods["config"];

    // A sequencing fault is not a sizing fault, but the response to a PATTERN
    // of them is the same: a smaller steal makes every later batch cheaper to
    // get wrong and buys back tolerance while the cause is still unknown.
    const d = nextSteal(0.50, { batches: 20, bad: BAD_BATCH_TOLERANCE + 1, worstOver: 0 }, 0.95);
    assert(d.changed && d.steal < 0.50, "repeated bad batches should back off");
    assert(d.reason.includes("bad batch"), `reason was "${d.reason}"`);

    // A single one must not, and this is the half that cost money: a live run
    // cut alpha-ent from 94.8% to 56.9% on one batch out of 223 and left it
    // there, while rho-construction took the same 1-in-536 and held.
    const one = nextSteal(0.50, { batches: 20, bad: BAD_BATCH_TOLERANCE, worstOver: 0 }, 0.95);
    assert(one.steal >= 0.50, `one bad batch cut the fraction to ${one.steal}`);
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
    const bad = nextSteal(0.10, { batches: 2, bad: 2, worstOver: 0 }, 0.95);
    assert(bad.changed, "a fault should not wait for a full window");

    // One bad batch is not a fault, though. A stream carrying jitter near the
    // spacer produces them, a smaller steal does not make landings punctual,
    // and DESYNC_STRIKES consecutive ones still stop the stream outright.
    const one = nextSteal(0.10, { batches: 200, bad: 1, worstOver: 0 }, 0.95);
    assert(!one.changed || one.steal > 0.10, `one bad batch cut the fraction to ${one.steal}`);
  },

  "a back-off never raises the fraction": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal } = mods["lib/plan"];

    // chooseSteal hands back a one-hack-thread plan when even that is over
    // budget, and that fraction can sit BELOW MIN_STEAL_FRACTION. Clamping to
    // the floor then RAISES it on evidence that said to cut: a live run logged
    // `steal 0.3% -> 0.5% (400/400 dispatches found no room)`.
    const d = nextSteal(0.003, { attempts: 400, noRoom: 400 });
    assert(d.steal <= 0.003, `a back-off went UP, 0.003 -> ${d.steal}`);
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
    const { s, calls, fire } = await makeStream();
    fire();
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

  "the grow margin is derived from the fraction, so the tolerance is flat": async () => {
    const { mods } = await loadContinuous();
    const { growMarginFor, stealTolerance } = mods["lib/plan"];
    const { GROW_MARGIN, GROW_MARGIN_CAP, GROW_DRIFT_TOLERANCE } = mods["config"];

    // The inversion. A flat margin buys 42% of headroom at 10% steal and 0.27%
    // at 94.7% - generous where nothing can go wrong, absent where everything
    // can. Deriving it instead fixes the headroom and lets the cost move.
    // Exact wherever the algebra binds: everything from ~70% up to the derived
    // ceiling, which is the range where a batcher actually dies.
    const ceiling = mods["lib/plan"].maxStealForDrift();
    for (const f of [0.8, 0.9, ceiling]) {
      assertClose(stealTolerance(f), GROW_DRIFT_TOLERANCE, 1e-9, `tolerance at ${f}`);
    }
    // Above it the margin cap binds and the budget is no longer delivered,
    // which is exactly what clampSteal refuses to let happen.
    assert(stealTolerance(0.99) < GROW_DRIFT_TOLERANCE, "the cap must bind above the ceiling");
    // Below that the GROW_MARGIN floor binds and hands out MORE headroom than
    // asked for. Never less, at any fraction.
    for (const f of [0.05, 0.3, 0.5, 0.7]) {
      assert(stealTolerance(f) >= GROW_DRIFT_TOLERANCE - 1e-9, `headroom shrank at ${f}`);
    }

    // Cost rises with the fraction, which is the point.
    assert(growMarginFor(0.95) > growMarginFor(0.5), "margin must rise with steal");
    // ...but never below the flat value it replaces: at low fractions the
    // algebra asks for ~1.002 and the threads are cheap enough not to bother.
    assert(growMarginFor(0.05) === GROW_MARGIN, "the old constant is the floor");
    // Above ~98% no finite grow repairs the drift, so the cap binds instead of
    // returning something unplaceable.
    assert(growMarginFor(0.999) === GROW_MARGIN_CAP, "the cap must bind");
    assert(growMarginFor(0) === GROW_MARGIN && growMarginFor(1) === GROW_MARGIN, "degenerate");
  },

  "a batch repairs its own hack at the drift the-hub actually drifted by": async () => {
    const { mods } = await loadContinuous();
    const { growMarginFor } = mods["lib/plan"];
    const { GROW_MARGIN } = mods["config"];

    // The measured failure, reproduced as arithmetic. the-hub ran at a planned
    // 94.7% and went from $4723.8m to $9.4m in 18 landed batches - net x0.708
    // each. Solving `(1 - actual) * 1.05 / (1 - 0.947) = 0.708` gives an actual
    // take of 96.4%: 1.8% of drift against 0.27% of headroom.
    const planned = 0.947;
    const actual = 0.964;
    const net = (m) => (1 - actual) * m / (1 - planned);

    assertClose(net(GROW_MARGIN), 0.708, 0.01, "the flat margin loses 29% a batch");
    assert(net(growMarginFor(planned)) >= 1, `still drains: net ${net(growMarginFor(planned))}`);
  },

  "the ceiling survives the drift a live fleet actually produced": async () => {
    const { mods } = await loadContinuous();
    const { growMarginFor, maxStealForDrift, clampSteal } = mods["lib/plan"];

    // Measured, not chosen. One run stepped all three targets down within
    // seconds of each other - "overshoot 2.16% past the 2.00% tolerance", then
    // 2.13% and 2.13% - so the real drift over a weaken window on that fleet is
    // a little over 2%. A budget set at the observed value has no margin, and
    // at 94.9% steal a 2.16% overshoot nets x0.933 per batch: with 1061 batches
    // in flight the targets read $0.1m of $17482.0m before the controller's
    // correction reached a single landing.
    const drift = 0.0216;
    const p = clampSteal(0.99);
    const net = (1 - p * (1 + drift)) * growMarginFor(p) / (1 - p);
    assert(net >= 1, `the ceiling still drains at the measured drift: net ${net}`);

    // The old pairing did not, which is what the run demonstrated.
    const old = (1 - 0.949 * (1 + drift)) * growMarginFor(0.949, 0.02) / (1 - 0.949);
    assert(old < 1, `fixture wrong - the 2% budget should lose at 94.9%, got ${old}`);

    // And the ceiling is not a constant anyone typed: widen the budget and it
    // must come down, because a bigger budget costs more margin to buy.
    assert(maxStealForDrift(0.10) < maxStealForDrift(0.02), "a wider budget must lower the ceiling");
  },

  "grow is priced at the security it will meet, not the one we hope for": async () => {
    const { mods } = await loadContinuous();
    const { planThreadsForHack } = mods["lib/plan"];

    const seen = [];
    const math = {
      weakenPerThread: () => 0.05,
      securityPerHackThread: () => 0.002,
      securityPerGrowThread: () => 0.004,
      coreBonusFor: () => 1,
      growThreadsToRestore: (snap, from, to, atSecurity) => { seen.push(atSecurity); return 100; },
    };

    // A live run measured alpha-ent at 24.54 against a 17.00 minimum, with a
    // weaken window 45% longer than the one it was ranked on. Pricing grow at
    // the minimum there under-restores by whatever the gap is worth, and at a
    // high fraction that compounds within one window.
    planThreadsForHack(math, { maxMoney: 1e9, minSec: 17, sec: 24.54 }, 10, 0.01);
    assert(seen[0] === 24.54, `priced at ${seen[0]}, not the security it will meet`);

    // Never BELOW the minimum, which is where a healthy stream sits and what
    // the analyze backend would answer anyway.
    planThreadsForHack(math, { maxMoney: 1e9, minSec: 17, sec: 3 }, 10, 0.01);
    assert(seen[1] === 17, `priced at ${seen[1]}, below the floor prep holds`);
  },

  "the money floor still means something at the top of the range": async () => {
    const { mods } = await loadContinuous();
    const { baselineDrift } = mods["lib/plan"];
    const { MONEY_FLOOR_BATCHES } = mods["config"];

    const snap = (frac) => ({ maxMoney: 1e9, money: frac * 1e9, minSec: 10, sec: 10 });
    const th = (steal) => ({ actualSteal: steal, hackSec: 0.1, growSec: 0.2 });

    // `(1-s)^2` is 0.28% of max at 94.7%, so a target could lose 99.7% of its
    // money and pass. A live run reported OFF BASELINE at $9.4m of $4723.8m for
    // exactly that reason.
    const old = Math.pow(1 - 0.947, MONEY_FLOOR_BATCHES);
    assert(old < 0.01, "fixture assumes the power really is that permissive");
    assert(baselineDrift(snap(0.01), th(0.947)).moneyOff, "1% of max must read as drained");

    // Below ~50% the power is the tighter of the two and stays in charge.
    assertClose(baselineDrift(snap(0.5), th(0.10)).moneyFloor, 0.81e9, 1e-6, "10% steal");
    assert(!baselineDrift(snap(0.9), th(0.10)).moneyOff, "a healthy low-steal dip is not a drain");
  },

  "a stream whose drift is steady climbs back toward its ceiling": async () => {
    const { mods } = await loadContinuous();
    const { nextSteal, stealTolerance } = mods["lib/plan"];
    const { DRIFT_SAFETY } = mods["config"];

    // The steady state, by construction: the budget is DRIFT_SAFETY times the
    // worst drift seen and the margin is derived from the budget, so a target
    // behaving exactly as measured sits at 1/DRIFT_SAFETY of its own tolerance -
    // 0.667 - whatever the fraction and however clean the batches are.
    // 70%, not 30%: below ~44% the flat GROW_MARGIN floor dominates the derived
    // margin, so the tolerance is the same whatever drift is passed and the test
    // would pass without nextSteal honouring it at all.
    const drift = 0.09;
    const tol = stealTolerance(0.70, null, drift);
    const steady = tol / DRIFT_SAFETY;

    const d = nextSteal(0.70, { batches: 40, bad: 0, worstOver: steady }, 0.87, { drift });

    // A threshold below 0.667 does not mean "climb when comfortable", it means
    // "never climb". A live run held phantasy at 30.4% under an 87% ceiling and
    // iron-gym at 28.0% under 66% for a whole run, with bad 0 and hit 98%.
    assert(d.changed && d.steal > 0.70, `stuck at 70%: ${d.reason}`);
    assert(d.steal <= 0.87, `climbed past its ceiling to ${d.steal}`);
  },

  "drift is predicted from hack effectiveness, not inferred from money": async () => {
    const t = {
      moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
      hackPercentPerThread: 0.003, growBase: 1.0018,
      weakenTime: 20000, growTime: 16000, hackTime: 5000,
    };
    const { s, mods } = await makeStream({ servers: { t } });
    const { GROW_DRIFT_TOLERANCE, DRIFT_SAFETY } = mods["config"];

    const now = Date.now();
    s.dispatch(now);

    // Hack effectiveness rises 6% over one weaken window. That IS the drift: a
    // batch dispatched at the start of the window lands into this.
    t.hackPercentPerThread = 0.003 * 1.06;
    s.dispatch(now + 21000);

    // The report-based estimator cannot see this. `over` is stolen/take - 1, so
    // it only reveals drift while the target is FULL, and it is a decayed max of
    // a bursty series - hacking level rises in steps. A live run climbed three
    // targets to 94.7-95.0% on "worst overshoot 0.20% of a 0.50% tolerance" and
    // then took overshoots of 6.23% and 9.16%. All three drained to under 1%.
    assert(
      s.drift > GROW_DRIFT_TOLERANCE + 1e-9,
      `budget ignored a 6% trend: ${(s.drift * 100).toFixed(2)}%`,
    );
    assertClose(s.drift, 0.06 * DRIFT_SAFETY, 2e-3, "budget should be the trend times the safety factor");
  },

  "the drift budget cannot grow to excuse itself": async () => {
    const { s, calls, fire, mods } = await makeStream();
    const { MAX_DRIFT_TOLERANCE } = mods["config"];

    fire();
    const id = calls[calls.length - 1].args[2];
    const take = s.stats.lastThreads.take;
    for (const c of calls) {
      s.credit({
        b: id, op: c.args[5], t: c.threads,
        p: Number(c.args[4]), a: Number(c.args[4]),
        r: c.args[5] === "H" ? take * 2 : 1,
      });
    }
    s.retire();

    // 100% overshoot. Unbounded, that becomes a 150% drift budget, and since the
    // grow margin is derived from the budget the tolerance widens to cover it -
    // so the back-off that would catch the NEXT one can never fire. The
    // measurement grows to excuse the thing it exists to detect.
    assert(
      s.drift <= MAX_DRIFT_TOLERANCE + 1e-9,
      `budget ran away to ${(s.drift * 100).toFixed(0)}%`,
    );
  },

  "backing off does not wait out the hold, climbing does": async () => {
    const { s, calls, fire } = await makeStream();

    // Credit a batch that took far more than its grow was sized to restore.
    const overshoot = () => {
      const id = calls[calls.length - 1].args[2];
      const take = s.stats.lastThreads.take;
      for (const c of calls) {
        s.credit({
          b: id, op: c.args[5], t: c.threads,
          p: Number(c.args[4]), a: Number(c.args[4]),
          r: c.args[5] === "H" ? take * 2 : 1,
        });
      }
      calls.length = 0;
      s.retire();
    };

    fire();
    overshoot();
    const first = s.steal;
    assert(first < 0.1, `first overshoot did not back off: ${first}`);

    // The hold is now set. A CLIMB would have to wait it out - but the evidence
    // that a fraction is too high is conclusive the moment it arrives, and
    // every cadence spent waiting lands another oversized batch. A 94.7% target
    // drained in 18 batches while the controller sat out ~528 of them.
    fire();
    overshoot();
    assert(s.steal < first, `second overshoot waited for the hold: ${s.steal}`);
  },

  "evidence from the old fraction cannot re-trigger a step": async () => {
    const { s, calls, fire } = await makeStream();

    // Two batches planned at 0.1, in flight together.
    fire();
    const a = [...calls];
    calls.length = 0;
    fire();
    const b = [...calls];

    const take = s.stats.lastThreads.take;
    const creditAll = (list) => {
      const id = list[0].args[2];
      for (const c of list) {
        s.credit({
          b: id, op: c.args[5], t: c.threads,
          p: Number(c.args[4]), a: Number(c.args[4]),
          r: c.args[5] === "H" ? take * 2 : 1,
        });
      }
      s.retire();
    };

    creditAll(a);
    const after = s.steal;
    assert(after < 0.1, "the first batch should have backed it off");

    // B was PLANNED at 0.1 and says nothing about the fraction now in force.
    // Counting it would step down again on the same fault, and at a cadence of
    // 400ms against a weaken window, a whole window of stale reports would walk
    // the fraction to the floor for one bad reading.
    creditAll(b);
    assert(s.steal === after, `stale evidence moved the fraction to ${s.steal}`);
  },

  "a snapshot alone cannot stop a stream whose hacks keep finding it full": async () => {
    const t = {
      moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
      hackPercentPerThread: 0.003, growBase: 1.0018,
      weakenTime: 20000, growTime: 16000, hackTime: 5000,
    };
    const { s, calls, fire, mods } = await makeStream({ servers: { t } });
    const { DESYNC_STRIKES } = mods["config"];

    const creditLast = (share) => {
      const list = [...calls];
      calls.length = 0;
      const id = list[0].args[2];
      const take = s.stats.lastThreads.take;
      for (const c of list) {
        s.credit({
          b: id, op: c.args[5], t: c.threads,
          p: Number(c.args[4]), a: Number(c.args[4]),
          r: c.args[5] === "H" ? take * share : 1,
        });
      }
      s.retire();
    };

    // One batch that found the target exactly as full as it was planned for.
    fire();
    creditLast(1);
    assert(s.stats.hackHits === 1, "setup: one landed hack");
    assert(!s.drained, "a hack that found the target full is not a drain");

    // Now show the dispatch gate a target that reads empty. The snapshot is
    // taken at whatever point of the cycle dispatch happens to fall on, and
    // dispatch is paced at exactly the batch cadence - so it reads the SAME
    // point every time, and at a high fraction that point is often the
    // post-hack dip. Three consecutive readings used to stop the stream.
    t.moneyAvailable = 1e6;
    for (let i = 0; i < DESYNC_STRIKES + 2; i++) s.dispatch();
    assert(!s.stopped, `a snapshot stopped a healthy stream: ${s.stopped}`);

    // The reports are the honest measurement: `over` is taken at the instant a
    // hack landed, which is the only moment the balance has to be right. Once
    // THEY say the target was not full, the snapshot is corroborated and the
    // stream stops for re-prep as it always did.
    t.moneyAvailable = 1e9;
    fire();
    creditLast(0.05);
    assert(s.lastUnder < -0.25, `setup: expected a drained reading, got ${s.lastUnder}`);
    // The same verdict the RANKING reads, so a live stream is priced on its
    // reports rather than on whenever a rescan happened to look at it.
    assert(s.drained, "the reports say drained; the getter must agree");

    t.moneyAvailable = 1e6;
    for (let i = 0; i < DESYNC_STRIKES; i++) s.dispatch();
    assert(s.stopped === "off baseline", `a corroborated drain must stop: ${s.stopped}`);
  },

  // ---------------------------------------------------- steal calculator ---

  "the held-time RAM model reduces to the old depth x gb under all-at-once": async () => {
    const { mods } = await loadContinuous();
    const { avgConcurrentRam, heldAllAtOnce, batchRam } = mods["lib/plan"];
    const { CADENCE_MS } = mods["config"];

    const threads = { hack: 28, weaken1: 2, grow: 107 };
    const ram = { hack: 1.7, grow: 1.75, weaken: 1.75 };
    const times = { hack: 5000, grow: 16000, weaken: 20000 };
    const w2 = 5;

    // This equivalence is the whole reason the calculator can be written now
    // and reused unchanged by the JIT dispatcher: under all-at-once every op is
    // held ~W, so ramSeconds/cadence collapses to the figure admission has
    // always used. Phase 3 changes the model by passing different held times,
    // not by rewriting anything.
    const depth = times.weaken / CADENCE_MS;
    const old = batchRam(threads, ram, w2) * depth;
    const got = avgConcurrentRam(threads, ram, heldAllAtOnce(times, 0), w2, CADENCE_MS);

    assertClose(got, old, 1e-6, "held-time model disagrees with depth x gb");
  },

  "JIT held times cost less than all-at-once ones": async () => {
    const { mods } = await loadContinuous();
    const { heldAllAtOnce, batchRamSeconds } = mods["lib/plan"];

    const times = { hack: 5000, grow: 16000, weaken: 20000 };
    const held = heldAllAtOnce(times, 100);
    assert(held.H > times.weaken * 0.9, "all-at-once holds hack nearly the whole window");

    // Each op held for its own duration - the arithmetic behind the ~27%.
    const jit = { H: times.hack, W1: times.weaken, G: times.grow, W2: times.weaken };
    const threads = { hack: 28, weaken1: 2, grow: 107 };
    const ram = { hack: 1.7, grow: 1.75, weaken: 1.75 };

    const now = batchRamSeconds(threads, ram, held, 5);
    const then = batchRamSeconds(threads, ram, jit, 5);
    assert(then < now, "JIT held times must cost less");
    assert(then / now < 0.8 && then / now > 0.6, `expected ~0.7x, got ${(then / now).toFixed(3)}`);
  },

  "an unconstrained pool calculates the ceiling fraction": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 1048576 },
      servers: {
        rich: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
                hackPercentPerThread: 0.003, growBase: 1.0018,
                weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });
    const { chooseSteal, maxStealForDrift } = mods["lib/plan"];
    const { MAX_STEAL_FRACTION } = mods["config"];

    // Income is LINEAR in steal with no interior optimum, so with RAM to spare
    // the answer is simply the ceiling. Less would mean the search stops early.
    //
    // The ceiling is the DERIVED one, not MAX_STEAL_FRACTION: RAM has nothing
    // to say about whether a fraction can repair itself, and a calculator that
    // answered the RAM question alone handed streams 94.3% with a drift budget
    // that could not cover them.
    const ceiling = Math.min(MAX_STEAL_FRACTION, maxStealForDrift());
    const got = chooseSteal(math, math.snapshot(ns, "rich"), ram, 1e9);
    assert(got.fits, "should fit on an effectively infinite budget");
    assert(got.capped, "should report that it hit the ceiling");
    assertClose(got.steal, ceiling, 0.01, "should land at the ceiling");
  },

  "a tight budget slows the pace instead of shrinking the bite": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });
    const { chooseSteal, planThreadsForHack, batchRamSeconds, heldAllAtOnce, weaken2For } =
      mods["lib/plan"];
    const { CADENCE_MS } = mods["config"];

    const snap = math.snapshot(ns, "t");
    const perThread = math.hackFractionPerThread(snap);
    const held = heldAllAtOnce(math.opTimes(snap));
    const budget = 20000;
    const got = chooseSteal(math, snap, ram, budget);

    // Shrinking the bite cannot fix a DEPTH problem - the floor of a batch is
    // one hack thread plus the weakens that cancel it, and a whole pipeline of
    // those still does not fit. A live run duly settled on 0.3% steal, 38x over
    // budget, and earned $0.14m/s while refusing 816 dispatches to land 3.
    assert(got.cadence > CADENCE_MS, `stayed at the configured pace: ${got.cadence}ms`);
    assert(!got.fits, "a budget this tight cannot run at the configured pace");
    assertClose(got.gb, budget, budget * 1e-6, "the pace must spend the budget, not exceed it");
    assert(
      got.steal > perThread * 10,
      `collapsed to the thread floor: ${(got.steal * 100).toFixed(2)}%`,
    );

    // And it must be the highest-INCOME pace, which is the whole objective now.
    // Both ends of the range are worse: one thread wastes the budget on batch
    // overhead, the ceiling spends it all on grow threads that scale as
    // ln(1/(1-steal)) while income only scales linearly.
    const incomeAt = (hack) => {
      const th = planThreadsForHack(math, snap, hack, perThread);
      const ramSeconds = batchRamSeconds(th, ram, held, weaken2For(math, th.grow));
      return th.take / Math.max(CADENCE_MS, ramSeconds / budget);
    };
    const ceiling = Math.floor(0.943 / perThread);
    assert(got.income >= incomeAt(1), "one thread earns more than the chosen plan");
    assert(got.income >= incomeAt(ceiling), "the ceiling earns more than the chosen plan");
  },

  "the cost function is monotonic, which is what makes the search valid": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });
    const { planThreadsForHack, avgConcurrentRam, heldAllAtOnce, weaken2For } = mods["lib/plan"];

    // A binary search over a non-monotonic cost returns a wrong answer SILENTLY
    // rather than failing, so assert it directly instead of trusting the
    // reasoning about growThreadsToRestore.
    const snap = math.snapshot(ns, "t");
    const perThread = math.hackFractionPerThread(snap);
    const held = heldAllAtOnce(math.opTimes(snap));

    let prev = 0;
    for (let h = 1; h <= 200; h += 7) {
      const th = planThreadsForHack(math, snap, h, perThread);
      const gb = avgConcurrentRam(th, ram, held, weaken2For(math, th.grow));
      assert(gb > prev, `cost fell from ${prev.toFixed(1)} to ${gb.toFixed(1)} at ${h} threads`);
      prev = gb;
    }
  },

  "a larger budget never yields a smaller fraction": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });
    const { chooseSteal } = mods["lib/plan"];

    const snap = math.snapshot(ns, "t");
    let last = 0;
    for (const budget of [500, 2000, 8000, 32000, 128000, 1e9]) {
      const got = chooseSteal(math, snap, ram, budget);
      assert(got !== null, `no answer at budget ${budget}`);
      assert(got.steal >= last - 1e-9, `budget ${budget} gave LESS steal than a smaller one`);
      last = got.steal;
    }
  },

  "one batch must fit at once, not merely on average": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 600000, growTime: 480000, hackTime: 150000 },
      },
    });
    const { chooseSteal, batchRam } = mods["lib/plan"];

    // A long weaken window means the cadence has enormous room to widen, so the
    // MEAN occupancy can be brought inside any budget at any thread count. The
    // mean is not what the pool has to hold: widening pushes depth down, and
    // past depth 1 there is no overlap left to average over.
    //
    // A live run priced iron-gym at "0.46TB of a 0.46TB slice, paced at 363.9s"
    // and the batch behind that average was 9.29TB on a 1.6TB pool. It placed
    // weakens and never once placed its grow - `sent 2 done 0, no room for G`.
    // 400 GB, not a round 1000: the unbounded income optimum for this fixture
    // is 91 threads at a 550 GB batch whatever the budget, so a budget above
    // that would pass without the bound ever being consulted.
    const budget = 400;
    const got = chooseSteal(math, math.snapshot(ns, "t"), ram, budget);

    assert(got.gb <= budget * (1 + 1e-9), `mean ${got.gb.toFixed(0)}GB over budget`);
    assert(
      got.peak <= budget * (1 + 1e-9),
      `a ${got.peak.toFixed(0)}GB batch against a ${budget}GB budget`,
    );
    assertClose(
      got.peak,
      batchRam(got.threads, ram, got.threads.weaken2),
      1e-6,
      "the reported peak must be the batch it actually plans",
    );
    assert(got.hack >= 1 && got.income > 0, `got hack=${got.hack} income=${got.income}`);
  },

  "an absurd budget yields a slow plan, never NaN": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });
    const { chooseSteal } = mods["lib/plan"];

    // A gigabyte of budget is a millionth of one batch. There is still an
    // answer - a very slow one - and the caller must be able to tell that this
    // is the case rather than getting null, NaN, or a plan that claims to fit.
    const got = chooseSteal(math, math.snapshot(ns, "t"), ram, 0.001);
    assert(got !== null, "should still return an answer");
    assert(got.fits === false, "should report that it cannot run at the configured pace");
    assert(Number.isFinite(got.cadence) && got.cadence > 0, `cadence ${got.cadence}`);
    assert(Number.isFinite(got.gb) && got.gb > 0, `gb ${got.gb}`);
    assert(Number.isFinite(got.income), `income ${got.income}`);
  },

  "a pinned fraction overrides the calculation": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 1048576 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });
    const { chooseSteal } = mods["lib/plan"];

    // --steal exists for controlled measurement, where a self-sizing fraction
    // is exactly what ruins the experiment.
    const snap = math.snapshot(ns, "t");
    const free = chooseSteal(math, snap, ram, 1e9);
    const pinned = chooseSteal(math, snap, ram, 1e9, { pin: 0.25 });

    assert(pinned.steal < free.steal, "the pin should hold it below the calculated optimum");
    assertClose(pinned.steal, 0.25, 0.005, `pinned at ${pinned.steal}`);
  },

  "the calculated fraction is a ceiling the controller can descend from": async () => {
    const { s, mods } = await makeStream({ steal: 0.8 });
    const { MAX_STEAL_FRACTION } = mods["config"];

    s.setBase(0.8);
    assert(s.cap === 0.8, `cap ${s.cap}`);

    // A ceiling, not an assignment. The calculator knows what the SERVER and the
    // RAM allow; only the reports know about hacking-level drift, so a stream
    // that has backed off must not be yanked back up by a rescan.
    s.setBase(0.6);
    assert(s.cap === 0.6 && s.steal <= 0.6, `lowering the base must pull steal down: ${s.steal}`);

    s.setBase(0.9);
    assert(s.cap === 0.9, "raising the base raises the ceiling");
    assert(s.steal <= 0.6, "but must NOT yank the fraction back up");

    // And the ceiling can never exceed either bound: MAX_STEAL_FRACTION, or the
    // largest fraction whose drift budget the margin can actually buy. The
    // second is usually the binding one, and it moves with what the stream has
    // measured rather than being a constant anyone typed.
    const { maxStealForDrift } = mods["lib/plan"];
    s.setBase(5);
    const hard = Math.min(MAX_STEAL_FRACTION, maxStealForDrift(s.drift));
    assert(s.cap === hard, `cap escaped to ${s.cap}, wanted ${hard}`);
    assert(s.cap < MAX_STEAL_FRACTION, "the derived ceiling should be the binding one here");
  },

  "a drained target cannot push its anchors two weaken windows out": async () => {
    // minSec far below one batch's security churn, which is the shape a drained
    // target takes: grow gets sized to climb back from almost nothing, so
    // growSec dwarfs the minimum the weakens are holding it at.
    const t = {
      moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 0.1, hackDifficulty: 0.1,
      hackPercentPerThread: 0.003, growBase: 1.0018,
      weakenTime: 20000, growTime: 16000, hackTime: 5000,
    };
    const { s, mods } = await makeStream({
      servers: { t }, steal: 0.94, hosts: { home: 1048576 },
    });
    const { MIN_LEAD_MS, MAX_ANCHOR_SWING } = mods["config"];

    const before = Date.now();
    const res = s.dispatch();
    assert(res.dispatched, `dispatch failed: ${res.why}`);

    const lead = res.anchor - before;
    // Weaken-1 lands ON the anchor and runs a full weaken, so a full window is
    // the floor. The swing allowance sits on top of that and used to be able to
    // double it: at 1, and a 480s window, a live run put every new batch's
    // deadline sixteen minutes out and froze two streams solid - `done` stuck
    // while `sent` climbed, depth pinned at MAX_IN_FLIGHT, and free RAM rising
    // because nothing was due to launch.
    assert(lead >= 20000, `anchor ${lead}ms out - weaken-1 cannot reach it`);
    assert(
      lead <= 20000 * (1 + MAX_ANCHOR_SWING) + MIN_LEAD_MS + 100,
      `anchor ${lead}ms out, past the ${MAX_ANCHOR_SWING} swing allowance`,
    );

    // But the LAUNCH allowance is a separate number and must stay generous.
    // Capping both was one edit and it cost ~200 aborts per stream in a live
    // run - "W1 missed its slot x116, G missed its slot x82" - because ops in
    // this exact shape were judged not-yet-due and then found unreachable.
    // Launching early is nearly free; launching late loses the batch.
    const before2 = s.stats.aborted;
    s.tick(Date.now() + 1e9);
    assert(s.stats.aborted === before2, `capping the anchor must not abort ops: ${s.stats.aborted}`);
    assert(s.depth === 1, "the batch should still be in flight, fully launched");
  },

  "the drift budget is measured per target, and the ceiling follows it": async () => {
    const { s, calls, fire, mods } = await makeStream();
    const { GROW_DRIFT_TOLERANCE, DRIFT_SAFETY } = mods["config"];

    // A new stream has measured nothing, so it budgets the floor.
    assertClose(s.drift, GROW_DRIFT_TOLERANCE, 1e-12, "a fresh stream budgets the floor");
    const capBefore = s.cap;

    // Now show it a window that drifted far more than the floor allows. Drift
    // is hacking level moving between dispatch and landing, so it scales with
    // the weaken window: one run measured 4.41% on a 266s target and 6.37% on a
    // 473s one against a single 4.00% constant, and the long one earned $49.97b
    // while holding a third of the RAM that the short one turned into $17.27t.
    const over = 0.10;
    fire();
    const take = s.stats.lastThreads.take;
    const id = calls[0].args[2];
    for (const c of calls) {
      s.credit({
        b: id, op: c.args[5], t: c.threads,
        p: Number(c.args[4]), a: Number(c.args[4]),
        r: c.args[5] === "H" ? take * (1 + over) : 1,
      });
    }
    s.retire();

    assertClose(s.drift, over * DRIFT_SAFETY, 1e-9, "the budget must follow the measurement");
    assert(s.cap < capBefore, `a wider budget must lower the ceiling: ${s.cap} vs ${capBefore}`);
    assert(s.steal <= s.cap, "and the fraction must be pulled under it");
  },

  "a drain is measured from every hack, not only the ones the controller owns": async () => {
    const { s, calls, fire } = await makeStream();

    // Two batches in flight, both planned at the starting fraction.
    fire();
    const a = [...calls];
    calls.length = 0;
    fire();
    const b = [...calls];

    const take = s.stats.lastThreads.take;
    const creditAll = (list, share) => {
      const id = list[0].args[2];
      for (const c of list) {
        s.credit({
          b: id, op: c.args[5], t: c.threads,
          p: Number(c.args[4]), a: Number(c.args[4]),
          r: c.args[5] === "H" ? take * share : 1,
        });
      }
      s.retire();
    };

    // A overshoots, so the controller steps down and the evidence window is now
    // attributed to the NEW fraction.
    creditAll(a, 2);
    assert(s.steal < 0.1, "setup: the overshoot should have backed it off");
    assert(!s.drained, "setup: an overshoot is not a drain");

    // B was planned at the old fraction, so it says nothing about the new one -
    // but it says everything about the TARGET, which is empty. Gating this on
    // the controller's attribution was a real outage: the fraction wobbles by a
    // tenth of a percent every window, resetting the attribution, so a stream
    // whose target had emptied never corroborated its own money check and never
    // stopped. Two of them hacked a server at 0.05% of max for 500 batches and
    // reported `hit 100%, bad 0` throughout, because every batch really did
    // land in order - on nothing.
    creditAll(b, 0.0001);
    assert(s.drained, `a drained target must read as drained: lastUnder ${s.lastUnder}`);
  },

  "a proven stream is priced at its own drift budget, not the default": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 1048576 },
      servers: {
        rich: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
                hackPercentPerThread: 0.003, growBase: 1.0018,
                weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });
    const { priceTargets } = mods["core"];

    const ranked = [{ host: "rich", chance: 1 }];
    const live = new Set(["rich"]);
    const price = (drifts) =>
      priceTargets(ns, math, ram, 0.1, ranked, live, new Map(), Infinity, null, new Set(), drifts);

    // The calculator hands the stream its BASE, and the stream's own ceiling can
    // never exceed it. So pricing every target at the conservative pre-evidence
    // default pins a target that has proved itself steady - a live run held
    // alpha-ent and rho-construction at 91.7% for a whole run while they were
    // measuring 0.22% and 0.42% of drift.
    const byDefault = price(new Map());
    const byEvidence = price(new Map([["rich", 0.005]]));

    assert(
      byEvidence[0].fit.steal > byDefault[0].fit.steal,
      `evidence must raise the base: ${byEvidence[0].fit.steal} vs ${byDefault[0].fit.steal}`,
    );
  },

  "a target that measures LESS drift than the default is let up, not held down": async () => {
    const { s, calls, fire, mods } = await makeStream();
    const { GROW_DRIFT_TOLERANCE, MAX_STEAL_FRACTION } = mods["config"];
    const { maxStealForDrift } = mods["lib/plan"];

    s.setBase(MAX_STEAL_FRACTION);
    const capBefore = s.cap;
    assertClose(capBefore, maxStealForDrift(GROW_DRIFT_TOLERANCE), 1e-9, "pre-evidence ceiling");

    // Measured drift differs by an order of magnitude between targets in one
    // run - 0.34% on alpha-ent against 4.50% on nova-med - so the constant can
    // only be the PRE-EVIDENCE default. Holding a target that has proved itself
    // steady at a budget sized for the worst one costs income for nothing.
    fire();
    const take = s.stats.lastThreads.take;
    const id = calls[0].args[2];
    for (const c of calls) {
      s.credit({
        b: id, op: c.args[5], t: c.threads,
        p: Number(c.args[4]), a: Number(c.args[4]),
        r: c.args[5] === "H" ? take * 1.001 : 1,
      });
    }
    s.retire();

    assert(s.drift < GROW_DRIFT_TOLERANCE, `budget stuck at the default: ${s.drift}`);
    assert(s.cap > capBefore, `a proven target must be let up: ${s.cap} vs ${capBefore}`);
    assert(s.cap <= MAX_STEAL_FRACTION, "but never past the hard cap");
  },

  // --------------------------------------------------------------- JIT ----

  "a dispatch places and execs nothing - only tick does": async () => {
    const { s, calls, pool } = await makeStream();
    const before = pool.freeRam;

    const res = s.dispatch();
    assert(res.dispatched, `dispatch failed: ${res.why}`);

    // The whole change in one assertion. A dispatch used to place all four ops
    // and exec them, so a hack thread held 1.70 GB doing nothing for nearly a
    // whole weaken window. Now it only queues.
    assert(calls.length === 0, `dispatch exec'd ${calls.length} workers`);
    assertClose(pool.freeRam, before, 1e-9, "dispatch must reserve nothing");
    assert(s.depth === 1, "the batch is in flight even though nothing has launched");
  },

  "the late ops wait; only the ones actually due go out": async () => {
    const { s, calls, mods } = await makeStream();
    const { LAUNCH_LEAD_MS, MIN_LEAD_MS } = mods["config"];
    s.dispatch();

    s.tick(Date.now());

    // Weaken-1 is due at A - W, and the anchor sits at now + W + MIN_LEAD_MS -
    // so it is due within MIN_LEAD_MS. With LAUNCH_LEAD_MS larger than that it
    // is inside the lead window immediately and goes out at once, which is
    // exactly what the all-at-once dispatcher did with it too (delay 0, land A).
    assert(LAUNCH_LEAD_MS > MIN_LEAD_MS, "fixture assumes the lead exceeds the anchor cushion");
    // Both weakens are due immediately - they run for a full W, so they have to
    // start a full W before they land, and the anchor is only MIN_LEAD_MS
    // further out than that. The all-at-once dispatcher launched them at the
    // same moment for the same reason.
    for (const c of calls) {
      assert(c.args[5] === "W1" || c.args[5] === "W2", `${c.args[5]} should not be due yet`);
    }

    // The ones that matter are still waiting: hack is due 0.75W later, and
    // launching it now is the whole thing JIT exists to avoid.
    assert(!calls.some((c) => c.args[5] === "H"), "hack must not launch at dispatch");
    assert(!calls.some((c) => c.args[5] === "G"), "grow must not launch at dispatch");

    s.tick(Date.now() + 1e9);
    assert(calls.length >= 4, `expected all four ops, got ${calls.length}`);
  },

  "every launched op gets a non-negative additionalMsec": async () => {
    const { calls, fire } = await makeStream();
    fire(3);

    // The game THROWS on a negative additionalMsec (NetscriptHelpers.tsx:363),
    // so this is a crash, not a mistiming.
    for (const c of calls) {
      const delay = Number(c.args[1]);
      assert(Number.isFinite(delay) && delay >= 0, `${c.args[5]} got delay ${delay}`);
    }
  },

  "RAM is held for each op's own duration, not the whole window": async () => {
    const { s, calls, mods, fire } = await makeStream();
    const { batchRamSeconds, heldAllAtOnce } = mods["lib/plan"];

    fire();
    const th = s.stats.lastThreads;
    const ram = { hack: 1.7, grow: 1.75, weaken: 1.75 };
    const times = { hack: 5000, grow: 16000, weaken: 20000 };

    // What the ops were actually launched with, read back off the exec calls:
    // land - delay - now is each op's measured duration, and that is how long
    // it holds its RAM.
    const jitHeld = { H: times.hack, W1: times.weaken, G: times.grow, W2: times.weaken };
    const jit = batchRamSeconds(th, ram, jitHeld, th.weaken2);
    const allAtOnce = batchRamSeconds(th, ram, heldAllAtOnce(times), th.weaken2);

    assert(jit < allAtOnce, "JIT must hold less RAM-time than all-at-once");
    // Hack is the big multiple (4x) but the small share; grow dominates and only
    // saves 20% of its own time. Hence ~27% rather than something dramatic.
    const saved = 1 - jit / allAtOnce;
    assert(saved > 0.15 && saved < 0.45, `saving ${(saved * 100).toFixed(1)}% is off the model`);
    assert(calls.length >= 4, "sanity: the batch did launch");
  },

  "an op that misses its slot aborts the batch instead of landing late": async () => {
    const { s, calls, mods } = await makeStream();
    const { SPACER_MS } = mods["config"];

    s.dispatch();
    // Launch W1 and W2 normally, then jump the clock so grow can no longer
    // reach its landing. Launching it anyway would put it somewhere in the
    // sequence nobody chose.
    s.tick(Date.now() + 1e9);
    const launched = calls.map((c) => c.args[5]);

    assert(SPACER_MS > 0, "sanity");
    // With everything due at once the batch completes normally; the abort path
    // is exercised by the placement and exec tests. What matters here is that
    // no op was launched with a delay that would land it out of order.
    const landOf = (op) => Number(calls.find((c) => c.args[5] === op).args[4]);
    assert(landOf("H") < landOf("W1"), `H must land before W1: ${launched.join(",")}`);
    assert(landOf("W1") < landOf("G"), "W1 must land before G");
    assert(landOf("G") < landOf("W2"), "G must land before W2");
  },

  "a slightly late op launches anyway instead of abandoning the batch": async () => {
    const { s, calls, mods } = await makeStream();
    const { LATE_TOLERANCE_MS, SPACER_MS } = mods["config"];

    // The tolerance has to leave a clear margin against reordering, since the
    // ops of a batch are one spacer apart.
    assert(LATE_TOLERANCE_MS > 0, "a zero tolerance aborts on any drift at all");
    assert(LATE_TOLERANCE_MS < SPACER_MS, "tolerating a whole spacer could reorder ops");

    s.dispatch();
    s.tick(Date.now() + 1e9);

    // Every op launched; nothing was abandoned for being a few ms behind. The
    // strict check this replaces abandoned 1450 of 1826 batches in a live run,
    // because the due-ness scan reads a cached op time and hackTime moves with
    // security.
    assert(s.stats.aborted === 0, `aborted ${s.stats.aborted}: ${JSON.stringify(s.stats.abortReasons)}`);
    assert(calls.length >= 4, `only ${calls.length} ops launched`);
  },

  "an op that is late beyond tolerance still aborts": async () => {
    const { ns, math, pool, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });

    // Tolerating lateness must not become tolerating anything. Past the
    // threshold an op lands out of sequence, and a batch whose grow lands
    // before its hack is the case that actually loses money.
    let slow = false;
    const drifting = {
      ...math,
      // Op times balloon after the batch is planned - which is the real hazard
      // in miniature: security rises, durations grow, and an op that looked
      // reachable at plan time no longer is.
      opTimes: (snap) => (slow
        ? { hack: 1e7, grow: 1e7, weaken: 1e7 }
        : math.opTimes(snap)),
    };

    const calls = [];
    ns.exec = (file, host, threads, ...args) => {
      calls.push({ file, host, threads, args });
      return calls.length;
    };

    const s = mods["lib/stream"].createStream(ns, drifting, {
      host: "t", pool, ram, steal: 0.1, log: () => {},
    });

    s.dispatch();
    slow = true;
    s.tick(Date.now() + 1e9);

    assert(s.stats.aborted === 1, `expected an abort, got ${s.stats.aborted}`);
    assert(!calls.some((c) => c.args[5] === "H"), "hack must not launch after an abort");
    const reasons = Object.keys(s.stats.abortReasons).join(",");
    assert(reasons.includes("missed its slot"), `abort reason was "${reasons}"`);
  },

  "an op time that stretches with security does not abandon the batch": async () => {
    const { ns, math, pool, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });

    // The real failure, in miniature. A streaming target sits at minimum
    // security only about half the time; the rest of the time it carries one
    // batch's uncancelled hack or grow, and op times stretch with it. An op
    // scheduled against the relaxed figure is already late when it starts.
    //
    // A live run abandoned 59% of one target's grows this way - 177 of ~300 -
    // because a fixed lead cannot cover a swing that scales with the weaken
    // time.
    //
    // The allowance is (hackSec + growSec) / minSec, which for this fixture is
    // ~8.2%. Stretching by 5% is inside it and must survive; stretching far
    // past it must still abort, because a target whose times move more than one
    // batch's security can account for is not behaving like the model and
    // launching into it would land ops out of sequence.
    let stretch = 1;
    const stretchy = {
      ...math,
      opTimes: (snap) => {
        const t = math.opTimes(snap);
        return { hack: t.hack * stretch, grow: t.grow * stretch, weaken: t.weaken * stretch };
      },
    };

    const calls = [];
    ns.exec = (file, host, threads, ...args) => {
      calls.push({ file, host, threads, args });
      return calls.length;
    };

    const s = mods["lib/stream"].createStream(ns, stretchy, {
      host: "t", pool, ram, steal: 0.1, log: () => {},
    });

    s.dispatch();
    stretch = 1.05;
    s.tick(Date.now() + 1e9);

    assert(
      s.stats.aborted === 0,
      `aborted ${s.stats.aborted}: ${JSON.stringify(s.stats.abortReasons)}`,
    );
    assert(calls.some((c) => c.args[5] === "G"), "grow should still have launched");
    assert(calls.some((c) => c.args[5] === "H"), "and so should hack");

    // Beyond the allowance it still aborts - the tolerance is derived, not a
    // blanket excuse for any drift at all.
    stretch = 1;
    s.dispatch();
    stretch = 3;
    s.tick(Date.now() + 1e9);
    assert(s.stats.aborted > 0, "a swing far past the model must still abort");
  },

  "a stopped stream discards its queued ops": async () => {
    const { s, calls, mods } = await makeStream({
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e6, minDifficulty: 5, hackDifficulty: 40,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });
    const { DESYNC_STRIKES } = mods["config"];

    // Get one batch queued against a healthy read, then drive it off baseline.
    for (let i = 0; i < DESYNC_STRIKES + 1; i++) s.dispatch();
    assert(s.stopped, "the fixture should stop the stream");

    s.tick(Date.now() + 1e9);
    // Firing queued hacks into a target already known to be wrong is exactly
    // what stopping is for.
    assert(!calls.some((c) => c.args[5] === "H"), "a stopped stream launched a hack");
  },

  "a wound-down stream still launches the batches it already planned": async () => {
    const { s, calls } = await makeStream();

    s.dispatch();
    s.windDown();
    s.tick(Date.now() + 1e9);

    // Unlike a stopped stream, these batches are part-paid for - the target is
    // fine, it is just being handed over. Finishing them earns their money.
    assert(calls.length >= 4, `a draining stream should finish its batch, launched ${calls.length}`);
    assert(calls.some((c) => c.args[5] === "H"), "including its hack");
  },

  // ----------------------------------------------------------- intrusion ---

  "a hack landing inside another batch's restore is an intrusion": async () => {
    const { s, calls, fire } = await makeStream();

    // Two batches in flight. Batch A hacks, and before A's grow lands, B hacks
    // the same server - so A's grow was sized against money B has just taken,
    // and A under-refills. Every op of BOTH batches landed in perfect order, so
    // the per-batch verdict cannot see this at all.
    fire();
    const a = calls[0].args[2];
    calls.length = 0;
    fire();
    const b = calls[0].args[2];
    assert(a !== b, "the two batches need distinct ids");

    s.credit({ b: a, op: "H", t: 1, p: 1000, a: 1000, r: 5e7 });
    s.credit({ b: b, op: "H", t: 1, p: 1400, a: 1400, r: 5e7 }); // A has not grown
    assert(s.stats.intrusions === 1, `expected 1 intrusion, got ${s.stats.intrusions}`);
  },

  "the normal cadence produces no intrusions": async () => {
    const { s, calls, fire } = await makeStream();

    fire();
    const a = calls[0].args[2];
    calls.length = 0;
    fire();
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
    const { s, calls, fire } = await makeStream();

    fire();
    const a = calls[0].args[2];
    const aCalls = [...calls];
    calls.length = 0;
    fire();
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

    const { CADENCE_MS } = mods["config"];

    const t = (host, gb, weaken) => ({ host, gb, times: { weaken } });
    const priced = [t("a", 100, 40000), t("b", 100, 40000), t("c", 100, 40000)];

    // Depth is weakenTime / cadence, so every figure here moves when the spacer
    // is tuned. Derived rather than written out: the literals were 100 and
    // 10000GB at a 400ms cadence, and they failed the day the cadence became
    // 320 - for no reason except that they were literals.
    const depth = Math.ceil(40000 / CADENCE_MS);
    const want = depth * 100;

    // Budget for two and a half targets, so the third is refused on RAM.
    const { admitted, committed } = admitTargets(priced, want * 2.5, 12);
    assert(admitted.length === 2, `expected 2 admitted, got ${admitted.length}`);
    assert(committed === want * 2, `committed ${committed}, expected ${want * 2}`);
    assert(admitted[0].depth === depth && admitted[0].want === want, "depth/want recorded");
  },

  "a cheap target still gets in behind one that did not fit": async () => {
    const { mods } = await loadContinuous();
    const { admitTargets } = mods["core"];

    const { CADENCE_MS } = mods["config"];
    const depth = Math.ceil(40000 / CADENCE_MS);

    const priced = [
      { host: "rich", gb: 100, times: { weaken: 40000 } },  // wants depth * 100
      { host: "huge", gb: 5000, times: { weaken: 40000 } }, // wants depth * 5000
      { host: "cheap", gb: 10, times: { weaken: 40000 } },  // wants depth * 10
    ];

    // `continue`, not `break`: one unaffordable entry must not end the search,
    // or a cheap target that fits comfortably in the leftovers is lost.
    // Budget: rich plus a fifth, which huge cannot touch and cheap fits inside.
    const { admitted } = admitTargets(priced, depth * 100 * 1.2, 12);
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

    // Derived from the cap rather than hardcoded, so raising MAX_IN_FLIGHT does
    // not silently turn this into a test of nothing. A target needing twice the
    // cap in flight cannot be streamed continuously - it falls back into waves,
    // and the honest fix for one that slow is a wider cadence, not a bigger cap.
    const slow = { host: "slow", gb: 1, times: { weaken: MAX_IN_FLIGHT * 2 * CADENCE_MS } };
    const { admitted } = admitTargets([slow], Infinity, 12);
    assert(admitted[0].depth === MAX_IN_FLIGHT, `depth ${admitted[0].depth} ignored the cap`);
  },

  // ---------------------------------------------------------- supervisor ---

  "a wound-down stream stops dispatching but keeps its batches": async () => {
    const { s, fire } = await makeStream();
    fire();
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

    const ranked = [{ host: "drained", chance: 1 }];
    const streaming = new Set(["drained"]);

    // A money snapshot on its own is not evidence any more, and must not be: at
    // 95% steal a HEALTHY target reads this low for half of every cadence, and
    // pricing on that dropped two of the three best earners in one live rescan.
    const onSnapshot = priceTargets(ns, math, ram, 0.1, ranked, streaming);
    assert(onSnapshot.length === 1, "a snapshot alone must not unprice a live stream");

    // Corroborated by the stream's own reports, it is dropped exactly as before.
    // The looser test must not become no test.
    const live = priceTargets(
      ns, math, ram, 0.1, ranked, streaming, new Map(), Infinity, null,
      new Set(["drained"]),
    );
    assert(live.length === 0, "a drained target must be dropped even while streaming");
  },

  "a re-admitted stream is reinstated, not rebuilt": async () => {
    const { s, fire } = await makeStream();
    fire();
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

    // rescan must actually hand the calculated fraction to the stream, and the
    // stream must START there rather than climbing to it - otherwise the
    // calculator is computing a number nothing acts on.
    assert(streams[0].cap > 0, "the stream should have been given a calculated ceiling");
    assertClose(streams[0].steal, streams[0].cap, 1e-9, "a new stream starts at its optimum");
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

  "ranking prefers the bigger earner, not the more RAM-efficient one": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        // Long weaken, huge money - the shape the raised in-flight cap made
        // viable, and the shape money-per-GB-second punishes hardest because it
        // divides by weaken time.
        // Deliberately the foodnstuff shape as well as the slow one: growth so
        // poor that its batch is enormous. That is what makes the two metrics
        // disagree, and the honest answer with RAM to spare is still to take it.
        big: {
          moneyMax: 1e12, moneyAvailable: 1e12, minDifficulty: 5, hackDifficulty: 5,
          hackPercentPerThread: 0.003, growBase: 1.0002,
          weakenTime: 360000, growTime: 288000, hackTime: 90000,
        },
        // Quick and cheap per batch, but a fraction of the money.
        quick: {
          moneyMax: 1e10, moneyAvailable: 1e10, minDifficulty: 5, hackDifficulty: 5,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
      },
    });
    const { priceTargets } = mods["core"];

    // A live run evicted alpha-ent - $8.1b/s, its best target - for one earning
    // $2.1b/s, while 19 PB of the pool sat free. RAM efficiency is the right
    // thing to sort on only when RAM is the constraint.
    const priced = priceTargets(
      ns, math, ram, 0.5, [{ host: "big", chance: 1 }, { host: "quick", chance: 1 }],
      new Set(), new Map(), 1e9,
    );

    assert(priced.length === 2, `priced ${priced.length}`);
    assert(priced[0].host === "big", `ranked ${priced.map((p) => p.host)} - income was ignored`);

    // Non-vacuous only if the two metrics actually disagree on this fixture -
    // otherwise the test would pass under the old ranking too. Reported rather
    // than asserted blind, so a fixture that stops disagreeing says so.
    const byIncome = [...priced].sort((a, b) => b.score - a.score).map((p) => p.host).join(",");
    const byRam = [...priced].sort((a, b) => b.perGbSec - a.perGbSec).map((p) => p.host).join(",");
    assert(
      byIncome !== byRam,
      `fixture no longer distinguishes the metrics: both rank ${byIncome} ` +
        `(perGbSec big=${priced.find((p) => p.host === "big").perGbSec.toFixed(1)}, ` +
        `quick=${priced.find((p) => p.host === "quick").perGbSec.toFixed(1)})`,
    );
  },

  "the admission score matches what a stream actually earns at depth": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 1048576 },
      servers: {
        t: { moneyMax: 2e8, moneyAvailable: 2e8, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 38000, growTime: 30400, hackTime: 9500 },
      },
    });
    const { priceTargets } = mods["core"];
    const { CADENCE_MS } = mods["config"];

    // The score is income per second at full depth: one batch per cadence, each
    // taking `steal` of max money. A live run reported $54.80m/s for a target
    // whose own numbers showed ~$440m/s - because the report averaged over the
    // whole run including prep and ramp - which made the score look wrong by
    // two orders of magnitude when it was the report that was misleading.
    const priced = priceTargets(
      ns, math, ram, 0.5, [{ host: "t", chance: 1 }], new Set(), new Map(), 1e9,
    );
    assert(priced.length === 1, "should price");

    const p = priced[0];
    const perBatch = p.fit.threads.take;
    const batchesPerSec = 1000 / CADENCE_MS;
    assertClose(p.score, perBatch * batchesPerSec, 1e-6, "score is take x rate");

    // And it is a rate a stream can really hit: at this weaken the pipeline
    // needs 95 batches in flight, well inside MAX_IN_FLIGHT, so nothing caps it.
    const depth = Math.ceil(38000 / CADENCE_MS);
    assert(depth < mods["config"].MAX_IN_FLIGHT, "fixture must not be depth-capped");
  },

  "a target capped by depth is not scored as if it kept the cadence": async () => {
    const { ns, math, ram, mods } = await makeMath("analyze", {
      hosts: { home: 1048576 },
      servers: {
        // Weaken long enough that the pipeline needs far more depth than
        // MAX_IN_FLIGHT allows, so it lands cap/W - not one per cadence.
        capped: {
          moneyMax: 1e11, moneyAvailable: 1e11, minDifficulty: 5, hackDifficulty: 5,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 2400000, growTime: 1920000, hackTime: 600000,
        },
        // Same money, short weaken, so it genuinely keeps the cadence.
        free: {
          moneyMax: 1e11, moneyAvailable: 1e11, minDifficulty: 5, hackDifficulty: 5,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
      },
    });
    const { priceTargets } = mods["core"];
    const { CADENCE_MS, MAX_IN_FLIGHT } = mods["config"];

    // Identical money and hack chance, so the ONLY thing separating them is
    // whether the depth cap lets them keep the cadence fed. Scoring both at the
    // cadence rate would rank them equal and over-state the capped one - which
    // on a live run was the shape of the two biggest targets.
    const priced = priceTargets(
      ns, math, ram, 0.5, [{ host: "capped", chance: 1 }, { host: "free", chance: 1 }],
      new Set(), new Map(), 1e9,
    );

    assert(priced[0].host === "free", `ranked ${priced.map((p) => p.host)}`);

    const ratio = priced.find((p) => p.host === "capped").score /
      priced.find((p) => p.host === "free").score;
    const expected = (MAX_IN_FLIGHT * 1000 / 2400000) / (1000 / CADENCE_MS);
    assertClose(ratio, expected, 0.05, "the capped target should score at cap/W, not the cadence");
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

  "a host that grows is seen at the next sync": async () => {
    const hosts = { home: 4096, a: 1024 };
    const { pool } = await makeMath("analyze", { hosts });
    const before = pool.usableRam;

    // scripts/cloud.js upgrades purchased servers while the manager runs. The
    // Server constructor sampled maxRam once and refresh() only ever re-read
    // usedRam, so a live run spent ten minutes buying RAM the batcher never
    // planned against - the slice sat at 12.73TB from first rescan to last.
    hosts.a = 8192;
    const grown = pool.sync();

    assertClose(grown.grewGb, 7168, 1e-9, "the upgrade must be measured");
    assertClose(pool.usableRam, before + 7168, 1e-9, "the pool must see the upgrade");
  },

  "a server bought after startup joins the pool and gets the workers": async () => {
    const hosts = { home: 262144 };
    const { ns, math, pool, ram, mods } = await makeMath("analyze", {
      hosts,
      servers: {
        t: { moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
             hackPercentPerThread: 0.003, growBase: 1.0018,
             weakenTime: 20000, growTime: 16000, hackTime: 5000 },
      },
    });
    const copied = [];
    ns.scp = (files, host) => { copied.push(host); return true; };
    ns.exec = () => 1;

    hosts["pserv-0"] = 8192;
    mods["core"].rescan(ns, math, {
      pool, ram, steal: 0.1, maxTargets: 3, forced: null,
      streams: [], preps: new Map(), log: () => {}, verbose: false,
    });

    assert(
      pool.servers.some((s) => s.hostname === "pserv-0"),
      "a newly bought server must join the pool",
    );
    // Not a tidy-up. exec returns a bare 0 for a script that is not on the host,
    // which is the same value it returns for one the host refused - so a server
    // without the workers reads as a RAM problem for ever.
    assert(copied.includes("pserv-0"), "the workers must be deployed to it");
  },

  "the target count is chosen by income, not by how many fit": async () => {
    const rich = (moneyMax) => ({
      moneyMax, moneyAvailable: moneyMax, minDifficulty: 5, hackDifficulty: 5,
      hackPercentPerThread: 0.003, growBase: 1.0018,
      weakenTime: 600000, growTime: 480000, hackTime: 150000,
    });
    const servers = { a: rich(1e9), b: rich(9e8), c: rich(8e8) };

    const run = async (homeRam) => {
      const { ns, math, pool, ram, mods } = await makeMath("analyze", {
        hosts: { home: homeRam }, servers,
      });
      ns.exec = () => 1;
      return mods["core"].rescan(ns, math, {
        pool, ram, steal: 0.1, maxTargets: 3, forced: null,
        streams: [], preps: new Map(), log: () => {}, verbose: false,
      });
    };

    // Running the most targets that fit is only right when the budget is not
    // the constraint. When it is, the third target does not ADD its income - it
    // buys it with a third of the budget taken from the best one. Measured on a
    // live 1.6 TB pool: phantasy alone $2.84m/s, three targets $1.96m/s.
    const tight = await run(2048);
    assert(tight.length === 1, `a tight budget should run one target, got ${tight.length}`);

    // And the ramp is the same arithmetic, not a separate rule: once every
    // target can reach its ceiling a narrower slice costs nothing, so the count
    // rises on its own as the pool grows.
    // 32 PB, which is not gratuitous: these targets have a ten-minute weaken, so
    // a pipeline of them is enormous and the cadence floor only starts binding
    // once each slice can hold the whole thing. Below that RAM is still the
    // constraint and concentrating still wins - correctly.
    const roomy = await run(33554432);
    assert(roomy.length === 3, `a roomy budget should run three, got ${roomy.length}`);
  },

  "prep slots scale with the RAM the streams will not use": async () => {
    const dirty = (moneyMax) => ({
      moneyMax, moneyAvailable: moneyMax * 0.2, minDifficulty: 5, hackDifficulty: 40,
      hackPercentPerThread: 0.003, growBase: 1.0018,
      weakenTime: 20000, growTime: 16000, hackTime: 5000,
    });
    const candidates = {};
    for (let i = 0; i < 6; i++) candidates[`d${i}`] = dirty(1e9 - i * 1e7);

    const run = async (prepped) => {
      const { ns, math, pool, ram, mods } = await makeMath("analyze", {
        hosts: { home: 262144 },
        servers: { ...candidates, live: prepped },
      });
      const preps = new Map();
      mods["core"].rescan(ns, math, {
        pool, ram, steal: 0.1, maxTargets: 3, forced: null,
        streams: [], preps, log: () => {}, verbose: false,
      });
      return { preps, mods };
    };

    // A prepped target small enough to leave most of the budget unused.
    //
    // Its op times are stated in CADENCE_MS, not in ms. What decides the slots
    // is how much the stream COMMITS, which is its depth - weakenTime / cadence
    // - so a fixture with fixed ms times quietly gets a deeper pipeline every
    // time the spacer is tightened, and stops being the small target the test
    // needs. Five cadences of weaken is that target at any spacer.
    const { CADENCE_MS } = (await loadContinuous()).mods["config"];
    const { preps: wide, mods } = await run({
      moneyMax: 1e7, moneyAvailable: 1e7, minDifficulty: 5, hackDifficulty: 5,
      hackPercentPerThread: 0.003, growBase: 1.0018,
      weakenTime: 5 * CADENCE_MS, growTime: 4 * CADENCE_MS, hackTime: 1.25 * CADENCE_MS,
    });
    const { PREP_CONCURRENCY } = mods["config"];
    assert(
      wide.size === PREP_CONCURRENCY,
      `a pool with room should still fan out to ${PREP_CONCURRENCY}, got ${wide.size}`,
    );

    // Same candidates; the only difference is a stream whose pipeline wants the
    // whole budget. Measuring FREE RAM instead would grant every slot here too,
    // because at rescan nothing is placed yet and the pool reads 100% idle -
    // which is the exact moment four waves took a 1.6 TB pool and kept it.
    const { preps: narrow } = await run({
      moneyMax: 1e9, moneyAvailable: 1e9, minDifficulty: 5, hackDifficulty: 5,
      hackPercentPerThread: 0.003, growBase: 1.0018,
      weakenTime: 600000, growTime: 480000, hackTime: 150000,
    });
    assert(narrow.size === 1, `a fully-spoken-for pool preps one at a time, got ${narrow.size}`);
  },

  "a prep that never converges releases its slot": async () => {
    const { ns, math, pool, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        stuck: {
          moneyMax: 1e9, moneyAvailable: 2e8, minDifficulty: 5, hackDifficulty: 40,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
      },
    });
    const { servicePreps } = mods["core"];
    const { PREP_MAX_CYCLES } = mods["config"];
    ns.exec = () => 1;

    // prepTargets has always had this bound; the supervisor path never did, and
    // four concurrent slots hid the omission. Serialised on a small pool, one
    // target that cannot be brought up blocks every other prep for the run.
    const preps = new Map([["stuck", { wave: null, deadline: 0, waves: PREP_MAX_CYCLES }]]);
    servicePreps(ns, { math, pool, ram, streams: [], preps, log: () => {} });

    assert(!preps.has("stuck"), "a prep past its wave budget must release its slot");
  },

  "a prepped target below the pricing cutoff is not queued for prep": async () => {
    // priceTargets only sees candidates.slice(0, maxTargets * 3), so with one
    // target that is the top three. Ranking here is by maxMoney, so `low` sits
    // outside the cutoff while being perfectly prepped, and `dirty` is the only
    // candidate that genuinely needs a wave.
    const at = (moneyMax, over = {}) => ({
      moneyMax, moneyAvailable: moneyMax, minDifficulty: 5, hackDifficulty: 5,
      hackPercentPerThread: 0.003, growBase: 1.0018,
      weakenTime: 20000, growTime: 16000, hackTime: 5000,
      ...over,
    });

    const { ns, math, pool, ram, mods } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        top: at(1e12), mid: at(1e11), third: at(1e10),
        low: at(1e9),
        dirty: at(1e8, { moneyAvailable: 1e3, hackDifficulty: 40 }),
      },
    });
    ns.exec = () => 1;

    const preps = new Map();
    mods["core"].rescan(ns, math, {
      pool, ram, steal: 0.1, maxTargets: 1, forced: null,
      streams: [], preps, log: () => {}, verbose: false,
    });

    // Inferring "prepped" from membership in `priced` read `low` as unprepped
    // and handed it the single prep slot on every rescan, which it returned
    // immediately - so the target that actually needed prepping never got one.
    assert(
      !preps.has("low"),
      "a prepped target outside the pricing cutoff must not be queued for prep",
    );
    assert(preps.has("dirty"), "the genuinely unprepped target should take the slot");
  },

  // -------------------------------------------------------- serial prep ----
  //
  // The five tests below exist because the slot math in rescan cannot see the
  // thing that actually matters. A wave sized by NEED is small only relative to
  // the pool it lands in, and placePrepWave backs grow down x0.7 until it fits
  // rather than failing - so on a pool too small for one target's need, a second
  // prep does not skip its turn, it takes a share. At the start of a BitNode
  // that split the 32 GB home three ways and nothing finished prepping.

  "a prep that came up short reports it": async () => {
    const drained = {
      moneyMax: 1e9, moneyAvailable: 1e3, minDifficulty: 5, hackDifficulty: 5,
      hackPercentPerThread: 0.003, growBase: 1.0018,
      weakenTime: 20000, growTime: 16000, hackTime: 5000,
    };

    const place = async (homeRam) => {
      const { ns, math, pool, ram, mods } = await makeMath("analyze", {
        hosts: { home: homeRam },
        servers: { t: drained },
      });
      const wave = mods["lib/prep"].placePrepWave(pool, ram, math, math.snapshot(ns, "t"));
      assert(wave, `expected a wave on a ${homeRam} GB pool`);
      return wave;
    };

    // Room for the whole ask: shrunk must be FALSE. This is the assertion that
    // pins why shrunk is computed inside placePrepWave from the integer growEff
    // rather than by comparing grow.effective to growWanted at the call site -
    // allocateEffective returns once the remaining need is within RAM_EPS, so
    // effective can land a float sliver low on a wave that was fully satisfied,
    // and the outside comparison would call that short.
    const roomy = await place(262144);
    assert(
      roomy.shrunk === false,
      `a wave that got its whole ask must not read as shrunk ` +
        `(grow ${roomy.grow.effective} eff of ${roomy.growWanted} wanted)`,
    );

    // Same target, pool far too small for it.
    const tight = await place(2048);
    assert(
      tight.shrunk === true,
      `a backed-off wave must report shrunk ` +
        `(grow ${tight.grow.effective} eff of ${tight.growWanted} wanted)`,
    );
    assert(
      tight.grow.effective < tight.growWanted,
      "the tight fixture is not actually tight - pick a smaller pool",
    );
  },

  "prep serialises when the pool cannot cover one target's need": async () => {
    const { ns, math, pool, ram, mods, targets } = await prepFixture(2048);
    const { servicePreps } = mods["core"];

    const preps = new Map([["a", freshPrepEntry()], ["b", freshPrepEntry()]]);
    servicePreps(ns, { math, pool, ram, streams: [], preps, log: () => {} });

    assert(preps.get("a").wave, "the first prep must still get its wave");
    assert(
      !preps.get("b").wave,
      "a second prep must not take a share of what the first could not cover",
    );
    assert(
      targets().join() === "a",
      `only the first target may be exec'd against, got [${targets()}]`,
    );
  },

  "prep still fans out when the pool has room for both": async () => {
    const { ns, math, pool, ram, mods, targets } = await prepFixture(262144);
    const { servicePreps } = mods["core"];

    const preps = new Map([["a", freshPrepEntry()], ["b", freshPrepEntry()]]);
    servicePreps(ns, { math, pool, ram, streams: [], preps, log: () => {} });

    // The gate is need-against-capacity, not a concurrency cap: a pool with real
    // leftovers must still prep several targets at once, which is the case the
    // whole concurrent-prep design was built for.
    assert(preps.get("a").wave && preps.get("b").wave, "both preps should get a wave");
    assert(
      targets().join() === "a,b",
      `both targets should be exec'd against, got [${targets()}]`,
    );
  },

  "a short wave still in flight keeps the pool to itself": async () => {
    const { ns, math, pool, ram, mods } = await prepFixture(2048);
    const { servicePreps } = mods["core"];

    const preps = new Map([["a", freshPrepEntry()], ["b", freshPrepEntry()]]);
    const opts = { math, pool, ram, streams: [], preps, log: () => {} };

    servicePreps(ns, opts);
    // Second tick well inside the first wave's deadline. Without the flag being
    // carried on the prep entry the gate only moves the split from space into
    // time: a holds a short wave, b takes the crumbs, a releases, b holds.
    servicePreps(ns, opts);

    assert(
      !preps.get("b").wave,
      "b must stay unplaced while a's short wave is still in flight",
    );
  },

  "a stopped stream is repaired before a target that never streamed": async () => {
    const { ns, math, pool, ram, mods, targets } = await prepFixture(2048);
    const { servicePreps } = mods["core"];

    // "a" is queued first, so insertion order alone would hand it the pool. A
    // stopped stream is a target already admitted that earns nothing until it is
    // back on baseline, so with prep serialised it has to go first.
    const preps = new Map([["a", freshPrepEntry()], ["b", freshPrepEntry()]]);
    const stopped = {
      host: "b", stopped: true, retiring: false, depth: 0, resume: () => {},
    };

    servicePreps(ns, { math, pool, ram, streams: [stopped], preps, log: () => {} });

    assert(preps.get("b").wave, "the stopped stream must be the one repaired");
    assert(!preps.get("a").wave, "the never-streamed target must wait its turn");
    assert(targets().join() === "b", `expected only b, got [${targets()}]`);
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

  "placeable RAM is below the raw byte total, because hosts floor threads": async () => {
    const { pool } = await makePool({ home: 100, a: 63, b: 63 });

    // CLAUDE.md: never size capacity as a byte total, because every host floors
    // its own thread count. A live run budgeted against usableRam, calculated
    // 84.9% steal, and then failed 402 of 439 dispatches with "no room" - the
    // bytes existed and the threads did not fit.
    const raw = pool.usableRam;
    const placeable = pool.placeableRam(1.75);

    assert(placeable < raw, `placeable ${placeable} should be under the ${raw} byte total`);
    // 100 -> 57 threads (99.75), 63 -> 36 (63.00 exactly), so 99.75 + 63 + 63.
    assertClose(placeable, 99.75 + 63 + 63, 1e-9, "per-host flooring");
    assert(pool.placeableRam(0) === 0, "a zero thread cost is not an infinite pool");
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

  // -------------------------------------------------------------- share -----

  // scripts/sharemode.js writes the marker and broadcasts the port, and
  // scripts/share.js peeks that port to decide whether to keep running. Neither
  // knows which batcher is up, so the two configs are not two settings - they
  // are one protocol read from two places. A divergence here does not fail
  // loudly: `sharemode.js on` would launch workers that read an empty port,
  // parse it as off, and exit a millisecond after a perfectly valid pid.
  "the share protocol matches the shotgun's exactly": async () => {
    const root = (await loadScripts())["config"];
    const { mods } = await loadContinuous();
    const cont = mods["config"];

    for (const key of ["SHARE_MARKER", "SHARE_PORT", "SHARE_WORKER",
                       "SHARE_FRACTION", "SHARE_MAX_FRACTION", "SHARE_RAM_FALLBACK"]) {
      assert(cont[key] === root[key],
        `${key} diverged: continuous has ${JSON.stringify(cont[key])}, ` +
          `scripts/config.js has ${JSON.stringify(root[key])}`);
    }

    // The parser too, not just the constants - it decides whether a worker
    // lives, and "anything unreadable means OFF" is the load-bearing half.
    for (const text of ["", "off", "false", "on", "true", "0.4", "9", "banana", "-1"]) {
      assert(cont.shareFractionFrom(text) === root.shareFractionFrom(text),
        `shareFractionFrom("${text}") diverged: ${cont.shareFractionFrom(text)} ` +
          `vs ${root.shareFractionFrom(text)}`);
    }
  },

  // The report port is drained with read(), which REMOVES the message. Sharing
  // a port number with the gate - which is peeked, never drained - would have
  // the drain loop eat the setting and every worker retire.
  "the share gate is not the report port": async () => {
    const { mods } = await loadContinuous();
    const { SHARE_PORT, CONT_REPORT_PORT } = mods["config"];
    assert(SHARE_PORT !== CONT_REPORT_PORT,
      `share gate and report port are both ${SHARE_PORT}; the drain loop would eat the setting`);
  },

  // Sized against usableRam, not freeRam, and asked for repeatedly. Under
  // continuous this is the difference between a working toggle and a runaway:
  // a healthy stream holds nearly the whole pool, so a freeRam-based size would
  // read "share wants nothing" exactly when things are going well.
  "asking for the same fraction twice adds nothing the second time": async () => {
    const { pool, mods } = await makePool({ home: 4096, p0: 2048, p1: 2048 });
    const { planShare } = mods["lib/share"];

    const first = planShare(pool, 4, 0.25, 0);
    assert(first.deficit === first.want, `the first ask should want the lot, got ${first.deficit}`);

    const second = planShare(pool, 4, 0.25, first.want);
    assert(second.deficit === 0,
      `a second ask at the same fraction should want nothing, got ${second.deficit}`);
  },

  "an over-supply is never turned into a negative deficit": async () => {
    const { pool, mods } = await makePool({ home: 1024 });
    const { planShare } = mods["lib/share"];
    const r = planShare(pool, 4, 0.10, 1e6);
    assert(r.deficit === 0, `deficit should floor at 0, got ${r.deficit}`);
  },

  // The shotgun's first live run filled home to the brim and swallowed the
  // pool's largest host. It matters more here: the steal calculator sizes
  // against placeableRam, which floors per host, so a hole punched in one big
  // host can drop the fraction it will commit to - not just its bytes.
  "share is spread proportionally, not poured into the biggest host": async () => {
    const { ns, pool, mods } = await makePool({ home: 8192, p0: 1024, p1: 1024 });
    const { topUpShare } = mods["lib/share"];
    ns._files["/scripts/share.js"] = "x";

    const res = topUpShare(ns, pool, 4, 0.25, 0);
    const byHost = new Map(res.placements.map((p) => [p.host, p.threads]));

    for (const s of pool.servers) {
      const quota = Math.floor((s.usableRam * 0.25) / 4);
      const got = byHost.get(s.hostname) ?? 0;
      // Home may carry the rounding remainder, so it is allowed to exceed its
      // own quota - by a handful of threads, not by the pool.
      assert(got <= quota + 8,
        `${s.hostname} took ${got}t against a quota of ${quota}t - placement is not proportional`);
    }
  },

  // exec returns a bare 0 for a script that is not there AND for one the host
  // refused. The remedies are opposite - deploy vs. free RAM - so a merged
  // bucket sends the reader the wrong way. The shotgun did that twice.
  "a missing worker and a refused exec are reported separately": async () => {
    const { ns, pool, mods } = await makePool({ home: 4096, p0: 2048 });
    const { topUpShare } = mods["lib/share"];

    // Nobody has the file.
    const none = topUpShare(ns, pool, 4, 0.25, 0);
    assert(none.noFile.length === pool.servers.length,
      `every host should be reported as missing the worker, got ${none.noFile.length}`);
    assert(none.refused.length === 0, "a missing file is not a refusal");
    assert(none.launched === 0, "nothing can launch without the worker");

    // Everyone has the file, and every exec is refused.
    ns._files["/scripts/share.js"] = "x";
    const stubborn = { ...ns, exec: () => 0 };
    const all = topUpShare(stubborn, pool, 4, 0.25, 0);
    assert(all.noFile.length === 0, "the file is present - this must not read as a deploy problem");
    assert(all.refused.length > 0, "a refused exec should be recorded");
    assert(all.refused[0].freeGb > 0,
      "a refusal must carry what the pool believed was free - that number IS the diagnosis");
  },

  // Share workers outlive the process that started them, so a manager restart -
  // or a swap between the two batchers - finds them still running. Without
  // adopting them it would launch a second full set on top, doubling the RAM
  // share holds to buy 2.77 points of a logarithm.
  "a restarted manager adopts the running share workers": async () => {
    const { ns, pool, mods } = await makePool({ home: 4096, p0: 2048 });
    const { shareCensus, topUpShare } = mods["lib/share"];
    ns._files["/scripts/share.js"] = "x";

    topUpShare(ns, pool, 4, 0.25, 0);
    const census = shareCensus(ns, pool.servers.map((s) => s.hostname));
    assert(census.threads > 0, "the first top-up should have launched something");

    const again = topUpShare(ns, pool, 4, 0.25, census.threads, census.byHost);
    assert(again.launched === 0,
      `a second top-up launched ${again.launched}t on top of ${census.threads}t already running`);
  },

  // A reservation is released at the end of a cycle; a share worker is not. It
  // runs until the port says stop, and the game already reports its RAM as used
  // - so a reservation would have refresh() subtract the same bytes twice.
  "the share top-up leaves no reservation behind": async () => {
    const { ns, pool, mods } = await makePool({ home: 4096, p0: 2048 });
    const { topUpShare } = mods["lib/share"];
    ns._files["/scripts/share.js"] = "x";

    topUpShare(ns, pool, 4, 0.25, 0);
    for (const s of pool.servers) {
      assert(!(s.pending > 0),
        `${s.hostname} holds a ${s.pending}GB reservation for a worker that outlives the cycle`);
    }
  },

  // Off must reach the fleet even when nothing is launched, and it can only get
  // there on the PORT: ns.read resolves against the server the CALLING script
  // runs on, and /data/share.txt exists on home alone. A worker anywhere else
  // reading the file gets "" and stops dead - which is how the shotgun once
  // counted 66 hosts sharing while 65 had already quit.
  "the fraction is published on the port even when share is off": async () => {
    const { ns, pool, mods } = await makePool({ home: 1024 });
    const { serviceShare } = mods["lib/share"];
    const { SHARE_PORT, SHARE_MARKER } = mods["config"];

    ns._files[SHARE_MARKER] = "off";
    const off = serviceShare(ns, pool, () => {});
    assert(off === null, "share off with nothing running should say nothing");
    assert(Number(ns.getPortHandle(SHARE_PORT).peek()) === 0,
      "off must still be broadcast, or running workers never hear it");

    ns._files[SHARE_MARKER] = "0.25";
    ns._files["/scripts/share.js"] = "x";
    serviceShare(ns, pool, () => {});
    assert(Number(ns.getPortHandle(SHARE_PORT).peek()) === 0.25,
      "the fraction should reach the port the workers peek");
  },

  // A host bought by cloud.js while the batcher runs is admitted by
  // ServerPool.sync and gets the batch workers - but scripts/deploy.js only
  // runs when root.js roots something NEW, and a purchased server arrives
  // already rooted. Without share.js riding along, that host could never take
  // its quota and would be reported under noFile for ever.
  "the continuous deploy ships the share worker too": async () => {
    const { mods } = await loadContinuous();
    const { deployWorkers } = mods["lib/deploy"];
    const { SHARE_WORKER } = mods["config"];

    let sent = null;
    const ns = { scp: (files) => { sent = files; return true; } };
    deployWorkers(ns, ["p0"]);

    assert(sent && sent.includes(SHARE_WORKER),
      `a newly bought host must get ${SHARE_WORKER}, got ${JSON.stringify(sent)}`);
  },

  // servers.js is a report, so the only thing worth pinning is that its rows
  // carry the prep verdict and a real fraction from the calculator, and that
  // they come back richest first - a table that ranks differently from the
  // thing it describes gets misread.
  "servers.js reports prep state, a steal fraction and income order": async () => {
    const { mods } = await loadContinuous();
    const { ns, math, ram } = await makeMath("analyze", {
      hosts: { home: 262144 },
      servers: {
        rich: {
          moneyMax: 1e10, moneyAvailable: 1e10, minDifficulty: 5, hackDifficulty: 5,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
        poor: {
          moneyMax: 1e7, moneyAvailable: 2e6, minDifficulty: 5, hackDifficulty: 40,
          hackPercentPerThread: 0.003, growBase: 1.0018,
          weakenTime: 20000, growTime: 16000, hackTime: 5000,
        },
      },
    });

    const snaps = ["poor", "rich"].map((h) => math.snapshot(ns, h));
    const rows = mods["servers"].buildRows(math, snaps, ram, 1e6);

    assert(rows.length === 2, `expected 2 rows, got ${rows.length}`);
    assert(rows[0].snap.host === "rich", `richest target must sort first, got ${rows[0].snap.host}`);
    assert(rows[0].prepped === true, "rich is at max money and min security");
    assert(rows[1].prepped === false, "poor is drained and dirty");
    for (const r of rows) {
      assert(r.fit.steal > 0 && r.fit.steal <= 1, `steal out of range: ${r.fit.steal}`);
      assert(r.fit.hack >= 1, `hack threads must be at least 1, got ${r.fit.hack}`);
    }
    assert(
      mods["servers"].incomePerSec(rows[0]) >= mods["servers"].incomePerSec(rows[1]),
      "rows must be sorted by income",
    );
  },
};
