import { STOCK_PUSH_FILE } from "scripts/continuous/config";

/**
 * The stock trader's wishes, as the batcher reads them.
 *
 * scripts/stocks/stocks.js writes STOCK_PUSH_FILE every market tick:
 * `{ [org]: { dir, value } }`, keyed by company name. The game ties a hack or
 * grow to a stock through the server's `organizationName`
 * (PlayerInfluencing.ts), so that is the key here too, read once per host
 * through ns.getServer - which the manager already pays for (lib/cores.js and
 * the snapshot), so this costs 0 GB.
 *
 * ns.read is 0 GB and the file is re-parsed only when its text changes.
 * Missing, empty or broken reads as "push nothing" - the inert failure.
 */
export function parsePush(text) {
  try {
    const o = JSON.parse(String(text ?? "").trim() || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

export function createPushReader(ns) {
  const orgs = new Map();
  let text = null;
  let want = {};
  const orgOf = (host) => {
    if (!orgs.has(host)) orgs.set(host, ns.getServer(host).organizationName ?? "");
    return orgs.get(host);
  };
  const entry = (host) => want[orgOf(host)];
  return {
    /** Re-read the file; true when what it asks for changed. */
    reload() {
      const t = ns.read(STOCK_PUSH_FILE);
      if (t === text) return false;
      text = t;
      want = parsePush(t);
      return true;
    },
    /** 1 push up, -1 push down, 0 leave it. */
    dirFor(host) {
      return Math.sign(Number(entry(host)?.dir) || 0);
    },
    /** The held position's value behind that push, 0 when none. */
    valueFor(host) {
      return entry(host) ? Number(entry(host).value) || 0 : 0;
    },
    /** The host's company, "" for none - one getServer per host, ever. */
    orgFor: orgOf,
    get any() { return Object.keys(want).length > 0; },
  };
}
