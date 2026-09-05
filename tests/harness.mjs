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
