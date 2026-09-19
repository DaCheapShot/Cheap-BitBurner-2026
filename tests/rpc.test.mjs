import { loadScripts, readScript, scriptNames, scriptFiles, assert } from "./harness.mjs";
import { makeNs, resolveBodyImports } from "./mockNs.mjs";

/**
 * The RPC worker.
 *
 * What is worth testing here is not that a value comes back - it is every way
 * the call can fail QUIETLY, because each one surfaces as a wrong number rather
 * than an error:
 *
 *   - ns.run returns a bare 0 for both "no free RAM" and "does not compile";
 *   - a transient that throws dies with its log window a few hundred ms later;
 *   - a late reply from a timed-out call would be read as the next call's answer;
 *   - two calls in flight from one process share a reply port and swap answers,
 *     and the game's own concurrency check does NOT catch it, because
 *     nextWrite() is not a blocking netscript call.
 *
 * The round-trip tests run the GENERATED module for real, by importing it as a
 * data: URL, rather than asserting on the source text. A test that only checked
 * the string would pass for a body that does not parse.
 */

/**
 * A mock ns whose run() actually executes what rpc.js just wrote.
 *
 * The real ns.run starts the script and returns immediately, so the execution
 * is deliberately left unawaited here - that is what makes nextWrite() the
 * thing being tested rather than a formality.
 */
function rpcNs(opts = {}) {
  const ns = makeNs({
    pid: opts.pid ?? 7,
    extra: {
      run: (file, _threadOrOptions, ...args) => {
        if (opts.runFails) return 0;
        const src = ns._files[file];
        if (src === undefined) throw new Error(`run: nothing was written to ${file}`);
        ns._ran = (ns._ran ?? []).concat(file);
        if (opts.neverReplies) return 99;
        (async () => {
          const mod = await import("data:text/javascript," + encodeURIComponent(src));
          await mod.main({ ...ns, args });
        })();
        return 99;
      },
    },
  });
  return ns;
}

