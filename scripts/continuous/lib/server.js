import { RAM_SAFETY_FRACTION } from "scripts/continuous/config";

/**
 * RAM pool primitives for the continuous (streaming) HWGW batcher.
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
 * Note what is NOT here: ns.getServer, the only source of cpuCores, costs 2 GB
 * on its own - nearly six times this whole module. Cores arrive as a plain
 * {host: cores} map passed into build(), and scripts/continuous/lib/cores.js
 * pays for building that map. Anything that only needs to place RAM (the
 * harness's pool report, a future census) gets to stay cheap.
 *
 * ---------------------------------------------------------------------------
 * How this differs from scripts/ram.js, and why it has to
 *
 * The shotgun refreshes its pool at cycle start, when NOTHING is in flight, so
 * `pending` and the game's own used RAM can never describe the same worker.
 * A stream has workers in flight permanently, so that separation has to be
 * maintained by hand:
 *
 *   reserve  ->  pending += gb    a placement decided, not yet exec'd
 *   commit   ->  refresh, then pending -= gb
 *                                 exec returned a pid; the game now counts it
 *   release  ->  pending -= gb    exec returned 0; undo the reservation
 *
 * commit() is the load-bearing one and the refresh inside it is not optional.
 * Dropping `pending` without re-reading usedRam would make freeRam jump by the
 * batch's whole size the instant it launched, and the next dispatch would place
 * a second batch into RAM the first is already using - the pool would
 * cheerfully over-commit every host until exec started returning 0.
 *
 * The consequence is that RAM is freed by the GAME, not by port reports: a
 * worker exits, getServerUsedRam drops, the next refresh() sees it. Reports are
 * for stream health only. That means a report dropped by a full port costs a
 * health sample and never leaks RAM.
 */

// maxRam is a power of two and script RAM is a multiple of 0.05 - float error
// is tiny but real. Tolerate a sliver so a thread that exactly fits isn't lost.
const RAM_EPS = 1e-6;

/**
 * One usable host.
 *
 * @property {number} cores  cpuCores, or 1 when unknown. Grow and weaken are
 *   linear in `threads * coreBonus(cores)`; hack is not. Defaulting to 1 is the
 *   safe direction - it under-states a host's power, so an op sized against it
 *   over-provisions rather than falling short.
 */
export class Server {
  /**
   * @param {NS} ns
   * @param {string} hostname
   * @param {object} [opts]
   * @param {number} [opts.staticReserve=0] GB permanently withheld from the pool
   * @param {number} [opts.cores=1]
   * @param {number} [opts.safetyFraction=RAM_SAFETY_FRACTION]
   */
  constructor(ns, hostname, opts = {}) {
    const {
      staticReserve = 0,
      cores = 1,
      safetyFraction = RAM_SAFETY_FRACTION,
    } = opts;

    this.ns = ns;
    this.hostname = hostname;
    this.maxRam = ns.getServerMaxRam(hostname);
    this.usedRam = ns.getServerUsedRam(hostname);
    this.staticReserve = staticReserve;
    this.cores = cores;
    this.safetyFraction = safetyFraction;
    this.pending = 0;
  }

  /** Re-read the game's used RAM. Cheap (0.05 GB, already paid for). */
  refresh() {
    this.usedRam = this.ns.getServerUsedRam(this.hostname);
  }

  /** GB of this host the pool will plan against at all, before any usage. */
  get plannableRam() {
    return this.maxRam * this.safetyFraction;
  }

  /** GB actually available to us right now. */
  get freeRam() {
    return Math.max(0, this.plannableRam - this.usedRam - this.staticReserve - this.pending);
  }

  /** GB this host contributes to the pool at all (ignores current usage). */
  get usableRam() {
    return Math.max(0, this.plannableRam - this.staticReserve);
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
   * allocation must not turn into a failed exec mid-stream.
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

  /**
   * Hand a reservation over to the game: the worker is running, so
   * getServerUsedRam counts it and our own ledger must stop doing so.
   *
   * The refresh is what makes this safe. See the module header.
   */
  commit(gb) {
    this.refresh();
    this.releaseGb(gb);
  }

  /** Give reserved GB back to the pool (exec failed, or the plan was dropped). */
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
    // splits shallow and leaves small hosts free for later batches. Per-op
    // orders (see hostsBy) re-sort a copy and never disturb this.
    this.servers = servers.sort((a, b) => b.maxRam - a.maxRam);
  }

