import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPTS = path.resolve(import.meta.dirname, "..", "scripts");

/**
 * Files BELOW scripts/ that a top-level script imports.
 *
 * boot.js reaches scripts/continuous/config.js for the continuous worker paths.
 * It has to kill BOTH systems' orphan workers when it swaps between them, and a
 * hand-copied list of those paths would drift the moment a worker is renamed -
 * silently, since the only symptom is RAM held by batches nobody owns.
 *
 * Listed explicitly rather than walked recursively so this loader stays the
 * flat-file one. The continuous tree imports by absolute in-game path
 * ("scripts/continuous/lib/plan"), which needs the different rewrite in
 * tests/continuous.test.mjs; mirroring it here would mean two loaders that have
 * to agree about that.
 */
const NESTED = [
  "continuous/config.js",
  // The gang subsystem's pure modules. gang/math.js is where every gang
  // decision is made and it holds no ns call, so it is testable directly -
  // which is the point of putting the decisions there rather than in the
  // transients that act on them.
  "gang/config.js",
  "gang/math.js",
  "gang/marker.js",
  "gang/report.js",
  // The gang entry points hold ns calls, but only inside main() - nothing runs
  // at import time, so Node can load them and a test can drive gang.js's loop
  // with a mock ns.
  //
  // All of them are listed, including the ones no test drives, because merely
  // importing a module PARSES it. Nothing else in this repo parses the gang
  // transients, and a `node --check` cannot be run on them: there is no
  // package.json, so Node reads a bare .js as CommonJS and rejects `export`.
  // Two runtime errors have already reached the live game past a clean check.
  "gang/gang.js",
  "gang/tick.js",
  "gang/ascend.js",
  "gang/equip.js",
  "gang/war.js",
  "gang/create.js",
];

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

  for (const f of [...names, ...NESTED]) {
    const src = fs.readFileSync(path.join(SCRIPTS, f), "utf8");
    // The character class admits "/" so "./continuous/config.js" is rewritten
    // too; without it the specifier survives as .js and Node cannot resolve it,
    // which breaks every caller of loadScripts, not just boot's.
    const rewritten = src.replace(/from\s+"\.\/([\w\-/]+)\.js"/g, 'from "./$1.mjs"');
    const dest = path.join(dir, f.replace(/\.js$/, ".mjs"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, rewritten);
  }

  // Nested modules are keyed by their nested name ("gang/math"), so a caller
  // asking for a flat script cannot collide with one. They are imported here
  // rather than left as mirrored files because every one of them is constants
  // or pure arithmetic - nothing in NESTED may run an ns call at IMPORT
  // time, or loading it under Node would fail.
  const mods = {};
  for (const f of [...names, ...NESTED]) {
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
