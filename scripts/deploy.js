import { WORKER_LIST, SHARE_WORKER, DEPLOY_LIST, DEPLOY_MANIFEST } from "./config.js";

/**
 * Copy the worker scripts to every rooted host with RAM.
 *
 * Must run before any exec: exec requires the script to already exist on the
 * target server. Re-run it after editing a worker, or after rooting new hosts -
 * scp overwrites, so running it twice is harmless.
 *
 * Checks home's copies before shipping them. scp copies FROM home, so a worker
 * that never reached home gets faithfully broadcast to every host in its stale
 * form, and the only symptom is missing fields in port reports much later. The
 * weak link is disk -> home (the filesync extension pushes on save, and with
 * pushAllOnConnection false it never backfills edits made while disconnected);
 * home -> hosts is reliable once home is right.
 *
 * RAM: 1.60 base + 0.20 scan + 0.05 hasRootAccess + 0.05 getServerMaxRam
 *      + 0.60 scp = 2.50 GB   (ns.read is 0 GB, config.js is 0 GB)
 *
 * Usage: run scripts/deploy.js
 */

/**
 * Text every worker's port-write must contain. Not a version number: a version
 * would have to live in config.js, which goes stale by the same mechanism and
 * would then agree with the stale workers. This is a fixed property of a correct
 * worker, so it stays true no matter how out of date the rest of the tree is.
 */
const REQUIRED_IN_WORKER = "r: result";

/**
 * The same idea for the share worker, which reports nothing and so cannot be
 * checked the same way. Its one job is to call ns.share, and a copy on home
 * without that call is a stale file rather than a working one.
 */
const REQUIRED_IN_SHARE = "ns.share(";

/** @param {NS} ns */
export async function main(ns) {
  const stale = [];
  for (const file of WORKER_LIST) {
    const src = ns.read(file);
    if (!src) stale.push(`${file} (not on home at all)`);
    else if (!src.includes(REQUIRED_IN_WORKER)) stale.push(`${file} (no result reporting)`);
  }
  const share = ns.read(SHARE_WORKER);
  if (!share) stale.push(`${SHARE_WORKER} (not on home at all)`);
  else if (!share.includes(REQUIRED_IN_SHARE)) stale.push(`${SHARE_WORKER} (does not call ns.share)`);

  if (stale.length) {
    ns.tprint(
      `ERROR: home's copies are stale, refusing to broadcast them:\n  ${stale.join("\n  ")}\n` +
        `The game has not received your latest edits. Check the filesync extension is ` +
        `connected, re-save the file(s), and run this again.`,
    );
    return;
  }

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

  const copied = [];
  const failed = [];
  let skipped = 0;

  for (const host of seen) {
    if (host === "home") continue; // workers already live here
    if (!ns.hasRootAccess(host) || ns.getServerMaxRam(host) <= 0) {
      skipped++;
      continue;
    }
    // scp takes the whole array; it returns false if ANY file failed.
    if (ns.scp(DEPLOY_LIST, host, "home")) copied.push(host);
    else failed.push(host);
  }

  // Routine copies go to the script's own log, not the terminal. boot.js runs
  // this on every network change, and a success line per run is pure noise.
  ns.print(`workers: ${DEPLOY_LIST.join("  ")}`);
  ns.print(`copied to ${copied.length} host(s): ${copied.join(", ") || "(none)"}`);
  ns.print(`skipped ${skipped} (no root or no RAM), scanned ${seen.size}`);

  // A failed scp still goes to the terminal: it means hosts are missing workers,
  // and every exec the batcher aims at them will silently return 0.
  if (failed.length) {
    ns.tprint(`ERROR: deploy failed on ${failed.length} host(s): ${failed.join(", ")}`);
    return;
  }

  // Record WHAT was broadcast, not merely that a broadcast happened. boot.js
  // compares this against DEPLOY_LIST and re-runs deploy when a worker file has
  // been added - which nothing else notices, because deploy is triggered by
  // newly rooted hosts and adding a file roots nothing.
  //
  // Writing the file list rather than a timestamp is the whole point: if the
  // copy of THIS script running in the game is older than the one on disk, it
  // writes the older list, boot sees the mismatch persist across a deploy, and
  // says so. A timestamp would look like success every time.
  //
  // One line, no timestamp: boot compares it as a whole string, and a second
  // line would only be something to parse wrongly.
  ns.write(DEPLOY_MANIFEST, DEPLOY_LIST.join(" "), "w");
}
