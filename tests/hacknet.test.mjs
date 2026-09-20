import { loadScripts, readScript, assert } from "./harness.mjs";

/**
 * The hacknet subsystem.
 *
 * Everything worth testing lives in hacknet/math.js on purpose: the two entries
 * are thin, and a decision that can only be exercised by running a 6.60 GB
 * script against a live BitNode 9 is a decision nobody checks. The cost and
 * gain formulas below are transcribed from src/Hacknet/formulas/*.ts a SECOND
 * time, flat, rather than calling the module - a test that reuses the
 * implementation's own helpers proves only that the file is self-consistent.
 */

export const tests = {
  "config exposes the tunables and the two upgrade names": async () => {
    const mods = await loadScripts();
    const cfg = mods["hacknet/config"];

    assert(cfg.HACKNET_MONEY_SERVICE === "/scripts/hacknet/hacknet.js",
      `money service path is ${cfg.HACKNET_MONEY_SERVICE}`);
    assert(cfg.HACKNET_HASH_SERVICE === "/scripts/hacknet/hashes.js",
      `hash service path is ${cfg.HACKNET_HASH_SERVICE}`);

    // A hash is worth exactly this much, at every level, forever: Sell for
    // Money is the one upgrade with a FLAT `cost` (4) rather than a
    // costPerLevel, and its value is $1e6. HashUpgradesMetadata.tsx.
    assert(cfg.HASH_PRICE === 250000, `a hash is worth $${cfg.HASH_PRICE}, expected 250000`);

    // Spelled exactly as HashUpgradeEnum spells them: spendHashes() resolves
    // the name through getEnumHelper and THROWS on a miss.
    assert(cfg.MAX_MONEY_UPGRADE === "Increase Maximum Money", cfg.MAX_MONEY_UPGRADE);
    assert(cfg.MIN_SECURITY_UPGRADE === "Reduce Minimum Security", cfg.MIN_SECURITY_UPGRADE);

    // Contracts shared with the batchers, re-exported so the subsystem has one
    // import root. Server.ts's constructor RENAMES any ordinary server whose
    // hostname starts with this, so the prefix test is safe by construction.
    assert(cfg.TARGETS_MARKER === "/data/targets.txt", cfg.TARGETS_MARKER);
    assert(cfg.HACKNET_HOST_PREFIX === "hacknet-server-", cfg.HACKNET_HOST_PREFIX);
  },

  // The module loader resolves `export ... from` like an import; RamCalculations
  // does NOT - its ExportNamedDeclaration branch looks the raw specifier up in
  // the server's script map, whose keys carry the extension. `from
  // "scripts/config"` ran fine and failed the RAM check with `Import Error`.
  "hacknet/config.js re-exports with the .js extension": () => {
    const src = readScript("hacknet/config");
    for (const m of src.matchAll(/export\s+\{[^}]*\}\s+from\s+"([^"]+)"/g)) {
      assert(m[1].endsWith(".js"),
        `re-export from "${m[1]}" must spell the .js extension or the game refuses to start the importer`);
    }
  },
};
