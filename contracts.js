import { SOLVERS } from "/solvers.js";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  // Remove legacy pending markers from old file-based approach
  for (const p of ns.ls("home", "contracts/pending/")) ns.rm(p, "home");

  // BFS scan
  const visited = new Set(["home"]);
  const queue   = ["home"];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const nb of ns.scan(cur)) {
      if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
    }
  }

  // Cache all .cct files per host (avoids repeated ns.ls calls)
  const contractsByHost = new Map();
  for (const host of visited) {
    const files = ns.ls(host, ".cct").filter(f => f.endsWith(".cct"));
    if (files.length) contractsByHost.set(host, files);
  }

  // Purge skip markers for contracts that no longer exist on their server
  for (const path of ns.ls("home", "contracts/failed/")) {
    const m = path.match(/([^/@]+)@(.+)\.txt$/);
    if (!m || !(contractsByHost.get(m[1]) ?? []).includes(m[2])) {
      ns.rm(path, "home");
    }
  }

  // Attempt all live contracts
  for (const [host, files] of contractsByHost) {
    for (const filename of files) {
      const skipPath = `contracts/failed/${host}@${filename}.txt`;
      if (ns.fileExists(skipPath, "home")) continue;

      const triesLeft = ns.codingcontract.getNumTriesRemaining(filename, host);
      if (triesLeft < 5) {
        ns.tprint(`CONTRACTS: Skipping — only ${triesLeft} tries left: ${host}/${filename}`);
        continue;
      }

      const type   = ns.codingcontract.getContractType(filename, host);
      const solver = SOLVERS[type];
      if (!solver) {
        ns.write(skipPath, `unknown:${type}`, "w");
        ns.tprint(`CONTRACTS: Unknown type '${type}' at ${host}/${filename} — ${triesLeft} tries remaining`);
        continue;
      }

      const data   = ns.codingcontract.getData(filename, host);
      const answer = solver(data);
      const reward = ns.codingcontract.attempt(answer, filename, host);

      if (reward) {
        ns.write(`contracts/solved/${host}@${filename}.txt`, reward, "w");
        ns.tprint(`CONTRACTS: Solved '${type}' on ${host} — ${reward}`);
      } else {
        const remaining = ns.codingcontract.getNumTriesRemaining(filename, host);
        ns.write(skipPath, type, "w");
        ns.tprint(`CONTRACTS: Failed '${type}' on ${host}/${filename} — ${remaining} tries remaining`);
      }
    }
  }
}
