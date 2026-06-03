// ─── Constants ───────────────────────────────────────────────────────────────

const REFRESH_MS = 5_000;

const C = {
  reset:  "\x1b[0m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  grey:   "\x1b[90m",
};

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtMoney(n) {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}t`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}m`;
  if (n >= 1e3)  return `$${(n / 1e3).toFixed(2)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtTime(ms) {
  const s = ms / 1000;
  if (s < 60)   return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 60)   return `${Math.round(m)}m`;
  return `${Math.round(m / 60)}h`;
}

function pad(str, width, right = false) {
  str = String(str);
  if (str.length > width) str = str.slice(0, width);
  return right ? str.padStart(width) : str.padEnd(width);
}

// ─── Network ─────────────────────────────────────────────────────────────────

function scanNetwork(ns) {
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
  visited.delete("home");
  return [...visited];
}

function classifyServers(servers) {
  const targets = [], purchased = [], other = [];
  for (const s of servers) {
    if (s.hostname.startsWith("cheap-"))  purchased.push(s);
    else if (s.moneyMax > 0)              targets.push(s);
    else                                  other.push(s);
  }
  const byName = (a, b) => a.hostname.localeCompare(b.hostname);
  targets.sort(byName);
  purchased.sort(byName);
  other.sort(byName);
  return { targets, purchased, other };
}

// ─── Display ─────────────────────────────────────────────────────────────────

function printHeader(ns, servers) {
  const home = ns.getServer("home");
  let totalRam = home.maxRam;
  let freeRam  = home.maxRam - home.ramUsed;
  let rooted   = 1; // home is always rooted

  for (const s of servers) {
    if (s.hasAdminRights) {
      rooted++;
      totalRam += s.maxRam;
      freeRam  += s.maxRam - s.ramUsed;
    }
  }

  const total = servers.length + 1; // +1 for home
  const ts    = new Date().toLocaleTimeString();
  ns.print(`${C.cyan}NETWORK DASHBOARD                        [${ts} | ${REFRESH_MS / 1000}s]${C.reset}`);
  ns.print(`${C.cyan}Hosts: ${total} | Rooted: ${rooted} | Free RAM: ${freeRam.toFixed(0)} / ${totalRam.toFixed(0)} GB${C.reset}`);
  ns.print("");
}

function getPhase(server, stateMap = null) {
  if (stateMap?.has(server.hostname)) return stateMap.get(server.hostname).phase;
  if (!server.hasAdminRights || server.moneyMax <= 0) return null;
  if (server.hackDifficulty <= server.minDifficulty + 5 &&
      server.moneyAvailable >= server.moneyMax * 0.90) return "FARM";
  return "PREP";
}

function rowColor(server, phase) {
  if (!server.hasAdminRights)                                     return C.grey;
  if (phase === "FARM")                                           return C.green;
  if (server.hackDifficulty > server.minDifficulty + 10 ||
      server.moneyAvailable === 0)                               return C.red;
  return C.yellow; // PREP
}

function printTargets(ns, managerTargets) {
  if (!managerTargets || managerTargets.length === 0) {
    ns.print(`${C.yellow}▶ MANAGER TARGETS ${"─".repeat(55)}${C.reset}`);
    ns.print(`${C.grey}  manager not running${C.reset}`);
    ns.print("");
    return;
  }

  const hostW = Math.max(16, ...managerTargets.map(e => e.host.length)) + 1;
  const sep   = `  ${"─".repeat(hostW)}` +
    `┼${"─".repeat(13)}` +
    `┼${"─".repeat(10)}` +
    `┼${"─".repeat(13)}` +
    `┼${"─".repeat(11)}` +
    `┼${"─".repeat(6)}` +
    `┼${"─".repeat(6)}` +
    `┼${"─".repeat(6)}` +
    `┼${"─".repeat(6)}`;

  ns.print(`${C.yellow}▶ MANAGER TARGETS (${managerTargets.length}) ${"─".repeat(50)}${C.reset}`);
  ns.print(
    `${C.grey}  ${pad("HOST", hostW)}` +
    `| ${pad("SEC / MIN", 13)}` +
    `| ${pad("MONEY %", 8)}` +
    `| ${pad("MONEY MAX", 9)} ` +
    `| ${pad("EST $/S", 9)} ` +
    `| ${pad("WKN", 4)} ` +
    `| ${pad("GRW", 4)} ` +
    `| ${pad("HCK", 4)} ` +
    `| PHASE${C.reset}`
  );
  ns.print(sep);

  for (const entry of managerTargets) {
    const s        = ns.getServer(entry.host);
    const phase    = entry.phase.toUpperCase();
    const color    = rowColor(s, phase);
    const secStr   = `${s.hackDifficulty.toFixed(1)} / ${s.minDifficulty.toFixed(1)}`;
    const moneyPct = s.moneyMax > 0
      ? `${Math.min(100, Math.round(s.moneyAvailable / s.moneyMax * 100))}%`
      : "0%";
    const wkn      = fmtTime(ns.getWeakenTime(entry.host));
    const grw      = fmtTime(ns.getGrowTime(entry.host));
    const hck      = fmtTime(ns.getHackTime(entry.host));

    ns.print(
      `${color}  ${pad(entry.host, hostW)}` +
      `| ${pad(secStr, 13)} ` +
      `| ${pad(moneyPct, 8)} ` +
      `| ${pad(fmtMoney(s.moneyMax), 9)} ` +
      `| ${pad(fmtMoney(entry.estPerSec), 9)} ` +
      `| ${pad(wkn, 4)} ` +
      `| ${pad(grw, 4)} ` +
      `| ${pad(hck, 4)} ` +
      `| ${phase}${C.reset}`
    );
  }
  ns.print("");
}

function printPurchased(ns, servers) {
  if (servers.length === 0) return;

  const mostRam  = servers.reduce((a, b) => a.maxRam >= b.maxRam ? a : b);
  const leastRam = servers.reduce((a, b) => a.maxRam <= b.maxRam ? a : b);
  const rows     = servers.length === 1 ? [mostRam] : [mostRam, leastRam];

  const hostW = Math.max(16, ...rows.map(s => s.hostname.length)) + 1;
  const sep   = `  ${"─".repeat(hostW)}┼──────────┼──────────┼────────`;

  ns.print(`${C.yellow}▶ PURCHASED SERVERS (${servers.length}) ${"─".repeat(48)}${C.reset}`);
  ns.print(
    `${C.grey}  ${pad("HOST", hostW)}` +
    `| ${pad("RAM USED", 8)} ` +
    `| ${pad("RAM MAX", 8)} ` +
    `| FREE %${C.reset}`
  );
  ns.print(sep);

  for (const s of rows) {
    const freeRam = s.maxRam - s.ramUsed;
    const freePct = s.maxRam > 0 ? Math.round(freeRam / s.maxRam * 100) : 0;
    ns.print(
      `  ${pad(s.hostname, hostW)}` +
      `| ${pad(s.ramUsed.toFixed(1) + " GB", 8)} ` +
      `| ${pad(s.maxRam.toFixed(1) + " GB", 8)} ` +
      `| ${freePct}%`
    );
  }
  ns.print("");
}

function printOther(ns, servers) {
  if (servers.length === 0) return;

  const hostW = Math.max(16, ...servers.map(s => s.hostname.length)) + 1;
  const sep   = `  ${"─".repeat(hostW)}┼──────┼────────┼────────`;

  ns.print(`${C.yellow}▶ OTHER SERVERS (${servers.length}) ${"─".repeat(48)}${C.reset}`);
  ns.print(
    `${C.grey}  ${pad("HOST", hostW)}` +
    `| ROOT ` +
    `| HK REQ ` +
    `| RAM MAX${C.reset}`
  );
  ns.print(sep);

  for (const s of servers) {
    const color = s.hasAdminRights ? "" : C.grey;
    const root  = s.hasAdminRights ? "  ✓   " : "  ✗   ";
    ns.print(
      `${color}  ${pad(s.hostname, hostW)}` +
      `|${root}` +
      `| ${pad(s.requiredHackingSkill, 6)} ` +
      `| ${s.maxRam} GB${C.reset}`
    );
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();

  while (true) {
    ns.clearLog();

    const allHostnames = scanNetwork(ns);
    const servers      = allHostnames.map(h => ns.getServer(h));
    const { purchased, other } = classifyServers(servers);

    let dashData = null;
    try {
      const raw = ns.read("data/dashboard.json");
      if (raw) dashData = JSON.parse(raw);
    } catch (_) {}
    const stale = !dashData || (Date.now() - dashData.updatedAt > 15_000);

    printHeader(ns, servers);
    printTargets(ns, stale ? null : dashData.targets);
    printPurchased(ns, purchased);
    printOther(ns, other);

    await ns.sleep(REFRESH_MS);
  }
}
