import { SHARE_WORKER, WORKER_LIST } from "scripts/continuous/config";

/**
 * Worker distribution for the continuous batcher.
 *
 *   ns.scp   0.60 GB
 *
 * and nothing else. In particular NOT ns.fileExists, which the shotgun's
 * deploy needs and this one does not - see "why it always copies" below.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all
 *
 * scripts/deploy.js broadcasts only DEPLOY_LIST from scripts/config.js, and
 * this system may not edit that file. So it copies its own workers, or exec
 * returns a bare 0 on every host but home - the same value exec returns when
 * the script is absent, which is why that failure cost the shotgun two live
 * runs to diagnose.
 *
 * ---------------------------------------------------------------------------
 * Why it always copies instead of checking first
 *
 * The obvious version asks fileExists and copies only what is missing. That is
 * cheaper by 0.10 GB and wrong in the way that costs a debugging session: after
 * a worker is EDITED, every host still has the old copy and fileExists happily
 * says yes. The shotgun needs a whole DEPLOY_MANIFEST to detect that. An
 * unconditional scp of three tiny files makes the question moot.
 *
 * ---------------------------------------------------------------------------
 * Why scp's return value is worth reading
 *
 * From the fork's NetscriptFunctions.ts, scp does NOT throw when a source file
 * is missing - it logs and sets noFailures = false. So:
 *
 *   scp false                  the worker is not on home. The filesync
 *                              extension did not push it. Nothing else will
 *                              work until that is fixed.
 *   scp true, later exec 0     the host has the file and refused the launch -
 *                              a RAM or permissions problem, not a deploy one.
 *
 * Keeping those two apart is the whole point. The shotgun merged them twice and
 * both times the log named the wrong cause, which got acted on.
 */

/**
 * Everything a host needs before this manager can exec on it.
 *
 * scripts/share.js rides along, and it is not this system's file. It belongs to
 * scripts/deploy.js, which broadcasts on a trigger this system cannot fire:
 * deploy runs when root.js roots something NEW, and buying a server roots
 * nothing - purchased servers arrive rooted. So a host bought by cloud.js while
 * the batcher runs is admitted by ServerPool.sync, gets the three batch
 * workers, and would be permanently unable to take its share quota. lib/share.js
 * would report it under `noFile` for ever, honestly and uselessly.
 *
 * A path string, not an import: importing share.js would cost 2.40 GB for
 * ns.share, which this file never calls.
 */
const DEPLOY_FILES = [...WORKER_LIST, SHARE_WORKER];

/**
 * Copy every worker to every host given, home excluded.
 *
 * @param {NS} ns
 * @param {string[]} hosts
 * @returns {{copied: number, failed: string[], skipped: number}}
 *   `failed` lists hosts scp refused. If it holds EVERY host, suspect the
 *   source files on home rather than the hosts.
 */
export function deployWorkers(ns, hosts) {
  const failed = [];
  let copied = 0;
  let skipped = 0;

  for (const host of hosts) {
    // home is where the files come from; scp'ing a server to itself is a no-op
    // that reports failure and would poison the diagnostic above.
    if (host === "home") {
      skipped++;
      continue;
    }
    if (ns.scp(DEPLOY_FILES, host, "home")) copied++;
    else failed.push(host);
  }

  return { copied, failed, skipped };
}

/**
 * One line describing a deploy result, or null when there is nothing to say.
 *
 * Split out so the manager and the harness report a failure identically - a
 * diagnostic that names the wrong cause is worse than no diagnostic, so there
 * should only be one copy of the wording.
 */
export function describeDeploy(result, totalHosts) {
  if (result.failed.length === 0) return null;

  const allFailed = result.copied === 0 && result.failed.length > 0;
  const head =
    `scp refused on ${result.failed.length}/${totalHosts - result.skipped} host(s): ` +
    result.failed.slice(0, 5).join(", ") +
    (result.failed.length > 5 ? `, +${result.failed.length - 5} more` : "");

  if (allFailed) {
    return (
      `${head}\n` +
      `  EVERY host failed, so the problem is almost certainly the SOURCE, not the hosts: ` +
      `the workers are missing from home. Check the filesync extension pushed ` +
      `scripts/continuous/ - it fails silently, and pushAllOnConnection only backfills ` +
      `on connect.`
    );
  }
  return `${head}\n  (some hosts copied fine, so this is per-host - no root access, most likely)`;
}
