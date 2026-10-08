import { assert, loadScripts, readScript } from "./harness.mjs";
import { makeNs } from "./mockNs.mjs";

/** mulberry32: a seeded RNG, so a market run is the same every time. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The game's market, transcribed from src/StockMarket/StockMarket.ts
 * processStockPrices and Stock.ts - not a re-derivation, so the strategy is
 * tested against the process it has to beat: ONE volatility draw per tick for
 * every stock, the 75-tick cycle flipping each stock with p = 0.45, the
 * forecast drifting by otlkMag * av and its second-order forecast by half that.
 */
function market(seed, n = 12) {
  const r = rng(seed);
  const stocks = Array.from({ length: n }, (_, i) => {
    const price = 5e3 + r() * 45e3;
    const b = r() < 0.5;
    const otlkMag = 1 + r() * 19;
    return {
      sym: `S${i}`, price, cap: price * 1e4, mv: 0.5 + r() * 2.5, b, otlkMag,
      ff: b ? 50 + otlkMag : 50 - otlkMag, spread: 0.2 + r() * 0.8, max: 20e6,
      long: 0, longAvg: 0, short: 0, shortAvg: 0,
    };
  });
  let untilCycle = 1 + Math.floor(r() * 75);
  const abs = (s) => (s.b ? 50 + s.otlkMag : 50 - s.otlkMag);
  const cycle = (s, change) => {
    const inc = (50 + Math.min(Math.max(s.ff - abs(s), -45), 45)) / 100;
    s.otlkMag += (r() < inc) === s.b ? change : -change;
    s.otlkMag = Math.min(s.otlkMag, 50);
    if (s.otlkMag < 0) { s.otlkMag *= -1; s.b = !s.b; }
  };
  return {
    stocks,
    tick() {
      if (--untilCycle <= 0) {
        for (const s of stocks) if (r() < 0.45) { s.b = !s.b; s.ff = 100 - s.ff; }
        untilCycle = 75;
      }
      const v = r();
      for (const s of stocks) {
        const av = (v * s.mv) / 100;
        let chc = (s.b ? 50 + s.otlkMag : 50 - s.otlkMag) / 100;
        if (s.price >= s.cap) { chc = 0.1; s.b = false; }
        s.price = r() < chc ? s.price * (1 + av) : s.price / (1 + av);
        let change = s.otlkMag * av;
        if (s.otlkMag < 5) change = s.otlkMag <= 1 ? 1 : change * 10;
        cycle(s, change);
        s.ff = Math.min(100, Math.max(0, s.ff + (r() < 0.5 ? change / 2 : -change / 2)));
      }
    },
    ask: (s) => s.price * (1 + s.spread / 100),
    bid: (s) => s.price * (1 - s.spread / 100),
    fc: (s) => abs(s) / 100,
  };
}

/** The game's buy/sell bookkeeping (BuyingAndSelling.ts), cash in `w.cash`. */
function fill(m, w, o) {
  const s = m.stocks.find((x) => x.sym === o.sym);
  if (o.open) {
    const px = o.kind === "long" ? m.ask(s) : m.bid(s);
    if (w.cash < o.shares * px + 100e3) return 0;
    w.cash -= o.shares * px + 100e3;
    const avg = o.kind + "Avg";
    s[avg] = (s[o.kind] * s[avg] + o.shares * px) / (s[o.kind] + o.shares);
    s[o.kind] += o.shares;
    return px;
  }
  if (o.kind === "long") {
    const px = m.bid(s);
    w.cash += o.shares * px - 100e3;
    s.long = 0;
    return px;
  }
  const px = m.ask(s);
  w.cash += o.shares * (2 * s.shortAvg - px) - 100e3;
  s.short = 0;
  return px;
}

