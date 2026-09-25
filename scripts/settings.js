import { CLOUD_BUDGET_FRACTION } from "./config.js";
import { HACKNET_CASH_FRACTION, PAYBACK_SECONDS } from "./hacknet/config.js";
import { EQUIP_BUDGET_FRACTION } from "./gang/config.js";
import {
  HOME_RAM_BUDGET_FRACTION, HOME_CORES_BUDGET_FRACTION, PROG_BUDGET_FRACTION,
} from "./sing/config.js";

/**
 * Live overrides for a handful of tunables, set from the terminal by
 * scripts/set.js and read at the point of use - so a change lands on the next
 * sweep, loop or rpc body with no edit and no restart.
 *
 * Why a file and not an in-game rewrite of config.js: the filesync extension
 * pushes disk -> game on every save and on connect, so an edit made inside the
 * game is silently reverted the next time anything is saved. The file lives on
 * home only, which is fine: every reader runs on home (unlike share.js, which is
 * why share needs a port).
 *
 * Pure, 0 GB, like config.js: no ns anywhere. Every default is IMPORTED from
 * the config.js that owns it, so config.js stays the one place a default lives.
 */
export const SETTINGS_FILE = "/data/settings.txt";

export const KNOBS = {
  "hacknet.cash": { def: HACKNET_CASH_FRACTION, min: 0, max: 1, doc: "fraction of cash one hacknet sweep may spend" },
  "hacknet.payback": { def: PAYBACK_SECONDS, min: 60, max: 7 * 86400, doc: "seconds an upgrade must repay itself within" },
  "cloud.cash": { def: CLOUD_BUDGET_FRACTION, min: 0, max: 1, doc: "fraction of cash one cloud purchase/upgrade may cost" },
  "gang.equip": { def: EQUIP_BUDGET_FRACTION, min: 0, max: 1, doc: "fraction of cash one gang equip sweep (~30s) may spend" },
  "sing.homeRam": { def: HOME_RAM_BUDGET_FRACTION, min: 0, max: 1, doc: "fraction of cash a home RAM upgrade may cost" },
  "sing.homeCores": { def: HOME_CORES_BUDGET_FRACTION, min: 0, max: 1, doc: "fraction of cash a home core upgrade may cost" },
  "sing.progs": { def: PROG_BUDGET_FRACTION, min: 0, max: 1, doc: "fraction of cash a darkweb program may cost" },

  // Service switches, read by boot.js every tick. Off STOPS a running resident
  // (cloud, gang, sing) and skips a transient (hacknet, contracts). The manager
  // is deliberately absent: stopping it drags in killOrphanWorkers and the
  // retired-manager rules, which --no-manager already owns.
  "enabled.cloud": { def: 1, min: 0, max: 1, bool: true, doc: "cloud.js buys/upgrades servers" },
  "enabled.gang": { def: 1, min: 0, max: 1, bool: true, doc: "gang.js supervisor" },
  "enabled.sing": { def: 1, min: 0, max: 1, bool: true, doc: "sing.js supervisor (off also releases the share hold)" },
  "enabled.hacknet": { def: 1, min: 0, max: 1, bool: true, doc: "hacknet money + hash sweeps" },
  "enabled.contracts": { def: 1, min: 0, max: 1, bool: true, doc: "coding contract sweep" },
};

const WORDS = { on: 1, true: 1, off: 0, false: 0 };

/** The overrides object in `text`, or {} for a missing or broken file. */
export function parseSettings(text) {
  try {
    const o = JSON.parse(String(text ?? "").trim() || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/**
 * The value in force for `key`: the override when it is a finite number inside
 * the knob's range, the default otherwise. NEVER throws - a hand-mangled file
 * must cost an override, not the sweep reading it.
 */
export function setting(text, key) {
  const k = KNOBS[key];
  if (!k) throw new Error(`unknown setting "${key}"`);
  const v = parseSettings(text)[key];
  return typeof v === "number" && Number.isFinite(v) && v >= k.min && v <= k.max ? v : k.def;
}

/**
 * New file text with `key` set to `value`, or cleared when `value` is
 * "default". Throws naming the problem - this is the trust boundary, the one
 * place a typo can be refused before anything reads it.
 */
export function setSetting(text, key, value) {
  const k = KNOBS[key];
  if (!k) throw new Error(`unknown setting "${key}" - one of: ${Object.keys(KNOBS).join(", ")}`);
  const o = parseSettings(text);
  if (String(value).trim().toLowerCase() === "default") {
    delete o[key];
  } else {
    const word = String(value).trim().toLowerCase();
    const v = k.bool && word in WORDS ? WORDS[word] : Number(value);
    if (k.bool && v !== 0 && v !== 1) throw new Error(`${key} is on or off, got "${value}"`);
    if (word === "" || !Number.isFinite(v) || v < k.min || v > k.max) {
      throw new Error(`${key} must be a number in [${k.min}, ${k.max}], got "${value}"`);
    }
    o[key] = v;
  }
  return JSON.stringify(o, null, 2);
}
