import { CLOUD_BUDGET_FRACTION } from "./config.js";
import { HACKNET_CASH_FRACTION, PAYBACK_SECONDS, HACKNET_EVERY, STUDY_LEVELS } from "./hacknet/config.js";
import { EQUIP_BUDGET_FRACTION, TICK_EVERY, WAR_EVERY, ASCEND_EVERY, EQUIP_EVERY } from "./gang/config.js";
import {
  HOME_RAM_BUDGET_FRACTION, HOME_CORES_BUDGET_FRACTION, PROG_BUDGET_FRACTION, SING_TICK_MS,
  AUTO_INSTALL, GRIND_GANG_KARMA, MIN_AUG_BATCH, IDLE_STUDY,
} from "./sing/config.js";

/** boot.js's tick. Here, not in boot.js, so the default has one home a pure module can import. */
export const BOOT_TICK_S = 60;

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

/**
 * Keys are `<script>.<knob>`, and each script's knobs stay TOGETHER here:
 * set.js lists them in this order, a group per script, and a test holds every
 * prefix contiguous. Order: gang, cloud, hacknet, sing, contracts, boot.
 *
 * `<script>.enabled` is the live switch, read by boot.js every tick. Off STOPS
 * a running resident (cloud, gang, sing) and skips a transient (hacknet,
 * contracts). The manager has none: stopping it drags in killOrphanWorkers and
 * the retired-manager rules, which --no-manager already owns.
 *
 * Cadences are read at the top of each loop, so they apply from the next wait.
 * sing.tick scales EVERY sing cadence with it (upgrade, progs, join, augs...
 * are counted in ticks) - deliberate: one knob slows or speeds all of sing.
 * The gang ones are counted in gang updates (2 s, faster in bonus time).
 */
export const KNOBS = {
  "gang.enabled": { def: 1, min: 0, max: 1, bool: true, doc: "gang.js supervisor" },
  "gang.equip": { def: EQUIP_BUDGET_FRACTION, min: 0, max: 1, doc: "fraction of cash one gang equip sweep (~30s) may spend" },
  "gang.tickEvery": { def: TICK_EVERY, min: 1, max: 300, int: true, doc: "gang updates between tick bodies" },
  "gang.warEvery": { def: WAR_EVERY, min: 1, max: 300, int: true, doc: "gang updates between war checks" },
  "gang.ascendEvery": { def: ASCEND_EVERY, min: 1, max: 300, int: true, doc: "gang updates between ascension passes" },
  "gang.equipEvery": { def: EQUIP_EVERY, min: 1, max: 300, int: true, doc: "gang updates between equipment sweeps" },

  "cloud.enabled": { def: 1, min: 0, max: 1, bool: true, doc: "cloud.js buys/upgrades servers" },
  "cloud.cash": { def: CLOUD_BUDGET_FRACTION, min: 0, max: 1, doc: "fraction of cash one cloud purchase/upgrade may cost" },

  "hacknet.enabled": { def: 1, min: 0, max: 1, bool: true, doc: "hacknet money + hash sweeps" },
  "hacknet.cash": { def: HACKNET_CASH_FRACTION, min: 0, max: 1, doc: "fraction of cash one hacknet sweep may spend" },
  "hacknet.payback": { def: PAYBACK_SECONDS, min: 60, max: 7 * 86400, doc: "seconds an upgrade must repay itself within" },
  "hacknet.every": { def: HACKNET_EVERY, min: 1, max: 60, int: true, doc: "boot ticks between hacknet sweeps" },
  "hacknet.studyLevels": { def: STUDY_LEVELS, min: 0, max: 100, int: true, doc: "Improve Studying levels to buy while sing studies" },

  // autoInstall and grindKarma are read inside the SWEEP and READ bodies;
  // minAugBatch at the top of each aug pass.
  "sing.enabled": { def: 1, min: 0, max: 1, bool: true, doc: "sing.js supervisor (off also releases the share hold)" },
  "sing.tick": { def: SING_TICK_MS / 1000, min: 5, max: 600, doc: "seconds per sing tick; scales all sing cadences" },
  "sing.homeRam": { def: HOME_RAM_BUDGET_FRACTION, min: 0, max: 1, doc: "fraction of cash a home RAM upgrade may cost" },
  "sing.homeCores": { def: HOME_CORES_BUDGET_FRACTION, min: 0, max: 1, doc: "fraction of cash a home core upgrade may cost" },
  "sing.progs": { def: PROG_BUDGET_FRACTION, min: 0, max: 1, doc: "fraction of cash a darkweb program may cost" },
  "sing.autoInstall": { def: AUTO_INSTALL ? 1 : 0, min: 0, max: 1, bool: true, doc: "install the aug queue once minAugBatch are queued" },
  "sing.grindKarma": { def: GRIND_GANG_KARMA ? 1 : 0, min: 0, max: 1, bool: true, doc: "grind Homicide + gym for gang karma (~15 h)" },
  "sing.idleStudy": { def: IDLE_STUDY ? 1 : 0, min: 0, max: 1, bool: true, doc: "nothing to work: a university class, not a money crime" },
  "sing.minAugBatch": { def: MIN_AUG_BATCH, min: 1, max: 100, int: true, doc: "augs a batch (plus the queue) must reach to buy" },

  "contracts.enabled": { def: 1, min: 0, max: 1, bool: true, doc: "coding contract sweep" },

  "boot.tick": { def: BOOT_TICK_S, min: 5, max: 3600, doc: "seconds between boot ticks (--interval wins)" },
};

