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
const NESTED = ["continuous/config.js"];

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
