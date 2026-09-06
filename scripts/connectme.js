/**
 * Print the terminal `connect` chain that reaches a host.
 *
 *   run scripts/connectme.js CSEC
 *   -> home; connect joesguns; connect CSEC
 *
 * The network is a TREE rooted at home (ns.scan's docs state this, and that the
 * parent is always element 0), so a BFS parent map yields THE path to a host,
 * not merely one shortest path among several. That is why nothing here has to
 * compare candidate routes.
 *
 * The chain is shortened wherever the game allows a direct jump. From
 * src/Terminal/commands/connect.ts, `connect X` succeeds when X is adjacent to
 * the current server OR when X.backdoorInstalled || X.purchasedByPlayer. So
 * once a server is backdoored you can reach it from anywhere in one command,
 * and a long route can start at the deepest backdoored node on it instead of
 * at home. Both the full path and the trimmed command are printed, so a wrong
 * trim is visible rather than silently stranding you.
 *
 * Usage:  run scripts/connectme.js CSEC
 *         run scripts/connectme.js csec              case does not matter
 *         run scripts/connectme.js CSEC avmnite-02h  several at once
 *         run scripts/connectme.js --factions        every backdoor-gated faction
 *
 * RAM: 1.60 base + scan 0.20 + getServer 2.00 + getHackingLevel 0.05 = 3.85 GB
 *      (tprint, args and string work are 0)
 *
 * getServer is nearly the whole cost and buys four fields: the two that decide
 * a direct jump, plus hasAdminRights and requiredHackingSkill for the faction
 * report. It is charged once no matter how many hosts are inspected, and this
 * is a script you run by hand on home, so the cost is irrelevant here in a way
 * it would not be inside the batcher.
 */

/**
 * The servers whose backdoor grants a faction invite.
 *
 * Taken from src/Faction/FactionInfo.tsx - every faction whose inviteReqs
 * contain haveBackdooredServer, and nothing else. Two mistakes are easy here,
 * and both were in an earlier connect.js in this repo:
 *
 *   - w0r1d_d43m0n grants NO faction. It is the endgame server, and it sits in
 *     SpecialServers.ts beside the real ones, which is how it creeps in.
 *   - fulcrumassets is easy to miss because Fulcrum Secret Technologies is a
 *     megacorp faction rather than a hacking one, so it is declared far from
 *     the others in the file.
 *
 * Order here is arbitrary; the report sorts by required hacking level, which is
 * the order you can actually reach them in.
 */
export const FACTION_SERVERS = [
  { faction: "CyberSec", host: "CSEC" },
  { faction: "NiteSec", host: "avmnite-02h" },
  { faction: "The Black Hand", host: "I.I.I.I" },
  { faction: "BitRunners", host: "run4theh111z" },
  { faction: "Fulcrum Secret Technologies", host: "fulcrumassets" },
];

/**
 * Map every reachable host to its parent, breadth first from home.
 *
 * Takes the scan FUNCTION rather than ns so the traversal can be tested against
 * a hand-built topology without a mock ns.
 *
 * @param {(host: string) => string[]} scanFn
 * @returns {Map<string, string|null>} host -> parent, home -> null
 */
export function buildParents(scanFn) {
  const parents = new Map([["home", null]]);
  const queue = ["home"];

  // Index walk rather than shift(): the queue is the visit order and never
  // needs to shrink, and this stays O(n) on a network of a few hundred hosts.
  for (let i = 0; i < queue.length; i++) {
    for (const neighbor of scanFn(queue[i])) {
      if (parents.has(neighbor)) continue;
      parents.set(neighbor, queue[i]);
      queue.push(neighbor);
    }
  }
  return parents;
}

/**
 * Canonical hostname for a user-typed name, or null.
 *
 * The terminal's connect is case sensitive (it looks the name up verbatim), but
 * hostnames like CSEC and I.I.I.I are annoying to type exactly, so accept any
 * casing here and hand back the spelling the game will accept.
 */
export function resolveHost(parents, typed) {
  const want = String(typed);
  if (parents.has(want)) return want;
  const lower = want.toLowerCase();
  for (const host of parents.keys()) if (host.toLowerCase() === lower) return host;
  return null;
}