const WORDS = { on: 1, true: 1, off: 0, false: 0 };

/**
 * The overrides object in `text`, or {} for a missing or broken file.
 *
 * Switches were first spelled `enabled.<script>`. A file written then is read
 * as `<script>.enabled` rather than silently dropped - dropped, a gang switched
 * OFF would come back on. The next set.js write saves the new spelling.
 * ponytail: delete the rename once no file with the old keys can exist.
 */
export function parseSettings(text) {
  try {
    const o = JSON.parse(String(text ?? "").trim() || "{}");
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    for (const k of Object.keys(o)) {
      if (!k.startsWith("enabled.")) continue;
      const renamed = `${k.slice("enabled.".length)}.enabled`;
      if (!(renamed in o)) o[renamed] = o[k];
      delete o[k];
    }
    return o;
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
  return typeof v === "number" && Number.isFinite(v) && v >= k.min && v <= k.max &&
    (!k.int || Number.isInteger(v)) ? v : k.def;
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
    if (k.int && !Number.isInteger(v)) throw new Error(`${key} must be a whole number, got "${value}"`);
    if (word === "" || !Number.isFinite(v) || v < k.min || v > k.max) {
      throw new Error(`${key} must be a number in [${k.min}, ${k.max}], got "${value}"`);
    }
    o[key] = v;
  }
  return JSON.stringify(o, null, 2);
}

/** A value as the terminal should read it: switches as on/off. */
export function showSetting(key, v) {
  return KNOBS[key]?.bool ? (v ? "on" : "off") : String(v);
}

/**
 * "key a -> b" for every knob whose value IN FORCE differs between two file
 * texts. Compared on setting(), not on the raw JSON, so an invalid override
 * that falls back to the default is not reported as a change it never made.
 */
export function settingChanges(before, after, prefix = "") {
  return Object.keys(KNOBS)
    .filter((k) => k.startsWith(prefix) && setting(before, k) !== setting(after, k))
    .map((k) => `${k} ${showSetting(k, setting(before, k))} -> ${showSetting(k, setting(after, k))}`);
}

/**
 * The one log line a reader prints about its settings, or null for none.
 * `before` null means "just started": list what is off its default. After
 * that, list what changed. `prefix` keeps each script to its own knobs
 * ("gang." in gang.js); boot passes "" and reports them all.
 */
export function settingsLog(before, after, prefix = "") {
  if (before === after) return null;
  const c = settingChanges(before ?? "", after, prefix);
  if (!c.length) return null;
  return `${before === null ? "settings (vs default)" : "settings changed"}: ${c.join(", ")}`;
}
