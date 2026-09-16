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

  // Resolvers waiting on nextWrite(). The real handle resolves on the NEXT
  // write, not on data already queued, so a mock that resolved immediately
  // would hide a caller that forgot to check empty() first.
  let waiters = [];
  const wake = () => { for (const r of waiters) r(); waiters = []; };

  const port = {
    nextWrite: () => new Promise((r) => waiters.push(r)),
    empty: () => queue.length === 0,
    full: () => queue.length >= PORT_CAPACITY,
    read: () => (queue.length ? queue.shift() : "NULL PORT DATA"),
    peek: () => (queue.length ? queue[0] : "NULL PORT DATA"),
    clear: () => { queue = []; },
    write: (v) => { queue.push(v); if (queue.length > PORT_CAPACITY) { queue.shift(); dropped++; } wake(); },
  };

  // Ports are keyed by NUMBER, because the real ones are. A getPortHandle that
  // returned the same queue for every number would let the share gate (port 2)
  // clear the report port (port 1) and nothing would notice until a live run.
  // Port 1 stays the object above so `ns._port` keeps meaning the report port.
  const ports = new Map([[1, port]]);
  const portFor = (n) => {
    const key = Number(n);
    if (!ports.has(key)) {
      let q = [];
      let w = [];
      const wakeQ = () => { for (const r of w) r(); w = []; };
      ports.set(key, {
        nextWrite: () => new Promise((r) => w.push(r)),
        empty: () => q.length === 0,
        full: () => q.length >= PORT_CAPACITY,
        read: () => (q.length ? q.shift() : "NULL PORT DATA"),
        peek: () => (q.length ? q[0] : "NULL PORT DATA"),
        clear: () => { q = []; },
        write: (v) => { q.push(v); if (q.length > PORT_CAPACITY) q.shift(); wakeQ(); },
      });
    }
    return ports.get(key);
  };

  const srv = (h) => servers[h] ?? {};

  const ns = {
    _hosts: hosts, _used: used, _servers: servers, _files: files,
    _port: port, _droppedReports: () => dropped, _log: [],

    args: o.args ?? [],
    disableLog: () => {}, enableLog: () => {},
    ui: { openTail: () => {} },
    // This fork's ns.format namespace - number/ram/percent/time, all 0 GB.
    // NOT ns.formatNumber, which does not exist here.
    //
    // The suffix list and the /1000 scaling are the game's, from
    // src/ui/formatNumber.ts. Deliberately NOT reproduced: the Numeric Display
    // settings (nothing here has a Player to read them from), the "∞" spelling
    // for non-finite values, and the switch to exponential form past 1e33.
    // Reproduce those with the test that needs them.
    format: {
      number: (n, digits = 3, suffixStart = 1000, isInteger = false) => {
        const abs = Math.abs(n);
        // isInteger applies ONLY below suffixStart. Once a suffix is in play
        // the game uses fractionalDigits regardless - which is why passing 0
        // here printed both 1.6m and 2.05m as "2m" in a live log.
        if (abs < suffixStart) return isInteger ? String(Math.round(n)) : n.toFixed(digits);
        const SUFFIX = ["", "k", "m", "b", "t", "q", "Q", "s", "S", "o", "n"];
        let i = Math.min(Math.floor(Math.log10(abs) / 3), SUFFIX.length - 1);
        let scaled = n / 1000 ** i;
        // The game's rollover guard, from src/ui/formatNumber.ts: a mantissa
        // that rounds up to 1000.00 becomes 1.00 of the NEXT suffix, so
        // 999999 at 2 digits is "1.00m" and never "1000.00k".
        if (Math.abs(scaled).toFixed(digits).length === digits + 5 && SUFFIX[i + 1]) {
          i += 1;
          scaled = scaled < 0 ? -1 : 1;
        }
        return `${scaled.toFixed(digits)}${SUFFIX[i]}`;
      },
      ram: (n, digits = 2) => `${n.toFixed(digits)}GB`,
      percent: (n, digits = 2) => `${(n * 100).toFixed(digits)}%`,
      time: (ms) => `${Math.round(ms / 1000)}s`,
    },
    print: (s) => ns._log.push(s),
    tprint: (s) => ns._log.push("[T] " + s),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    // asleep is the ONE function checkEnvFlags exempts from the concurrency
    // check (NetscriptHelpers.tsx:405), which is why rpc.js races against it
    // rather than against sleep.
    asleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    // Unique per process, and the reply port rpc.js keys on.
    pid: o.pid ?? 1,

    read: (f) => files[f] ?? "",
    write: (f, data, mode) => { files[f] = mode === "a" ? (files[f] ?? "") + data : data; },
    // Files may be keyed either bare or host-prefixed; fileExists checks both since that's what callers use
    fileExists: (f, host = "home") => Boolean(files[`${host}:${f}`] ?? files[f]),
    getPortHandle: (n) => portFor(n),
    // The generated transients rpc.js writes reply with writePort, not through
    // a handle, so the mock needs both spellings to hit the same queue.
    writePort: (n, v) => portFor(n).write(v),

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
    hackAnalyzeSecurity: (t) => 0.002 * t,
    growthAnalyzeSecurity: (t) => 0.004 * t,

    exec: (file, host, threads, ...args) => {
      const filename = file.replace(/^\/+/, "");
      const pid = nextPid++;
      processes.push({ filename, pid, args, threads, host });
      return pid;
    },
    // The second argument is a thread COUNT or a RunOptions object, as in the
    // real API. Storing the object as `threads` gives a process an object for
    // a thread count, which the share census then sums.
    run: (file, threadOrOptions, ...args) => {
      const filename = file.replace(/^\/+/, "");
      const opts = threadOrOptions && typeof threadOrOptions === "object"
        ? threadOrOptions
        : { threads: threadOrOptions };
      const pid = nextPid++;
      processes.push({
        filename, pid, args, host: "home",
        threads: opts.threads ?? 1,
        temporary: Boolean(opts.temporary),
      });
      // A transient generated by scripts/rpc.js has to actually RUN, or every
      // caller of rpc() in a test times out and reports a failure that is the
      // mock's, not the code's. Importing the written source as a data: URL
      // runs the REAL generated module, wrapper and all - a mock that answered
      // the call itself would pass for a body that does not parse.
      //
      // Deliberately not awaited: ns.run starts the script and returns, which
      // is what makes nextWrite() the thing under test rather than a formality.
      const src = files[file];
      if (src !== undefined && filename.startsWith("tmp/rpc-")) {
        void (async () => {
          const mod = await import("data:text/javascript," + encodeURIComponent(src));
          await mod.main({ ...ns, args });
        })();
      }
      return pid;
    },
    // Host-aware, because the real one is. A ps that ignores its argument makes
    // any per-host census see the whole network on every host and multiply its
    // answer by the host count - which is exactly the arithmetic the share
    // top-up depends on getting right.
    ps: (host) => processes.filter((p) => p.host === host).map((p) => ({ ...p })),
    // The game's own formula, from src/NetworkShare/Share.ts. The intelligence
    // and core bonuses are not modelled: they scale the thread count before the
    // log, and nothing here has a Player to read them from.
    getSharePower: () => {
      const t = processes
        .filter((p) => p.filename === "scripts/share.js")
        .reduce((n, p) => n + p.threads, 1);
      return 1 + Math.log(t) / 25;
    },
    share: async () => {},
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