/** Hosts whose name contains the typed text, for a "did you mean" line. */
export function suggest(parents, typed, limit = 5) {
  const lower = String(typed).toLowerCase();
  const hits = [];
  for (const host of parents.keys()) {
    if (host.toLowerCase().includes(lower)) hits.push(host);
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Full route home -> ... -> target, or null if the host is unknown. */
export function pathTo(parents, target) {
  if (!parents.has(target)) return null;
  const path = [];
  for (let node = target; node !== null; node = parents.get(node)) path.unshift(node);
  return path;
}

/**
 * The shortest command list that walks `path`.
 *
 * Scans from the target backwards for the LAST directly-connectable host, so
 * the jump lands as close to the destination as possible. home is always
 * directly connectable (purchasedByPlayer is true for it), so the search always
 * terminates and index 0 is the worst case.
 *
 * @param {string[]} path      home -> ... -> target
 * @param {(host: string) => boolean} isDirect
 * @returns {{commands: string[], from: string, jumped: boolean}}
 */
export function commandsFor(path, isDirect) {
  let start = 0;
  for (let i = path.length - 1; i >= 1; i--) {
    if (isDirect(path[i])) { start = i; break; }
  }

  // From home the player types `home`, not `connect home` - both work, but one
  // is what the terminal's own help teaches.
  const commands = start === 0
    ? ["home", ...path.slice(1).map((h) => `connect ${h}`)]
    : path.slice(start).map((h) => `connect ${h}`);

  return { commands, from: path[start], jumped: start > 0 };
}

/**
 * What still stands between you and `backdoor` on a server.
 *
 * src/Terminal/commands/backdoor.ts rejects on hasAdminRights first and
 * requiredHackingSkill second, so a server blocked by both only ever tells you
 * about the first. Reporting both is the point: that you are also 200 levels
 * short changes what you do next, and the root check alone would hide it.
 *
 * @param {object} server  an ns.getServer() result
 * @param {number} hackingLevel
 * @returns {string[]} empty when `backdoor` would succeed right now
 */
export function backdoorBlockers(server, hackingLevel) {
  const blockers = [];
  if (!server.hasAdminRights) {
    const ports = server.numOpenPortsRequired ?? 0;
    blockers.push(`no root (${ports} port${ports === 1 ? "" : "s"} to open, then NUKE)`);
  }
  const need = server.requiredHackingSkill ?? 0;
  if (need > hackingLevel) blockers.push(`hacking ${need}, you have ${hackingLevel}`);
  return blockers;
}

/** The route half of a report block: how to get there, and the shortest way. */
function routeLines(path, isDirect) {
  const { commands, from, jumped } = commandsFor(path, isDirect);
  const hops = path.length - 1;
  return [
    `  path   ${path.join(" > ")}  (${hops} hop${hops === 1 ? "" : "s"})`,
    `  cmd    ${commands.join("; ")}`,
    ...(jumped ? [`  note   jumping straight to ${from} - it is backdoored or yours`] : []),
  ];
}

/** @param {NS} ns */
export async function main(ns) {
  const args = ns.args.map(String);
  // Bare "factions" is accepted alongside --factions: it is what an older
  // connect.js in this repo took, and muscle memory outlives scripts.
  const factionsMode = args.some((a) => a === "--factions" || a === "factions");
  const targets = args.filter((a) => !a.startsWith("--") && a !== "factions");

  if (!factionsMode && targets.length === 0) {
    ns.tprint("Usage: run scripts/connectme.js <host> [host ...]   |   --factions");
    return;
  }

  const parents = buildParents((h) => ns.scan(h));

  // One getServer per host, memoised: routes overlap heavily near home, and the
  // faction report asks about the same hosts twice - once for the jump check
  // and once for the backdoor status.
  const cache = new Map();
  const serverOf = (host) => {
    if (!cache.has(host)) cache.set(host, ns.getServer(host));
    return cache.get(host);
  };
  const isDirect = (host) => {
    const s = serverOf(host);
    return Boolean(s.backdoorInstalled || s.purchasedByPlayer);
  };

  const out = [];

  if (factionsMode) {
    const rows = FACTION_SERVERS.map(({ faction, host }) => {
      const name = resolveHost(parents, host);
      return name
        ? { faction, host: name, server: serverOf(name), path: pathTo(parents, name) }
        : { faction, host, server: null, path: null };
    });

    // Required hacking level is the order you can actually reach these in, and
    // it is usually the number you are waiting on. Anything unreachable sorts
    // last rather than to the front as a level of 0.
    rows.sort((a, b) =>
      (a.server?.requiredHackingSkill ?? Infinity) - (b.server?.requiredHackingSkill ?? Infinity));

    const level = ns.getHackingLevel();
    let earned = 0;

    for (const row of rows) {
      if (!row.server) {
        out.push(`${row.faction} via ${row.host}\n  ERROR  not on the network`);
        continue;
      }

      let status;
      if (row.server.backdoorInstalled) {
        earned++;
        status = "backdoored - invite earned";
      } else {
        const blockers = backdoorBlockers(row.server, level);
        status = blockers.length === 0
          ? "READY - connect, then run `backdoor`"
          : `blocked: ${blockers.join("; ")}`;
      }

      out.push([
        `${row.faction} via ${row.host}`,
        `  status ${status}`,
        ...routeLines(row.path, isDirect),
      ].join("\n"));
    }

    ns.tprint(
      `\nbackdoor-gated factions - ${earned}/${rows.length} earned, hacking level ${level}\n\n` +
      `${out.join("\n\n")}\n`,
    );
    return;
  }

  for (const typed of targets) {
    const host = resolveHost(parents, typed);
    if (!host) {
      const near = suggest(parents, typed);
      out.push(`${typed}\n  ERROR  not on the network${near.length ? ` - did you mean: ${near.join(", ")}` : ""}`);
      continue;
    }
    out.push([host, ...routeLines(pathTo(parents, host), isDirect)].join("\n"));
  }

  ns.tprint(`\n${out.join("\n\n")}\n`);
}
