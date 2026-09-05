# Formulas.exe Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the batcher use `ns.formulas.hacking` for exact thread math when Formulas.exe is owned, and fall back to the existing `*Analyze` math when it is not, without either path paying the other's RAM.

**Architecture:** A math interface with two implementations (`mathFormulas.js`, `mathAnalyze.js`). `managerCore.js` and `prepper.js` become math-free and receive an implementation as a parameter. Thin entry scripts each statically import exactly one implementation, so Bitburner's static RAM analysis charges each entry for only what it uses. `boot.js` picks the entry matching `fileExists("Formulas.exe", "home")` and treats the two managers as one service.

**Tech Stack:** Bitburner Netscript 2 (ES modules), plain Node 26 for tests (no package.json, no test framework — this plan builds a minimal runner).

**Spec:** `docs/superpowers/specs/2026-09-05-formulas-integration-design.md`

## Global Constraints

- **Verify every `ns.*` function against this fork's docs before using it.** Signatures and RAM costs differ from vanilla. Per-function docs: `https://raw.githubusercontent.com/DaCheapShot/bitburner-src/stable/markdown/bitburner.ns.<fn>.md`
- **RAM is charged per `ns` function reachable through imports, called or not.** A module that imports another module pays for everything that module can reach. This is the reason for the whole design.
- **`config.js` and `verify.js` must contain zero `ns` calls; `calib.js` may use only `ns.read` (0 GB).** Adding a billed call to any of them taxes every script in the repo.
- Verified RAM costs used throughout: `formulas.*` 0, `getServer` 2.00, `getPlayer` 0.50, `hackAnalyze`/`growthAnalyze`/`weakenAnalyze` 1.00 each, `getServerMoneyAvailable`/`SecurityLevel`/`MinSecurityLevel`/`MaxMoney`/`RequiredHackingLevel` 0.10 each, `getServerMaxRam`/`getServerUsedRam`/`hasRootAccess`/`getHackingLevel` 0.05 each, `getHackTime`/`getGrowTime`/`getWeakenTime` 0.05 each, `scan` 0.20, `exec` 1.30, `run` 1.00, `ps` 0.20, `kill` 0.50, `scp` 0.60, `getScriptRam` 0.10, `fileExists` 0.10, `nuke`/port crackers 0.05 each, script base 1.60.
- **Target RAM:** `manager.js` (analyze) stays exactly **6.15 GB**; `manager-formulas.js` **6.10 GB**; `boot.js` **3.40 GB**.
- **Cores and `hackChance` are out of scope.** Both implementations assume 1 core. Signatures must not preclude adding them later.
- Comments explain *why*, especially where a simpler-looking alternative is wrong. Match the existing density.
- Commit after every task.

---

### Task 1: Test harness

The repo has no test runner. Every later task needs one, so it comes first.
Bitburner scripts import each other as `./x.js`; Node needs `.mjs`. The harness
mirrors `scripts/` into a temp directory, rewriting imports, and loads modules
from there.

**Files:**
- Create: `tests/harness.mjs`
- Create: `tests/mockNs.mjs`
- Create: `tests/run.mjs`
- Create: `tests/harness.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadScripts()` → `Promise<Record<string, Module>>` keyed by bare name (`"manager"`, `"prepper"`, …)
  - `makeNs(overrides)` → mock `ns` object
  - `assert(cond, msg)`, `assertClose(a, b, tol, msg)`, `assertThrows(fn, msg)`
  - Test files are `tests/*.test.mjs` exporting `export const tests = { name: async () => {...} }`

- [ ] **Step 1: Write the harness**

Create `tests/harness.mjs`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPTS = path.resolve(import.meta.dirname, "..", "scripts");

/**
 * Mirror scripts/ into a temp dir as .mjs so Node can import them.
 *
 * Bitburner resolves "./config.js"; Node needs the real extension. Rewriting on
 * a copy keeps the game files untouched and means tests always run against what
 * is actually on disk, not a hand-maintained duplicate.
 */
export async function loadScripts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbtest-"));
  const names = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith(".js"));

  for (const f of names) {
    const src = fs.readFileSync(path.join(SCRIPTS, f), "utf8");
    const rewritten = src.replace(/from\s+"\.\/([\w-]+)\.js"/g, 'from "./$1.mjs"');
    fs.writeFileSync(path.join(dir, f.replace(/\.js$/, ".mjs")), rewritten);
  }

  const mods = {};
  for (const f of names) {
    const bare = f.replace(/\.js$/, "");
    const url = pathToFileURL(path.join(dir, bare + ".mjs")).href;
    mods[bare] = await import(url);
  }
  return mods;
}

/** Raw source of one script, for tests that inspect imports or text. */
export function readScript(bare) {
  return fs.readFileSync(path.join(SCRIPTS, bare + ".js"), "utf8");
}

/** Names of all scripts, without extension. */
export function scriptNames() {
  return fs.readdirSync(SCRIPTS).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

export function assertClose(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) {
    throw new Error(`${msg || "not close"}: ${a} vs ${b} (tolerance ${tol})`);
  }
}

export function assertThrows(fn, msg) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(msg || "expected a throw");
}
```

- [ ] **Step 2: Write the mock ns**

Create `tests/mockNs.mjs`:

```js
/**
 * A mock ns that reproduces the game's real semantics where they matter.
 *
 * The three that have caused false confidence before, all reproduced here:
 *   - ports hold 50 entries and discard the OLDEST on overflow
 *   - file paths are stored WITHOUT a leading slash, so ns.run("/scripts/x.js")
 *     works but ns.ps() reports "scripts/x.js"
 *   - port crackers THROW when the program is not owned
 */
export const PORT_CAPACITY = 50;

export function makeNs(o = {}) {
  const hosts = o.hosts ?? { home: 1024 };
  const used = Object.fromEntries(Object.keys(hosts).map((h) => [h, 0]));
  const servers = o.servers ?? {};
  const files = o.files ?? {};
  let queue = [];
  let dropped = 0;

  const port = {
    empty: () => queue.length === 0,
    full: () => queue.length >= PORT_CAPACITY,
    read: () => (queue.length ? queue.shift() : "NULL PORT DATA"),
    peek: () => (queue.length ? queue[0] : "NULL PORT DATA"),
    clear: () => { queue = []; },
    write: (v) => { queue.push(v); if (queue.length > PORT_CAPACITY) { queue.shift(); dropped++; } },
  };

  const srv = (h) => servers[h] ?? {};

  const ns = {
    _hosts: hosts, _used: used, _servers: servers, _files: files,
    _port: port, _droppedReports: () => dropped, _log: [],

    args: o.args ?? [],
    disableLog: () => {}, enableLog: () => {},
    ui: { openTail: () => {} },
    print: (s) => ns._log.push(s),
    tprint: (s) => ns._log.push("[T] " + s),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),

    read: (f) => files[f] ?? "",
    write: (f, data, mode) => { files[f] = mode === "a" ? (files[f] ?? "") + data : data; },
    fileExists: (f, host = "home") => Boolean(files[`${host}:${f}`] ?? files[f]),
    getPortHandle: () => port,

    scan: (h) => (h === "home" ? [...Object.keys(hosts).filter((x) => x !== "home"), ...Object.keys(servers)] : []),
    hasRootAccess: (h) => srv(h).rooted !== false,
    getServerMaxRam: (h) => hosts[h] ?? 0,
    getServerUsedRam: (h) => used[h] ?? 0,
    getScriptRam: (f) => (f.includes("hack") ? 1.7 : 1.75),

    getServerMaxMoney: (h) => srv(h).moneyMax ?? 0,
    getServerMoneyAvailable: (h) => srv(h).moneyAvailable ?? 0,
    getServerMinSecurityLevel: (h) => srv(h).minDifficulty ?? 1,
    getServerSecurityLevel: (h) => srv(h).hackDifficulty ?? 1,
    getServerRequiredHackingLevel: (h) => srv(h).requiredHackingSkill ?? 1,
    getHackingLevel: () => o.hackingLevel ?? 9999,

    getWeakenTime: (h) => srv(h).weakenTime ?? 2000,
    getGrowTime: (h) => srv(h).growTime ?? 1600,
    getHackTime: (h) => srv(h).hackTime ?? 500,

    hackAnalyze: (h) => srv(h).hackPercentPerThread ?? 0.0037,
    growthAnalyze: (h, mult) => Math.log(mult) / Math.log(srv(h).growBase ?? 1.0018),
    weakenAnalyze: (t) => 0.05 * t,

    exec: () => 1,
    run: () => 1,
    ps: () => [],
    kill: () => true,
    scp: () => true,

    ...o.extra,
  };
  return ns;
}

