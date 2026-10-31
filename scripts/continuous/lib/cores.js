/**
 * cpuCores lookup for the continuous batcher.
 *
 * Kept in its own module because of what it costs:
 *
 *   ns.getServer   2.00 GB
 *
 * That is nearly six times the whole of lib/server.js, and ns.getServer is the
 * ONLY way to read cpuCores - there is no getServerCores, and the fork exposes
 * no ServerConstants. Isolating it means anything that merely places RAM can
 * import the pool without paying for core awareness it will not use.
 *
 * Why it is worth 2 GB here: in this fork foreign servers are not single-core.
 * initForeignServers in src/Server/ServerHelpers.ts assigns
 *
 *     server.cpuCores = getRandomIntInclusive(Math.ceil(layer / 2), layer)
 *
 * over 15 network layers, so cores run 1..15 across the network. Grow and
 * weaken scale with `threads * getCoreBonus(cores)`, so a grow thread on a
 * 9-core host does the work of 1.5 threads. Ignoring that would leave a
 * significant fraction of the pool's real capacity unused.
 */

/**
 * Cores per host.
 *
 * Read fresh every time, and never cached. initForeignServers re-rolls cpuCores
 * at every install while this module outlives the process, so a cache handed the
 * next run another install's numbers, and a host over-stated that way
 * under-delivers grow and weaken. It only runs at startup and for hosts sync
 * finds, so there is nothing to save.
 *
 * @param {NS} ns
 * @param {string[]} hosts
 * @returns {Record<string, number>}
 */
export function coreMap(ns, hosts) {
  const out = {};
  for (const host of hosts) out[host] = ns.getServer(host).cpuCores ?? 1;
  return out;
}

/**
 * Build a memoized coreBonus(cores) function from a weaken-effect measurement.
 *
 * Pure: it calls only what you hand it, so importing this for the factory alone
 * adds nothing beyond whatever the measuring function itself costs.
 *
 * The bonus is MEASURED rather than hardcoded, per this repo's standing rule
 * that constants come from the API and not from memory. Both backends can
 * supply the measurement, since weaken's effect is linear in threads:
 *
 *     analyze:   (t, c) => ns.weakenAnalyze(t, c)
 *     formulas:  (t, c) => ns.formulas.hacking.weakenEffect(t, c)
 *
 * One ratio serves grow as well. That is not an assumption - the fork's
 * src/Server/ServerHelpers.ts has a single getCoreBonus() shared by
 * getWeakenEffect and calculateServerGrowthLog, so measuring it through weaken
 * yields exactly the factor grow uses.
 *
 * @param {(threads: number, cores: number) => number} weakenEffect
 * @returns {(cores: number) => number} 1.0 for 1 core, rising with cores
 */
export function makeCoreBonus(weakenEffect) {
  const base = weakenEffect(1, 1);
  const memo = new Map([[1, 1]]);

  return (cores) => {
    const c = Math.max(1, Math.floor(cores || 1));
    if (memo.has(c)) return memo.get(c);

    // A non-positive or non-finite base would make every bonus garbage, and a
    // NaN bonus silently defeats every comparison it appears in - including the
    // `need <= 0` that terminates the placement loop. Fall back to no bonus,
    // which only ever over-provisions.
    const bonus = base > 0 ? weakenEffect(1, c) / base : 1;
    const safe = Number.isFinite(bonus) && bonus >= 1 ? bonus : 1;

    memo.set(c, safe);
    return safe;
  };
}
