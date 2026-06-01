/** @param {NS} ns */
export async function main(ns) {
  const target = ns.args[0];
  if (!target) { ns.tprint("Usage: run connect.js <target>"); return; }

  // BFS from home with parent tracking
  const parent = new Map([["home", null]]);
  const queue  = ["home"];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === target) break;
    for (const neighbor of ns.scan(cur)) {
      if (!parent.has(neighbor)) {
        parent.set(neighbor, cur);
        queue.push(neighbor);
      }
    }
  }

  if (!parent.has(target)) {
    ns.tprint(`ERROR: ${target} not found on network`);
    return;
  }

  // Reconstruct path from target back to home
  const path = [];
  for (let node = target; node !== "home"; node = parent.get(node)) {
    path.unshift(node);
  }

  ns.tprint(path.map(h => `connect ${h}`).join("; "));
}
