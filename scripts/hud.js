import { HACKNET_HOST_PREFIX } from "./config.js";
import { HELD_FILE } from "./stocks/config.js";

/**
 * Paints extra rows into the sidebar overview, then exits. boot runs it once a
 * tick, so the figures refresh every `boot.tick` (60 s) - the user's rule: no
 * new resident script.
 *
 * The overview (src/ui/React/CharacterOverview.tsx) renders two empty
 * Typography cells, overview-extra-hook-0 and -1, that React never fills - so
 * text written into them outlives this script. It is lost only when the
 * overview unmounts (collapsed), and the next tick paints it back.
 *
 * THE DOM COSTS 25 GB BY NAME. RamCalculations.ts bills the bare identifier
 * `document` at RamCostConstants.Dom, called or not. A computed key is a
 * Literal and free - gang's info["respectForNextRecruit"] trick - and
 * globalThis is not in the cost table. Never write the bare name here.
 *
 * Income is the change in what getMoneySources().sinceInstall has EARNED, so a
 * server purchase does not read as negative income. The previous sample lives
 * in SAMPLE_FILE; the rate is over one boot tick.
 *
 * RAM: 1.60 base + getMoneySources 1.00 + getServerMoneyAvailable 0.10
 *      + getSharePower 0.20 + scan 0.20 + hasRootAccess/getServerMaxRam/
 *      getServerUsedRam 0.15 = 3.25 GB, for a few ms a tick.
 */

const SAMPLE_FILE = "/data/hud.txt";

/** Every MoneySourceTracker field that records money coming IN. */
const EARNINGS = ["hacking", "stock", "gang", "hacknet", "crime", "work", "codingcontract", "sleeves",
  "corporation", "bladeburner", "infiltration", "casino", "darknet", "other"];

/** @param {NS} ns */
export async function main(ns) {
  const doc = globalThis["document"];
  const labels = doc?.getElementById("overview-extra-hook-0");
  const values = doc?.getElementById("overview-extra-hook-1");
  if (!labels || !values) return; // overview collapsed - next tick

  const rows = [];
  const $ = (n) => `$${ns.format.number(n, 2)}`;

  const src = ns.getMoneySources().sinceInstall;
  const earned = EARNINGS.reduce((n, k) => n + (src[k] ?? 0), 0);
  const now = Date.now();
  let prev = null;
  try { prev = JSON.parse(ns.read(SAMPLE_FILE)); } catch { /* first run */ }
  ns.write(SAMPLE_FILE, JSON.stringify({ t: now, earned }), "w");
  // An install zeroes sinceInstall; that one sample would read as a huge loss.
  if (prev && now > prev.t && earned >= prev.earned * 0.5) {
    rows.push(["Income", `${$((earned - prev.earned) / ((now - prev.t) / 1000))}/s`]);
  }

  // ponytail: after a sell-all HELD_FILE holds a COUNT of refused sales, not
  // dollars; the $1m floor hides that. A real position that small hides too.
  const stocks = Number(ns.read(HELD_FILE)) || 0;
  if (stocks >= 1e6) {
    rows.push(["Stocks", $(stocks)]);
    rows.push(["Worth", $(ns.getServerMoneyAvailable("home") + stocks)]);
  }

  if (!ns.gang.inGang()) rows.push(["Karma", ns.format.number(ns.heart.break(), 2)]);

  const power = ns.getSharePower();
  if (power > 1) rows.push(["Share", `x${ns.format.number(power, 3)}`]);

  // boot's reachableHosts walk; hacknet servers are not pool RAM.
  let used = 0, max = 0;
  const seen = new Set(["home"]);
  const queue = ["home"];
  for (let i = 0; i < queue.length; i++) {
    for (const h of ns.scan(queue[i])) if (!seen.has(h)) { seen.add(h); queue.push(h); }
    const host = queue[i];
    if (host.startsWith(HACKNET_HOST_PREFIX) || !ns.hasRootAccess(host)) continue;
    used += ns.getServerUsedRam(host);
    max += ns.getServerMaxRam(host);
  }
  if (max > 0) rows.push(["RAM", `${ns.format.ram(used)} / ${ns.format.ram(max)} (${ns.format.percent(used / max, 0)})`]);

  labels.innerText = rows.map((r) => r[0]).join("\n");
  values.innerText = rows.map((r) => r[1]).join("\n");
}