/** Run the trader's plan against the simulated market for `ticks`; net worth at the end. */
async function simulate({ seed, ticks, fs, canShort = true, cash = 250e6 }) {
  const { track, planTrades, positionValue } = (await loadScripts())["stocks/math"];
  const m = market(seed);
  const w = { cash };
  const recs = new Map();
  let trades = 0;
  for (let t = 0; t < ticks; t++) {
    m.tick();
    const view = m.stocks.map((s) => {
      const rec = track(recs.get(s.sym), s.price);
      recs.set(s.sym, rec);
      return { sym: s.sym, ask: m.ask(s), bid: m.bid(s), long: s.long, longAvg: s.longAvg, short: s.short,
        shortAvg: s.shortAvg, max: s.max, fc: fs ? m.fc(s) : null, vol: fs ? s.mv / 100 : null, moves: rec.moves };
    });
    const worth = w.cash + view.reduce((n, s) => n + positionValue(s), 0);
    const { sells, buys } = planTrades({ stocks: view, cash: w.cash, cap: worth, fs, canShort });
    for (const o of sells) { fill(m, w, { ...o, open: false }); trades++; }
    for (const o of buys) { fill(m, w, { ...o, open: true }); trades++; }
  }
  const end = m.stocks.reduce((n, s) => n + positionValue({ ...s, ask: m.ask(s), bid: m.bid(s) }), w.cash);
  return { end, trades };
}

/** "+$1.23m" as the mock's ns.format.number writes it, back to a number. */
function money(text) {
  const m = /^([+-]?)\$([\d.]+)([kmbtq]?)$/.exec(String(text));
  if (!m) return NaN;
  return (m[1] === "-" ? -1 : 1) * Number(m[2]) * 1000 ** " kmbtq".indexOf(m[3] || " ");
}

/** One stock as planTrades sees it, flat. */
const stock = (o = {}) => ({
  sym: "AAA", ask: 1010, bid: 990, long: 0, longAvg: 0, short: 0, shortAvg: 0,
  max: 1e6, fc: 0.5, vol: 0.02, moves: [], ...o,
});

/** stocks.js's bodies by const name, as tests/rpc.test.mjs extracts them. */
function bodies(file) {
  const out = {};
  for (const m of readScript(file).matchAll(/\bconst\s+([A-Z_]+)\s*=\s*`([\s\S]*?)`;/g)) out[m[1]] = m[2];
  return out;
}

