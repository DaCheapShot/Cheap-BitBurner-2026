import { SETTINGS_FILE, KNOBS, parseSettings, setting, setSetting } from "./settings.js";

/**
 * Change a tunable live, without editing config.js or restarting anything.
 *
 *   run scripts/set.js                          list every setting
 *   run scripts/set.js hacknet.cash 0.9         set one
 *   run scripts/set.js hacknet.cash default     back to config.js's value
 *
 * Readers pick it up on their next sweep / loop / rpc body. See settings.js.
 * RAM: ns.read, ns.write and ns.tprint are 0 GB, so this is the 1.60 base.
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const [key, value] = ns.args.map(String);
  const text = ns.read(SETTINGS_FILE);

  if (key === undefined) {
    const o = parseSettings(text);
    const rows = Object.entries(KNOBS).map(([k, d]) => {
      const now = setting(text, k);
      const mark = k in o ? (now === o[k] ? " *" : " (override INVALID, using default)") : "";
      return `  ${k.padEnd(16)} ${String(now).padStart(8)}  default ${String(d.def).padStart(6)}` +
        `  [${d.min}, ${d.max}]  ${d.doc}${mark}`;
    });
    ns.tprint(`settings (${SETTINGS_FILE}, * = overridden):\n${rows.join("\n")}`);
    return;
  }
  if (value === undefined) {
    ns.tprint(`ERROR: usage: run scripts/set.js ${key} <value|default>`);
    return;
  }

  let next;
  try {
    next = setSetting(text, key, value);
  } catch (e) {
    ns.tprint(`ERROR: ${e.message}`);
    return;
  }
  const before = setting(text, key);
  ns.write(SETTINGS_FILE, next, "w");
  ns.tprint(`${key}: ${before} -> ${setting(next, key)}`);
}