  /**
   * BFS the network from home, keep every rooted host with RAM.
   *
   * @param {NS} ns
   * @param {object} [opts]
   * @param {number} [opts.homeReserve=0]   GB withheld on home
   * @param {boolean} [opts.includeHome=true]
   * @param {string[]} [opts.exclude=[]]    hostnames to drop entirely
   * @param {string[]} [opts.extraHosts=[]] hosts to union in on top of the scan
   * @param {Record<string, number>} [opts.cores={}] cpuCores per host, from
   *   scripts/continuous/lib/cores.js. Absent hosts default to 1 core.
   * @param {number} [opts.safetyFraction=RAM_SAFETY_FRACTION]
   * @returns {ServerPool}
   */
  static build(ns, opts = {}) {
    const {
      homeReserve = 0,
      includeHome = true,
      exclude = [],
      extraHosts = [],
      cores = {},
      safetyFraction = RAM_SAFETY_FRACTION,
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
      servers.push(
        new Server(ns, host, {
          staticReserve: host === "home" ? homeReserve : 0,
          cores: cores[host] ?? 1,
          safetyFraction,
        }),
      );
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

  /** Sum of maxRam across the pool (before any reserve or safety fraction). */
  get totalRam() {
    return this.servers.reduce((n, s) => n + s.maxRam, 0);
  }

  /** Sum of maxRam minus reserves - the pool's real ceiling. */
  get usableRam() {
    return this.servers.reduce((n, s) => n + s.usableRam, 0);
  }

  /** Sum of currently-free RAM. */
  get freeRam() {
    return this.servers.reduce((n, s) => n + s.freeRam, 0);
  }

  /** Total GB reserved by us and not yet committed or released. */
  get pendingRam() {
    return this.servers.reduce((n, s) => n + s.pending, 0);
  }

  /**
   * A sorted COPY of the host list for one op's fill order.
   *
   *   "ram"       most free RAM first - fewest hosts touched, shallowest split
   *   "coresDesc" best cores first - for grow and weaken, where a thread on a
   *               high-core host does more work for the same RAM
   *   "coresAsc"  worst cores first - for hack, which gets no core bonus, so
   *               that it leaves the core-bearing RAM for the ops that multiply
   *
   * Ties break on free RAM in every order, so the choice among equal-core hosts
   * is still the shallow-split one.
   */
  hostsBy(order = "ram") {
    const byRam = (a, b) => b.freeRam - a.freeRam;
    const copy = [...this.servers];
    if (order === "coresDesc") return copy.sort((a, b) => b.cores - a.cores || byRam(a, b));
    if (order === "coresAsc") return copy.sort((a, b) => a.cores - b.cores || byRam(a, b));
    return copy.sort(byRam);
  }

  /** How many threads of this cost the whole pool could hold right now. */
  maxThreadsFor(ramPerThread) {
    return this.servers.reduce((n, s) => n + s.threadsFor(ramPerThread), 0);
  }

  /** Largest thread count that fits on a SINGLE host. */
  maxContiguousThreadsFor(ramPerThread) {
    return this.servers.reduce((n, s) => Math.max(n, s.threadsFor(ramPerThread)), 0);
  }

  /**
   * Effective (core-weighted) threads the pool could hold for a boosted op.
   *
   * This is the number that matters for grow and weaken, and it is strictly
   * larger than maxThreadsFor on any network with multi-core hosts - which in
   * this fork is most of them, since initForeignServers assigns each server
   * `getRandomIntInclusive(ceil(layer/2), layer)` cores.
   *
   * @param {(cores: number) => number} coreBonus measured, never hardcoded
   */
  maxEffectiveThreadsFor(ramPerThread, coreBonus) {
    return this.servers.reduce((n, s) => n + s.threadsFor(ramPerThread) * coreBonus(s.cores), 0);
  }

  /**
   * Place `threads` threads of `ramPerThread` across the pool.
   *
   * All-or-nothing: if the full thread count doesn't fit, nothing is reserved
   * and null comes back. A partially-placed op is worse than no op - a batch
   * that hacks but fails to grow steals money and never returns it.
   *
   * @param {number} ramPerThread
   * @param {number} threads
   * @param {object} [opts]
   * @param {boolean} [opts.contiguous=false] force a single host. Hack may want
   *        this: split hack is legal but each split takes its fraction of
   *        whatever money is left when it resolves, so the batch steals
   *        1 - (1-f1)(1-f2)... rather than f1+f2+...
   * @param {string} [opts.order="ram"] see hostsBy
   * @returns {{host: string, threads: number, gb: number, cores: number}[] | null}
   */
  allocate(ramPerThread, threads, opts = {}) {
    const { contiguous = false, order = "ram" } = opts;
    if (threads <= 0) return [];

    const candidates = this.hostsBy(order);

    if (contiguous) {
      const host = candidates.find((s) => s.threadsFor(ramPerThread) >= threads);
      if (!host) return null;
      const gb = host.reserveThreads(threads, ramPerThread);
      return [{ host: host.hostname, threads, gb, cores: host.cores }];
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
      cores: server.cores,
    }));
  }

