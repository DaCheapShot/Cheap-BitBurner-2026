/** @param {NS} ns */
export async function main(ns) {
  // RAM: 1.60GB base + 0.20GB (ns.scan) = 1.80GB
  // Everything else used here (tprint, write, args, sprintf) costs 0GB.
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

  // seen.delete("home");
  const servers = [...seen];

  if (ns.args[0] === "--file") {
    ns.write("/data/servers.txt", servers.join("\n"), "w");
    ns.tprint(`INFO: ${servers.length} servers -> /data/servers.txt`);
  } else {
    ns.tprint(`\n${servers.join("\n")}\n${servers.length} servers found`);
  }
}
