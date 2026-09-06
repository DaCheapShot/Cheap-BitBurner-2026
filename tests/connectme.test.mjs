import { loadScripts, assert } from "./harness.mjs";

/**
 * The topology from ns.scan's own documentation, which is also the shape that
 * matters: a tree where one branch is deeper than the other.
 *
 *   home
 *   --n00dles
 *   --joesguns
 *   ----CSEC
 *   ------omega-net
 *
 * scan() is symmetric in the game - a host lists its parent as well as its
 * children - so the mock must be too, or a BFS bug that revisits the parent
 * would go unnoticed here.
 */
const LINKS = {
  home: ["n00dles", "joesguns"],
  n00dles: ["home"],
  joesguns: ["home", "CSEC"],
  CSEC: ["joesguns", "omega-net"],
  "omega-net": ["CSEC"],
};
const scan = (h) => LINKS[h] ?? [];

/** Nothing backdoored: only home is directly connectable. */
const nothingDirect = (h) => h === "home";

export const tests = {
  "buildParents walks the whole tree without revisiting parents": async () => {
    const { connectme } = await loadScripts();
    const p = connectme.buildParents(scan);
    assert(p.size === 5, `expected 5 hosts, got ${p.size}`);
    assert(p.get("home") === null, "home must be the root");
    assert(p.get("CSEC") === "joesguns", `CSEC's parent should be joesguns, got ${p.get("CSEC")}`);
    assert(p.get("omega-net") === "CSEC", "omega-net's parent should be CSEC");
  },

  "the connect chain reaches a nested host": async () => {
    const { connectme } = await loadScripts();
    const p = connectme.buildParents(scan);
    const path = connectme.pathTo(p, "CSEC");
    assert(path.join(">") === "home>joesguns>CSEC", `bad path ${path.join(">")}`);

    const { commands } = connectme.commandsFor(path, nothingDirect);
    assert(
      commands.join("; ") === "home; connect joesguns; connect CSEC",
      `bad chain: ${commands.join("; ")}`,
    );
  },

  // src/Terminal/commands/connect.ts allows a direct connect to any backdoored
  // or player-owned host, so the route should start at the DEEPEST such node -
  // starting at a shallower one would emit commands that are merely redundant,
  // but starting past the target would emit ones that fail.
  "a backdoored host on the route trims the chain to a jump": async () => {
    const { connectme } = await loadScripts();
    const p = connectme.buildParents(scan);
    const path = connectme.pathTo(p, "omega-net");

    const backdoored = (h) => h === "home" || h === "joesguns" || h === "CSEC";
    const r = connectme.commandsFor(path, backdoored);
    assert(r.from === "CSEC", `should jump to the deepest backdoored host, got ${r.from}`);
    assert(r.jumped === true, "jumped should be reported");
    assert(
      r.commands.join("; ") === "connect CSEC; connect omega-net",
      `bad chain: ${r.commands.join("; ")}`,
    );
  },

  "with the target itself backdoored the chain is a single connect": async () => {
    const { connectme } = await loadScripts();
    const p = connectme.buildParents(scan);
    const r = connectme.commandsFor(connectme.pathTo(p, "omega-net"), () => true);
    assert(r.commands.join("; ") === "connect omega-net", `bad chain: ${r.commands.join("; ")}`);
  },

  "home resolves to the bare home command, not connect home": async () => {
    const { connectme } = await loadScripts();
    const p = connectme.buildParents(scan);
    const r = connectme.commandsFor(connectme.pathTo(p, "home"), nothingDirect);
    assert(r.commands.join("; ") === "home", `bad chain: ${r.commands.join("; ")}`);
  },

  // The terminal's connect looks the hostname up verbatim, so a case-insensitive
  // match here has to hand back the game's spelling, never what was typed.
  "a mistyped case resolves to the game's spelling": async () => {
    const { connectme } = await loadScripts();
    const p = connectme.buildParents(scan);
    assert(connectme.resolveHost(p, "csec") === "CSEC", "lowercase should resolve to CSEC");
    assert(connectme.resolveHost(p, "OMEGA-NET") === "omega-net", "uppercase should resolve");
    assert(connectme.resolveHost(p, "nope") === null, "an unknown host must resolve to null");
  },

  // Pinned against src/Faction/FactionInfo.tsx: exactly the five factions whose
  // inviteReqs contain haveBackdooredServer. An earlier connect.js in this repo
  // got this wrong in both directions at once, which is why the list is asserted
  // whole rather than just spot-checked.
  "the faction list is exactly the backdoor-gated factions": async () => {
    const { connectme } = await loadScripts();
    const hosts = connectme.FACTION_SERVERS.map((f) => f.host);
    assert(
      hosts.join(",") === "CSEC,avmnite-02h,I.I.I.I,run4theh111z,fulcrumassets",
      `faction hosts drifted: ${hosts.join(",")}`,
    );
    // w0r1d_d43m0n is the endgame server and grants no faction, but it lives in
    // SpecialServers.ts next to the real four and keeps getting swept in.
    assert(!hosts.includes("w0r1d_d43m0n"), "w0r1d_d43m0n grants no faction invite");
    assert(connectme.FACTION_SERVERS.every((f) => f.faction), "every entry needs a faction name");
  },

  // backdoor.ts checks admin rights first and returns, so a doubly-blocked
  // server never reveals the level requirement in game. Reporting both is the
  // whole reason this function exists rather than inlining the first check.
  "backdoorBlockers reports root and level together, not just the first": async () => {
    const { connectme } = await loadScripts();
    const both = connectme.backdoorBlockers(
      { hasAdminRights: false, numOpenPortsRequired: 4, requiredHackingSkill: 505 }, 312);
    assert(both.length === 2, `expected both blockers, got ${JSON.stringify(both)}`);
    assert(both[0].includes("4 ports"), `root blocker should name the port count: ${both[0]}`);
    assert(both[1].includes("505") && both[1].includes("312"), `level blocker should name both: ${both[1]}`);
  },

  "backdoorBlockers is empty exactly when backdoor would succeed": async () => {
    const { connectme } = await loadScripts();
    const ready = { hasAdminRights: true, numOpenPortsRequired: 4, requiredHackingSkill: 505 };
    assert(connectme.backdoorBlockers(ready, 505).length === 0, "equal level is enough, not short");
    assert(connectme.backdoorBlockers(ready, 504).length === 1, "one level short must block");
    // A server needing no ports still needs the singular/plural right, and a
    // missing requiredHackingSkill must not read as NaN > level.
    const one = connectme.backdoorBlockers({ hasAdminRights: false, numOpenPortsRequired: 1 }, 1);
    assert(one.length === 1 && one[0].includes("1 port to open"), `bad singular: ${one[0]}`);
  },

  "an unknown host suggests near matches": async () => {
    const { connectme } = await loadScripts();
    const p = connectme.buildParents(scan);
    assert(connectme.suggest(p, "omega").join(",") === "omega-net", "substring match failed");
    assert(connectme.suggest(p, "zzz").length === 0, "nothing should match zzz");
  },
};
