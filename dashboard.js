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

// ─── Entry point ─────────────────────────────────────────────────────────────

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.tail();

  while (true) {
    ns.clearLog();

    const allHostnames = scanNetwork(ns);
    const servers      = allHostnames.map(h => ns.getServer(h));
    const { targets, purchased, other } = classifyServers(servers);

    ns.print(`Targets: ${targets.length} | Purchased: ${purchased.length} | Other: ${other.length}`);

    await ns.sleep(REFRESH_MS);
  }
}
