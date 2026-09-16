import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPTS = path.resolve(import.meta.dirname, "..", "scripts");

/**
 * Files BELOW scripts/ that loadScripts() imports and keys by nested name.
 *
 * Every file is MIRRORED (see mirrorScripts), so an import into a subfolder
 * resolves whether or not it is listed here. This list is only what gets
 * imported up front - which also PARSES it, the one syntax check a nested
 * module gets.
 */
const NESTED = [
  "continuous/config.js",
  // managerCore.js imports the share functions from here, so the shotgun and
  // the continuous batcher run one copy of them.
  "continuous/lib/share.js",
  // The gang subsystem's pure modules. gang/math.js is where every gang
  // decision is made and it holds no ns call, so it is testable directly -
  // which is the point of putting the decisions there rather than in the
  // transients that act on them.
  "gang/config.js",
  "gang/math.js",
  // The supervisor holds ns calls only inside main(), so Node can load it and a
  // test can drive its loop with a mock ns. Importing it is also what PARSES it:
  // with no package.json, `node --check` reads a bare .js as CommonJS and
  // rejects `export`. Its rpc bodies are parsed by tests/rpc.test.mjs.
  "gang/gang.js",
];

/** Every .js under scripts/, as posix paths relative to it. */
export function scriptFiles(dir = SCRIPTS, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...scriptFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".js")) out.push(rel);
  }
  return out;
}

/**
 * Point one import specifier at the mirrored .mjs, relative to the importer.
 *
 * Both of the game's spellings, because the trees now import each other: the
 * top level writes "./continuous/lib/share.js", the continuous tree writes
 * "scripts/config". One rewrite for both is what lets a cross-tree import load
 * at all - the two loaders this replaced each knew only their own spelling.
 */
export function rewriteImports(src, rel) {
  const from = path.posix.dirname(rel);
  const to = (target) => {
    const spec = path.posix.relative(from, `${target}.mjs`);
    return spec.startsWith(".") ? spec : `./${spec}`;
  };
  return src
    .replace(/from\s+"scripts\/([\w\-/]+?)(?:\.js)?"/g, (_m, t) => `from "${to(t)}"`)
    .replace(/from\s+"\.\/([\w\-/]+)\.js"/g, (_m, t) => `from "${to(path.posix.join(from, t))}"`);
}

/**
 * Mirror ALL of scripts/ into a fresh temp dir as .mjs, and return the dir.
 *
 * Bitburner resolves "./config.js"; Node needs the real extension. Rewriting on
 * a copy keeps the game files untouched and means tests always run against what
 * is actually on disk, not a hand-maintained duplicate.
 */
export function mirrorScripts(prefix = "bbtest-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const rel of scriptFiles()) {
    const src = fs.readFileSync(path.join(SCRIPTS, rel), "utf8");
    const dest = path.join(dir, rel.replace(/\.js$/, ".mjs"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, rewriteImports(src, rel));
  }
  return dir;
}

export async function loadScripts() {
  const dir = mirrorScripts();
  const names = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith(".js"));

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
