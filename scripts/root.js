/**
 * Open every port and NUKE every server we can reach.
 *
 * Rooting is what puts a server's RAM into the batcher's pool and makes it a
 * legal hack target, so this is the cheapest way to grow the operation - run it
 * again every time you buy a new port opener.
 *
 * NUKE does NOT care about hacking level. The docs are explicit: "the server's
 * required hacking level is not a requirement of nuking. You can nuke a server
 * as long as you open enough ports, regardless of your hacking level." So this
 * roots everything the crackers allow immediately, and a server you cannot yet
 * hack still contributes its RAM.
 *
 * DELIBERATELY DOES NOT CHECK ANYTHING FIRST. It fires all five crackers and
 * then NUKE at every unrooted host, and lets the failures fall on the floor.
 * Checking would cost fileExists (0.10) + getServerNumPortsRequired (0.10) per
 * the docs, to learn something the attempt itself tells us for free. Each call
 * is wrapped because a cracker you do not own THROWS rather than returning
 * false, and one missing program would otherwise kill the whole pass.
 *
 * Idempotent: rooted hosts are skipped, and re-running a cracker on an already
 * open port is harmless. Safe to run on a timer.
 *
 * Usage:  run scripts/root.js
 *         run scripts/root.js --quiet          (only report changes)
 *         run scripts/root.js --loop 60000     (re-check every minute)
 *
 * On a successful pass it stamps ROOT_MARKER so a supervisor can tell that the
 * network changed without re-scanning it - see scripts/boot.js, which uses it
 * to decide whether deploy.js needs to run.
 *
 * RAM: 1.60 base + scan 0.20 + hasRootAccess 0.05 + nuke 0.05
 *      + 5 crackers x 0.05 = 2.15 GB   (ns.write is 0 GB, config.js is 0 GB)
 */
import { ROOT_MARKER } from "./config.js";

/** Every hostname reachable from home. */
function scanAll(ns) {
  const seen = new Set(["home"]);
  const queue = ["home"];
  for (let i = 0; i < queue.length; i++) {
    for (const host of ns.scan(queue[i])) {
      if (!seen.has(host)) {
        seen.add(host);
        queue.push(host);
      }
    }
  }
  return [...seen];
}

/**
 * Try to root one host. Every call is individually guarded: a cracker you do
 * not own throws, and so does NUKE when too few ports are open, but neither is
 * an error condition here - it just means this host is not available yet.
 */
function tryRoot(ns, host) {
  try { ns.brutessh(host); } catch { /* not owned */ }
  try { ns.ftpcrack(host); } catch { /* not owned */ }
  try { ns.relaysmtp(host); } catch { /* not owned */ }
  try { ns.httpworm(host); } catch { /* not owned */ }
  try { ns.sqlinject(host); } catch { /* not owned */ }
  try { return ns.nuke(host); } catch { return false; }
}

/** One pass over the network. */
function rootPass(ns) {
  const rooted = [];
  let already = 0;
  let locked = 0;

  for (const host of scanAll(ns)) {
    if (host === "home") continue;
    if (ns.hasRootAccess(host)) {
      already++;
      continue;
    }
    if (tryRoot(ns, host)) rooted.push(host);
    else locked++;
  }

  return { rooted, already, locked };
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const args = ns.args.map(String);
  const quiet = args.includes("--quiet");
  const lIdx = args.indexOf("--loop");
  const loopMs = lIdx >= 0 ? Math.max(1000, Number(args[lIdx + 1]) || 60000) : 0;

  do {
    const r = rootPass(ns);

    if (r.rooted.length) {
      // Stamp before printing: a supervisor polling this file should never see
      // the message without the marker.
      ns.write(ROOT_MARKER, `${Date.now()}\n${r.rooted.join(",")}`, "w");
      ns.tprint(
        `ROOTED ${r.rooted.length} new server(s): ${r.rooted.join(", ")}\n` +
          `Run scripts/deploy.js to put workers on them.`,
      );
    } else if (!quiet) {
      ns.tprint(
        `root: nothing new. ${r.already} already rooted, ` +
          `${r.locked} still need more port openers.`,
      );
    }

    if (loopMs) await ns.sleep(loopMs);
  } while (loopMs);
}
