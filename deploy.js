/**
 * deploy.js — copy worker scripts from home to a target execution host, then exit.
 * RAM: 1.60 GB base + 0.60 GB (ns.scp) = 2.20 GB, freed immediately on exit.
 *
 * Keeping scp here (not in manager.js) saves 0.60 GB from manager's permanent reservation.
 * Manager launches this once per newly discovered host.
 *
 * Args:
 *   ns.args[0] {string} host — destination hostname (required)
 */
/** @param {NS} ns */
export async function main(ns) {
  const host = /** @type {string} */ (ns.args[0]);
  if (!host) {
    ns.tprint("ERROR deploy.js: hostname argument required");
    return;
  }
  const workers = ["hack.js", "grow.js", "weaken.js"];
  const ok = ns.scp(workers, host, "home");
  ns.print(ok
    ? `deploy.js: workers deployed to ${host}`
    : `deploy.js: ERROR — scp to ${host} failed`
  );
}
