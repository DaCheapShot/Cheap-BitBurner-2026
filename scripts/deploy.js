import { WORKER_LIST } from "./config.js";

/**
 * Copy the three worker scripts to every rooted host with RAM.
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

/** @param {NS} ns */
export async function main(ns) {
  const stale = [];
  for (const file of WORKER_LIST) {
    const src = ns.read(file);
    if (!src) stale.push(`${file} (not on home at all)`);
    else if (!src.includes(REQUIRED_IN_WORKER)) stale.push(`${file} (no result reporting)`);
  }
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
    if (ns.scp(WORKER_LIST, host, "home")) copied.push(host);
    else failed.push(host);
  }

  const out = [
    "",
    `workers: ${WORKER_LIST.join("  ")}`,
    `copied to ${copied.length} host(s): ${copied.join(", ") || "(none)"}`,
    `skipped ${skipped} (no root or no RAM), scanned ${seen.size}`,
  ];
  if (failed.length) out.push(`FAILED on ${failed.length}: ${failed.join(", ")}`);
  ns.tprint(out.join("\n"));
}
