import { loadScripts, assert, assertThrows } from "./harness.mjs";

/**
 * scripts/settings.js: the live overrides scripts/set.js writes. The reader
 * must never throw (a mangled file costs an override, not a sweep); the writer
 * is the trust boundary and must refuse anything the reader would ignore.
 */
export const tests = {
  "a missing, broken or foreign file reads as every default": async () => {
    const { settings: S } = await loadScripts();
    for (const text of ["", "   ", "not json", "[1,2]", "null", "42"]) {
      for (const [k, d] of Object.entries(S.KNOBS)) {
        assert(S.setting(text, k) === d.def, `${JSON.stringify(text)}: ${k} read ${S.setting(text, k)}`);
      }
    }
  },

  "an override is used only when it is a number inside the range": async () => {
    const { settings: S } = await loadScripts();
    const def = S.KNOBS["hacknet.cash"].def;
    assert(S.setting('{"hacknet.cash":0.9}', "hacknet.cash") === 0.9, "valid override ignored");
    for (const bad of ['"0.9"', "1.5", "-0.1", "null", "true"]) {
      const v = S.setting(`{"hacknet.cash":${bad}}`, "hacknet.cash");
      assert(v === def, `${bad} should fall back to ${def}, got ${v}`);
    }
  },

  "setSetting validates, stores numbers, and clears on default": async () => {
    const { settings: S } = await loadScripts();
    let t = S.setSetting("", "hacknet.cash", "0.9");
    assert(S.setting(t, "hacknet.cash") === 0.9, "set did not stick");
    t = S.setSetting(t, "cloud.cash", "0.2");
    assert(S.setting(t, "hacknet.cash") === 0.9, "a second set clobbered the first");
    t = S.setSetting(t, "hacknet.cash", "default");
    assert(!("hacknet.cash" in S.parseSettings(t)), "default did not clear the override");
    assert(S.setting(t, "cloud.cash") === 0.2, "clearing one cleared another");
    assertThrows(() => S.setSetting("", "hacknet.cahs", "0.9"), "unknown key accepted");
    for (const bad of ["", "abc", "1.5", "-1", "NaN"]) {
      assertThrows(() => S.setSetting("", "hacknet.cash", bad), `"${bad}" accepted`);
    }
  },

  "every knob's default lies inside its own range": async () => {
    const { settings: S } = await loadScripts();
    for (const [k, d] of Object.entries(S.KNOBS)) {
      assert(typeof d.def === "number" && d.def >= d.min && d.def <= d.max,
        `${k}: default ${d.def} outside [${d.min}, ${d.max}] - an import went missing?`);
    }
  },

  "switches take on/off words and refuse anything but 0 or 1": async () => {
    const { settings: S } = await loadScripts();
    for (const [w, v] of [["off", 0], ["OFF", 0], ["false", 0], ["0", 0], ["on", 1], ["true", 1], ["1", 1]]) {
      assert(S.setting(S.setSetting("", "gang.enabled", w), "gang.enabled") === v, `"${w}" should be ${v}`);
    }
    for (const bad of ["0.5", "yes", ""]) {
      assertThrows(() => S.setSetting("", "gang.enabled", bad), `"${bad}" accepted for a switch`);
    }
    // A fraction knob must NOT take "on": that would read as 1 = all the cash.
    assertThrows(() => S.setSetting("", "hacknet.cash", "on"), '"on" accepted for a fraction');
  },

  "cadence counts must be whole numbers, in the file and at the CLI": async () => {
    const { settings: S } = await loadScripts();
    const def = S.KNOBS["gang.equipEvery"].def;
    assert(S.setting('{"gang.equipEvery":5}', "gang.equipEvery") === 5, "valid count ignored");
    // A fractional modulus would never hit 0 - the sweep would silently stop.
    assert(S.setting('{"gang.equipEvery":2.5}', "gang.equipEvery") === def, "2.5 should fall back");
    assertThrows(() => S.setSetting("", "gang.equipEvery", "2.5"), "2.5 accepted for a count");
    assertThrows(() => S.setSetting("", "hacknet.every", "0"), "0 accepted - modulo by zero");
    assert(S.setting(S.setSetting("", "boot.tick", "30"), "boot.tick") === 30, "boot.tick 30 refused");
  },

  "settingsLog: start lists overrides, then only changes, scoped by prefix": async () => {
    const { settings: S } = await loadScripts();
    const a = '{"gang.equip":0.5,"cloud.cash":0.2}';
    assert(S.settingsLog(null, "", "gang.") === null, "nothing overridden should print nothing");
    assert(S.settingsLog(null, a, "gang.") === "settings (vs default): gang.equip 0.15 -> 0.5",
      `start line: ${S.settingsLog(null, a, "gang.")}`);
    assert(S.settingsLog(a, a, "gang.") === null, "unchanged text should print nothing");
    const b = '{"gang.equip":0.5,"cloud.cash":0.3}';
    assert(S.settingsLog(a, b, "gang.") === null, "another script's knob must not reach the gang log");
    assert(S.settingsLog(a, b, "cloud.") === "settings changed: cloud.cash 0.2 -> 0.3", S.settingsLog(a, b, "cloud."));
    assert(S.settingsLog(a, '{"gang.equip":7}', "gang.") === "settings changed: gang.equip 0.5 -> 0.15",
      "an invalid override reads as the default it falls back to");
  },

  // set.js prints KNOBS in order, a group per script, so a knob added at the
  // bottom of the list would split its script's group in two.
  "each script's settings are contiguous in KNOBS": async () => {
    const { settings: S } = await loadScripts();
    const seen = [];
    for (const k of Object.keys(S.KNOBS)) {
      const g = k.split(".")[0];
      if (seen.at(-1) === g) continue;
      assert(!seen.includes(g), `${k} splits the ${g} group - move it beside the other ${g}.* keys`);
      seen.push(g);
    }
  },

  "a file written with the old enabled.<script> keys still switches": async () => {
    const { settings: S } = await loadScripts();
    const old = '{"enabled.gang":0}';
    assert(S.setting(old, "gang.enabled") === 0, "the old spelling of an off switch was dropped");
    const t = S.setSetting(old, "cloud.cash", "0.2");
    assert(t.includes('"gang.enabled": 0') && !t.includes("enabled.gang"), `rewrite should migrate: ${t}`);
    assert(S.setting('{"enabled.gang":0,"gang.enabled":1}', "gang.enabled") === 1, "the new key wins");
  },
};
