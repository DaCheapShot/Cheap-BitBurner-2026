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

  // The gain of any upgrade is a RATIO on the production getNodeStats already
  // reports, because every upgrade's effect is an independent multiplicative
  // factor. That is what removes ns.formulas.hacknetNodes (Formulas.exe) and
  // getBitNodeMultipliers (4.00 GB): the production mult and the BitNode mult
  // appear in both the before and the after, and cancel.
  //
  // Checked against a flat transcription of calculateMoneyGainRate and
  // calculateHashGainRate, recomputed at the upgraded stats.
  "gain ratios equal a recompute of the fork's production formulas": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];

    // src/Hacknet/formulas/HacknetNodes.ts. The trailing mult*bnMult is dropped
    // on both sides of every comparison below, which is the identity under test.
    const nodeRate = (level, ram, cores) =>
      level * 1.5 * Math.pow(1.035, ram - 1) * ((cores + 5) / 6);
    // src/Hacknet/formulas/HacknetServers.ts.
    const serverRate = (level, used, maxRam, cores) =>
      0.001 * level * Math.pow(1.07, Math.log2(maxRam)) * (1 + (cores - 1) / 5) * (1 - used / maxRam);

    const near = (a, b, what) =>
      assert(Math.abs(a - b) < Math.abs(b) * 1e-9 + 1e-12, `${what}: got ${a}, expected ${b}`);

    const node = { level: 7, ram: 4, cores: 3 };
    node.production = nodeRate(node.level, node.ram, node.cores);
    near(m.stepGain(false, "level", node), nodeRate(8, 4, 3) - node.production, "node level");
    near(m.stepGain(false, "ram", node), nodeRate(7, 8, 3) - node.production, "node ram");
    near(m.stepGain(false, "core", node), nodeRate(7, 4, 4) - node.production, "node core");

    const server = { level: 12, ram: 8, cores: 4, cache: 2, used: 0 };
    server.production = serverRate(server.level, 0, server.ram, server.cores);
    near(m.stepGain(true, "level", server), serverRate(13, 0, 8, 4) - server.production, "server level");
    near(m.stepGain(true, "ram", server), serverRate(12, 0, 16, 4) - server.production, "server ram");
    near(m.stepGain(true, "core", server), serverRate(12, 0, 8, 5) - server.production, "server core");

    // Cache moves hashCapacity, not the hash rate. It is not scored against the
    // others; it is bought only when capacity blocks a purchase (see planHashes).
    assert(m.stepGain(true, "cache", server) === 0, "cache has no production term");
  },

  // ramRatio = 1 - ramUsed/maxRam is a plain factor in calculateHashGainRate,
  // and doubling maxRam improves it as well as the 1.07 ladder - so the gain is
  // strictly MORE than 7% whenever anything is running there. With the pool
  // exclusion in place `used` is 0 and it collapses to exactly 7%; computing it
  // properly is free and stays right if a stray script ever lands on one.
  "a server's RAM gain accounts for the used-RAM penalty": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];

    const serverRate = (level, used, maxRam, cores) =>
      0.001 * level * Math.pow(1.07, Math.log2(maxRam)) * (1 + (cores - 1) / 5) * (1 - used / maxRam);

    const idle = { level: 10, ram: 16, cores: 1, used: 0 };
    idle.production = serverRate(10, 0, 16, 1);
    assert(Math.abs(m.stepGain(true, "ram", idle) - idle.production * 0.07) < 1e-12,
      "an idle server's RAM gain is exactly the 1.07 ladder");

    const busy = { level: 10, ram: 16, cores: 1, used: 8 };
    busy.production = serverRate(10, 8, 16, 1);
    const expected = serverRate(10, 8, 32, 1) - busy.production;
    assert(Math.abs(m.stepGain(true, "ram", busy) - expected) < Math.abs(expected) * 1e-9,
      `busy server RAM gain: got ${m.stepGain(true, "ram", busy)}, expected ${expected}`);
    assert(m.stepGain(true, "ram", busy) > busy.production * 0.07,
      "with RAM in use, doubling maxRam beats the bare 1.07 ladder");
  },

  // A new unit's production has no reference of its own, so it is derived by
  // dividing an owned unit's reported production by that unit's own factors.
  // Same cancellation, one step further.
  "a fresh unit's production is derived from an owned one": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];

    const nodeRate = (level, ram, cores, mult) =>
      level * 1.5 * Math.pow(1.035, ram - 1) * ((cores + 5) / 6) * mult;
    const serverRate = (level, used, maxRam, cores, mult) =>
      0.001 * level * Math.pow(1.07, Math.log2(maxRam)) * (1 + (cores - 1) / 5) *
      (1 - used / maxRam) * mult;

    // An arbitrary product of the player's hacknet multiplier and the BitNode's
    // - neither is read anywhere, and this is what proves it does not need to be.
    const mult = 3.7;

    const node = { level: 9, ram: 8, cores: 5, production: nodeRate(9, 8, 5, mult) };
    const freshNode = nodeRate(1, 1, 1, mult);
    assert(Math.abs(m.freshProduction(false, node) - freshNode) < freshNode * 1e-9,
      `fresh node: got ${m.freshProduction(false, node)}, expected ${freshNode}`);

    const server = { level: 40, ram: 64, cores: 9, used: 16, production: serverRate(40, 16, 64, 9, mult) };
    const freshServer = serverRate(1, 0, 1, 1, mult);
    assert(Math.abs(m.freshProduction(true, server) - freshServer) < freshServer * 1e-9,
      `fresh server: got ${m.freshProduction(true, server)}, expected ${freshServer}`);
  },

  // The greedy picks minimum PAYBACK, not minimum price. Cheapest-first buys
  // whatever ladder happens to be low regardless of what it returns, which on
  // a node whose level is far ahead of its RAM is the wrong rung every time.
  "the money plan takes the best payback, not the cheapest price": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const cfg = { PAYBACK_SECONDS: 3600, HASH_PRICE: 250000 };

    const nodeRate = (level, ram, cores) =>
      level * 1.5 * Math.pow(1.035, ram - 1) * ((cores + 5) / 6);
    const unit = { level: 50, ram: 1, cores: 1 };
    unit.production = nodeRate(50, 1, 1);

    const mults = { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 };
    const plan = m.planMoney(
      { isServer: false, units: [unit], budget: 1e9, mults }, cfg);

    assert(plan.buys.length > 0, `expected buys, got none (${plan.reason})`);

    // Every buy must clear the threshold it claims to.
    let live = { ...unit };
    for (const buy of plan.buys) {
      if (buy.kind === "unit") continue;
      const gain = m.stepGain(false, buy.kind, live);
      assert(buy.price / gain < cfg.PAYBACK_SECONDS,
        `${buy.kind} pays back in ${(buy.price / gain).toFixed(0)}s, over the threshold`);
      if (buy.kind === "level") live.level += 1;
      if (buy.kind === "ram") live.ram *= 2;
      if (buy.kind === "core") live.cores += 1;
      live.production += gain;
    }

    // At level 50 with 1 GB and 1 core, the first rung taken must be the one
    // with the best payback - which is not the cheapest one.
    const first = plan.buys[0];
    const prices = {};
    const paybacks = {};
    for (const kind of ["level", "ram", "core"]) {
      prices[kind] = m.stepPrice(false, kind, unit, mults);
      paybacks[kind] = prices[kind] / m.stepGain(false, kind, unit);
    }
    const bestPayback = Object.keys(paybacks).sort((a, b) => paybacks[a] - paybacks[b])[0];
    assert(first.kind === bestPayback,
      `first buy was ${first.kind}; best payback is ${bestPayback}`);
  },

  "the money plan stops at the budget and says so": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const cfg = { PAYBACK_SECONDS: 1e9, HASH_PRICE: 250000 };
    const mults = { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 };

    const unit = { level: 10, ram: 2, cores: 1, production: 10 * 1.5 * 1.035 * 1 };
    // Enough for a handful of level steps at 500-ish each, nothing more.
    const plan = m.planMoney({ isServer: false, units: [unit], budget: 3000, mults }, cfg);

    assert(plan.spent <= 3000, `spent ${plan.spent} of a 3000 budget`);
    assert(plan.buys.length > 0, "a 3000 budget should buy at least one level step");
    assert(plan.reason.includes("budget"), `reason was "${plan.reason}"`);
  },

  "the money plan refuses everything when nothing pays back in time": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const mults = { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 };
    const unit = { level: 10, ram: 2, cores: 1, production: 10 * 1.5 * 1.035 };

    const plan = m.planMoney(
      { isServer: false, units: [unit], budget: 1e12, mults },
      { PAYBACK_SECONDS: 1e-6, HASH_PRICE: 250000 });

    assert(plan.buys.length === 0, `expected no buys, got ${plan.buys.length}`);
    assert(plan.spent === 0, `expected to spend nothing, spent ${plan.spent}`);
    assert(plan.reason.includes("payback"), `reason was "${plan.reason}"`);
  },

  // With nothing owned there is no production to derive a fresh unit's rate
  // from, so the first one is bought unconditionally within the budget. It is
  // $1,000 for a node and $50,000 for a server, and in BitNode 9 no servers
  // means no hashes at all - there is nothing to weigh it against.
  "the first unit is bought unconditionally": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const mults = { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 };
    const cfg = { PAYBACK_SECONDS: 1e-6, HASH_PRICE: 250000 };

    const plan = m.planMoney({ isServer: false, units: [], budget: 1e6, mults }, cfg);
    assert(plan.buys.length === 1 && plan.buys[0].kind === "unit",
      `expected one unit purchase, got ${JSON.stringify(plan.buys)}`);
    assert(plan.buys[0].price === 1000, `first node should cost $1000, got ${plan.buys[0].price}`);

    // ...but not when it does not fit the budget.
    const broke = m.planMoney({ isServer: false, units: [], budget: 999, mults }, cfg);
    assert(broke.buys.length === 0, "a budget under the price buys nothing");
    assert(broke.reason.includes("budget"), `reason was "${broke.reason}"`);
  },

  // In BitNode 9 production is hashes/s, so it is valued at the auto-sale rate.
  // That deliberately UNDERSTATES: the hash sweep only spends a hash when it is
  // worth more than the sale price, so erring low on node upgrades is the right
  // direction for a spend decision.
  "server production is valued at the hash sale price": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const mults = { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 };

    const serverRate = (level, used, maxRam, cores) =>
      0.001 * level * Math.pow(1.07, Math.log2(maxRam)) * (1 + (cores - 1) / 5) * (1 - used / maxRam);
    const unit = { level: 30, ram: 8, cores: 2, cache: 1, used: 0 };
    unit.production = serverRate(30, 0, 8, 2);

    const price = m.stepPrice(true, "level", unit, mults);
    const gain = m.stepGain(true, "level", unit);
    // A threshold that sits just either side of the true payback in $/s terms.
    const payback = price / (gain * 250000);

    const bought = m.planMoney(
      { isServer: true, units: [unit], budget: 1e12, mults },
      { PAYBACK_SECONDS: payback * 1.5, HASH_PRICE: 250000 });
    assert(bought.buys.length > 0, "should buy when the hash-priced payback clears the bar");

    const refused = m.planMoney(
      { isServer: true, units: [unit], budget: 1e12, mults },
      { PAYBACK_SECONDS: payback * 0.5, HASH_PRICE: 250000 });
    assert(refused.buys.length === 0,
      "should refuse when the hash-priced payback misses the bar");
  },
};
