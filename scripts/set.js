import { SETTINGS_FILE, KNOBS, parseSettings, setting, setSetting, showSetting } from "./settings.js";

/**
 * Change a tunable live, without editing config.js or restarting anything.
 *
 *   run scripts/set.js                          list every setting
 *   run scripts/set.js hacknet.cash 0.9         set one
 *   run scripts/set.js hacknet.cash default     back to config.js's value
 *   run scripts/set.js gang.enabled off         switches take on/off (or 1/0)
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
    // KNOBS is grouped by script; a blank line between groups keeps each
    // script's settings visibly together.
    const group = (k) => k.split(".")[0];
    const rows = Object.entries(KNOBS).map(([k, d], i, all) => {
      const now = setting(text, k);
      const mark = k in o ? (now === o[k] ? " *" : " (override INVALID, using default)") : "";
      const range = d.bool ? "on/off" : `[${d.min}, ${d.max}]`;
      const gap = i && group(all[i - 1][0]) !== group(k) ? "\n" : "";
      return `${gap}  ${k.padEnd(17)} ${showSetting(k, now).padStart(8)}  default ${showSetting(k, d.def).padStart(6)}` +
        `  ${range.padEnd(12)}  ${d.doc}${mark}`;
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
  ns.tprint(`${key}: ${showSetting(key, before)} -> ${showSetting(key, setting(next, key))}` +
    ` (boot's log confirms it on its next tick)`);
}
