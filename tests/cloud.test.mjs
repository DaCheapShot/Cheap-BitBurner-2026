import { loadScripts, assert } from "./harness.mjs";

/**
 * One cloud.js pass against a fake fleet. Prices are flat per GB so the
 * arithmetic stays readable: a server costs $1k/GB, an upgrade the difference.
 */
async function pass({ cash, owned = {}, limit = 3, ramLimit = 64, store = {} }) {
  const { main } = (await loadScripts())["cloud"];
  const ns = {
    args: [], disableLog: () => {}, print: () => {}, tprint: () => {},
    read: (f) => store[f] ?? "",
    write: (f, d) => { store[f] = d; },
    getServerMoneyAvailable: () => cash,
    getServerMaxRam: (h) => owned[h],
    format: { number: (n) => String(Math.round(n)), ram: (g) => `${g}GB`, percent: (f) => `${f * 100}%` },
    cloud: {
      getServerLimit: () => limit,
      getRamLimit: () => ramLimit,
      getServerNames: () => Object.keys(owned),
      getServerCost: (r) => r * 1000,
      getServerUpgradeCost: (h, r) => (r > owned[h] ? (r - owned[h]) * 1000 : -1),
      purchaseServer: (name, r) => { cash -= r * 1000; owned[name] = r; return name; },
      upgradeServer: (h, r) => { cash -= (r - owned[h]) * 1000; owned[h] = r; return true; },
    },
  };
  await main(ns);
  return { store, owned };
}

export const tests = {
  // A pass keeps buying while the budget covers another server - one action
  // per boot tick would take a minute a slot on a fresh fleet.
  "one pass buys until the budget runs out, and logs every purchase": async () => {
    const { CLOUD_STATUS_FILE, CLOUD_HISTORY_FILE } = (await loadScripts())["config"];
    // 10% of what is left each step: 64GB servers while they fit, then smaller.
    const r = await pass({ cash: 1e6, limit: 50 });
    const bought = Object.keys(r.owned);
    assert(bought.length >= 2, `should buy more than one server in a pass, got ${bought}`);
    const h = r.store[CLOUD_HISTORY_FILE].trim().split("\n");
    assert(h.filter((l) => l.includes("BOUGHT")).length === bought.length, `every purchase logged: ${h}`);
    assert(r.store[CLOUD_STATUS_FILE].includes("wait:"), "the status ends on what it waits for");
  },

  // The wait line re-prices every pass as cash moves; that is not news.
  "a repeated wait is logged once, whatever the cash": async () => {
    const { CLOUD_HISTORY_FILE } = (await loadScripts())["config"];
    const owned = { "cheapserv-00": 8, "cheapserv-01": 8, "cheapserv-02": 8 };
    const store = {};
    await pass({ cash: 10, owned, store });
    await pass({ cash: 20, owned, store });
    const h = store[CLOUD_HISTORY_FILE].trim().split("\n");
    assert(h.length === 1 && h[0].includes("wait:"), `one wait line expected: ${h}`);
    // 8GB -> 16GB is $8k; at the 10% default that needs $80k cash.
    assert(h[0].includes("needs $80000 cash"), `the wait says what cash ends it: ${h[0]}`);
    await pass({ cash: 1e6, owned, store });
    assert(store[CLOUD_HISTORY_FILE].includes("UPGRADED"), "an upgrade is logged");
  },

  "a maxed fleet stamps the done marker": async () => {
    const { CLOUD_DONE_MARKER } = (await loadScripts())["config"];
    const r = await pass({ cash: 0, owned: { a: 64, b: 64, c: 64 } });
    assert(r.store[CLOUD_DONE_MARKER].includes("nothing left to buy"), r.store[CLOUD_DONE_MARKER]);
  },
};