/**
 * A mock of ns.formulas.hacking backed by the same numbers as the analyze mock,
 * so a test can compare the two implementations on identical ground truth.
 *
 * growThreads models BOTH the exponential and additive terms, which is exactly
 * what growthAnalyze cannot express - that difference is the point of the whole
 * feature, so the mock must have it.
 */
export function withFormulas(ns, { owned = true } = {}) {
  const guard = () => {
    if (!owned) throw new Error("Requires Formulas.exe to run.");
  };
  const rate = (server) => {
    const base = server.growBase ?? 1.0018;
    // Growth degrades as security rises; at minDifficulty the base is as given.
    const sec = server.hackDifficulty ?? server.minDifficulty ?? 1;
    const min = server.minDifficulty ?? 1;
    return 1 + (base - 1) * (min / sec);
  };
  ns.formulas = {
    mockServer: () => ({}),
    mockPlayer: () => ({}),
    hacking: {
      hackPercent: (server) => { guard(); return server.hackPercentPerThread ?? 0.0037; },
      hackChance: () => { guard(); return 1; },
      growPercent: (server, threads) => { guard(); return Math.pow(rate(server), threads); },
      growThreads: (server, _player, targetMoney) => {
        guard();
        const from = Math.max(server.moneyAvailable ?? 0, 1);
        const to = Math.min(targetMoney, server.moneyMax ?? targetMoney);
        if (to <= from) return 0;
        // Additive +1/thread then exponential, solved numerically - matches the
        // game's documented "linearly AND exponentially" behaviour closely
        // enough for tests, and is strictly better than a pure log ratio.
        const r = rate(server);
        let lo = 0, hi = 1;
        const reached = (t) => (from + t) * Math.pow(r, t);
        while (reached(hi) < to && hi < 1e9) hi *= 2;
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (reached(mid) < to) lo = mid; else hi = mid;
        }
        return Math.ceil(hi);
      },
      growAmount: (server, _p, threads) => {
        guard();
        const from = Math.max(server.moneyAvailable ?? 0, 1);
        return Math.min((from + threads) * Math.pow(rate(server), threads), server.moneyMax ?? Infinity);
      },
      hackTime: (server) => { guard(); return server.hackTime ?? 500; },
      growTime: (server) => { guard(); return server.growTime ?? 1600; },
      weakenTime: (server) => { guard(); return server.weakenTime ?? 2000; },
      weakenEffect: (threads) => { guard(); return 0.05 * threads; },
      hackExp: () => { guard(); return 1; },
    },
  };
  ns.getServer = (h) => ({ hostname: h, ...(ns._servers[h] ?? {}) });
  ns.getPlayer = () => ({ skills: { hacking: 9999 } });
  return ns;
}
```

- [ ] **Step 3: Write the runner**

Create `tests/run.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = import.meta.dirname;
const only = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !only || f.includes(only));

