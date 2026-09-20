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

  // Transcribed a SECOND time, flat, from src/Hacknet/formulas/HacknetNodes.ts
  // and HacknetServers.ts. The two level ladders start their exponent in
  // DIFFERENT places and it is not a typo: nodes at startingLevel - 1, servers
  // at startingLevel. An off-by-one here is a silent mispricing, never an error.
  "cost ladders match a flat transcription of the fork's formulas": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];

    const nodeLevel = (start, count, mult) => {
      if (start + count > 200) return Infinity;
      let total = 0, cur = start - 1;
      for (let i = 0; i < count; i++) { total += Math.pow(1.04, cur); cur++; }
      return 500 * total * mult;
    };
    const serverLevel = (start, count, mult) => {
      if (start + count > 300) return Infinity;
      let total = 0, cur = start;
      for (let i = 0; i < count; i++) { total += Math.pow(1.1, cur); cur++; }
      return 10 * 50e3 * total * mult;
    };
    const ramPrice = (base, ladder, max, start, count, mult) => {
      if (start * Math.pow(2, count) > max) return Infinity;
      let total = 0, u = Math.round(Math.log2(start)), cur = start;
      for (let i = 0; i < count; i++) { total += cur * base * Math.pow(ladder, u); cur *= 2; u++; }
      return total * mult;
    };
    const corePrice = (base, ladder, max, start, count, mult) => {
      if (start + count > max) return Infinity;
      let total = 0, cur = start;
      for (let i = 0; i < count; i++) { total += Math.pow(ladder, cur - 1); cur++; }
      return base * total * mult;
    };

    const mults = { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 };
    const near = (a, b, what) =>
      assert(Math.abs(a - b) < Math.max(1e-6, Math.abs(b) * 1e-9), `${what}: got ${a}, expected ${b}`);

    // Nodes.
    const node = { level: 7, ram: 4, cores: 3, production: 1 };
    near(m.stepPrice(false, "level", node, mults), nodeLevel(7, 1, 1), "node level");
    near(m.stepPrice(false, "ram", node, mults), ramPrice(30e3, 1.28, 64, 4, 1, 1), "node ram");
    near(m.stepPrice(false, "core", node, mults), corePrice(500e3, 1.48, 16, 3, 1, 1), "node core");
    near(m.unitPrice(false, 5, mults), 1000 * Math.pow(1.85, 5), "node purchase");

    // Servers. cache has NO cost multiplier - calculateCacheUpgradeCost takes
    // no costMult argument at all.
    const server = { level: 12, ram: 8, cores: 4, cache: 2, used: 0, production: 1 };
    near(m.stepPrice(true, "level", server, mults), serverLevel(12, 1, 1), "server level");
    near(m.stepPrice(true, "ram", server, mults), ramPrice(200e3, 1.4, 8192, 8, 1, 1), "server ram");
    near(m.stepPrice(true, "core", server, mults), corePrice(1e6, 1.55, 128, 4, 1, 1), "server core");
    near(m.stepPrice(true, "cache", server, mults), corePrice(10e6, 1.85, 15, 2, 1, 1), "server cache");
    near(m.unitPrice(true, 5, mults), 50e3 * Math.pow(3.2, 5), "server purchase");

    // The cost multipliers are applied - and cache is the one that must NOT be.
    const dear = { purchaseCost: 2, levelCost: 3, ramCost: 4, coreCost: 5 };
    near(m.stepPrice(false, "level", node, dear), nodeLevel(7, 1, 3), "node level x3");
    near(m.stepPrice(true, "ram", server, dear), ramPrice(200e3, 1.4, 8192, 8, 1, 4), "server ram x4");
    near(m.stepPrice(true, "cache", server, dear), corePrice(10e6, 1.85, 15, 2, 1, 1),
      "server cache takes no cost multiplier");
  },

  // Over the maximum every ladder returns Infinity, which is what makes a maxed
  // upgrade fall out of the greedy with no separate cap check anywhere. Note
  // the RAM ceilings differ by a factor of 128 between the two forms.
  "a maxed upgrade prices at Infinity": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const mults = { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 };

    const maxNode = { level: 200, ram: 64, cores: 16, production: 1 };
    for (const kind of ["level", "ram", "core"]) {
      assert(m.stepPrice(false, kind, maxNode, mults) === Infinity, `node ${kind} should be Infinity`);
    }

    const maxServer = { level: 300, ram: 8192, cores: 128, cache: 15, used: 0, production: 1 };
    for (const kind of ["level", "ram", "core", "cache"]) {
      assert(m.stepPrice(true, kind, maxServer, mults) === Infinity, `server ${kind} should be Infinity`);
    }

    // MaxServers is 20 - calculateServerCost returns Infinity at n-1 >= 20, so
    // the 21st is unbuyable. Nodes have no limit (maxNumNodes is Infinity).
    assert(m.unitPrice(true, 20, mults) === Infinity, "the 21st hacknet server should be Infinity");
    assert(Number.isFinite(m.unitPrice(false, 20, mults)), "nodes have no purchase limit");
  },
};
