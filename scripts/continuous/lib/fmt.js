/**
 * Money formatting, shared by everything that prints a figure.
 *
 * The suffix list and the scaling rule are the GAME's, taken verbatim from
 * src/ui/formatNumber.ts, so a number in the script log reads the same as the
 * one the UI shows beside it. Three separate copies of this had the list
 * stopping at "t" or earlier, which is why a live report read "$2219301.35b"
 * for what the game itself calls $2.22q - the suffix ran out and the mantissa
 * grew without bound instead.
 *
 * No ns calls at all, so this is free to import anywhere. Keep it that way.
 */

/** Powers of 1000. Verbatim from src/ui/formatNumber.ts. */
const SUFFIX = ["", "k", "m", "b", "t", "q", "Q", "s", "S", "o", "n"];

/**
 * `$1.94b`, `$309.73t`, `$2.22q`.
 *
 * @param {number} n
 * @param {number} digits fractional digits, 2 unless a caller needs it tighter
 */
export function fmtMoney(n, digits = 2) {
  // A rate can be Infinity or NaN before the first batch lands, and "$NaNm/s"
  // in a report is worse than an obvious dash.
  if (!Number.isFinite(n)) return "$-";
  const abs = Math.abs(n);
  if (abs < 1000) return `$${n.toFixed(digits)}`;
  // The game's own index. Clamped because the list ends at 10^30 and a number
  // past it must still print something rather than "undefined".
  const i = Math.min(Math.floor(Math.log10(abs) / 3), SUFFIX.length - 1);
  return `$${(n / 1000 ** i).toFixed(digits)}${SUFFIX[i]}`;
}