  /**
   * Place enough RAW threads to deliver `effectiveThreads` of core-weighted
   * work. For grow and weaken only - hack gets no bonus, so hack uses
   * allocate() and the two counts are the same thing.
   *
   * The caller sizes the op ONCE, as if every thread ran on a 1-core host, and
   * hands that number here. Because both boosted ops are exactly linear in
   * `threads * coreBonus` (weaken directly, grow inside the log), the split
   * across hosts composes exactly, so this can spend the demand greedily
   * best-cores-first and stop when it is met.
   *
   * The raw thread total that comes back is usually SMALLER than
   * `effectiveThreads`, and that saving is the entire point of paying 2 GB for
   * cpuCores.
   *
   * Per-host counts are rounded UP, so the delivered effective total is always
   * >= what was asked. Over-delivery is the safe direction for both ops:
   * surplus grow is clamped at moneyMax and surplus weaken is clamped at
   * minDifficulty.
   *
   * @param {number} ramPerThread
   * @param {number} effectiveThreads
   * @param {(cores: number) => number} coreBonus
   * @param {object} [opts]
   * @param {string} [opts.order="coresDesc"]
   * @returns {{placements: object[], rawThreads: number, effective: number} | null}
   */
  allocateEffective(ramPerThread, effectiveThreads, coreBonus, opts = {}) {
    const { order = "coresDesc" } = opts;
    if (effectiveThreads <= 0) return { placements: [], rawThreads: 0, effective: 0 };

    const plan = [];
    let need = effectiveThreads;

    for (const s of this.hostsBy(order)) {
      if (need <= RAM_EPS) break;
      const capacity = s.threadsFor(ramPerThread);
      if (capacity <= 0) continue;

      const bonus = coreBonus(s.cores);
      if (!(bonus > 0)) continue; // a zero or NaN bonus would loop forever

      const t = Math.min(capacity, Math.ceil(need / bonus));
      plan.push({ server: s, threads: t, bonus });
      need -= t * bonus;
    }

    if (need > RAM_EPS) return null; // all-or-nothing, same as allocate()

    const placements = plan.map(({ server, threads, bonus }) => ({
      host: server.hostname,
      threads,
      gb: server.reserveThreads(threads, ramPerThread),
      cores: server.cores,
      effective: threads * bonus,
    }));

    return {
      placements,
      rawThreads: placements.reduce((n, p) => n + p.threads, 0),
      effective: placements.reduce((n, p) => n + p.effective, 0),
    };
  }

  /**
   * The workers are running: stop counting their RAM ourselves and let the
   * game's own used-RAM figure carry it. Call this ONLY after exec returned a
   * non-zero pid for every placement handed in.
   */
  commit(placements) {
    if (!placements) return;
    const byHost = new Map(this.servers.map((s) => [s.hostname, s]));
    for (const p of placements) {
      const s = byHost.get(p.host);
      if (s) s.commit(p.gb);
    }
  }

  /** Hand back what allocate()/allocateEffective() reserved. */
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
