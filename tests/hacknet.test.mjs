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
  // Server's own constructor renames any ordinary server whose hostname starts
  // with "hacknet-node-" or "hacknet-server-", so the namespace is reserved and
  // the prefix test cannot false-positive. The alternative, ns.getServer(host)
  // .isHacknetServer, costs 2.00 GB - and the pool is deliberately cheap.
  "the pool tests the prefix without paying for getServer": () => {
    for (const mod of ["continuous/lib/server"]) {
      const src = readScript(mod);
      assert(src.includes("HACKNET_HOST_PREFIX"),
        `${mod}.js must use the shared prefix constant, not a literal`);
      assert(!/ns\.getServer\s*\(/.test(src),
        `${mod}.js must not call ns.getServer - it is 2.00 GB and the prefix answers this`);
    }
  },

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
    const firstRung = plan.buys.find(b => b.kind !== "unit");
    assert(firstRung, "expected at least one rung buy");
    const prices = {};
    const paybacks = {};
    for (const kind of ["level", "ram", "core"]) {
      prices[kind] = m.stepPrice(false, kind, unit, mults);
      paybacks[kind] = prices[kind] / m.stepGain(false, kind, unit);
    }
    const bestPayback = Object.keys(paybacks).sort((a, b) => paybacks[a] - paybacks[b])[0];
    assert(firstRung.kind === bestPayback,
      `first rung was ${firstRung.kind}; best payback is ${bestPayback}`);
  },

  // A whole new unit competes with the rungs on every pass, not only when
  // nothing is owned. The first implementation scored it inside the
  // `units.length === 0` branch, which made `kind: "unit"` unreachable after the
  // first buy - so an unlimited budget poured into one unit's ladders while a
  // fresh unit at base price paid back four times faster.
  //
  // Fixture: level and cores well up their ladders and RAM already at the node
  // maximum (so that rung prices at Infinity), leaving a fresh node the best
  // buy by a clear margin.
  "a fresh unit competes with the rungs once something is owned": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const mults = { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 };

    const nodeRate = (level, ram, cores) =>
      level * 1.5 * Math.pow(1.035, ram - 1) * ((cores + 5) / 6);
    const unit = { level: 150, ram: 64, cores: 12 };
    unit.production = nodeRate(150, 64, 12);

    const plan = m.planMoney(
      { isServer: false, units: [unit], budget: 1e6, mults },
      { PAYBACK_SECONDS: 1e5, HASH_PRICE: 250000 });

    assert(plan.buys.length > 0, `expected buys, got none (${plan.reason})`);
    assert(plan.buys[0].kind === "unit" && plan.buys[0].index === -1,
      `expected a new unit first, got ${JSON.stringify(plan.buys[0])}`);
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

  // A refusal has to carry the number that caused it. This is the live BitNode
  // 4 case: HacknetNodeMoney is 0.05, so a fresh node makes $0.075/s and the
  // $500 level rung pays back in 6667s against a 3600s bar. With $1.12q in the
  // wallet the old line read as "cannot afford a $500 upgrade", which is a
  // diagnostic naming the wrong cause - the one failure mode this repo pays
  // most for. Behavioural, so deleting the tracking reddens it.
  "a refused sweep reports the nearest rung and its payback": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const mults = { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 };
    const cfg = { PAYBACK_SECONDS: 3600, HASH_PRICE: 250000 };

    // A brand new node as BitNode 4 reports it: level 1, 1 GB, 1 core.
    const unit = { level: 1, ram: 1, cores: 1, production: 1.5 * 0.05 };
    const plan = m.planMoney({ isServer: false, units: [unit], budget: 5.6e13, mults }, cfg);

    assert(plan.buys.length === 0, `expected no buys, got ${JSON.stringify(plan.buys)}`);
    assert(plan.nearest, "a refusal must name the nearest candidate it scored");
    // The level rung is both the cheapest and the best-paying one here, and the
    // point of ranking is that those are not the same question.
    assert(plan.nearest.kind === "level",
      `nearest should be the level rung, got ${plan.nearest.kind}`);
    assert(plan.nearest.price === 500, `nearest price should be $500, got ${plan.nearest.price}`);
    assert(Math.abs(plan.nearest.payback - 6667) < 1,
      `nearest payback should be ~6667s, got ${plan.nearest.payback}`);
    assert(plan.nearest.payback > cfg.PAYBACK_SECONDS,
      "the nearest candidate must be one that FAILED the bar");
  },

  // Production of exactly 0 is BitNode 8 (HacknetNodeMoney: 0), where no rung
  // can ever pay back at any price. Nothing is ranked at all, so blaming the
  // payback threshold would name a cause that was never consulted.
  "a BitNode where the hacknet earns nothing says so, not 'payback'": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const mults = { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 };
    const cfg = { PAYBACK_SECONDS: 3600, HASH_PRICE: 250000 };

    const unit = { level: 1, ram: 1, cores: 1, production: 0 };
    const plan = m.planMoney({ isServer: false, units: [unit], budget: 1e12, mults }, cfg);

    assert(plan.buys.length === 0, `expected no buys, got ${JSON.stringify(plan.buys)}`);
    assert(plan.nearest === null, "nothing can be ranked when production is 0");
    assert(!plan.reason.includes("payback"),
      `reason must not blame the threshold: "${plan.reason}"`);
    assert(plan.reason.includes("0"), `reason was "${plan.reason}"`);
  },

  // The figure only helps if the entry actually prints it.
  "the money sweep prints the nearest rung's payback when it buys nothing": async () => {
    const src = readScript("hacknet/hacknet");
    assert(/plan\.nearest/.test(src),
      "hacknet.js must report plan.nearest on a no-buy sweep");
    assert(/ns\.format\.time\(\s*plan\.nearest\.payback \* 1000\s*\)/.test(src),
      "the payback must be printed through ns.format.time, the game's own formatter");
    assert(/ns\.format\.time\(\s*PAYBACK_SECONDS \* 1000\s*\)/.test(src),
      "the bar it failed must be printed beside it");
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
  //
  // The claim is pinned by planning the SAME unit twice at two hash prices,
  // rather than by deriving a threshold from one rung. Every candidate the
  // greedy scores scales by the same HASH_PRICE factor, so one threshold
  // separates the two readings whichever candidate happens to win - and the
  // first version of this test did derive from one rung, set a threshold the
  // `core` rung beat by 28x, and asserted a refusal that could never happen.
  "server production is valued at the hash sale price": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const mults = { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 };

    const serverRate = (level, used, maxRam, cores) =>
      0.001 * level * Math.pow(1.07, Math.log2(maxRam)) * (1 + (cores - 1) / 5) * (1 - used / maxRam);
    const unit = { level: 30, ram: 8, cores: 2, cache: 1, used: 0 };
    unit.production = serverRate(30, 0, 8, 2);

    // The best payback over every candidate planMoney scores, with production
    // valued at $1 per unit. The next-unit candidate is included: on this
    // fixture it is the fastest of the lot, and leaving it out is exactly how
    // the first version of this test went wrong.
    let best = Infinity;
    for (const kind of ["level", "ram", "core"]) {
      const price = m.stepPrice(true, kind, unit, mults);
      const gain = m.stepGain(true, kind, unit);
      if (gain > 0 && Number.isFinite(price)) best = Math.min(best, price / gain);
    }
    const fresh = m.freshProduction(true, unit);
    const nextPrice = m.unitPrice(true, 1, mults);
    if (fresh > 0 && Number.isFinite(nextPrice)) best = Math.min(best, nextPrice / fresh);
    assert(Number.isFinite(best), "the fixture must offer at least one buyable candidate");

    // Half the dollar-priced payback: out of reach at $1 a hash, comfortable at
    // $250k.
    const threshold = best / 2;

    const priced = m.planMoney(
      { isServer: true, units: [{ ...unit }], budget: 1e12, mults },
      { PAYBACK_SECONDS: threshold, HASH_PRICE: 250000 });
    assert(priced.buys.length > 0,
      `hashes at $250k each must clear the bar, got no buys (${priced.reason})`);

    const unpriced = m.planMoney(
      { isServer: true, units: [{ ...unit }], budget: 1e12, mults },
      { PAYBACK_SECONDS: threshold, HASH_PRICE: 1 });
    assert(unpriced.buys.length === 0,
      `hashes at $1 each must be refused, got ${unpriced.buys.length} buy(s)`);
  },

  // HashUpgrade.getCost: `costPerLevel * 0.5 * count * (count + 2*level + 1)`,
  // which is the collapsed sum of (level+1) + (level+2) + ... - so a bundle is
  // priced exactly and the level counter is GLOBAL per upgrade, not per target.
  "a hash bundle is priced by the collapsed sum": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];

    // Priced against the repeated single-level form it collapses.
    for (const [level, count] of [[0, 1], [0, 5], [7, 1], [7, 4], [123, 9]]) {
      let sum = 0;
      for (let i = 0; i < count; i++) sum += 50 * (level + i + 1);
      const got = m.bundlePrice(50, level, count);
      assert(Math.abs(got - sum) < 1e-9, `level ${level} x${count}: got ${got}, expected ${sum}`);
    }
    // The first Increase Maximum Money costs 50 hashes - $12.5m of forgone sales.
    assert(m.bundlePrice(50, 0, 1) === 50, "the first level costs 50 hashes");
  },

  // Server.changeMaximumMoney: above the soft cap the step becomes
  // `1 + (n-1)/Math.log(moneyMax - softCap)/Math.log(8)` - two divisions by
  // logs, which is what the source does. Transcribed rather than approximated
  // by refusing to buy above the cap.
  "the max-money factor is 1.02 until the soft cap damps it": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const softcap = 10e12;

    assert(m.maxMoneyFactor(2.4e9, softcap) === 1.02, "under the cap it is a flat +2%");
    assert(m.maxMoneyFactor(softcap, softcap) === 1.02, "at the cap exactly it is still +2%");

    const above = 50e12;
    const expected = 1 + 0.02 / Math.log(above - softcap) / Math.log(8);
    const got = m.maxMoneyFactor(above, softcap);
    assert(Math.abs(got - expected) < 1e-12, `above the cap: got ${got}, expected ${expected}`);
    assert(got < 1.02 && got > 1, `damped factor ${got} should sit between 1 and 1.02`);
  },

  // src/Hacking.ts. Three terms move together when minimum security falls:
  //   hack chance      ∝ (100 - d)/100
  //   money per thread ∝ (100 - d)/100
  //   op time          ∝ (2.5*R*d + 500)        <- diffFactor is 2.5, not 2.4
  // so income ∝ (100-d)² / (2.5Rd + 500). The grow-thread improvement is left
  // out, which understates - the safe direction.
  "the min-security factor follows chance, threads and time": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];

    const flat = (R, d) => {
      const after = Math.max(1, d * 0.98);
      const chance = (100 - after) / (100 - d);
      const time = (2.5 * R * d + 500) / (2.5 * R * after + 500);
      return chance * chance * time;
    };

    for (const [R, d] of [[1000, 20], [1000, 3], [80, 5], [2500, 40]]) {
      const got = m.minSecurityFactor(R, d);
      assert(Math.abs(got - flat(R, d)) < 1e-12, `R=${R} d=${d}: got ${got}, expected ${flat(R, d)}`);
    }

    // The numbers that justify computing this rather than skipping it: on a
    // high-minimum-security target it beats Increase Maximum Money's flat +2%
    // at the same 50-hash tier.
    assert(Math.abs(m.minSecurityFactor(1000, 20) - 1.0304) < 0.0005,
      `R=1000 d=20 should be about +3.04%, got ${m.minSecurityFactor(1000, 20)}`);
    assert(Math.abs(m.minSecurityFactor(1000, 3) - 1.0203) < 0.0005,
      `R=1000 d=3 should be about +2.03%, got ${m.minSecurityFactor(1000, 3)}`);

    // changeMinimumSecurity clamps at 1, so there is nothing left to buy there.
    assert(m.minSecurityFactor(1000, 1) === 1, "at the floor the factor is exactly 1");
  },

  // One spendHashes call per {upgrade, target} pair, whatever the level count.
  // Raising max money leaves the target below its new maximum and lowering
  // minimum security leaves it above its new floor - both put a streaming
  // target off baseline and cost a re-prep, so the sweep pays that once.
  "the hash plan bundles each upgrade-target pair into one spend": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const cfg = {
      HASH_PRICE: 250000, HASH_HORIZON_S: 3600, HASH_VALUE_MARGIN: 2,
      MONEY_SOFTCAP: 10e12,
      MAX_MONEY_UPGRADE: "Increase Maximum Money",
      MIN_SECURITY_UPGRADE: "Reduce Minimum Security",
    };
    const state = {
      hashes: 100000, capacity: 1e6,
      levels: { "Increase Maximum Money": 0, "Reduce Minimum Security": 0 },
      perLevel: { "Increase Maximum Money": 50, "Reduce Minimum Security": 50 },
      income: 1e9,
      targets: [{ host: "phantasy", moneyMax: 2.4e9, minSec: 20, reqSkill: 1000 }],
      units: [{ index: 0, cache: 1 }],
      budget: 0,
      mults: { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 },
    };

    const plan = m.planHashes(state, cfg);
    assert(plan.spends.length > 0, `expected spends, got none (${plan.reason})`);

    const seen = new Set();
    for (const s of plan.spends) {
      const key = `${s.upgrade}|${s.host}`;
      assert(!seen.has(key), `${key} appears twice - it must be one bundled call`);
      seen.add(key);
      assert(s.count >= 1, `${key} has count ${s.count}`);
    }
    const total = plan.spends.reduce((n, s) => n + s.hashes, 0);
    assert(total <= state.hashes, `planned ${total} hashes against a ${state.hashes} balance`);
  },

  // At R=1000 d=20, Reduce Minimum Security is +3.04% against Increase Maximum
  // Money's +2% at the same 50-hash tier, so the first buy must be the security
  // one. This is the whole reason it is computed rather than skipped.
  "the better upgrade is taken first on a high-security target": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const cfg = {
      HASH_PRICE: 250000, HASH_HORIZON_S: 3600, HASH_VALUE_MARGIN: 2,
      MONEY_SOFTCAP: 10e12,
      MAX_MONEY_UPGRADE: "Increase Maximum Money",
      MIN_SECURITY_UPGRADE: "Reduce Minimum Security",
    };
    const plan = m.planHashes({
      hashes: 60, capacity: 1e6,
      levels: { "Increase Maximum Money": 0, "Reduce Minimum Security": 0 },
      perLevel: { "Increase Maximum Money": 50, "Reduce Minimum Security": 50 },
      income: 1e9,
      targets: [{ host: "phantasy", moneyMax: 2.4e9, minSec: 20, reqSkill: 1000 }],
      units: [{ index: 0, cache: 1 }], budget: 0,
      mults: { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 },
    }, cfg);

    assert(plan.spends.length === 1, `expected one spend, got ${plan.spends.length}`);
    assert(plan.spends[0].upgrade === "Reduce Minimum Security",
      `expected the security buy first, got ${plan.spends[0].upgrade}`);
  },

  // Unspent hashes are not waste: overflow is auto-sold at exactly the same
  // $250k/hash. So "buy nothing" is a correct null action, and a small income
  // must produce it rather than a bad buy.
  "a small income buys nothing and blames the sale price": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const cfg = {
      HASH_PRICE: 250000, HASH_HORIZON_S: 3600, HASH_VALUE_MARGIN: 2,
      MONEY_SOFTCAP: 10e12,
      MAX_MONEY_UPGRADE: "Increase Maximum Money",
      MIN_SECURITY_UPGRADE: "Reduce Minimum Security",
    };
    const plan = m.planHashes({
      hashes: 1e6, capacity: 1e6,
      levels: { "Increase Maximum Money": 0, "Reduce Minimum Security": 0 },
      perLevel: { "Increase Maximum Money": 50, "Reduce Minimum Security": 50 },
      income: 100,
      targets: [{ host: "n00dles", moneyMax: 1.75e6, minSec: 1, reqSkill: 1 }],
      units: [{ index: 0, cache: 1 }], budget: 0,
      mults: { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 },
    }, cfg);

    assert(plan.spends.length === 0, `expected no spends, got ${plan.spends.length}`);
    assert(plan.reason.includes("sale"), `reason was "${plan.reason}"`);
  },

  // Hashes nothing is going to spend are sold, because the game auto-sells only
  // the OVERFLOW: storeHashes() caps the balance at capacity and pays out just
  // the remainder, so everything at or below capacity sits forever. A cache-1
  // server holds 32 * 2^1 = 64 hashes, which is $16m a server parked for the
  // whole of a fresh BitNode 9's first prep, when no manager has published a
  // target yet and money is what home RAM costs 5x of.
  //
  // The sale rate is identical to the auto-sale rate, so this is the same money
  // collected now rather than never - never a discount taken for liquidity.
  "hashes are sold when there is nothing worth buying": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const cfg = {
      HASH_PRICE: 250000, HASH_SALE_COST: 4, HASH_HORIZON_S: 3600,
      HASH_VALUE_MARGIN: 2, MONEY_SOFTCAP: 10e12,
      MAX_MONEY_UPGRADE: "Increase Maximum Money",
      MIN_SECURITY_UPGRADE: "Reduce Minimum Security",
    };
    const base = {
      hashes: 63, capacity: 64,
      levels: { [cfg.MAX_MONEY_UPGRADE]: 0, [cfg.MIN_SECURITY_UPGRADE]: 0 },
      perLevel: { [cfg.MAX_MONEY_UPGRADE]: 50, [cfg.MIN_SECURITY_UPGRADE]: 50 },
      units: [{ index: 0, cache: 1 }], budget: 1e12,
      mults: { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 },
    };

    // No manager has published anything - the live case.
    const idle = m.planHashes({ ...base, income: 1e9, targets: [] }, cfg);
    assert(idle.sell === 15, `expected 15 sales of 4 hashes from 63, got ${idle.sell}`);
    assert(!idle.spends.length, "nothing may be bought without a target");

    // Targets exist but the batcher earns too little for any upgrade to clear
    // the sale price - sell for the same reason.
    const poor = m.planHashes(
      { ...base, income: 1, targets: [{ host: "n00dles", moneyMax: 1e6, minSec: 3, reqSkill: 1 }] }, cfg);
    assert(poor.reason.includes("sale price"), `reason was "${poor.reason}"`);
    assert(poor.sell === 15, `a target nothing beats should still sell, got ${poor.sell}`);
  },

  // The two branches that must NOT sell: both mean a purchase IS worth making
  // and is only out of reach, so the balance is being saved toward it. Selling
  // there funds the cache upgrade and then leaves nothing to fill the larger
  // store with, which is a slow loop that never buys the upgrade it planned.
  "hashes being saved for a worthwhile buy are never sold": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const cfg = {
      HASH_PRICE: 250000, HASH_SALE_COST: 4, HASH_HORIZON_S: 3600,
      HASH_VALUE_MARGIN: 2, MONEY_SOFTCAP: 10e12,
      MAX_MONEY_UPGRADE: "Increase Maximum Money",
      MIN_SECURITY_UPGRADE: "Reduce Minimum Security",
    };
    const targets = [{ host: "phantasy", moneyMax: 1e9, minSec: 20, reqSkill: 1000 }];
    const state = {
      levels: { [cfg.MAX_MONEY_UPGRADE]: 0, [cfg.MIN_SECURITY_UPGRADE]: 0 },
      perLevel: { [cfg.MAX_MONEY_UPGRADE]: 50, [cfg.MIN_SECURITY_UPGRADE]: 50 },
      income: 1e12, targets, units: [{ index: 0, cache: 1 }], budget: 1e12,
      mults: { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 },
    };

    // Short of hashes, store big enough: fills on its own in a minute or two.
    const waiting = m.planHashes({ ...state, hashes: 20, capacity: 4096 }, cfg);
    assert(waiting.reason.includes("waiting on hashes"), `reason was "${waiting.reason}"`);
    assert(!waiting.sell, `sold ${waiting.sell} while saving up for a real buy`);

    // Store too small to ever HOLD the bundle: cache is the answer, not a sale.
    const cramped = m.planHashes({ ...state, hashes: 20, capacity: 32 }, cfg);
    assert(cramped.cacheBuy, `expected a cache buy, reason was "${cramped.reason}"`);
    assert(!cramped.sell, `sold ${cramped.sell} while upgrading cache to hold the bundle`);
  },

  "no published targets means no server-targeted buys": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const cfg = {
      HASH_PRICE: 250000, HASH_HORIZON_S: 3600, HASH_VALUE_MARGIN: 2,
      MONEY_SOFTCAP: 10e12,
      MAX_MONEY_UPGRADE: "Increase Maximum Money",
      MIN_SECURITY_UPGRADE: "Reduce Minimum Security",
    };
    const plan = m.planHashes({
      hashes: 1e9, capacity: 1e9,
      levels: { "Increase Maximum Money": 0, "Reduce Minimum Security": 0 },
      perLevel: { "Increase Maximum Money": 50, "Reduce Minimum Security": 50 },
      income: 1e12, targets: [],
      units: [{ index: 0, cache: 1 }], budget: 0,
      mults: { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 },
    }, cfg);

    assert(plan.spends.length === 0, "an empty marker must buy nothing");
    assert(plan.reason.includes("target"), `reason was "${plan.reason}"`);
  },

  // hashCapacity is 32 * 2^cache SUMMED over servers - 64 hashes at cache 1,
  // while Increase Maximum Money at level 50 costs 2,550. So cache is
  // load-bearing, and a bundle the store cannot HOLD asks for a cache level
  // rather than a spend. A bundle that fits capacity but not the current
  // balance simply waits: hashes accumulate and overflow is auto-sold.
  "capacity too small asks for cache; short of hashes just waits": async () => {
    const mods = await loadScripts();
    const m = mods["hacknet/math"];
    const cfg = {
      HASH_PRICE: 250000, HASH_HORIZON_S: 3600, HASH_VALUE_MARGIN: 2,
      MONEY_SOFTCAP: 10e12,
      MAX_MONEY_UPGRADE: "Increase Maximum Money",
      MIN_SECURITY_UPGRADE: "Reduce Minimum Security",
    };
    const base = {
      levels: { "Increase Maximum Money": 0, "Reduce Minimum Security": 0 },
      perLevel: { "Increase Maximum Money": 50, "Reduce Minimum Security": 50 },
      income: 1e9,
      targets: [{ host: "phantasy", moneyMax: 2.4e9, minSec: 20, reqSkill: 1000 }],
      units: [{ index: 0, cache: 1 }, { index: 1, cache: 3 }],
      mults: { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 },
    };

    // 32 hashes of capacity cannot hold a 50-hash bundle at any balance.
    const blocked = m.planHashes({ ...base, hashes: 32, capacity: 32, budget: 1e9 }, cfg);
    assert(blocked.spends.length === 0, "nothing can be bought under capacity");
    assert(blocked.cacheBuy !== null, "a blocked bundle must ask for cache");
    // The lowest cache level is the cheapest rung, so that is the unit picked.
    assert(blocked.cacheBuy.index === 0, `cache bought on unit ${blocked.cacheBuy.index}, expected 0`);
    assert(blocked.reason.includes("capacity"), `reason was "${blocked.reason}"`);

    // Capacity is fine, the balance is not: wait, do not buy cache.
    const poor = m.planHashes({ ...base, hashes: 10, capacity: 1e6, budget: 1e9 }, cfg);
    assert(poor.spends.length === 0, "10 hashes cannot buy a 50-hash bundle");
    assert(poor.cacheBuy === null, "capacity is not the problem, so no cache buy");
    assert(poor.reason.includes("hashes"), `reason was "${poor.reason}"`);

    // No cash for cache either: say that, do not pretend the plan is fine.
    const broke = m.planHashes({ ...base, hashes: 32, capacity: 32, budget: 0 }, cfg);
    assert(broke.cacheBuy === null, "with no budget there is no cache buy");
    assert(broke.reason.includes("capacity"), `reason was "${broke.reason}"`);
  },

  // Improve Studying: HashUpgrade.getCost is costPerLevel * (L+1) per level, 50
  // per level (HashUpgradesMetadata.tsx), so levels 0,1,2 cost 50, 100, 150.
  "planStudy buys what the balance covers, up to the cap, only while studying": async () => {
    const { planStudy } = (await loadScripts())["hacknet/math"];
    const base = { studying: true, level: 0, perLevel: 50, cap: 10, hashes: 320, capacity: 1000 };
    let p = planStudy(base);
    assert(p.count === 3 && p.hashes === 300 && !p.saving, `50+100+150 = 300 of 320: ${JSON.stringify(p)}`);
    p = planStudy({ ...base, cap: 2 });
    assert(p.count === 2 && p.hashes === 150, `capped at 2: ${JSON.stringify(p)}`);
    p = planStudy({ ...base, studying: false });
    assert(p.count === 0 && !p.saving, "not studying: nothing, and nothing held");
    p = planStudy({ ...base, level: 10 });
    assert(p.count === 0 && !p.saving, "at the cap: nothing, and nothing held");
  },

  // Out of reach but fits the store: hold the hashes, never sell them - the
  // sale would fund nothing and the level would never be bought. Too dear for
  // the whole store: it can never fill, so nothing is held for it.
  "planStudy saves toward a level the store can hold, and only that": async () => {
    const { planStudy } = (await loadScripts())["hacknet/math"];
    const base = { studying: true, level: 5, perLevel: 50, cap: 10, hashes: 100, capacity: 1000 };
    assert(planStudy(base).saving === true, "300 fits a 1000 store: save");
    assert(planStudy({ ...base, capacity: 200 }).saving === false, "300 never fits a 200 store: do not save");
    const src = readScript("hacknet/hashes");
    assert(/study\.saving\s*&&\s*plan\.sell/.test(src) && /plan\.sell\s*=\s*0/.test(src),
      "hashes.js must cancel the sale while saving for a study level");
    assert(/numHashes\(\)\s*-\s*study\.hashes/.test(src),
      "planHashes must be handed the balance LEFT after the study buy");
  },

  // The name is resolved through getEnumHelper().nsGetMember, which THROWS on a
  // miss - so a folded or mistyped upgrade name takes the whole sweep down
  // rather than quietly skipping one buy. This is the Vigenere lesson: the
  // contract solver folded one non-ASCII name and read as permanently unsolved
  // with no error anywhere.
  "the hash sweep checks the upgrade names against the game's own list": () => {
    const src = readScript("hacknet/hashes");
    assert(/getHashUpgrades\s*\(/.test(src),
      "hashes.js must ask the game for its upgrade names rather than trusting the constants");
  },

  // ns.getTotalScriptIncome()[0] sums onlineMoneyMade/onlineRunningTime over
  // scripts running RIGHT NOW (NetscriptFunctions.ts), and both batchers are
  // just-in-time - hack.js credits its money and exits microseconds later - so
  // [0] is dominated by zeros and reads one to two orders of magnitude low.
  // [1] (scriptProdSinceLastAug / playtimeSinceLastAug) is the usable $/s
  // rate. Reading [0] alone put every candidate below the 50 x $250k x 2
  // sale-price bar and made the whole BN9 half of this subsystem silently do
  // nothing, blaming "nothing beats the sale price" - the wrong cause. Pinned
  // so nobody "simplifies" it back to [0].
  "the hash sweep's income read takes the larger of getTotalScriptIncome's two elements": () => {
    const src = readScript("hacknet/hashes");
    assert(/const\s+inc\s*=\s*ns\.getTotalScriptIncome\(\)/.test(src),
      "hashes.js must capture getTotalScriptIncome() before indexing it");
    assert(/Math\.max\(\s*inc\[0\]\s*,\s*inc\[1\]\s*\)/.test(src),
      "hashes.js must read Math.max(inc[0], inc[1]) - [0] alone is near-zero for a JIT batcher");
  },

  // ns.read resolves against the server the CALLING SCRIPT runs on
  // (NetscriptFunctions.ts: `const server = ctx.workerScript.getServer()`), and
  // /data/targets.txt exists on home alone. Both sweeps are run by boot on home,
  // so this is safe - but nothing may pass the marker path to a worker.
  "the target marker is read, never handed to a worker": () => {
    const src = readScript("hacknet/hashes");
    assert(!/exec\s*\(/.test(src),
      "hashes.js must not exec anything - the marker it reads exists on home alone");
  },

  // Whichever batcher is up publishes what it is working. Hash upgrades only
  // pay on a server the batcher is actually hitting, and which system runs is
  // the user's choice - so the reader must not have to know which.
  "the manager publishes its targets and boot clears the marker": () => {
    const core = readScript("continuous/core");
    assert(core.includes("TARGETS_MARKER"),
      "continuous/core.js must publish its admitted targets");
    assert(/ns\.write\(\s*TARGETS_MARKER/.test(core),
      "continuous/core.js must WRITE the marker, not just import it");

    // A stale list has hashes bought for a server nobody is hitting, and hash
    // upgrades do not refund. boot clears it on BOTH paths where no manager of
    // any system survives: mid-run (a swap) and never-at-all (--no-manager).
    // Counted rather than .test-ed: a single occurrence would still pass if
    // either clear site were deleted.
    const boot = readScript("boot");
    const bootClears = boot.match(/ns\.write\(\s*TARGETS_MARKER\s*,\s*""/g) ?? [];
    assert(bootClears.length >= 2,
      "boot.js must clear the marker both when a swap leaves no manager and under --no-manager");
  },

  // Transients that are SUPPOSED to exit, so ensureService and the inGang()
  // relaunch trap do not apply - this is the contracts.js shape. isUp is still
  // checked, not for duplicates but for STACKING: a hand-run --dry-run can be
  // going, and a second sweep on top would both plan against the same cash.
  "boot runs both sweeps as transients, on a cadence, and can opt out": () => {
    const src = readScript("boot");

    assert(src.includes("HACKNET_MONEY_SERVICE") && src.includes("HACKNET_HASH_SERVICE"),
      "boot must import both service paths from hacknet/config.js");
    assert(src.includes("--no-hacknet"), "boot must accept --no-hacknet");
    // The cadence is the live `hacknet.every` setting, defaulting to HACKNET_EVERY.
    assert(src.includes('"hacknet.every"'), "boot must run the sweeps on a cadence");

    // runToCompletion, never ensureService: a sweep that exits would be
    // relaunched every tick forever.
    assert(/runToCompletion\(ns,\s*HACKNET_MONEY_SERVICE/.test(src),
      "the money sweep must be run with runToCompletion");
    assert(/runToCompletion\(ns,\s*HACKNET_HASH_SERVICE/.test(src),
      "the hash sweep must be run with runToCompletion");
    assert(!/ensureService\(ns,\s*HACKNET_/.test(src),
      "neither sweep is a service - ensureService would relaunch it every tick forever");
  },
};
