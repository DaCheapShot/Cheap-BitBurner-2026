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
 *
 * RAM: 1.60 base + scan 0.20 + getServer 2.00 = 3.80 GB
 *      (tprint, args and string work are 0)
 *
 * getServer is the whole 2.00 GB and buys only the two booleans above. It is
 * charged once no matter how many hosts are inspected, and this is a script you
 * run by hand on home, so the cost is irrelevant here in a way it would not be
 * inside the batcher.
 */

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

/** @param {NS} ns */
export async function main(ns) {
  const targets = ns.args.map(String);
  if (targets.length === 0) {
    ns.tprint("Usage: run scripts/connectme.js <host> [host ...]");
    return;
  }

  const parents = buildParents((h) => ns.scan(h));

  // One getServer per host on a route, memoised because routes overlap heavily
  // near home and a repeated lookup would be pure waste.
  const directCache = new Map();
  const isDirect = (host) => {
    if (!directCache.has(host)) {
      const s = ns.getServer(host);
      directCache.set(host, Boolean(s.backdoorInstalled || s.purchasedByPlayer));
    }
    return directCache.get(host);
  };

  const out = [];
  for (const typed of targets) {
    const host = resolveHost(parents, typed);
    if (!host) {
      const near = suggest(parents, typed);
      out.push(`${typed}\n  ERROR  not on the network${near.length ? ` - did you mean: ${near.join(", ")}` : ""}`);
      continue;
    }

    const path = pathTo(parents, host);
    const { commands, from, jumped } = commandsFor(path, isDirect);
    const hops = path.length - 1;

    out.push(
      `${host}\n` +
      `  path   ${path.join(" > ")}  (${hops} hop${hops === 1 ? "" : "s"})\n` +
      `  cmd    ${commands.join("; ")}` +
      (jumped ? `\n  note   jumping straight to ${from} - it is backdoored or yours` : ""),
    );
  }

  ns.tprint(`\n${out.join("\n\n")}\n`);
}
