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

  // ── 1. Register newly discovered contracts as .txt markers ────────────────
  // ns.scp() cannot transfer .cct files, so we create a .txt marker on home
  // instead. The solve API still operates on the original server location.
  for (const host of visited) {
    for (const filename of ns.ls(host, ".cct")) {
      const pendingPath = `contracts/pending/${host}@${filename}.txt`;
      const solvedPath  = `contracts/solved/${host}@${filename}.txt`;
      if (ns.fileExists(solvedPath,  "home")) continue; // already solved
      if (ns.fileExists(pendingPath, "home")) continue; // already registered
      ns.write(pendingPath, "", "w");
    }
  }

  // ── 2. Attempt to solve all pending contracts ─────────────────────────────
  for (const pendingPath of ns.ls("home", "contracts/pending/")) {
    // Parse host and filename from "contracts/pending/I.I.I.I@contract-001.cct.txt"
    const base     = pendingPath.replace("contracts/pending/", "").replace(/\.txt$/, "");
    const at       = base.indexOf("@");
    const host     = base.slice(0, at);
    const filename = base.slice(at + 1);

    if (!ns.fileExists(filename, host)) {
      ns.rm(pendingPath, "home"); // contract expired — clean up marker
      continue;
    }

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
      ns.rm(pendingPath, "home");
      ns.write(`contracts/solved/${host}@${filename}.txt`, reward, "w");
      ns.tprint(`CONTRACTS: Solved '${type}' on ${host} — ${reward}`);
    } else {
      const remaining = ns.codingcontract.getNumTriesRemaining(filename, host);
      ns.tprint(`CONTRACTS: Failed '${type}' on ${host}/${filename} — ${remaining} tries remaining`);
    }
  }
}