export const tests = {
  // ------------------------------------------------------------ math.js ----

  // A tick's direction is a coin with p = forecast, so the up-share over the
  // long window estimates it. 400 ticks at a held 0.65 must read within 0.05.
  "the up-tick share estimates the forecast": async () => {
    const { track, upShare } = (await loadScripts())["stocks/math"];
    const r = rng(7);
    let rec = null;
    let price = 1000;
    const reads = [];
    for (let i = 0; i < 400; i++) {
      price *= r() < 0.65 ? 1.01 : 1 / 1.01;
      rec = track(rec, price);
      if (i >= 40) reads.push(upShare(rec.moves, 40));
    }
    const mean = reads.reduce((a, b) => a + b, 0) / reads.length;
    assert(Math.abs(mean - 0.65) < 0.05, `mean estimate ${mean.toFixed(3)} vs 0.65`);
    assert(rec.moves.length === 40, `history is capped at LONG_WIN, got ${rec.moves.length}`);
  },

  "with 4S: long above the edge, short below, ranked by expected gain": async () => {
    const { planTrades } = (await loadScripts())["stocks/math"];
    const stocks = [
      stock({ sym: "UP", fc: 0.6, vol: 0.01 }),
      stock({ sym: "BIG", fc: 0.7, vol: 0.02 }),
      stock({ sym: "DOWN", fc: 0.35, vol: 0.02 }),
      stock({ sym: "FLAT", fc: 0.52, vol: 0.05 }),
    ];
    const { buys } = planTrades({ stocks, cash: 5e9, cap: 5e9, fs: true, canShort: true });
    assert(buys.map((b) => `${b.kind} ${b.sym}`).join(",") === "long BIG,short DOWN,long UP",
      `got ${JSON.stringify(buys)}`);
    // max shares bound each position: 1e6 at ~$1k is $1b, so $5b fills all three.
    assert(buys.every((b) => b.shares === 1e6), `max shares: ${JSON.stringify(buys)}`);
    const noShort = planTrades({ stocks, cash: 5e9, cap: 5e9, fs: true, canShort: false }).buys;
    assert(!noShort.some((b) => b.kind === "short"), "no shorts without BN8 / SF8.2");
  },

  // A stock the batcher can push earns more than the same edge on one it
  // cannot reach, so it ranks ahead - but the bonus is ranking only.
  "a pushable stock ranks ahead by pushBonus, and still needs the edge": async () => {
    const { planTrades, pushableSyms } = (await loadScripts())["stocks/math"];
    const stocks = [
      stock({ sym: "BIG", fc: 0.7, vol: 0.02 }),
      stock({ sym: "PUSH", fc: 0.65, vol: 0.02 }),
      stock({ sym: "WEAK", fc: 0.52, vol: 0.05 }),
    ];
    // $1.5b buys one full position and part of a second: order decides who gets it.
    const order = (o) => planTrades({ stocks, cash: 1.5e9, cap: 1e12, fs: true, ...o }).buys.map((b) => b.sym).join();
    const pushable = pushableSyms('["Push Corp","Weak Corp"]', [
      { sym: "BIG", org: "Big Corp" }, { sym: "PUSH", org: "Push Corp" }, { sym: "WEAK", org: "Weak Corp" },
    ]);
    assert(order({}) === "BIG,PUSH", `no bonus: ${order({})}`);
    assert(order({ pushable, pushBonus: 1 }) === "BIG,PUSH", `bonus 1 is off: ${order({ pushable, pushBonus: 1 })}`);
    assert(order({ pushable, pushBonus: 2 }) === "PUSH,BIG", `bonus 2: ${order({ pushable, pushBonus: 2 })}`);
    assert(!order({ pushable, pushBonus: 100 }).includes("WEAK"), "under the buy edge stays unbought");
    assert(pushableSyms("not json", [{ sym: "X", org: "X" }]).size === 0, "broken file is none");
    assert(pushableSyms("", [{ sym: "X", org: "X" }]).size === 0, "missing file is none");
  },

  "nothing under MIN_TRADE, nothing past the cap or the reserve, nothing while held": async () => {
    const mods = await loadScripts();
    const { planTrades } = mods["stocks/math"];
    const { MIN_TRADE } = mods["stocks/config"];
    const stocks = [stock({ fc: 0.7 })];
    assert(planTrades({ stocks, cash: MIN_TRADE / 2, cap: 1e12, fs: true }).buys.length === 0, "under MIN_TRADE");
    const capped = planTrades({ stocks, cash: 1e12, cap: 100e6, fs: true }).buys[0];
    assert(capped.shares * 1010 <= 100e6, `cap: ${capped.shares} shares`);
    assert(planTrades({ stocks, cash: 1e9, cap: 1e12, reserve: 1e9, fs: true }).buys.length === 0, "the 4S reserve");
    const held = [stock({ fc: 0.2, long: 5e5, longAvg: 1000 }), stock({ sym: "B", fc: 0.8 })];
    const h = planTrades({ stocks: held, cash: 1e12, cap: 1e12, fs: true, hold: true });
    assert(h.sells.length === 0 && h.buys.length === 0, "a sell-all in force: no orders at all");
  },

  "a long closes when the forecast turns; never held both ways": async () => {
    const { planTrades } = (await loadScripts())["stocks/math"];
    const turned = planTrades({ stocks: [stock({ fc: 0.45, long: 1000, longAvg: 900 })], cash: 0, cap: 1e12, fs: true });
    assert(turned.sells.length === 1 && turned.sells[0].kind === "long" && turned.sells[0].shares === 1000,
      `close: ${JSON.stringify(turned)}`);
    const keep = planTrades({ stocks: [stock({ fc: 0.53, long: 1000, longAvg: 900 })], cash: 0, cap: 1e12, fs: true });
    assert(keep.sells.length === 0, "0.53 is still above SELL_EDGE - hold");
    // Held short, forecast now long-worthy: the short closes, and no long opens
    // beside it in the same tick.
    const flip = planTrades({ stocks: [stock({ fc: 0.7, short: 1000, shortAvg: 1100 })], cash: 1e12, cap: 1e12, fs: true });
    assert(flip.sells.length === 1 && flip.buys.length === 0, `flip: ${JSON.stringify(flip)}`);
  },

  // Before 4S the long window lags a flip by half its length; the short window
  // is what catches it. Ten down-ticks after thirty ups: long read 0.75, short 0.
  "pre-4S: the short window closes a flipped long and vetoes a stale buy": async () => {
    const { planTrades } = (await loadScripts())["stocks/math"];
    const moves = [...Array(30).fill(0.01), ...Array(10).fill(-0.01)];
    const held = planTrades({ stocks: [stock({ moves, long: 1e5, longAvg: 1000 })], cash: 1e12, cap: 1e12, fs: false });
    assert(held.sells.length === 1, `flipped long closes: ${JSON.stringify(held)}`);
    const fresh = planTrades({ stocks: [stock({ moves })], cash: 1e12, cap: 1e12, fs: false });
    assert(fresh.buys.length === 0, `stale long-window read must not buy: ${JSON.stringify(fresh)}`);
    const young = planTrades({ stocks: [stock({ moves: moves.slice(0, 20) })], cash: 1e12, cap: 1e12, fs: false });
    assert(young.buys.length === 0, "under LONG_WIN ticks of history: no signal, no buy");
  },

  // The real gate: the plan, run against the game's own market process, has to
  // make money - BN8's $250m, a few hours of ticks, before and after 4S. Seeded,
  // so a strategy change that loses money fails here every time, not sometimes.
  "the strategy makes money against the game's market, pre-4S and with 4S": async () => {
    const ticks = 3000; // five hours of 6 s ticks
    for (const seed of [1, 2, 3]) {
      const pre = await simulate({ seed, ticks, fs: false });
      const fs = await simulate({ seed, ticks, fs: true });
      assert(pre.end > 250e6, `seed ${seed} pre-4S: $250m -> $${(pre.end / 1e6).toFixed(1)}m over ${pre.trades} trades`);
      assert(fs.end > pre.end, `seed ${seed}: 4S ($${(fs.end / 1e6).toFixed(1)}m) must beat pre-4S ($${(pre.end / 1e6).toFixed(1)}m)`);
    }
  },

  // -------------------------------------------------- bodies + sing SWEEP ----

  // A sell-all landing between stocks.js's plan and its TRADE body must not be
  // followed by a buy the install then destroys. Closes still go through.
  "TRADE opens nothing inside a sell-all hold, but still closes": async () => {
    const mods = await loadScripts();
    const { HOLD_FILE } = mods["stocks/config"];
    const calls = [];
    const ns = makeNs({
      files: { [HOLD_FILE]: String(Date.now()) },
      extra: { stock: {
        buyStock: (s, n) => { calls.push(`buy ${s}`); return 1; },
        buyShort: (s, n) => { calls.push(`short ${s}`); return 1; },
        sellStock: (s, n) => { calls.push(`sell ${s}`); return 1; },
        sellShort: (s, n) => { calls.push(`cover ${s}`); return 1; },
      } },
    });
    const { TRADE } = bodies("stocks/stocks");
    const orders = [{ sym: "A", kind: "long", shares: 1, open: false }, { sym: "B", kind: "long", shares: 1, open: true }];
    const fills = await mods["rpc"].rpc(ns, TRADE, JSON.stringify(orders));
    assert(calls.join(",") === "sell A", `calls: ${calls}`);
    assert(fills[1] === 0, "the refused open reports 0");
  },

  // Prestige resets the market: an install with positions open loses them.
  "sing's SWEEP sells stock positions first, and holds the install when it cannot": async () => {
    const mods = await loadScripts();
    const { HELD_FILE, STOCKS_SELL_ALL } = mods["stocks/config"];
    const sweep = (() => {
      for (const m of readScript("sing/sing").matchAll(/\bconst\s+([A-Z_]+)\s*=\s*`([\s\S]*?)`;/g)) if (m[1] === "SWEEP") return m[2];
    })();
    const ran = [];
    const make = (sells) => {
      const ns = makeNs({ files: { [HELD_FILE]: "3" }, extra: { isRunning: () => false } });
      const run = ns.run;
      ns.run = (f, ...a) => {
        ran.push(f.replace(/^\/+/, "/"));
        if (f === STOCKS_SELL_ALL && sells) ns._files[HELD_FILE] = "0";
        return run(f, ...a);
      };
      return ns;
    };
    assert(await mods["rpc"].rpc(make(true), sweep) > 0, "sold - the sweep carries on to the contracts");
    assert(ran.includes(STOCKS_SELL_ALL), `sellall ran: ${ran}`);
    ran.length = 0;
    assert(await mods["rpc"].rpc(make(false), sweep) === -2, "still held - no install");
    assert(!ran.some((f) => f.includes("contracts")), `no contract sweep once held: ${ran}`);
  },

  // ------------------------------------------------------------ stocks.js --

  // Outside BN8 without SF8.1 there is no TIX: the trader exits at once (sing
  // buys the API, boot starts this after) and leaves sing and the batcher
  // reading "nothing held".
  "without TIX it exits at once, writing nothing held and nothing to push": async () => {
    const mods = await loadScripts();
    const { HELD_FILE, STOCK_PUSH_FILE } = mods["stocks/config"];
    const ns = makeNs({
      files: { [HELD_FILE]: "123", [STOCK_PUSH_FILE]: '{"x":1}' },
      extra: {
        stock: {
          hasTixApiAccess: () => false,
          nextUpdate: async () => { throw new Error("nextUpdate without TIX"); },
        },
      },
    });
    await mods["stocks/stocks"].main(ns);
    assert(ns.read(HELD_FILE) === "0", `HELD_FILE: ${ns.read(HELD_FILE)}`);
    assert(ns.read(STOCK_PUSH_FILE) === "{}", `STOCK_PUSH_FILE: ${ns.read(STOCK_PUSH_FILE)}`);
  },

  // Driven against the simulated market through a mock ns.stock: READ, plan,
  // TRADE, and the files sing and the player read.
  "stocks.js trades on the tick and writes the snapshot sing reads": async () => {
    const mods = await loadScripts();
    const { HELD_FILE, STATUS_FILE, HISTORY_FILE } = mods["stocks/config"];
    const m = market(5);
    const w = { cash: 250e6 };
    const EXTERNAL = 1e9;
    const by = (sym) => m.stocks.find((s) => s.sym === sym);
    let ticks = 0;
    // Ticks that delivered income: every nextUpdate but the one that stopped the run.
    const ticks0 = () => ticks - 1;
    const ns = makeNs({
      servers: { home: { get moneyAvailable() { return w.cash; } } },
      extra: {
        getResetInfo: () => ({ currentNode: 8, ownedSF: new Map() }),
        getBitNodeMultipliers: () => ({ FourSigmaMarketDataApiCost: 1 }),
        stock: {
          hasTixApiAccess: () => true,
          has4SDataTixApi: () => true,
          getConstants: () => ({ MarketDataTixApi4SCost: 25e9 }),
          nextUpdate: async () => {
            if (++ticks > 30) throw new Error("STOP");
            // Other income lands every tick - the batcher. The stock profit
            // line must not count it (a live run read +$53b holding nothing).
            w.cash += EXTERNAL;
            m.tick();
            await new Promise((r) => setTimeout(r, 1));
          },
          getSymbols: () => m.stocks.map((s) => s.sym),
          getMaxShares: (s) => by(s).max,
          getOrganization: (s) => `Org ${s}`,
          getPrice: (s) => by(s).price,
          getAskPrice: (s) => m.ask(by(s)),
          getBidPrice: (s) => m.bid(by(s)),
          getPosition: (s) => [by(s).long, by(s).longAvg, by(s).short, by(s).shortAvg],
          getForecast: (s) => m.fc(by(s)),
          getVolatility: (s) => by(s).mv / 100,
          buyStock: (sym, n) => fill(m, w, { sym, kind: "long", shares: n, open: true }),
          buyShort: (sym, n) => fill(m, w, { sym, kind: "short", shares: n, open: true }),
          sellStock: (sym, n) => fill(m, w, { sym, kind: "long", shares: n, open: false }),
          sellShort: (sym, n) => fill(m, w, { sym, kind: "short", shares: n, open: false }),
        },
      },
    });
    try {
      await mods["stocks/stocks"].main(ns);
    } catch (e) {
      if (e.message !== "STOP") throw e;
    }
    const held = m.stocks.filter((s) => s.long || s.short);
    assert(held.length > 0, "with 4S and $250m something opens within 30 ticks");
    // What selling them now would pay, net of commission - the cash sing's
    // aug batch counts them as.
    const sale = held.reduce((n, s) => n + s.long * m.bid(s) + s.short * (2 * s.shortAvg - m.ask(s)) - 100e3, 0);
    const got = Number(ns.read(HELD_FILE));
    assert(Math.abs(got - sale) < 1, `HELD_FILE ${got} vs sale value ${sale}`);
    // The batcher's half: one entry per held stock, keyed by its company, up
    // for a long and down for a short.
    const push = JSON.parse(ns.read(mods["stocks/config"].STOCK_PUSH_FILE));
    assert(Object.keys(push).length === held.length, `push ${JSON.stringify(push)} vs ${held.length} held`);
    for (const s of held) {
      assert(push[`Org ${s.sym}`]?.dir === (s.long ? 1 : -1), `push for ${s.sym}: ${JSON.stringify(push)}`);
    }
    // The log is a dashboard: cleared every tick, so it holds exactly the last
    // tick's picture - the same lines STATUS_FILE gets - and no trade spam.
    const dash = ns.read(STATUS_FILE).trimEnd().split("\n");
    assert(ns._log.join("\n") === dash.join("\n"), `log is the dashboard:\n${ns._log.join("\n")}`);
    for (const head of ["since   ", "stocks  ", "profit  ", "        closed ", "        open   "]) {
      assert(dash.some((l) => l.startsWith(head)), `dashboard line "${head}":\n${dash.join("\n")}`);
    }
    // Stock profit = cash the trades moved + what is held now, with the
    // outside income taken back out. Both commissions are in the cash flows.
    const flows = w.cash - 250e6 - ticks0() * EXTERNAL;
    const truth = flows + held.reduce((n, s) => n + s.long * m.bid(s) + s.short * (2 * s.shortAvg - m.ask(s)), 0);
    const shown = money(/^profit  ([+-]\$\S+) from stocks/.exec(dash.find((l) => l.startsWith("profit")))?.[1]);
    assert(Math.abs(shown - truth) <= Math.max(1e4, Math.abs(truth) * 0.001),
      `profit shows ${shown}, stocks made ${truth} (outside income ${ticks0() * EXTERNAL} must not count)`);
    const table = dash.findIndex((l) => l.startsWith("SYM"));
    assert(table > 0 && dash.slice(table + 1).filter((l) => /^S\d+\s+(long|short)/.test(l)).length === held.length,
      `one table row per position:\n${dash.join("\n")}`);
    assert(!dash.some((l) => /(open|close) (long|short) S\d+/.test(l)), `no trade lines on the dashboard:\n${dash.join("\n")}`);
    assert(/open (long|short) S\d+/.test(ns.read(HISTORY_FILE)), `history: ${ns.read(HISTORY_FILE)}`);
    assert(!ns.read(HISTORY_FILE).includes("WARN"), `a body failed: ${ns.read(HISTORY_FILE)}`);
  },
};
