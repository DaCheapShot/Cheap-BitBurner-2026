import {
  BUY_EDGE, SELL_EDGE, LONG_WIN, SHORT_WIN, PRE_BUY_EDGE, PRE_FLIP_EDGE, MIN_TRADE,
} from "./config.js";

/**
 * Every trading decision, pure - 0 GB, like gang/math.js and sleeve/plan.js.
 *
 * NAMES ARE BILLED. Every ns.stock function is 2.00-2.50 GB as a bare
 * identifier anywhere in an importer's closure, so nothing here is called
 * getPrice, getPosition, getForecast, buyStock, sellShort and the like - `ask`,
 * `bid`, `long`, `short`, `fc` and `vol` are free. tests/ram.test.mjs pins this
 * file at the base.
 */

/** The game's commission, per transaction (StockMarketConstants). */
export const COMMISSION = 100e3;

/**
 * One stock's record across ticks. `moves` holds the signed relative change of
 * each tick, newest last, at most LONG_WIN long - enough for both windows.
 */
export function track(prev, price) {
  const moves = prev ? [...prev.moves] : [];
  if (prev && prev.price > 0 && price !== prev.price) {
    moves.push(price / prev.price - 1);
    if (moves.length > LONG_WIN) moves.shift();
  }
  return { price, moves };
}

/**
 * The share of up-ticks in the last `n` moves, or null with fewer than `n`.
 * A tick's direction is a coin with p = forecast (StockMarket.ts
 * processStockPrices), so this is the forecast's estimate.
 */
export function upShare(moves, n) {
  if (moves.length < n) return null;
  const last = moves.slice(-n);
  return last.filter((m) => m > 0).length / n;
}

/** Mean size of a move - the expected |change| per tick. */
export function meanMove(moves) {
  return moves.length ? moves.reduce((s, m) => s + Math.abs(m), 0) / moves.length : 0;
}

/**
 * What the trader believes about one stock: forecast `fc`, the short-window
 * read `recent` (pre-4S only) and `er`, expected relative gain per tick of
 * holding it in the direction the forecast points.
 *
 * With 4S, getVolatility is mv/100 - the MAXIMUM move; the move is
 * U(0,1) * that, so its mean is half. Without it the mean is measured.
 */
export function signal(s, fs) {
  if (fs) {
    return { fc: s.fc, recent: null, er: Math.abs(2 * s.fc - 1) * (s.vol / 2) };
  }
  const fc = upShare(s.moves, LONG_WIN);
  if (fc === null) return { fc: null, recent: null, er: 0 };
  return { fc, recent: upShare(s.moves, SHORT_WIN), er: Math.abs(2 * fc - 1) * meanMove(s.moves) };
}

/**
 * Should a held position close? A long while the forecast falls under
 * SELL_EDGE; a short while it rises over 1 - SELL_EDGE. Before 4S, also when
 * the short window reads the flip: the 75-tick cycle flips 45% of stocks at
 * once, and the long window would hold a turned stock for ~20 ticks.
 * No signal yet (fresh restart, pre-4S) keeps the position.
 */
export function shouldClose(kind, sig) {
  if (sig.fc === null) return false;
  const up = kind === "long";
  const fc = up ? sig.fc : 1 - sig.fc;
  if (fc < SELL_EDGE) return true;
  if (sig.recent === null) return false;
  return (up ? sig.recent : 1 - sig.recent) <= PRE_FLIP_EDGE;
}

/** What closing a position would pay: getSellTransactionGain, commission aside. */
export function positionValue(s) {
  return s.long * s.bid + s.short * (2 * s.shortAvg - s.ask);
}

/**
 * The syms whose company the manager can push, off STOCK_PUSHABLE_FILE (an
 * array of org names). Missing or broken is none - the inert failure.
 */
export function pushableSyms(text, init) {
  let orgs;
  try {
    orgs = new Set(JSON.parse(String(text ?? "").trim() || "[]"));
  } catch {
    return new Set();
  }
  return new Set(init.filter((i) => orgs.has(i.org)).map((i) => i.sym));
}

/**
 * The tick's orders.
 *
 *   stocks:   [{ sym, ask, bid, long, longAvg, short, shortAvg, max, fc, vol, moves }]
 *   cash:     money on hand
 *   cap:      the most the trader may have in positions (stocks.cash x net worth)
 *   reserve:  cash to leave untouched (saving for 4S)
 *   fs:       4S forecasts are in hand
 *   canShort: BitNode 8 or SF8.2
 *   hold:     a sell-all is in force - close nothing, open nothing
 *   pushable: syms whose company server the batcher can push
 *   pushBonus: rank multiplier on those - ranking only, the edge still applies
 *
 * Sells first and their proceeds are spent the same tick. Opens go to the best
 * expected gain first, each one as big as max shares and the budget allow,
 * never under MIN_TRADE. A position is never held both ways - the game allows
 * it and it is two commissions for nothing.
 *
 * ponytail: no rotation. A strong signal does not evict a weaker held one;
 * the weaker one closes on its own signal and frees the money.
 */
export function planTrades({
  stocks, cash, cap, reserve = 0, fs, canShort, hold = false, pushable = new Set(), pushBonus = 1,
}) {
  const sells = [];
  const buys = [];
  if (hold) return { sells, buys };

  let held = 0;
  let free = cash;
  const sig = new Map(stocks.map((s) => [s.sym, signal(s, fs)]));
  for (const s of stocks) {
    const g = sig.get(s.sym);
    if (s.long > 0 && shouldClose("long", g)) {
      sells.push({ sym: s.sym, kind: "long", shares: s.long });
      free += s.long * s.bid - COMMISSION;
    } else if (s.short > 0 && shouldClose("short", g)) {
      sells.push({ sym: s.sym, kind: "short", shares: s.short });
      free += s.short * (2 * s.shortAvg - s.ask) - COMMISSION;
    } else {
      held += positionValue(s);
    }
  }

  const closing = new Set(sells.map((o) => o.sym));
  const edge = fs ? BUY_EDGE : PRE_BUY_EDGE;
  let budget = Math.min(free - reserve, cap - held);
  const wants = stocks
    .filter((s) => !closing.has(s.sym) && sig.get(s.sym).fc !== null)
    .map((s) => {
      const { fc, er, recent } = sig.get(s.sym);
      const kind = fc >= edge ? "long" : canShort && fc <= 1 - edge ? "short" : null;
      // Before 4S, the short window has to agree too: a stock that just flipped
      // still reads strong on the long window for half of it.
      const agrees = recent === null || (kind === "long" ? recent > 0.5 : recent < 0.5);
      return { s, kind, er: er * (pushable.has(s.sym) ? pushBonus : 1), agrees };
    })
    .filter((w) => w.kind && w.agrees)
    // Never both ways: a long is not opened beside a short, nor the reverse.
    .filter((w) => (w.kind === "long" ? w.s.short === 0 : w.s.long === 0))
    .sort((a, b) => b.er - a.er);

  for (const { s, kind } of wants) {
    if (budget < MIN_TRADE) break;
    const px = kind === "long" ? s.ask : s.bid;
    const room = s.max - s.long - s.short;
    const shares = Math.min(room, Math.floor((budget - COMMISSION) / px));
    if (shares * px < MIN_TRADE) continue;
    buys.push({ sym: s.sym, kind, shares });
    budget -= shares * px + COMMISSION;
  }
  return { sells, buys };
}
