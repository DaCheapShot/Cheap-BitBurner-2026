import { HELD_FILE, HOLD_FILE } from "./config.js";

/**
 * Sell every stock position, long and short. sing's SWEEP body runs this
 * before an install - Prestige resets the market, and every position with it.
 *
 * A real file, not an rpc body of sing's: the four stock names here are 9.05
 * GB, past sing's 6.60 ceiling, and this way it is also runnable by hand
 * before a manual install.
 *
 * HOLD_FILE is written FIRST, so stocks.js opens nothing from here until the
 * install (see TRADE in stocks.js). No await anywhere in main: it runs to
 * completion between two of any other script's steps.
 *
 * HELD_FILE gets the number of positions the game REFUSED to sell, so the
 * SWEEP holds the install rather than lose them.
 *
 * Usage:  run scripts/stocks/sellall.js
 *
 * RAM: 1.60 base + getSymbols 2.00 + getPosition 2.00 + sellStock 2.50
 *      + sellShort 2.50 + hasTixApiAccess 0.05 = 10.65 GB
 */
/** @param {NS} ns */
export async function main(ns) {
  ns.write(HOLD_FILE, String(Date.now()), "w");
  let left = 0;
  if (ns.stock.hasTixApiAccess()) {
    for (const sym of ns.stock.getSymbols()) {
      const [long, , short] = ns.stock.getPosition(sym);
      if (long > 0 && !ns.stock.sellStock(sym, long)) left++;
      if (short > 0 && !ns.stock.sellShort(sym, short)) left++;
    }
  }
  ns.write(HELD_FILE, String(left), "w");
  ns.print(left ? `WARN: ${left} position(s) could not be sold` : "every position sold");
}
