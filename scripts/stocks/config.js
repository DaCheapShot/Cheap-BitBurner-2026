/**
 * Stock trader tunables and paths. Pure, 0 GB: no ns anywhere - boot.js, sing's
 * SWEEP body and settings.js all import it.
 *
 * Mechanics these numbers rest on, from the fork's src/StockMarket/:
 *   - a tick every 6 s (msPerStockUpdate); each stock moves up with probability
 *     (50 +/- otlkMag)/100 by a factor of 1 + U(0,1) * mv/100
 *   - every 75 ticks (TicksPerCycle, random starting offset, ONE clock for all
 *     stocks) each stock flips bull/bear with p = 0.45
 *   - $100k commission per transaction, both ways; buying long pays the ask,
 *     selling pays the bid, so the spread is a round-trip cost too
 *   - trades move no price, only drag the forecast toward 50 (influenceForecast)
 */

/** Which way the batcher should push each held stock - a contract, so it lives in scripts/config.js. */
export { STOCK_PUSH_FILE, STOCK_PUSHABLE_FILE } from "scripts/config.js";

/** The resident trader, started by boot like sing - it parks without TIX. */
export const STOCKS_SERVICE = "/scripts/stocks/stocks.js";

/** Sells every position; sing's SWEEP runs it before an install. */
export const STOCKS_SELL_ALL = "/scripts/stocks/sellall.js";

/** One line per position, rewritten every tick, plus a total. `cat /data/stocks.txt` */
export const STATUS_FILE = "/data/stocks.txt";

/** Every trade and purchase, timestamped. Last HISTORY_KEEP lines kept. */
export const HISTORY_FILE = "/data/stocks.log.txt";
export const HISTORY_KEEP = 500;

/**
 * What selling every open position would pay, net of commission, written
 * every tick by stocks.js; 0 means nothing is held. sing reads it (ns.read,
 * 0 GB) twice: the aug batch plans against cash PLUS this, and SWEEP holds an
 * install while it is above 0 - Prestige resets the market and every position
 * with it. sellall.js writes the number of positions the game refused to
 * sell, so after a sell-all it is a count, and "above 0" still means "held".
 */
export const HELD_FILE = "/data/stocks-held.txt";

/**
 * Date.now() of the last sell-all. stocks.js opens nothing for HOLD_MS after
 * it, so the seconds between the sell-all and the install cannot rebuy. An
 * install that does not happen costs this long out of the market, once.
 */
export const HOLD_FILE = "/data/stocks-hold.txt";
export const HOLD_MS = 5 * 60 * 1000;

/** Default fraction of net worth (cash + positions) the trader may hold. */
export const STOCKS_CASH = 0.5;

/**
 * Buy 4S Market Data + its TIX API once net worth reaches this many times
 * their price. Positions are not sold for it: new buys stop until cash covers
 * it, and positions close on their own signals.
 */
export const FS_WORTH_MULT = 2;

/**
 * Buy the TIX API ($5b) once cash is this many times its price - outside BN8
 * before SF8.1, where the trader otherwise parks. 4x leaves $15b to trade
 * with, so the access fee is not most of the stake.
 */
export const TIX_CASH_MULT = 4;

/** Open a long above this forecast, a short below 1 - BUY_EDGE. */
export const BUY_EDGE = 0.55;
/**
 * Close a long once the forecast falls below this, a short once it rises above
 * 1 - SELL_EDGE. Exactly 0.5 is the break-even of an up/down coin.
 */
export const SELL_EDGE = 0.5;

/**
 * Before 4S the forecast is ESTIMATED from up-tick counts. LONG_WIN sets the
 * estimate; SHORT_WIN watches for the 75-tick flip, which LONG_WIN would take
 * half a window to notice. Pre-4S edges are wider: the estimate's standard
 * error over 40 coin flips is ~0.08.
 */
export const LONG_WIN = 40;
export const SHORT_WIN = 10;
export const PRE_BUY_EDGE = 0.62;
/** A position is closed when the short window reads this far the wrong way. */
export const PRE_FLIP_EDGE = 0.35;

/**
 * Smallest position worth opening. Two commissions are $200k, so a $20m
 * position spends 1% of itself on fees.
 */
export const MIN_TRADE = 20e6;

/**
 * Default rank multiplier on a stock whose company server the batcher can push
 * (STOCK_PUSHABLE_FILE). A flagged grow lifts the stock's second-order forecast
 * by 0.1 with probability moneyGrown / moneyMax (PlayerInfluencing.ts), and the
 * forecast drifts toward it every tick - fastest near neutral, where Stock.ts
 * steps otlkMag by 10x or a flat 1. Ranking only: the buy edge still applies.
 * 1 turns it off, and is the default: outside BN8 the manager picks targets by
 * income, not by what is held, so most "pushable" stocks never get pushed and
 * the bonus would trade edge for nothing. In BN8 the manager follows the
 * positions - `run scripts/set.js stocks.pushBonus 2` there.
 */
export const PUSH_BONUS = 1;
