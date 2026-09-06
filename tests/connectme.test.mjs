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

  "an unknown host suggests near matches": async () => {
    const { connectme } = await loadScripts();
    const p = connectme.buildParents(scan);
    assert(connectme.suggest(p, "omega").join(",") === "omega-net", "substring match failed");
    assert(connectme.suggest(p, "zzz").length === 0, "nothing should match zzz");
  },
};