export const tests = {
  // -------------------------------------------------------------- source ----

  "imports are hoisted out of main, where they would be a syntax error": async () => {
    const { rpc } = await loadScripts();
    const src = rpc.source('import { A } from "./config.js";\nreturn A;');
    const body = src.slice(src.indexOf("export async function main"));
    assert(!body.includes("import {"), "the import must not remain inside main()");
    assert(src.startsWith('import { A } from "./config.js";'), `import not hoisted: ${src.slice(0, 60)}`);
  },

  "the generated module parses": async () => {
    const { rpc } = await loadScripts();
    const src = rpc.source("return 1 + 1;");
    // Importing it IS the parse check - node --check cannot be run on these,
    // there being no package.json, so a bare .js reads as CommonJS.
    const mod = await import("data:text/javascript," + encodeURIComponent(src));
    assert(typeof mod.main === "function", "generated module must export main");
  },

  // --------------------------------------------------- content addressing ----

  "an identical body lands on an identical filename": async () => {
    const { rpc } = await loadScripts();
    const a = rpcNs();
    const b = rpcNs({ pid: 4242 });
    await rpc.rpc(a, "return 1;");
    await rpc.rpc(b, "return 1;");
    assert(a._ran[0] === b._ran[0], `same body, different file: ${a._ran[0]} vs ${b._ran[0]}`);
    // The pid must NOT reach the source. If it did, every restart would mint a
    // new filename and the litter would grow without bound.
    assert(!a._files[a._ran[0]].includes("4242"),
      "the reply port must arrive as an argument, not baked into the text");
  },

  "a different body lands on a different filename": async () => {
    const { rpc } = await loadScripts();
    const ns = rpcNs();
    await rpc.rpc(ns, "return 1;");
    await rpc.rpc(ns, "return 2;");
    assert(ns._ran[0] !== ns._ran[1], "two bodies collided on one filename");
  },

  // ---------------------------------------------------------- round trip ----

  "a value comes back": async () => {
    const { rpc } = await loadScripts();
    const got = await rpc.rpc(rpcNs(), "return { a: 1, b: [2, 3] };");
    assert(JSON.stringify(got) === JSON.stringify({ a: 1, b: [2, 3] }), `got ${JSON.stringify(got)}`);
  },

  "arguments reach the body, and ns does too": async () => {
    const { rpc } = await loadScripts();
    const ns = rpcNs();
    const got = await rpc.rpc(ns, "return args[0] + args[1];", 2, 40);
    assert(got === 42, `got ${got}`);
    const ram = await rpc.rpc(ns, "return ns.getServerMaxRam(args[0]);", "home");
    assert(ram === 1024, `ns unreachable in the body: got ${ram}`);
  },

  "the reply port is the caller's own, never a shared one": async () => {
    const { rpc } = await loadScripts();
    const ns = rpcNs({ pid: 31 });
    await rpc.rpc(ns, "return 1;");
    assert(ns._files[ns._ran[0]].includes("ns.args"), "the port must come from args");
    // 1-3 are the shotgun reports, share gate and continuous reports; 4 was gang's.
    assert(rpc.RPC_PORT_BASE > 4,
      `RPC_PORT_BASE ${rpc.RPC_PORT_BASE} can collide with an existing port`);
  },

  // ------------------------------------------------------------ failures ----

  "a body that throws surfaces as a throw naming the file, not a hang": async () => {
    const { rpc } = await loadScripts();
    let msg = "";
    try {
      await rpc.rpc(rpcNs(), 'throw new Error("boom");');
    } catch (e) {
      msg = e.message;
    }
    assert(msg.includes("boom"), `the body's message must survive: ${msg}`);
    assert(msg.includes("rpc-"), `the file must be named: ${msg}`);
  },

  "ns.run returning 0 throws, rather than waiting forever": async () => {
    const { rpc } = await loadScripts();
    let msg = "";
    try {
      await rpc.rpc(rpcNs({ runFails: true }), "return 1;");
    } catch (e) {
      msg = e.message;
    }
    // Both causes named: ns.run gives the same bare 0 for either.
    assert(msg.includes("RAM") && msg.includes("compile"), `both causes must be named: ${msg}`);
  },

  "a transient that never replies times out instead of hanging": async () => {
    const { rpc } = await loadScripts();
    let msg = "";
    try {
      await rpc.rpc(rpcNs({ neverReplies: true }), "return 1;");
    } catch (e) {
      msg = e.message;
    }
    assert(msg.includes("wrote nothing"), `expected a timeout, got: ${msg}`);
  },

  "a late reply from a timed-out call is not read as the next call's answer": async () => {
    const { rpc } = await loadScripts();
    const ns = rpcNs();
    // Exactly what a transient that resolved after its caller gave up leaves
    // behind: a stale value sitting on this process's reply port.
    ns.getPortHandle(rpc.RPC_PORT_BASE + ns.pid).write(JSON.stringify({ v: "stale" }));
    const got = await rpc.rpc(ns, 'return "fresh";');
    assert(got === "fresh", `read a stale reply: ${got}`);
  },

  "a second call while one is in flight throws instead of swapping answers": async () => {
    const { rpc } = await loadScripts();
    const ns = rpcNs({ neverReplies: true });
    const first = rpc.rpc(ns, "return 1;").catch(() => {});
    let msg = "";
    try {
      await rpc.rpc(ns, "return 2;");
    } catch (e) {
      msg = e.message;
    }
    await first;
    assert(msg.includes("already in flight"), `expected the concurrency guard, got: ${msg}`);
  },

  // The game hands every importer of rpc.js the SAME module instance
  // (NetscriptJSEvaluator.ts compile: `if (script.mod) return script.mod.module`),
  // so a module-level flag is shared by gang.js, sing.js and contracts.js. It was
  // one boolean: any overlap between two processes threw here, and sing's
  // pre-install SWEEP - which awaits contracts.js, itself an rpc caller - could
  // never sweep. One loaded module standing in for two processes is exactly the
  // game's shape.
  "another process's call in flight does not block this one": async () => {
    const { rpc } = await loadScripts();
    const first = rpc.rpc(rpcNs({ pid: 7, neverReplies: true }), "return 1;").catch(() => {});
    const got = await rpc.rpc(rpcNs({ pid: 8 }), 'return "other";');
    await first;
    assert(got === "other", `a second process was refused: ${got}`);
  },

  "the guard releases after a failed call": async () => {
    const { rpc } = await loadScripts();
    const ns = rpcNs();
    await rpc.rpc(ns, 'throw new Error("x");').catch(() => {});
    const got = await rpc.rpc(ns, 'return "after";');
    assert(got === "after", `the in-flight guard leaked: ${got}`);
  },

  // -------------------------------------------------------- the blindspot ----

  "every rpc body in scripts/ parses": async () => {
    // ramOf() in tests/ram.test.mjs blanks string literals, so an rpc body is
    // invisible to it - and to every other check in this repo. This recovers
    // the parse, which is the half that can be recovered. Its RAM is only ever
    // charged to a transient, so the exposure is a runtime ns.run -> 0, never a
    // manager that will not start.
    const { rpc } = await loadScripts();
    //
    // Two spellings, across the whole tree: a literal passed straight to rpc(),
    // and an UPPER_CASE const holding one (gang.js names its bodies). A body in
    // any other shape is one this test cannot see, so the counts are pinned.
    const bodies = [];
    for (const rel of scriptFiles()) {
      const name = rel.replace(/\.js$/, "");
      const src = readScript(name);
      for (const m of src.matchAll(/\brpc\s*\(\s*ns\s*,\s*`([\s\S]*?)`/g)) bodies.push([name, m[1]]);
      for (const m of src.matchAll(/\bconst\s+[A-Z_]+\s*=\s*`([\s\S]*?)`;/g)) bodies.push([name, m[1]]);
    }
    const per = (n) => bodies.filter(([f]) => f === n).length;
    assert(per("gang/gang") === 5, `gang.js should have 5 bodies (tick, war, ascend, equip, create), found ${per("gang/gang")}`);
    assert(per("continuous/lib/math") === 1, `continuous/lib/math.js should have 1 body, found ${per("continuous/lib/math")}`);
    assert(per("sing/sing") === 26,
      `sing.js should have 26 bodies (upgrade, tor, progs, invites, join, read, gym, crime, faction, ` +
        `crime stats, crime chance, company, apply, travel, owned, faction augs, prereq, aug info, buy, favor, favor gain, bitnode mults, sweep, ` +
        `install, backdoors, donate), found ${per("sing/sing")}`);
    assert(per("contracts/contracts") === 3, `contracts.js should have 3 bodies (find, submit, dummy), found ${per("contracts/contracts")}`);
    for (const [name, body] of bodies) {
      // A ${} interpolation cannot be evaluated here, so it is rejected
      // outright: a body assembled at runtime is one no check can read, and it
      // would also mint a new filename per distinct value.
      assert(!body.includes("${"),
        `${name}: an rpc body must be a plain template literal, not interpolated`);
      try {
        await import("data:text/javascript," + encodeURIComponent(resolveBodyImports(rpc.source(body))));
      } catch (e) {
        throw new Error(`${name}: rpc body does not parse - ${e.message}`);
      }
    }
  },
};
