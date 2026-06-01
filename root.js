/**
 * root.js — scan the network, apply port crackers, nuke accessible servers, then exit.
 *
 * RAM (~4.25 GB) is freed on exit. Keeping crackers here saves ~1.5 GB
 * from manager.js's permanent reservation.
 *
 * Crackers are detected dynamically from home — works at any game stage.
 * Manager runs this at startup and every 60s.
 */
/** @param {NS} ns */
export async function main(ns) {
  // BFS from home to discover every server on the network
  const visited = new Set(["home"]);
  const queue   = ["home"];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const neighbor of ns.scan(current)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  // Map each cracker executable to the NS function that opens its port.
  // Checked dynamically so this works whether we have 0 or 5 crackers.
  const crackers = [
    { file: "BruteSSH.exe",  fn: (h) => ns.brutessh(h)  },
    { file: "FTPCrack.exe",  fn: (h) => ns.ftpcrack(h)  },
    { file: "relaySMTP.exe", fn: (h) => ns.relaysmtp(h) },
    { file: "HTTPWorm.exe",  fn: (h) => ns.httpworm(h)  },
    { file: "SQLInject.exe", fn: (h) => ns.sqlinject(h) },
  ];

  let newlyRooted = 0;
  for (const host of visited) {
    if (host === "home") continue;
    const server = ns.getServer(host);
    if (server.hasAdminRights) continue; // already rooted

    // Apply every cracker we currently own on home
    let openedPorts = 0;
    for (const cracker of crackers) {
      if (ns.fileExists(cracker.file, "home")) {
        cracker.fn(host);
        openedPorts++;
      }
    }

    // Nuke if we opened at least as many ports as the server requires
    if (openedPorts >= server.numOpenPortsRequired) {
      ns.nuke(host);
      newlyRooted++;
      ns.print(`Rooted: ${host}`);
    }
  }
}
