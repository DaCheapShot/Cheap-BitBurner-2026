import { loadScripts, assert } from "./harness.mjs";

export const tests = {
  "every script loads as a module": async () => {
    const mods = await loadScripts();
    assert(mods.config, "config.js did not load");
    assert(typeof mods.config.SPACER_MS === "number", "config.SPACER_MS missing");
    assert(typeof mods.prepper.prep === "function", "prepper.prep missing");
    assert(typeof mods.manager.main === "function", "manager.main missing");
  },

  "port mock discards the oldest entry when full": async () => {
    const { makeNs, PORT_CAPACITY } = await import("./mockNs.mjs");
    const ns = makeNs();
    const p = ns.getPortHandle(1);
    for (let i = 0; i < PORT_CAPACITY + 5; i++) p.write(i);
    assert(p.read() === 5, "oldest entries should have been discarded first");
  },

  "paths are stored without a leading slash, as the game does": async () => {
    const { makeNs } = await import("./mockNs.mjs");
    const ns = makeNs();
    const pid = ns.run("/scripts/manager.js", 1, "--target", "joesguns");
    assert(pid === 1, `first pid should be 1, got ${pid}`);
    const procs = ns.ps("home");
    assert(procs.length === 1, "process should be listed");
    assert(procs[0].filename === "scripts/manager.js",
      `ps must report the stripped path, got "${procs[0].filename}"`);
  },
};
