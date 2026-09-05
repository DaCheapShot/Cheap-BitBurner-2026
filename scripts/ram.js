/**
 * RAM pool primitives for the shotgun HWGW batcher.
 *
 * Pure module - no main(). Bitburner charges the IMPORTING script for every
 * ns.* function reachable in here, so this file deliberately touches only the
 * four cheap ones:
 *
 *   ns.scan             0.20 GB
 *   ns.getServerMaxRam  0.05 GB
 *   ns.getServerUsedRam 0.05 GB
 *   ns.hasRootAccess    0.05 GB
 *   ------------------------------
 *   total               0.35 GB on top of the importer's 1.60 GB base
 *
 * Nothing here calls an analyze/formulas function; keep it that way so the
 * manager can stay cheap.
 */

// maxRam is a power of two, script RAM is a multiple of 0.05 - float error is
// tiny but real. Tolerate a sliver so a thread that exactly fits isn't dropped.
const RAM_EPS = 1e-6;

/**
 * One usable host. Tracks the game's own used RAM plus two reservations we
 * layer on top:
 *
 *   staticReserve - permanently walled off (e.g. home RAM kept for the manager
 *                   and whatever you run by hand). Never allocated.
 *   pending       - RAM handed out by the pool for jobs that are launched but
 *                   not yet reported complete. The game's getServerUsedRam
 *                   already counts a running worker, but there is a window
 *                   between "we decided to place it" and "exec actually ran",
 *                   and the manager releases on port report, not on exec exit.
 */
export class Server {
  /**
   * @param {NS} ns
   * @param {string} hostname
   * @param {number} staticReserve GB permanently withheld from the pool
   */
  constructor(ns, hostname, staticReserve = 0) {
    this.ns = ns;
    this.hostname = hostname;
    this.maxRam = ns.getServerMaxRam(hostname);
    this.usedRam = ns.getServerUsedRam(hostname);
    this.staticReserve = staticReserve;
    this.pending = 0;
  }

  /** Re-read the game's used RAM. Cheap (0.05 GB, already paid for). */
  refresh() {
    this.usedRam = this.ns.getServerUsedRam(this.hostname);
  }

  /** GB actually available to us right now. */
  get freeRam() {
    return Math.max(0, this.maxRam - this.usedRam - this.staticReserve - this.pending);
  }

  /** GB this host contributes to the pool at all (ignores current usage). */
  get usableRam() {
    return Math.max(0, this.maxRam - this.staticReserve);
  }

  /**
   * How many threads of a given per-thread cost fit in freeRam right now.
   * @param {number} ramPerThread GB per thread
   * @returns {number} integer thread count, >= 0
   */
  threadsFor(ramPerThread) {
    if (ramPerThread <= 0) return 0;
    return Math.floor((this.freeRam + RAM_EPS) / ramPerThread);
  }

  /**
   * Reserve threads. Throws rather than silently over-committing - a bad
   * allocation must not turn into a failed exec mid-volley.
   * @returns {number} GB reserved
   */
  reserveThreads(threads, ramPerThread) {
    const gb = threads * ramPerThread;
    if (gb > this.freeRam + RAM_EPS) {
      throw new Error(
        `${this.hostname}: cannot reserve ${threads}t x ${ramPerThread}GB ` +
          `(${gb.toFixed(2)}GB) - only ${this.freeRam.toFixed(2)}GB free`,
      );
    }
    this.pending += gb;
    return gb;
  }

  /** Give reserved GB back to the pool. */
  releaseGb(gb) {
    this.pending = Math.max(0, this.pending - gb);
  }

  /** Drop every pending reservation on this host. */
  releaseAll() {
    this.pending = 0;
  }
}

/**
 * All hosts we can run scripts on, plus placement logic.
 */
export class ServerPool {
  /** @param {Server[]} servers */
  constructor(servers) {
    // Biggest first: fills a job onto as few hosts as possible, which keeps
    // grow/weaken splits shallow and leaves small hosts free for later batches.
    this.servers = servers.sort((a, b) => b.maxRam - a.maxRam);
  }

