import {
  STATUS_FILE, HISTORY_FILE, HISTORY_KEEP, HELD_FILE, HOLD_FILE, HOLD_MS, FS_WORTH_MULT,
} from "./config.js";
import { track, planTrades, positionValue, signal, COMMISSION } from "./math.js";
import { rpc } from "scripts/rpc.js";
import { SETTINGS_FILE, setting } from "scripts/settings.js";

/**
 * The stock trader: resident, one decision per market tick.
 *
 * WHY. In BitNode 8 every other money path is multiplied by 0 -
 * ScriptHackMoneyGain, HacknetNodeMoney, CrimeMoney, CompanyWorkMoney - so
 * this is the only income there is. Source-File 8.1 keeps TIX access in every
 * later node, where it earns beside the batcher.
 *
 * RESIDENT, because the pre-4S forecast is ESTIMATED from a run of ticks and
 * that history has to live somewhere. ns.stock.nextUpdate() is 0 GB and
 * resolves on the market's own tick, so there is no timer to drift.
 *
 * EVERY PRICED CALL IS AN RPC BODY - the gang/sing shape. The stock API is
 * 2.00-2.50 GB a name; reading and trading in one process is ~22 GB. Here:
 * READ every tick (10.75), TRADE only on a tick that trades (11.60), INIT /
 * TERMS once per process, BUY_API once per node. The resident is 2.65.
 *
 * PARKS WITHOUT TIX rather than exiting - nextUpdate throws without it, and
 * an exit would have boot's ensureService relaunch it every tick. While
 * parked, BUY_TIX buys the TIX API once a minute's check finds cash at
 * TIX_CASH_MULT x its price (stocks.buyTix). No WSE account: nothing here
 * needs one. SF8.1 makes TIX permanent.
 *
 * INSTALLS SELL FIRST. Prestige resets the market and every position in it.
 * sing's SWEEP runs sellall.js when HELD_FILE says something is held, and
 * HOLD_FILE then keeps this from reopening for HOLD_MS.
 *
 * THE LOG IS A DASHBOARD, cleared and redrawn every tick: net worth at start
 * and now, profit and its rate, closed and open P/L, a row per position, and
 * the last few trades. Every trade also goes to HISTORY_FILE, which keeps them.
 *
 * Usage:  run scripts/stocks/stocks.js     (boot does this; --no-stocks opts out)
 *         cat /data/stocks.txt             (the dashboard, same lines)
 *         cat /data/stocks.log.txt         (every trade)
 *
 * RAM: 1.60 base + run 1.00 + hasTixApiAccess 0.05 = 2.65 GB
 */

// ------------------------------------------------------------------ bodies ---
//
// Plain template literals: rpc() rejects interpolation, tests/rpc.test.mjs
// parses every one, tests/ram.test.mjs prices every one.

/**
 * Fixed for the node: the symbols, each one's max shares, and its spread as
 * ask/price and bid/price - spreadPerc never changes (Stock.ts, readonly), so
 * READ can carry getPrice alone and save 4.00 GB a tick.
 */
const INIT = `
return ns.stock.getSymbols().map((sym) => {
  const p = ns.stock.getPrice(sym);
  return { sym, max: ns.stock.getMaxShares(sym), ask: ns.stock.getAskPrice(sym) / p, bid: ns.stock.getBidPrice(sym) / p };
});
`;

/**
 * May this save short (BitNode 8, or SF8.2 - the check NetscriptFunctions/
 * StockMarket.ts buyShort makes), and what 4S TIX API costs here: its base
 * times the node's multiplier (StockMarketCosts.ts). getBitNodeMultipliers
 * needs SF5; without it the base price is assumed and the purchase itself
 * refuses if that was wrong. ownedSF is a Map, so it never leaves the body.
 */
