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
};