  /**
   * BFS the network from home, keep every rooted host with RAM.
   *
   * @param {NS} ns
   * @param {object} [opts]
   * @param {number} [opts.homeReserve=0]  GB withheld on home
   * @param {boolean} [opts.includeHome=true]
   * @param {string[]} [opts.exclude=[]]   hostnames to drop entirely
   * @param {string[]} [opts.extraHosts=[]] hosts to union in on top of the scan
   *                                        (use if cloud servers turn out not to
   *                                        be on home's network)
   * @returns {ServerPool}
   */
  static build(ns, opts = {}) {
    const {
      homeReserve = 0,
      includeHome = true,
      exclude = [],
      extraHosts = [],
    } = opts;

    const hosts = ServerPool.scanAll(ns);
    for (const h of extraHosts) if (!hosts.includes(h)) hosts.push(h);

    const excluded = new Set(exclude);
    const servers = [];

    for (const host of hosts) {
      if (excluded.has(host)) continue;
      if (host === "home" && !includeHome) continue;
      if (!ns.hasRootAccess(host)) continue;
      if (ns.getServerMaxRam(host) <= 0) continue;
      servers.push(new Server(ns, host, host === "home" ? homeReserve : 0));
    }

    return new ServerPool(servers);
  }

  /** Every hostname reachable from home, home included. */
  static scanAll(ns) {
    const seen = new Set(["home"]);
    const queue = ["home"];
    for (let i = 0; i < queue.length; i++) {
      for (const host of ns.scan(queue[i])) {
        if (!seen.has(host)) {
          seen.add(host);
          queue.push(host);
        }
      }
    }
    return [...seen];
  }

  refresh() {
    for (const s of this.servers) s.refresh();
  }

  /** Sum of maxRam across the pool (before any reserve). */
  get totalRam() {
    return this.servers.reduce((n, s) => n + s.maxRam, 0);
  }

  /** Sum of maxRam minus static reserves - the pool's real ceiling. */
  get usableRam() {
    return this.servers.reduce((n, s) => n + s.usableRam, 0);
  }

  /** Sum of currently-free RAM. */
  get freeRam() {
    return this.servers.reduce((n, s) => n + s.freeRam, 0);
  }

  /** Total GB currently reserved by us but not yet released. */
  get pendingRam() {
    return this.servers.reduce((n, s) => n + s.pending, 0);
  }

  /** How many threads of this cost the whole pool could hold right now. */
  maxThreadsFor(ramPerThread) {
    return this.servers.reduce((n, s) => n + s.threadsFor(ramPerThread), 0);
  }

  /** Largest thread count that fits on a SINGLE host (hack needs this). */
  maxContiguousThreadsFor(ramPerThread) {
    return this.servers.reduce((n, s) => Math.max(n, s.threadsFor(ramPerThread)), 0);
  }

  /**
   * Place `threads` threads of `ramPerThread` across the pool.
   *
   * All-or-nothing: if the full thread count doesn't fit, nothing is reserved
   * and null comes back. A partially-placed HWGW op is worse than no op.
   *
   * @param {number} ramPerThread
   * @param {number} threads
   * @param {object} [opts]
   * @param {boolean} [opts.contiguous=false] force a single host. Hack wants
   *        this: splitting hack across hosts is legal but each split rounds
   *        its own money-stolen fraction, so the volley's take drifts.
   * @returns {{host: string, threads: number, gb: number}[] | null}
   */
  allocate(ramPerThread, threads, opts = {}) {
    const { contiguous = false } = opts;
    if (threads <= 0) return [];

    const candidates = [...this.servers].sort((a, b) => b.freeRam - a.freeRam);

    if (contiguous) {
      const host = candidates.find((s) => s.threadsFor(ramPerThread) >= threads);
      if (!host) return null;
      const gb = host.reserveThreads(threads, ramPerThread);
      return [{ host: host.hostname, threads, gb }];
    }

    // Dry run first so we never leave half a reservation behind on failure.
    const plan = [];
    let remaining = threads;
    for (const s of candidates) {
      if (remaining <= 0) break;
      const fit = Math.min(s.threadsFor(ramPerThread), remaining);
      if (fit > 0) {
        plan.push({ server: s, threads: fit });
        remaining -= fit;
      }
    }
    if (remaining > 0) return null;

    return plan.map(({ server, threads: t }) => ({
      host: server.hostname,
      threads: t,
      gb: server.reserveThreads(t, ramPerThread),
    }));
  }

  /** Hand back what allocate() returned. */
  release(placements) {
    if (!placements) return;
    const byHost = new Map(this.servers.map((s) => [s.hostname, s]));
    for (const p of placements) {
      const s = byHost.get(p.host);
      if (s) s.releaseGb(p.gb);
    }
  }

  releaseAll() {
    for (const s of this.servers) s.releaseAll();
  }

  get(hostname) {
    return this.servers.find((s) => s.hostname === hostname);
  }
}
