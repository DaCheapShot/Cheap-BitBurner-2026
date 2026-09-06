/**
 * A mock ns that reproduces the game's real semantics where they matter.
 *
 * Reproduced here, because both have previously made a passing simulation
 * disagree with the live game:
 *   - ports hold 50 entries and discard the OLDEST on overflow
 *   - script paths are stored WITHOUT a leading slash, so ns.run("/scripts/x.js")
 *     works while ns.ps() reports "scripts/x.js"
 *
 * Deliberately NOT reproduced: port crackers throwing when the program is not
 * owned. Nothing in this plan tests root.js, and an unused mock of a throwing
 * API is a liability - it would drift from the real behaviour unnoticed. Add it
 * with the test that needs it.
 */
export const PORT_CAPACITY = 50;

export function makeNs(o = {}) {
  const hosts = o.hosts ?? { home: 1024 };
  const used = Object.fromEntries(Object.keys(hosts).map((h) => [h, 0]));
  const servers = o.servers ?? {};
  const files = o.files ?? {};
  let queue = [];
  let dropped = 0;
  let processes = [];
  let nextPid = 1;

  const port = {
    empty: () => queue.length === 0,
    full: () => queue.length >= PORT_CAPACITY,
    read: () => (queue.length ? queue.shift() : "NULL PORT DATA"),
    peek: () => (queue.length ? queue[0] : "NULL PORT DATA"),
    clear: () => { queue = []; },
    write: (v) => { queue.push(v); if (queue.length > PORT_CAPACITY) { queue.shift(); dropped++; } },
  };

  const srv = (h) => servers[h] ?? {};

  const ns = {
    _hosts: hosts, _used: used, _servers: servers, _files: files,
    _port: port, _droppedReports: () => dropped, _log: [],

    args: o.args ?? [],
    disableLog: () => {}, enableLog: () => {},
    ui: { openTail: () => {} },
    print: (s) => ns._log.push(s),
    tprint: (s) => ns._log.push("[T] " + s),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),

    read: (f) => files[f] ?? "",
    write: (f, data, mode) => { files[f] = mode === "a" ? (files[f] ?? "") + data : data; },
    // Files may be keyed either bare or host-prefixed; fileExists checks both since that's what callers use
    fileExists: (f, host = "home") => Boolean(files[`${host}:${f}`] ?? files[f]),
    getPortHandle: () => port,

    scan: (h) => (h === "home" ? [...Object.keys(hosts).filter((x) => x !== "home"), ...Object.keys(servers)] : []),
    hasRootAccess: (h) => srv(h).rooted !== false,
    getServerMaxRam: (h) => hosts[h] ?? 0,
    getServerUsedRam: (h) => used[h] ?? 0,
    getScriptRam: (f) => (f.includes("hack") ? 1.7 : 1.75),

    getServerMaxMoney: (h) => srv(h).moneyMax ?? 0,
    getServerMoneyAvailable: (h) => srv(h).moneyAvailable ?? 0,
    getServerMinSecurityLevel: (h) => srv(h).minDifficulty ?? 1,
    getServerSecurityLevel: (h) => srv(h).hackDifficulty ?? 1,
    getServerRequiredHackingLevel: (h) => srv(h).requiredHackingSkill ?? 1,
    getHackingLevel: () => o.hackingLevel ?? 9999,

    getWeakenTime: (h) => srv(h).weakenTime ?? 2000,
    getGrowTime: (h) => srv(h).growTime ?? 1600,
    getHackTime: (h) => srv(h).hackTime ?? 500,

    hackAnalyze: (h) => srv(h).hackPercentPerThread ?? 0.0037,
    growthAnalyze: (h, mult) => Math.log(mult) / Math.log(srv(h).growBase ?? 1.0018),
    weakenAnalyze: (t) => 0.05 * t,

    exec: (file, host, threads, ...args) => {
      const filename = file.replace(/^\/+/, "");
      const pid = nextPid++;
      processes.push({ filename, pid, args, threads });
      return pid;
    },
    run: (file, threads, ...args) => {
      const filename = file.replace(/^\/+/, "");
      const pid = nextPid++;
      processes.push({ filename, pid, args, threads });
      return pid;
    },
    ps: (host) => processes.filter(p => true).map(p => ({ ...p })),
    kill: (pid) => {
      const idx = processes.findIndex(p => p.pid === pid);
      if (idx !== -1) processes.splice(idx, 1);
      return true;
    },
    scp: () => true,

    ...o.extra,
  };
  return ns;
}

/**
 * A mock of ns.formulas.hacking backed by the same numbers as the analyze mock,
 * so a test can compare the two implementations on identical ground truth.
 *
 * growThreads models BOTH the exponential and additive terms, which is exactly
 * what growthAnalyze cannot express - that difference is the point of the whole
 * feature, so the mock must have it.
 */
export function withFormulas(ns, { owned = true } = {}) {
  const guard = () => {
    if (!owned) throw new Error("Requires Formulas.exe to run.");
  };
  const rate = (server) => {
    const base = server.growBase ?? 1.0018;
    // Growth degrades as security rises; at minDifficulty the base is as given.
    const sec = server.hackDifficulty ?? server.minDifficulty ?? 1;
    const min = server.minDifficulty ?? 1;
    return 1 + (base - 1) * (min / sec);
  };
  ns.formulas = {
    mockServer: () => ({}),
    mockPlayer: () => ({}),
    hacking: {
      hackPercent: (server) => { guard(); return server.hackPercentPerThread ?? 0.0037; },
      hackChance: () => { guard(); return 1; },
      growPercent: (server, threads) => { guard(); return Math.pow(rate(server), threads); },
      growThreads: (server, _player, targetMoney) => {
        guard();
        const from = Math.max(server.moneyAvailable ?? 0, 1);
        const to = Math.min(targetMoney, server.moneyMax ?? targetMoney);
        if (to <= from) return 0;
        // Additive +1/thread then exponential, solved numerically - matches the
        // game's documented "linearly AND exponentially" behaviour closely
        // enough for tests, and is strictly better than a pure log ratio.
        const r = rate(server);
        let lo = 0, hi = 1;
        const reached = (t) => (from + t) * Math.pow(r, t);
        while (reached(hi) < to && hi < 1e9) hi *= 2;
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (reached(mid) < to) lo = mid; else hi = mid;
        }
        return Math.ceil(hi);
      },
      growAmount: (server, _p, threads) => {
        guard();
        const from = Math.max(server.moneyAvailable ?? 0, 1);
        return Math.min((from + threads) * Math.pow(rate(server), threads), server.moneyMax ?? Infinity);
      },
      hackTime: (server) => { guard(); return server.hackTime ?? 500; },
      growTime: (server) => { guard(); return server.growTime ?? 1600; },
      weakenTime: (server) => { guard(); return server.weakenTime ?? 2000; },
      weakenEffect: (threads) => { guard(); return 0.05 * threads; },
      hackExp: () => { guard(); return 1; },
    },
  };
  ns.getServer = (h) => ({ hostname: h, ...(ns._servers[h] ?? {}) });
  ns.getPlayer = () => ({ skills: { hacking: 9999 } });
  return ns;
}