let pass = 0, fail = 0;
for (const f of files) {
  const mod = await import(pathToFileURL(path.join(dir, f)).href);
  for (const [name, fn] of Object.entries(mod.tests ?? {})) {
    try {
      await fn();
      console.log(`  PASS  ${f.replace(".test.mjs", "")} :: ${name}`);
      pass++;
    } catch (e) {
      console.log(`  FAIL  ${f.replace(".test.mjs", "")} :: ${name}`);
      console.log(`        ${e.message}`);
      fail++;
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 4: Write the failing test**

Create `tests/harness.test.mjs`:

```js
import { loadScripts, assert } from "./harness.mjs";

export const tests = {
  "every script loads as a module": async () => {
    const mods = await loadScripts();
    assert(mods.config, "config.js did not load");
    assert(typeof mods.config.SPACER_MS === "number", "config.SPACER_MS missing");
    assert(typeof mods.prepper.prep === "function", "prepper.prep missing");
    assert(typeof mods.manager.main === "function", "manager.main missing");
  },

  "port mock discards the oldest entry when full": async () => {
    const { makeNs, PORT_CAPACITY } = await import("./mockNs.mjs");
    const ns = makeNs();
    const p = ns.getPortHandle(1);
    for (let i = 0; i < PORT_CAPACITY + 5; i++) p.write(i);
    assert(p.read() === 5, "oldest entries should have been discarded first");
  },
};
```

- [ ] **Step 5: Run and verify it passes**

Run: `node tests/run.mjs`
Expected: `2 passed, 0 failed`

- [ ] **Step 6: Commit**

```bash
git add tests/
git commit -m "test: minimal harness for Bitburner scripts

Mirrors scripts/ to a temp dir as .mjs with rewritten imports, so tests run
against what is actually on disk. The mock ns reproduces the three game
behaviours that have previously made simulations disagree with reality:
port capacity discarding oldest, paths stored without a leading slash, and
crackers throwing when unowned."
```

---

### Task 2: Move tolerances to config, add the math interface doc and `mathAnalyze.js`

`MONEY_TOLERANCE` and `SEC_TOLERANCE` currently live in `prepper.js`. Both math
implementations must use identical thresholds or `snapshot().moneyOk` means
different things depending on which is loaded, so they move to `config.js`.

**Files:**
- Modify: `scripts/config.js` (append tolerances)
- Create: `scripts/mathAnalyze.js`
- Create: `tests/math.test.mjs`
- Modify: `scripts/prepper.js:57-58` (re-export tolerances from config instead of defining them)

**Interfaces:**
- Consumes: `calib.js` (`loadCalibration`, `growBaseFor`, `SEC_TOLERANCE`).
- Produces — **the math interface every implementation must satisfy**:
  - `NAME` → `string` (`"analyze"` / `"formulas"`)
  - `prepare(ns)` → `{ ok: boolean, error?: string }`
  - `snapshot(ns, host)` → `{ ns, host, maxMoney, money, minSec, sec, moneyOk, secOk }`
  - `maxMoneyOf(ns, host)` → `number` — a cheap single-field read for scanning
    many candidate hosts, without building a full snapshot for each. This exists
    for RAM reasons: `pickTarget` and the retarget check would otherwise call
    `ns.getServerMaxMoney` directly, which the formulas build has no other need
    for and would push it from 6.10 to 6.20 GB.
  - `hackFractionPerThread(snap)` → `number` (fraction of *current* money per thread)
  - `securityPerHackThread(snap)` → `number`
  - `securityPerGrowThread(snap)` → `number`
  - `securityPerWeakenThread(snap)` → `number`
  - `growThreadsToRestore(snap, fromMoney, toMoney, atSecurity)` → `number`, may be fractional; callers apply `GROW_MARGIN` and `Math.ceil`
  - `opTimes(snap)` → `{ hack: number, grow: number, weaken: number }`

- [ ] **Step 1: Add tolerances to config.js**

Append to `scripts/config.js`:

```js
// ------------------------------------------------------------ tolerances ----

/**
 * How close to max money counts as "prepped".
 *
 * Lives here rather than in prepper.js because both math implementations
 * compute snapshot().moneyOk, and a difference between them would mean
 * "prepped" silently meant two different things depending on which one loaded.
 */
export const MONEY_TOLERANCE = 0.999;

/** How far above minimum security still counts as "at minimum". */
export const SEC_TOLERANCE = 0.01;
```

- [ ] **Step 2: Write the failing contract test**

Create `tests/math.test.mjs`:

```js
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
};
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node tests/run.mjs math`
Expected: FAIL — `Cannot read properties of undefined (reading 'prepare')` (no `mathAnalyze.js` yet)

- [ ] **Step 4: Write `scripts/mathAnalyze.js`**

```js
import { MONEY_TOLERANCE, SEC_TOLERANCE } from "./config.js";
import { loadCalibration, growBaseFor } from "./calib.js";

/**
 * Math interface backed by the *Analyze API plus the calibration cache.
 *
 * This is the always-available implementation: it needs no programs and works
 * from minute one of a BitNode. It is also honestly approximate - see
 * growThreadsToRestore.
 *
 * RAM charged to whoever imports this:
 *   4x getServer* 0.40 + hackAnalyze 1.00 + growthAnalyze 1.00
 *   + getHackTime/getGrowTime/getWeakenTime 0.15
 *   = 2.55 GB   (calib.js and config.js are 0 GB)
 */

export const NAME = "analyze";

let calib = null;

/** Load the calibration cache. Called once at startup by the entry script. */
export function prepare(ns) {
  calib = loadCalibration(ns);
  if (!calib) {
    return {
      ok: false,
      error: "/data/calib.json missing or invalid. Run scripts/calibrate.js first.",
    };
  }
  return { ok: true };
}

export function snapshot(ns, host) {
  const maxMoney = ns.getServerMaxMoney(host);
  const money = ns.getServerMoneyAvailable(host);
  const minSec = ns.getServerMinSecurityLevel(host);
  const sec = ns.getServerSecurityLevel(host);
  return {
    ns, host, maxMoney, money, minSec, sec,
    moneyOk: money >= maxMoney * MONEY_TOLERANCE,
    secOk: sec <= minSec + SEC_TOLERANCE,
  };
}

/**
 * Max money of a host, without building a full snapshot.
 *
 * For scanning many candidates (pickTarget, the retarget check). Kept separate
 * so the formulas build never needs ns.getServerMaxMoney, which is its only
 * remaining use and would cost it 0.10 GB for nothing.
 */
export function maxMoneyOf(ns, host) {
  return ns.getServerMaxMoney(host);
}

/** Live: moves with hacking level, which is why it is never cached. */
export function hackFractionPerThread(snap) {
  return snap.ns.hackAnalyze(snap.host);
}

// Cached per-thread constants. All three are linear in threads and independent
// of the target's current state, which is what makes them safe to cache; see
// scripts/calibrate.js for how they are measured.
export function securityPerHackThread() { return calib.hackSecPerThread; }
export function securityPerGrowThread() { return calib.growSecPerThread; }
export function securityPerWeakenThread() { return calib.weakenPerThread; }

/**
 * Grow threads to take money from fromMoney to toMoney.
 *
 * APPROXIMATE, deliberately and unavoidably. growthAnalyze evaluates at the
 * target's CURRENT security, so the atSecurity argument cannot be honoured -
 * it is accepted only so this signature matches mathFormulas, which can. When
 * the two disagree, formulas is right.
 *
 * Prefers the cached growth base when the host is still at the security it was
 * measured at, because that costs nothing; falls back to a live growthAnalyze
 * otherwise. Both are already charged to this module, so the preference is
 * about accuracy, not RAM.
 */
export function growThreadsToRestore(snap, fromMoney, toMoney, atSecurity) {
  const from = Math.max(fromMoney, 1);
  const to = Math.min(toMoney, snap.maxMoney);
  if (to <= from) return 0;
  const mult = to / from;

  const base = growBaseFor(calib, snap.host, atSecurity);
  if (base) return Math.log(mult) / Math.log(base);

  return snap.ns.growthAnalyze(snap.host, mult);
}

export function opTimes(snap) {
  return {
    hack: snap.ns.getHackTime(snap.host),
    grow: snap.ns.getGrowTime(snap.host),
    weaken: snap.ns.getWeakenTime(snap.host),
  };
}
```

- [ ] **Step 5: Re-point prepper's tolerances at config**

In `scripts/prepper.js`, replace lines 55-58:

```js
// Stop declaring "prepped" at exact equality - money asymptotes toward max and
// security carries float noise.
export const MONEY_TOLERANCE = 0.999;
export const SEC_TOLERANCE = 0.01;
```

with:

```js
// Re-exported from config.js so both math implementations and every consumer
// agree on what "prepped" means. Defining them here again would let the two
// drift apart silently.
export { MONEY_TOLERANCE, SEC_TOLERANCE } from "./config.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node tests/run.mjs`
Expected: all PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add scripts/config.js scripts/mathAnalyze.js scripts/prepper.js tests/math.test.mjs
git commit -m "feat: extract the analyze math behind a named interface

mathAnalyze.js implements the interface both math backends must satisfy.
Tolerances move to config.js: both implementations compute snapshot().moneyOk,
and defining the thresholds twice would let 'prepped' mean two different
things depending on which one was loaded.

growThreadsToRestore accepts atSecurity but cannot honour it - growthAnalyze
always evaluates at current security. The argument exists so the signature
matches the formulas implementation, which can, and the docstring records
that asymmetry rather than hiding it."
```

---

### Task 3: `mathFormulas.js`

**Files:**
- Create: `scripts/mathFormulas.js`
- Modify: `tests/math.test.mjs` (add formulas tests)

**Interfaces:**
- Consumes: the interface defined in Task 2.
- Produces: same interface, `NAME === "formulas"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/math.test.mjs`'s `tests` object (before the closing `};`):

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/run.mjs math`
Expected: FAIL — `mathFormulas` undefined

- [ ] **Step 3: Write `scripts/mathFormulas.js`**

```js
import { MONEY_TOLERANCE, SEC_TOLERANCE } from "./config.js";

/**
 * Math interface backed by ns.formulas.hacking.
 *
 * Exact where the analyze implementation can only approximate, because
 * formulas takes a SERVER OBJECT: we can hand it a hypothetical state instead
 * of whatever the server happens to be right now.
 *
 * RAM charged to whoever imports this:
 *   getServer 2.00 + getPlayer 0.50 = 2.50 GB
 * Every ns.formulas.* function is 0 GB, and the server object supplies money,
 * security and the three op times, so none of getServerMoneyAvailable,
 * getServerSecurityLevel, getServerMinSecurityLevel, getServerMaxMoney,
 * getHackTime, getGrowTime or getWeakenTime is needed here.
 */

export const NAME = "formulas";

/**
 * Confirm Formulas.exe is actually owned.
 *
 * ns.formulas.* throws when the program is missing, and it throws at CALL time,
 * not import time - so without this check the failure would surface mid-cycle
 * as a raw exception instead of at startup with a usable message.
 */
export function prepare(ns) {
  try {
    ns.formulas.hacking.weakenEffect(1);
    return { ok: true };
  } catch {
    return {
      ok: false,
      error:
        "Formulas.exe is not available on home. Run scripts/manager.js instead - " +
        "it uses the *Analyze API and works without the program.",
    };
  }
}

export function snapshot(ns, host) {
  const server = ns.getServer(host);
  const player = ns.getPlayer();
  const maxMoney = server.moneyMax;
  const money = server.moneyAvailable;
  const minSec = server.minDifficulty;
  const sec = server.hackDifficulty;
  return {
    ns, host, server, player, maxMoney, money, minSec, sec,
    moneyOk: money >= maxMoney * MONEY_TOLERANCE,
    secOk: sec <= minSec + SEC_TOLERANCE,
  };
}

/** See mathAnalyze.maxMoneyOf. getServer is already charged here, so this is free. */
export function maxMoneyOf(ns, host) {
  return ns.getServer(host).moneyMax;
}

export function hackFractionPerThread(snap) {
  return snap.ns.formulas.hacking.hackPercent(snap.server, snap.player);
}

/**
 * Security per thread.
 *
 * These are fixed game constants, not formulas outputs - the formulas API has
 * no hackSecurity/growSecurity entry, only weakenEffect. They are the same
 * numbers calibrate.js measures, so both implementations agree by construction.
 */
export function securityPerHackThread() { return 0.002; }
export function securityPerGrowThread() { return 0.004; }

export function securityPerWeakenThread(snap) {
  // weakenEffect(1) rather than a literal: it is the one security constant the
  // formulas API exposes, and it tracks BitNode multipliers.
  return snap.ns.formulas.hacking.weakenEffect(1);
}

/**
 * Grow threads to take money from fromMoney to toMoney at a given security.
 *
 * EXACT. The server object is cloned and overwritten with the hypothetical
 * state, so this answers "what will grow need when it lands", not "what would
 * grow need if it ran right now". That distinction is the entire reason for
 * this module: prep sizes waves for a server whose security is about to change,
 * and a batch's grow runs after its hack has already taken the money.
 *
 * growThreads also models the additive +$1/thread term that growthAnalyze
 * ignores, which is what GROW_MARGIN was padding against.
 */
export function growThreadsToRestore(snap, fromMoney, toMoney, atSecurity) {
  const from = Math.max(fromMoney, 1);
  const to = Math.min(toMoney, snap.maxMoney);
  if (to <= from) return 0;

  const hypothetical = { ...snap.server, moneyAvailable: from, hackDifficulty: atSecurity };
  return snap.ns.formulas.hacking.growThreads(hypothetical, snap.player, to);
}

export function opTimes(snap) {
  const f = snap.ns.formulas.hacking;
  return {
    hack: f.hackTime(snap.server, snap.player),
    grow: f.growTime(snap.server, snap.player),
    weaken: f.weakenTime(snap.server, snap.player),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/run.mjs`
Expected: all PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/mathFormulas.js tests/math.test.mjs
git commit -m "feat: formulas-backed math implementation

Exact where the analyze path approximates, because formulas takes a server
object: growThreadsToRestore clones it and overwrites moneyAvailable and
hackDifficulty, so it answers what grow will need when it LANDS rather than
what it would need right now.

A test asserts the asymmetry directly - formulas returns more threads at
elevated security, analyze returns the same number either way - so the known
limitation cannot later be mistaken for equivalence and 'fixed'."
```

---

### Task 4: Make `prepper.js` math-agnostic

`prepper.js` currently calls `ns.growthAnalyze` and reads `calib` directly. Both
move behind the injected math module, which is what lets `managerCore` stay free
of math RAM.

**Files:**
- Modify: `scripts/prepper.js` (`sizeGrowWave`, `planPrepWave`, `prep`, `measure`, `isPrepped`)
- Create: `tests/prep.test.mjs`
- Modify: `scripts/prep.js` (entry: inject `mathAnalyze`)
- Create: `scripts/prep-formulas.js`

**Interfaces:**
- Consumes: the math interface (Task 2), `mathAnalyze` / `mathFormulas`.
- Produces:
  - `sizeGrowWave(pool, ram, math, snap, growWanted, extraWeaken)` → `{grow, weaken}`
  - `planPrepWave(pool, ram, math, snap)` → `{grow, weaken, mode}`
  - `prep(ns, host, {math, ram, port, maxCycles, idPrefix, buildPool, log})` → `{ok, cycles, reason, m}`
  - `measure(ns, host, math)` → snapshot (delegates to `math.snapshot`)
  - `pickTarget(ns, math)` → `string | null` (now takes math, for `maxMoneyOf`)
  - `isPrepped(snap)` unchanged

- [ ] **Step 1: Write the failing test**

Create `tests/prep.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/run.mjs prep`
Expected: FAIL — `prep` rejects the `math` option / still calls `ns.growthAnalyze`

- [ ] **Step 3: Rewrite `sizeGrowWave` and `planPrepWave`**

In `scripts/prepper.js`, replace `sizeGrowWave` (line 159) and `planPrepWave`
(line 199) with:

```js
export function sizeGrowWave(pool, ram, math, snap, growWanted, extraWeaken = 0) {
  let grow = Math.min(growWanted, pool.maxThreadsFor(ram.grow));
  const perWeaken = math.securityPerWeakenThread(snap);
  const perGrow = math.securityPerGrowThread(snap);

  while (grow > 0) {
    // extraWeaken covers security the server is ALREADY carrying, on top of
    // what this grow will add. Both are cancelled by the same weaken landing.
    const weaken = Math.max(1, Math.ceil((perGrow * grow) / perWeaken) + extraWeaken);

    const g = pool.allocate(ram.grow, grow);
    if (g) {
      const w = pool.allocate(ram.weaken, weaken);
      pool.release(g);
      if (w) {
        pool.release(w);
        return { grow, weaken };
      }
    }

    const need = grow * ram.grow + weaken * ram.weaken;
    const scaled = Math.floor(grow * (pool.freeRam / need));
    grow = Math.min(scaled, grow - 1);
  }

  return { grow: 0, weaken: Math.min(extraWeaken, pool.maxThreadsFor(ram.weaken)) };
}

export function planPrepWave(pool, ram, math, snap) {
  const excess = Math.max(0, snap.sec - snap.minSec);
  const perWeaken = math.securityPerWeakenThread(snap);
  const fixSec = excess > 0 ? Math.ceil(excess / perWeaken) : 0;

  if (snap.moneyOk) {
    // maxThreadsFor, NOT freeRam / ramPerThread. Free RAM is spread across hosts
    // and each host floors its own thread count, so the total is not divisible.
    const fits = pool.maxThreadsFor(ram.weaken);
    return {
      grow: 0,
      weaken: Math.min(fixSec, fits),
      mode: `weaken (need ${fixSec}t for ${excess.toFixed(2)} sec)`,
    };
  }

  // Grow AND weaken in one wave, whatever the security. Grow lands one spacer
  // BEFORE the weaken, so a single weaken cancels both the drift the server
  // already carries and the security the grow adds. Sequential phases each cost
  // a full weaken window; threads are the cheap resource once the pool is large.
  //
  // atSecurity is snap.sec because grow really does execute at the CURRENT
  // security - it lands before this wave's weaken. The formulas implementation
  // uses that argument; the analyze one ignores it and is approximate here.
  const wanted = Math.ceil(
    math.growThreadsToRestore(snap, snap.money, snap.maxMoney, snap.sec) * GROW_MARGIN,
  );
  const plan = sizeGrowWave(pool, ram, math, snap, wanted, fixSec);
  const mode =
    plan.grow === 0
      ? `weaken only (${excess.toFixed(2)} sec drift needs ${fixSec}t; no room left to grow)`
      : `grow (want ${wanted}t to reach max money)` +
        (fixSec > 0 ? ` + ${fixSec}t weaken for ${excess.toFixed(2)} sec drift` : "");
  return { ...plan, mode };
}
```

- [ ] **Step 4: Re-point `measure`, `isPrepped` and `prep` at the math module**

In `scripts/prepper.js`, replace `measure` (line 108) with:

```js
/**
 * Current state of a host.
 *
 * Delegates to the math module because the formulas implementation already
 * holds a getServer object with these fields, and paying 0.40 GB for four
 * getServer* calls to re-read them would cancel out the swap's RAM saving.
 */
export function measure(ns, host, math) {
  return math.snapshot(ns, host);
}
```

Change `pickTarget` (line 133) to take the math module, so the formulas build
never needs `ns.getServerMaxMoney`:

```js
export function pickTarget(ns, math) {
  const level = ns.getHackingLevel();
  let best = null;
  for (const host of ServerPool.scanAll(ns)) {
    if (host === "home" || !ns.hasRootAccess(host)) continue;
    const maxMoney = math.maxMoneyOf(ns, host);
    if (maxMoney <= 0) continue;
    if (ns.getServerRequiredHackingLevel(host) > level) continue;
    if (!best || maxMoney > best.maxMoney) best = { host, maxMoney };
  }
  return best?.host ?? null;
}
```

In `prep` (line 362), change the options block and the two call sites:

```js
  const {
    math,
    ram = workerRam(ns),
    port = REPORT_PORT,
    maxCycles = DEFAULT_MAX_CYCLES,
    idPrefix = "prep",
    buildPool = () => buildWorkerPool(ns),
    log = (s) => ns.print(s),
  } = opts;

  if (!math) {
    return { ok: false, cycles: 0, reason: "no math implementation supplied", m: null };
  }
```

Replace every `measure(ns, host)` inside `prep` with `math.snapshot(ns, host)`,
and the `planPrepWave(ns, host, pool, ram, calib, m)` call with
`planPrepWave(pool, ram, math, m)`.

Delete the now-unused imports of `growSecurity` and `weakenThreadsFor` from
`./calib.js`, and the `GROW_MARGIN` import stays (still used above).

Update the module header's RAM block to:

```
 * RAM charged to whoever imports this (verified against the fork's docs):
 *   ram.js 0.35 + exec 1.30 + getScriptRam 0.10 + fileExists 0.10
 *   + getServerRequiredHackingLevel 0.10 + getHackingLevel 0.05
 *   = 2.00 GB   (ports, sleep, print are 0; ALL target reads and thread math
 *   now come from the injected math module, which is what lets the two
 *   implementations stay separately priced)
```

- [ ] **Step 5: Update the prep entry scripts**

Rewrite `scripts/prep.js`'s `main` to prepare and inject `mathAnalyze`:

```js
import { REPORT_PORT } from "./config.js";
import { prep, measure, pickTarget, DEFAULT_MAX_CYCLES } from "./prepper.js";
import * as math from "./mathAnalyze.js";
```

and inside `main`, replace the `loadCalibration` block with:

```js
  const ready = math.prepare(ns);
  if (!ready.ok) {
    ns.tprint(`ERROR: ${ready.error}`);
    return;
  }
```

then pass `math` through: `const res = await prep(ns, host, { math, maxCycles });`
and `const start = measure(ns, host, math);`

Create `scripts/prep-formulas.js` as the same file with one line changed:

```js
import * as math from "./mathFormulas.js";
```

and its header RAM line reading `1.60 base + prepper.js 2.00 + mathFormulas 2.50 = 6.10 GB`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node tests/run.mjs`
Expected: all PASS (10 tests)

- [ ] **Step 7: Commit**

```bash
git add scripts/prepper.js scripts/prep.js scripts/prep-formulas.js tests/prep.test.mjs
git commit -m "refactor: prepper takes an injected math module

prepper.js no longer calls growthAnalyze or reads the calibration cache. All
target reads and thread math come from the injected implementation, which is
what keeps prepper free of math RAM and lets each entry point pay for exactly
one backend.

A test asserts prepper.js contains no direct ns math calls, so the separation
cannot rot back."
```

---

### Task 5: Split the manager and add both entry points

**Files:**
- Create: `scripts/managerCore.js` (from `scripts/manager.js`, math removed)
- Rewrite: `scripts/manager.js` (entry, injects `mathAnalyze`)
- Create: `scripts/manager-formulas.js` (entry, injects `mathFormulas`)
- Create: `tests/isolation.test.mjs`
- Create: `tests/ram.test.mjs`

**Interfaces:**
- Consumes: `prepper.js` (Task 4), math interface (Tasks 2-3).
- Produces: `run(ns, math)` from `managerCore.js`; both entries export `main(ns)`.

- [ ] **Step 1: Write the failing isolation and RAM tests**

Create `tests/isolation.test.mjs`:

```js
import { readScript, assert } from "./harness.mjs";

/** Everything a script can reach through ./x.js imports, transitively. */
function importClosure(bare, seen = new Set()) {
  if (seen.has(bare)) return seen;
  seen.add(bare);
  const src = readScript(bare);
  for (const m of src.matchAll(/from\s+"\.\/([\w-]+)\.js"/g)) importClosure(m[1], seen);
  return seen;
}

export const tests = {
  "manager.js cannot reach mathFormulas": () => {
    const closure = importClosure("manager");
    assert(!closure.has("mathFormulas"),
      `manager.js reaches mathFormulas - it would be charged 2.50 GB for math it never uses. Closure: ${[...closure]}`);
    assert(closure.has("mathAnalyze"), "manager.js should reach mathAnalyze");
  },

  "manager-formulas.js cannot reach mathAnalyze": () => {
    const closure = importClosure("manager-formulas");
    assert(!closure.has("mathAnalyze"),
      `manager-formulas.js reaches mathAnalyze - it would be charged 2.00 GB for hackAnalyze and growthAnalyze it never uses. Closure: ${[...closure]}`);
    assert(!closure.has("calib"), "manager-formulas.js should not need the calibration cache");
  },

  "managerCore and prepper are math-free": () => {
    for (const bare of ["managerCore", "prepper"]) {
      const closure = importClosure(bare);
      assert(!closure.has("mathAnalyze") && !closure.has("mathFormulas"),
        `${bare}.js must not import a math implementation - the entry scripts inject one`);
    }
  },
};
```

Create `tests/ram.test.mjs`:

```js
import { readScript, assert } from "./harness.mjs";

// Verified against src/Netscript/RamCostGenerator.ts in this fork.
const COST = {
  scan: 0.2, hack: 0.1, grow: 0.15, weaken: 0.15,
  hackAnalyze: 1, hackAnalyzeSecurity: 1, hackAnalyzeThreads: 1, hackAnalyzeChance: 1,
  growthAnalyze: 1, growthAnalyzeSecurity: 1, weakenAnalyze: 1,
  exec: 1.3, run: 1, spawn: 2, scp: 0.6, kill: 0.5, killall: 0.5,
  hasRootAccess: 0.05, getHostname: 0.05, getHackingLevel: 0.05,
  getServer: 2, getServerMoneyAvailable: 0.1, getServerSecurityLevel: 0.1,
  getServerMinSecurityLevel: 0.1, getServerMaxMoney: 0.1,
  getServerRequiredHackingLevel: 0.1, getServerNumPortsRequired: 0.1,
  getServerGrowth: 0.1, getServerMaxRam: 0.05, getServerUsedRam: 0.05,
  fileExists: 0.1, isRunning: 0.1, ps: 0.2, ls: 0.2,
  getScriptRam: 0.1, getHackTime: 0.05, getGrowTime: 0.05, getWeakenTime: 0.05,
  getPlayer: 0.5, nuke: 0.05, brutessh: 0.05, ftpcrack: 0.05,
  relaysmtp: 0.05, httpworm: 0.05, sqlinject: 0.05,
};
const BASE = 1.6;

function closure(bare, seen = new Set()) {
  if (seen.has(bare)) return seen;
  seen.add(bare);
  for (const m of readScript(bare).matchAll(/from\s+"\.\/([\w-]+)\.js"/g)) closure(m[1], seen);
  return seen;
}

/**
 * Sum each distinct ns function reachable from an entry script.
 *
 * Approximates the game's static analysis: charged ONCE per function, however
 * many call sites. Comments and strings can produce false hits, so this counts
 * only real call syntax `ns.fn(`.
 */
function ramOf(bare) {
  const fns = new Set();
  for (const mod of closure(bare)) {
    const src = readScript(mod).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const m of src.matchAll(/\bns\.(\w+)\s*\(/g)) if (COST[m[1]] !== undefined) fns.add(m[1]);
  }
  return BASE + [...fns].reduce((n, f) => n + COST[f], 0);
}

export const tests = {
  "manager.js (analyze) stays at 6.15 GB": () => {
    const ram = ramOf("manager");
    assert(Math.abs(ram - 6.15) < 0.011, `expected 6.15 GB, got ${ram.toFixed(2)}`);
  },

  "manager-formulas.js costs 6.10 GB": () => {
    const ram = ramOf("manager-formulas");
    assert(Math.abs(ram - 6.10) < 0.011, `expected 6.10 GB, got ${ram.toFixed(2)}`);
  },

  "neither entry pays for the other's backend": () => {
    assert(ramOf("manager") < 8, "analyze entry is paying formulas cost");
    assert(ramOf("manager-formulas") < 8, "formulas entry is paying analyze cost");
  },
};
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/run.mjs isolation`
Expected: FAIL — `ENOENT` reading `manager-formulas.js`

- [ ] **Step 3: Create `managerCore.js`**

```bash
git mv scripts/manager.js scripts/managerCore.js
```

Then edit `scripts/managerCore.js`:

1. Change the imports — drop `loadCalibration`/`growBaseFor` and add nothing:

```js
import {
  STEAL_FRACTION, SPACER_MS, BATCH_SPACING_MS, GROW_MARGIN, HACK_CONTIGUOUS,
  HOME_RESERVE_GB, REPORT_PORT, REPORT_DRAIN_MS, PORT_CAPACITY,
  MAX_VOLLEY_BATCHES, VOLLEY_GRACE_MS, DESYNC_STRIKES, VOLLEY_OK_FRACTION,
  TARGET_SWITCH_MARGIN, WORKER_FILES, WORKER_RAM_FALLBACK, BATCH_OPS, OP_WORKER,
} from "./config.js";
import { analyzeBatch, batchOk } from "./verify.js";
import { prep, isPrepped, pickTarget, buildWorkerPool } from "./prepper.js";
```

2. Change `export async function main(ns)` to `export async function run(ns, math)`.

3. Delete `growthBasis` (lines 111-117) entirely — the math module owns this now.

4. Change `planThreads` and `planThreadsForHack` to take `math` and `snap`
   instead of `calib`, `perThread`, `maxMoney`, `growBase`:

```js
function planThreads(math, snap, steal) {
  const perThread = math.hackFractionPerThread(snap);
  const hack = Math.max(1, Math.ceil(steal / perThread));
  return planThreadsForHack(math, snap, hack, perThread);
}

/**
 * Thread counts for a batch built around an exact hack thread count.
 *
 * Hack threads are the quantised variable - steal only ever takes the values
 * hack * perThread - so the steal search enumerates these directly.
 *
 * perThread and the three security constants are read ONCE by the caller and
 * passed in, so this stays free of ns calls: the steal search runs hundreds of
 * candidates and must not touch the API.
 */
function planThreadsForHack(math, snap, hack, perThread, consts) {
  const steal = hack * perThread;
  if (!(steal < 1)) return { error: `hack ${hack}t would take ${steal} of the server` };

  const weaken1 = Math.max(1, Math.ceil((consts.hackSec * hack) / consts.weakenSec));

  // Money after this batch's hack lands, which is the state its grow must undo.
  // atSecurity is minSec: the batch's first weaken has already landed by then,
  // so grow executes at baseline security - not at whatever the server shows now.
  const afterHack = snap.maxMoney * (1 - steal);
  const grow = Math.max(1, Math.ceil(
    math.growThreadsToRestore(snap, afterHack, snap.maxMoney, snap.minSec) * GROW_MARGIN,
  ));

  const weaken2 = Math.max(1, Math.ceil((consts.growSec * grow) / consts.weakenSec));
  const hackAmount = snap.maxMoney * steal;
  return { hack, weaken1, grow, weaken2, perThread, steal, hackAmount };
}
```

5. In `chooseSteal`, take `(pool, ram, math, snap, perThread, consts, cap)` and
   call `planThreadsForHack(math, snap, hack, perThread, consts)`.

6. Replace `planTiming(ns, host)` (line 246) with:

```js
function planTiming(math, snap) {
  const { hack: H, grow: G, weaken: W } = math.opTimes(snap);
  const s = SPACER_MS;
  return {
    W, H, G, s,
    opTime: { H, W1: W, G, W2: W },
    land: { H: W - s, W1: W, G: W + s, W2: W + 2 * s },
    spacing: Math.max(BATCH_SPACING_MS, 4 * s),
    windowMs: W,
  };
}
```

7. In `run`, replace the calibration block with a math check, and the per-cycle
   reads with snapshot + constants:

```js
  const ready = math.prepare(ns);
  if (!ready.ok) {
    ns.tprint(`ERROR: ${ready.error}`);
    return;
  }
```

```js
    // One snapshot per cycle. Everything downstream reads from it, so the
    // per-cycle ns cost is fixed no matter how many steal candidates are tried.
    let m = math.snapshot(ns, target);
```

```js
    const consts = {
      hackSec: math.securityPerHackThread(m),
      growSec: math.securityPerGrowThread(m),
      weakenSec: math.securityPerWeakenThread(m),
    };
    const perThread = math.hackFractionPerThread(m);
    if (!(perThread > 0)) {
      ns.tprint(`ERROR: hack fraction for ${target} is ${perThread} - level too low or no root`);
      return;
    }
    const timing = planTiming(math, m);
```

   Delete the `growthBasis` call and the `basis` variable; pass `math, m` where
   `basis.base` was used. Pass `math` into the `prep(...)` options object. Replace
   `measure(ns, target)` with `math.snapshot(ns, target)` throughout.

   In the retarget block, use `pickTarget(ns, math)` and replace both
   `ns.getServerMaxMoney(...)` calls with `math.maxMoneyOf(ns, ...)`:

```js
    if (!pinnedTarget) {
      const best = pickTarget(ns, math);
      if (best && best !== target) {
        const bestMoney = math.maxMoneyOf(ns, best);
        const currentMoney = math.maxMoneyOf(ns, target);
        if (bestMoney > currentMoney * TARGET_SWITCH_MARGIN) {
```

   Also update the initial `pickTarget(ns)` call near the top of `run` to
   `pickTarget(ns, math)`. This must happen AFTER `math.prepare(ns)` succeeds.

8. Update the header: retitle to "the shotgun volley loop (math-agnostic core)",
   note that `run(ns, math)` is called by the entry scripts, and set the RAM line
   to:

```
 * RAM charged to whoever imports this:
 *   ram.js/prepper.js union 2.00 + exec (already counted) = 2.00 GB
 * The math implementation's cost is added by whichever entry script imports it:
 *   manager.js + mathAnalyze  = 6.15 GB
 *   manager-formulas.js + mathFormulas = 6.10 GB
```

- [ ] **Step 4: Write both entry scripts**

Create `scripts/manager.js`:

```js
import { run } from "./managerCore.js";
import * as math from "./mathAnalyze.js";

/**
 * The shotgun volley loop, using the *Analyze API and the calibration cache.
 *
 * This is the always-available build: it needs no programs and works from
 * minute one of a BitNode, which is why it keeps the plain name. If you own
 * Formulas.exe, scripts/manager-formulas.js computes the same batches exactly -
 * see docs/superpowers/specs/2026-09-05-formulas-integration-design.md.
 *
 * Do not import mathFormulas here. Bitburner charges for every ns function
 * reachable through imports, so touching both backends from one script would
 * cost 2.50 GB that this build never uses. tests/isolation.test.mjs enforces it.
 *
 * RAM: 1.60 base + managerCore/prepper 2.00 + mathAnalyze 2.55 = 6.15 GB
 */

/** @param {NS} ns */
export async function main(ns) {
  // Free: fileExists is already charged to this build via buildWorkerPool.
  if (ns.fileExists("Formulas.exe", "home")) {
    ns.print("note: Formulas.exe is available - scripts/manager-formulas.js is more accurate");
  }
  await run(ns, math);
}
```

Create `scripts/manager-formulas.js`:

```js
import { run } from "./managerCore.js";
import * as math from "./mathFormulas.js";

/**
 * The shotgun volley loop, using ns.formulas.hacking.
 *
 * Exact where the analyze build approximates, and slightly cheaper, because
 * every ns.formulas.* call is 0 GB and the getServer object supplies the money,
 * security and timing reads that would otherwise cost 0.55 GB.
 *
 * Requires Formulas.exe. math.prepare() checks at startup and exits with a
 * message naming manager.js, rather than throwing mid-cycle.
 *
 * Do not import mathAnalyze here - see the note in manager.js.
 *
 * RAM: 1.60 base + managerCore/prepper 2.00 + mathFormulas 2.50 = 6.10 GB
 */

/** @param {NS} ns */
export async function main(ns) {
  await run(ns, math);
}
```

- [ ] **Step 5: Run all tests**

Run: `node tests/run.mjs`
Expected: all PASS (16 tests). If `ram.test.mjs` reports a figure other than
6.15 / 6.10, an `ns` call has leaked into the wrong module — read the failure's
reported total and find the extra function before continuing.

- [ ] **Step 6: Verify every script still parses**

Run:
```bash
node -e '
const fs=require("fs"),os=require("os"),p=require("path"),cp=require("child_process");
const d=fs.mkdtempSync(p.join(os.tmpdir(),"parse-"));
for(const f of fs.readdirSync("scripts").filter(f=>f.endsWith(".js"))){
  fs.writeFileSync(p.join(d,f.replace(/\.js$/,".mjs")),
    fs.readFileSync(p.join("scripts",f),"utf8").replace(/from\s+"\.\/([\w-]+)\.js"/g,`from "./$1.mjs"`));
}
let bad=0;
for(const f of fs.readdirSync(d)){try{cp.execSync(`node --check "${p.join(d,f)}"`)}catch(e){console.log("FAIL",f);bad++}}
console.log(bad?`${bad} failed`:"all parse");
'
```
Expected: `all parse`

- [ ] **Step 7: Commit**

```bash
git add -A scripts/ tests/
git commit -m "feat: twin manager entry points with injected math

managerCore.js is the volley loop with every math call removed; manager.js and
manager-formulas.js are five-line entries that each import exactly one backend.
Bitburner charges per ns function reachable through imports, so this is what
keeps the analyze build at exactly its old 6.15 GB while the formulas build
comes in at 6.10.

Two tests enforce the split: an import-closure test proving neither entry can
reach the other's backend, and a RAM test that sums the reachable ns functions
against the fork's cost table and asserts both totals."
```

---

### Task 6: Teach `boot.js` about the manager pair

**Files:**
- Modify: `scripts/boot.js`
- Modify: `scripts/config.js` (add `FORMULAS_MARKER`, `FORMULAS_PROGRAM`)
- Create: `tests/boot.test.mjs`

**Interfaces:**
- Consumes: both manager entries (Task 5).
- Produces: `/data/formulas.txt` marker for 0 GB readers.

- [ ] **Step 1: Add config constants**

Append to `scripts/config.js`:

```js
/** The program that unlocks ns.formulas. */
export const FORMULAS_PROGRAM = "Formulas.exe";

/**
 * Written by boot.js so other scripts can learn whether Formulas is owned
 * without paying 0.10 GB for fileExists. Advisory only - boot re-checks every
 * tick, so a stale value corrects itself within one tick and nothing that
 * matters is decided from it.
 */
export const FORMULAS_MARKER = "/data/formulas.txt";
```

- [ ] **Step 2: Write the failing test**

Create `tests/boot.test.mjs`:

```js
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `node tests/run.mjs boot`
Expected: FAIL — boot launches `scripts/manager.js` regardless of Formulas

- [ ] **Step 4: Modify `scripts/boot.js`**

Add to the imports:

```js
import { ROOT_MARKER, CLOUD_DONE_MARKER, CLOUD_RECHECK_MS,
         FORMULAS_PROGRAM, FORMULAS_MARKER } from "./config.js";
```

Replace the `MANAGER` constant with the pair:

```js
const MANAGER_ANALYZE = "/scripts/manager.js";
const MANAGER_FORMULAS = "/scripts/manager-formulas.js";
```

Add after `killDuplicates`:

```js
/**
 * Ensure exactly one manager runs, and that it is the right one.
 *
 * The two managers are ALTERNATIVES, not separate services. killDuplicates only
 * dedupes by filename, so on its own it would happily leave an analyze manager
 * and a formulas manager running side by side - each believing it owned the RAM
 * pool and the report port, over-committing the same RAM and stealing each
 * other's completion reports.
 *
 * @returns {boolean} true if a manager is running when this returns
 */
function ensureOneManager(ns, wanted, other, args, log) {
  for (const p of instancesOf(ns, other)) {
    ns.kill(p.pid);
    log(`stopped ${other} - switching to ${wanted}`);
  }
  killDuplicates(ns, wanted, log);
  return isUp(ns, wanted) || ensureService(ns, wanted, args, log);
}
```

In `main`, parse the flag and resolve the pair each tick:

```js
  const noFormulas = args.includes("--no-formulas");
```

Inside the tick, before the calibrate step:

```js
    // Re-checked every tick, not once at startup: Formulas.exe is lost on every
    // augment install and can be bought at any time, so the right build to run
    // changes underneath a long-lived boot.
    const hasFormulas = !noFormulas && ns.fileExists(FORMULAS_PROGRAM, "home");
    ns.write(FORMULAS_MARKER, `${hasFormulas ? 1 : 0}\n${Date.now()}`, "w");
```

Change the calibrate condition to skip on the formulas build:

```js
    // The calibration cache exists only to feed mathAnalyze. On the formulas
    // build it is dead weight, and calibrating costs a 6.20 GB transient.
    const calib = hasFormulas ? null : loadCalibration(ns);
    const age = calib ? calibAgeMs(calib) : Infinity;
    if (!hasFormulas && (!calib || age > CALIB_MAX_AGE_MS || managerDied)) {
      ...unchanged body...
    }
```

Replace the manager service block:

```js
    if (!noManager) {
      const wanted = hasFormulas ? MANAGER_FORMULAS : MANAGER_ANALYZE;
      const other = hasFormulas ? MANAGER_ANALYZE : MANAGER_FORMULAS;
      ensureOneManager(ns, wanted, other, target ? ["--target", target] : [], log);
    }
```

And update `managerDied` to consider both:

```js
    const managerDied = !firstPass && !noManager
      && !isUp(ns, MANAGER_ANALYZE) && !isUp(ns, MANAGER_FORMULAS);
```

Update the header RAM line to `1.60 base + run 1.00 + ps 0.20 + kill 0.50 + fileExists 0.10 = 3.40 GB`
and add `--no-formulas` to the usage block.

- [ ] **Step 5: Run all tests**

Run: `node tests/run.mjs`
Expected: all PASS (21 tests)

- [ ] **Step 6: Commit**

```bash
git add scripts/boot.js scripts/config.js tests/boot.test.mjs
git commit -m "feat: boot picks the manager build and treats the pair as one service

Formulas.exe is lost on every augment install and can be bought at any time, so
the check runs every tick rather than once at startup. Buying it swaps the
running manager within a tick.

The two managers are alternatives, not separate services: killDuplicates only
dedupes by filename and would have left both running, each convinced it owned
the RAM pool and the report port. ensureOneManager kills the wrong build first.

boot also skips calibrate.js entirely on the formulas build - the cache feeds
only mathAnalyze - which drops a recurring 6.20 GB transient."
```

---

### Task 7: In-game verification and documentation

Mocks have disagreed with the live game before in this codebase. This task is
the real gate.

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/superpowers/plans/2026-09-05-formulas-verification.md` (results log)

- [ ] **Step 1: Update CLAUDE.md**

In the architecture table, replace the `manager.js` row and add:

```markdown
| `mathAnalyze.js` | math interface via *Analyze + calibration cache | 2.55 |
| `mathFormulas.js` | math interface via `ns.formulas` | 2.50 |
| `managerCore.js` | the volley loop, math-free | 2.00 |
| `manager.js` | entry: core + mathAnalyze (always works) | 6.15 |
| `manager-formulas.js` | entry: core + mathFormulas | 6.10 |
```

Add to the "Running things" block:

```
run scripts/boot.js --no-formulas       # force the analyze build
node tests/run.mjs                      # run the test suite
```

Add a subsection under "RAM is the design constraint":

```markdown
### Two math backends

`mathAnalyze.js` and `mathFormulas.js` implement the same interface. They must
never be reachable from the same entry point — Bitburner charges for every `ns`
function reachable through imports, so a script touching both pays ~2.5 GB it
cannot use. `tests/isolation.test.mjs` enforces this by walking the import
closure; `tests/ram.test.mjs` asserts the resulting totals.

`growThreadsToRestore(snap, from, to, atSecurity)` is where they differ.
Formulas honours `atSecurity` by cloning the server object; analyze cannot, and
always evaluates at current security. That asymmetry is deliberate and tested —
do not "fix" it into an equivalence.
```

- [ ] **Step 2: Deploy and run the analyze build in-game**

In the Bitburner terminal:

```
run scripts/deploy.js
run scripts/calibrate.js
run scripts/manager.js --dry-run
```

Record: chosen steal %, hack/W1/grow/W2 thread counts, batch RAM, batch count,
yield per volley.

- [ ] **Step 3: Run the formulas build against the same target**

```
run scripts/manager-formulas.js --dry-run
```

Record the same figures. Expected: thread counts within a few percent; **grow
threads slightly lower** on the formulas build, because `growThreads` models the
additive term that `GROW_MARGIN` was padding for. A large divergence (>20%)
means a bug — stop and investigate before firing anything.

- [ ] **Step 4: Fire one volley on each**

```
run scripts/manager.js --once
run scripts/manager-formulas.js --once
```

Both must report: all batches `ok`, `0 mistimed`, `0 incomplete`, jitter under
`SPACER_MS`, and the target back on baseline.

- [ ] **Step 5: Verify the live swap**

With `run scripts/boot.js` running and Formulas.exe owned, confirm the log shows
`stopped /scripts/manager.js - switching to /scripts/manager-formulas.js` and
that `ps` on home lists exactly one manager.

- [ ] **Step 6: Record results and commit**

Write the recorded figures into
`docs/superpowers/plans/2026-09-05-formulas-verification.md` as a table
(analyze vs formulas, per field), then:

```bash
git add CLAUDE.md docs/
git commit -m "docs: record Formulas integration verification results"
```

---

## Self-Review

**Spec coverage:**

| spec requirement | task |
|---|---|
| math interface, 7 members | 2 (defined + analyze impl) |
| `snapshot` owns target reads | 2, 4 |
| `growThreadsToRestore` explicit from/atSecurity | 2, 3 |
| formulas implementation | 3 |
| prepper math-agnostic | 4 |
| managerCore / twin entries | 5 |
| bare `manager.js` = analyze, free nudge | 5 |
| boot picks entry, pair as one service | 6 |
| `/data/formulas.txt` marker | 6 |
| skip calibrate on formulas build | 6 |
| `--no-formulas` rollback valve | 6 |
| `prepare()` fails cleanly without the program | 3 (impl), 6 (test) |
| contract test | 2, 3 |
| divergence test | 3 |
| plan-equivalence / isolation | 5 |
| in-game sign-off | 7 |
| cores and hackChance excluded | Global Constraints |
| RAM targets 6.15 / 6.10 / 3.40 | 5 (tested), 6 |

**Type consistency:** `snapshot` returns the same shape from both
implementations and is referred to as `snap` throughout. `math` is the parameter
name in every consumer. `growThreadsToRestore` has identical arity in both
implementations and at all call sites (`prepper.planPrepWave`,
`managerCore.planThreadsForHack`). `prepare` returns `{ok, error}` in both.
`run(ns, math)` is exported by `managerCore.js` and called by both entries.
`pickTarget(ns, math)` has the same arity at both call sites in `managerCore`
and in `prep.js` / `prep-formulas.js`.

**Correction made during review:** `maxMoneyOf` was added to the interface after
checking the RAM arithmetic. `pickTarget` and the retarget check called
`ns.getServerMaxMoney` directly, which the formulas build has no other use for —
it would have come in at 6.20 GB and failed the Task 5 RAM test against the
specced 6.10. The spec's interface list should be amended to match.

**Placeholder scan:** no TBD/TODO; every code step contains runnable code; no
step references an undefined function.

**Note on the side-by-side comparison:** the spec called for a throwaway
comparison script. Task 7 steps 2-3 do this by running both builds with
`--dry-run` and recording the figures, which needs no new script — better than
writing one, since `--dry-run` already prints exactly these numbers.
