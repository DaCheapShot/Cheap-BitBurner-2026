/**
 * One-shot probe: are cloud (purchased) servers reachable via ns.scan?
 *
 * This fork moved purchased servers to the ns.cloud namespace. In vanilla,
 * purchased servers are wired into home's network list so a plain BFS scan
 * finds them - but the docs mirror is docs-only, so that can't be confirmed
 * from source. This answers it empirically.
 *
 * Kept in its own file on purpose: ns.cloud.getServerNames costs 1.05 GB and
 * scripts/capacity.js should not carry that permanently.
 *
 * RAM: 1.60 base + 0.20 scan + 1.05 cloud.getServerNames
 *      + 0.05 getServerMaxRam + 0.05 hasRootAccess = 2.95 GB
 *
 * Result:
 *   "all cloud servers found by scan"  -> ServerPool.build needs no change
 *   "MISSING from scan: ..."           -> pass them via build(ns, {extraHosts})
 *                                         and eat the 1.05 GB in the manager
 */

/** @param {NS} ns */
export async function main(ns) {
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

  // Signature (verified): getServerNames(returnOpts?: HostReturnOptions): string[]
  // Returns hostnames by default.
  let cloud = [];
  try {
    cloud = ns.cloud.getServerNames();
  } catch (e) {
    ns.tprint(`ERROR: ns.cloud.getServerNames() threw: ${e}`);
    return;
  }

  const out = [];
  out.push("");
  out.push(`scan reached ${seen.size} hosts`);
  out.push(`ns.cloud.getServerNames() reported ${cloud.length} cloud servers`);

  if (cloud.length === 0) {
    out.push("No cloud servers owned yet - probe is inconclusive. Re-run after buying one.");
    ns.tprint(out.join("\n"));
    return;
  }

  const missing = cloud.filter((h) => !seen.has(h));
  out.push("");
  for (const h of cloud) {
    out.push(
      `  ${h.padEnd(24)} ${seen.has(h) ? "in scan" : "MISSING from scan"}  ` +
        `${ns.getServerMaxRam(h)}GB  root=${ns.hasRootAccess(h)}`,
    );
  }

  out.push("");
  if (missing.length === 0) {
    out.push("RESULT: all cloud servers are reachable by scan. ServerPool.build needs no change.");
  } else {
    out.push(`RESULT: ${missing.length} cloud server(s) NOT on home's network.`);
    out.push(`  Pass them in: ServerPool.build(ns, { extraHosts: ns.cloud.getServerNames() })`);
    out.push(`  Costs the manager a permanent 1.05 GB.`);
  }

  ns.tprint(out.join("\n"));
}
