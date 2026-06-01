import { SOLVERS } from "/solvers.js";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  // BFS scan — same pattern as root.js, finds every server including home
  const visited = new Set(["home"]);
  const queue   = ["home"];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const nb of ns.scan(cur)) {
      if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
    }
  }

  // ── 1. Copy newly discovered contracts to contracts/pending/ ──────────────
  for (const host of visited) {
    for (const filename of ns.ls(host, ".cct")) {
      const pendingPath = `contracts/pending/${host}.${filename}`;
      const solvedPath  = `contracts/solved/${host}.${filename}`;
      if (ns.fileExists(solvedPath,  "home")) continue; // already solved
      if (ns.fileExists(pendingPath, "home")) continue; // already filed
      // Copy to home root, then move into pending subfolder
      ns.scp(filename, "home", host);
      ns.mv(filename, pendingPath);
    }
  }

  // ── 2. Attempt to solve all pending contracts ─────────────────────────────
  for (const pendingPath of ns.ls("home", "contracts/pending/")) {
    // Parse host and filename: "contracts/pending/n00dles.contract-001.cct"
    const base    = pendingPath.replace("contracts/pending/", "");
    const dot     = base.indexOf(".");
    const host    = base.slice(0, dot);
    const filename = base.slice(dot + 1);

    if (!ns.fileExists(filename, host)) continue; // contract expired on source server

    const triesLeft = ns.codingcontract.getNumTriesRemaining(filename, host);
    if (triesLeft < 5) {
      ns.tprint(`CONTRACTS: Skipping — only ${triesLeft} tries left: ${host}/${filename}`);
      continue;
    }

    const type   = ns.codingcontract.getContractType(filename, host);
    const solver = SOLVERS[type];

    if (!solver) {
      ns.tprint(`CONTRACTS: Unknown type '${type}' at ${host}/${filename} — ${triesLeft} tries remaining`);
      continue;
    }

    const data   = ns.codingcontract.getData(filename, host);
    const answer = solver(data);
    const reward = ns.codingcontract.attempt(answer, filename, host);

    if (reward) {
      ns.mv(pendingPath, `contracts/solved/${host}.${filename}`);
      ns.tprint(`CONTRACTS: Solved '${type}' on ${host} — ${reward}`);
    } else {
      const remaining = ns.codingcontract.getNumTriesRemaining(filename, host);
      ns.tprint(`CONTRACTS: Failed '${type}' on ${host}/${filename} — ${remaining} tries remaining`);
    }
  }
}
