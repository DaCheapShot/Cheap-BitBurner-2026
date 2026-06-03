const FACTION_SERVERS = ["CSEC", "avmnite-02h", "I.I.I.I", "run4theh111z", "w0r1d_d43m0n"];

function bfsParents(ns) {
  const parent = new Map([["home", null]]);
  const queue  = ["home"];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const neighbor of ns.scan(cur)) {
      if (!parent.has(neighbor)) {
        parent.set(neighbor, cur);
        queue.push(neighbor);
      }
    }
  }
  return parent;
}

function connectString(parent, target) {
  const path = [];
  for (let node = target; node !== "home"; node = parent.get(node)) {
    path.unshift(node);
  }
  return path.map(h => `connect ${h}`).join("; ");
}

/** @param {NS} ns */
export async function main(ns) {
  const arg = ns.args[0];
  if (!arg) { ns.tprint("Usage: run connect.js <target|factions>"); return; }

  const parent = bfsParents(ns);

  if (arg === "factions") {
    for (const host of FACTION_SERVERS) {
      if (parent.has(host)) ns.tprint(`${host}: ${connectString(parent, host)}`);
    }
    return;
  }

  if (!parent.has(arg)) { ns.tprint(`ERROR: ${arg} not found on network`); return; }
  ns.tprint(connectString(parent, arg));
}