const TERMS = `
const r = ns.getResetInfo();
const k = ns.stock.getConstants();
let m = 1;
try { m = ns.getBitNodeMultipliers().FourSigmaMarketDataApiCost; } catch {}
return { canShort: r.currentNode === 8 || (r.ownedSF.get(8) ?? 0) >= 2, fsApi: k.MarketDataTixApi4SCost * m };
`;

/** The tick's prices and positions; forecasts only once 4S is owned (they throw before). */
const READ = `
const fs = ns.stock.has4SDataTixApi();
const out = { cash: ns.getServerMoneyAvailable("home"), fs, stocks: [] };
for (const sym of args) {
  const [long, longAvg, short, shortAvg] = ns.stock.getPosition(sym);
  out.stocks.push({
    sym, long, longAvg, short, shortAvg, price: ns.stock.getPrice(sym),
    fc: fs ? ns.stock.getForecast(sym) : null, vol: fs ? ns.stock.getVolatility(sym) : null,
  });
}
return out;
`;

/**
 * Place the orders; each returns its fill price, 0 when the game refused.
 * Opens re-check HOLD_FILE HERE: a sell-all landing between this process's
 * plan and this body would otherwise be followed by a fresh buy that the
 * install then destroys. Both scripts run to completion without an await, so
 * one of them always sees the other's whole effect.
 */
const TRADE = `
import { HOLD_FILE, HOLD_MS } from "/scripts/stocks/config.js";
const held = Number(ns.read(HOLD_FILE)) > Date.now() - HOLD_MS;
return JSON.parse(args[0]).map((o) => {
  if (o.open && held) return 0;
  if (o.open) return o.kind === "long" ? ns.stock.buyStock(o.sym, o.shares) : ns.stock.buyShort(o.sym, o.shares);
  return o.kind === "long" ? ns.stock.sellStock(o.sym, o.shares) : ns.stock.sellShort(o.sym, o.shares);
});
`;

/** 4S Market Data TIX API. The $1b 4S Market Data alone is UI-only: getForecast checks the API flag. */
const BUY_API = `return ns.stock.purchase4SMarketDataTixApi();`;

/**
 * The TIX API, while parked without it - outside BN8 before SF8.1. It is all
 * the trader needs: purchaseTixApi checks money only (no WSE account), and so
 * does the 4S API after it (NetscriptFunctions/StockMarket.ts). Bought once
 * cash is TIX_CASH_MULT x the price; the setting is read here so it is live.
 * Returns the price when it bought, 0 when it did not.
 */
const BUY_TIX = `
import { SETTINGS_FILE, setting } from "/scripts/settings.js";
import { TIX_CASH_MULT } from "/scripts/stocks/config.js";
if (!setting(ns.read(SETTINGS_FILE), "stocks.buyTix")) return 0;
const cost = ns.stock.getConstants().TixApiCost;
if (ns.getServerMoneyAvailable("home") < TIX_CASH_MULT * cost) return 0;
return ns.stock.purchaseTixApi() ? cost : 0;
`;

// -------------------------------------------------------------------- main ---

/** Dashboard column widths: SYM SIDE SHARES ENTRY NOW P/L FCST. */
const COLUMNS = [6, 7, 10, 11, 11, 13, 5];
/** The last few trades and warnings, under the table. HISTORY_FILE keeps them all. */
const RECENT_SHOWN = 5;

/** A held position's gain at the price it would close at now, commission aside. */
function openPnl(s) {
  return s.long > 0 ? (s.bid - s.longAvg) * s.long : (s.shortAvg - s.ask) * s.short;
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const $ = (n) => `$${ns.format.number(n, 2)}`;
  const signed$ = (n) => `${n < 0 ? "-" : "+"}${$(Math.abs(n))}`;
  // Events go to HISTORY_FILE, not the log: the log is a dashboard, cleared
  // and redrawn every tick. Its last few lines show at the bottom of it.
  const recent = [];
  const event = (l) => {
    const line = `${new Date().toLocaleTimeString()}  ${l}`;
    recent.push(line);
    if (recent.length > RECENT_SHOWN) recent.shift();
    const kept = ns.read(HISTORY_FILE).split("\n").filter(Boolean);
    ns.write(HISTORY_FILE, [...kept, `${new Date().toLocaleString()}  ${l}`].slice(-HISTORY_KEEP).join("\n") + "\n", "w");
  };

  // A warning is logged once, and cleared by that body's next success.
  const warned = new Set();
  const call = async (tag, body, ...args) => {
    try {
      const v = await rpc(ns, body, ...args);
      warned.delete(tag);
      return v;
    } catch (e) {
      if (!warned.has(tag)) event(`WARN: ${tag} failed - ${String(e?.message ?? e)}`);
      warned.add(tag);
      return null;
    }
  };

  if (!ns.stock.hasTixApiAccess()) {
    ns.print("no TIX API access - parked; buying it once cash allows (stocks.buyTix), re-checking every minute");
    ns.write(HELD_FILE, "0", "w");
    while (!ns.stock.hasTixApiAccess()) {
      const paid = await call("tix", BUY_TIX);
      if (paid) event(`bought the TIX API for ${$(paid)}`);
      else await ns.sleep(60e3);
    }
  }

  let init = null;
  let terms = null;
  let fsRefused = false;
  const recs = new Map();
  // The dashboard's baseline: net worth and positions at the first tick this
  // process saw, and what closed positions have made since.
  let start = null;
  const realized = { pnl: 0, closes: 0, wins: 0 };
  for (;;) {
    await ns.stock.nextUpdate();
    init ??= await call("init", INIT);
    terms ??= await call("terms", TERMS);
    if (!init || !terms) continue;
    const r = await call("read", READ, ...init.map((i) => i.sym));
    if (!r) continue;

    const stocks = r.stocks.map((x, i) => {
      const rec = track(recs.get(x.sym), x.price);
      recs.set(x.sym, rec);
      return { ...x, ask: x.price * init[i].ask, bid: x.price * init[i].bid, max: init[i].max, moves: rec.moves };
    });
    const invested = stocks.reduce((n, s) => n + positionValue(s), 0);
    const worth = r.cash + invested;
    start ??= { worth, at: Date.now(), held: stocks.filter((s) => s.long > 0 || s.short > 0).length };
    const cfg = ns.read(SETTINGS_FILE);

    // 4S: bought once net worth is FS_WORTH_MULT x its price. Until cash alone
    // covers it, nothing new opens - positions close on their own signals.
    //
    // A refusal is final for the process: BitNode options can disable 4S, or
    // the price can be wrong without SF5 - and retrying it every tick would
    // also skip every tick's trading, since a buy re-prices the cash.
    let reserve = 0;
    if (!r.fs && !fsRefused && setting(cfg, "stocks.buy4S") && worth >= FS_WORTH_MULT * terms.fsApi) {
      if (r.cash >= terms.fsApi) {
        if (await call("4S", BUY_API)) {
          event(`bought 4S Market Data TIX API for ${$(terms.fsApi)} - forecasts are exact from the next tick`);
          continue;
        }
        fsRefused = true;
        event(`WARN: the 4S TIX API purchase was refused at ${$(r.cash)} cash - trading on estimates until restart`);
      } else {
        reserve = terms.fsApi;
      }
    }

    const hold = Number(ns.read(HOLD_FILE)) > Date.now() - HOLD_MS;
    const { sells, buys } = planTrades({
      stocks, cash: r.cash, cap: setting(cfg, "stocks.cash") * worth, reserve, fs: r.fs, canShort: terms.canShort, hold,
    });
    const orders = [...sells.map((o) => ({ ...o, open: false })), ...buys.map((o) => ({ ...o, open: true }))];
    const bySym = new Map(stocks.map((s) => [s.sym, s]));
    if (orders.length) {
      const fills = (await call("trade", TRADE, JSON.stringify(orders))) ?? [];
      orders.forEach((o, i) => {
        const s = bySym.get(o.sym);
        const px = fills[i] ?? 0;
        const what = `${o.open ? "open" : "close"} ${o.kind} ${o.sym} ${ns.format.number(o.shares, 2)} sh`;
        if (!px) return event(`WARN: ${what} - refused`);
        if (o.open) {
          // The game's own running average (BuyingAndSelling.ts), so the
          // snapshot's value is right before the next READ confirms it.
          const avg = o.kind + "Avg";
          s[avg] = (s[o.kind] * s[avg] + o.shares * px) / (s[o.kind] + o.shares);
          s[o.kind] += o.shares;
          return event(`${what} @ ${$(px)} (${$(o.shares * px)})`);
        }
        const basis = o.kind === "long" ? s.longAvg : s.shortAvg;
        // Both commissions, the opening one included: this is what the round
        // trip actually made.
        const pnl = (o.kind === "long" ? px - basis : basis - px) * o.shares - 2 * COMMISSION;
        realized.pnl += pnl;
        realized.closes++;
        if (pnl > 0) realized.wins++;
        s[o.kind] = 0;
        event(`${what} @ ${$(px)}, P/L ${signed$(pnl)}`);
      });
    }

    // The dashboard, redrawn every tick - and the same lines to STATUS_FILE.
    // HELD_FILE is what sing reads: the batch counts it as cash, and SWEEP
    // sells it before an install.
    const open = stocks.filter((s) => s.long > 0 || s.short > 0);
    const hours = (Date.now() - start.at) / 3.6e6;
    const profit = worth - start.worth;
    const mode = r.fs ? "4S forecasts" : `pre-4S estimates (4S API at ${$(FS_WORTH_MULT * terms.fsApi)} worth)`;
    const flags = `${hold ? "  HOLD: sell-all before install" : ""}${reserve ? "  saving cash for 4S" : ""}`;
    const row = (cells) => cells.map((c, i) => String(c).padEnd(COLUMNS[i])).join("").trimEnd();
    const lines = [
      `${mode}${flags}`,
      `start   ${$(start.worth)} net worth, ${start.held} position(s) - ${ns.format.time(Date.now() - start.at)} ago`,
      `now     ${$(worth)} net worth = ${$(r.cash)} cash + ${$(invested)} in ${open.length} position(s)`,
      `profit  ${signed$(profit)} (${ns.format.percent(start.worth ? profit / start.worth : 0, 2)})` +
        (hours > 0.01 ? `, ${signed$(profit / hours)}/h` : ""),
      `closed  ${signed$(realized.pnl)} over ${realized.closes} trade(s), ${realized.wins} won`,
      `open    ${signed$(open.reduce((n, s) => n + openPnl(s), 0))} on what is held now (before commission)`,
      "",
      row(["SYM", "SIDE", "SHARES", "ENTRY", "NOW", "P/L", "FCST"]),
      ...open.map((s) => {
        const kind = s.long > 0 ? "long" : "short";
        const entry = kind === "long" ? s.longAvg : s.shortAvg;
        const now = kind === "long" ? s.bid : s.ask;
        const fc = signal(s, r.fs).fc;
        return row([s.sym, kind, ns.format.number(s[kind], 2), $(entry), $(now), signed$(openPnl(s)),
          fc === null ? "?" : ns.format.percent(fc, 0)]);
      }),
      ...(recent.length ? ["", ...recent] : []),
    ];
    ns.clearLog();
    for (const l of lines) ns.print(l);
    ns.write(STATUS_FILE, lines.join("\n") + "\n", "w");
    // At least $1 a position, so a position worth less than its commission
    // still reads as held.
    const value = open.reduce((n, s) => n + Math.max(1, positionValue(s) - COMMISSION), 0);
    ns.write(HELD_FILE, String(value), "w");
  }
}
