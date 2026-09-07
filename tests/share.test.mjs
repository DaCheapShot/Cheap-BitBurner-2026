import { loadScripts, assert, assertClose } from "./harness.mjs";
import { makeNs } from "./mockNs.mjs";

/**
 * Share mode.
 *
 * Two things here are worth more than the rest. The marker parser decides
 * whether every share thread on the network keeps running, so it must never
 * answer NaN or a number it invented - garbage has to read as "stop". And the
 * census is what stops a restarted manager launching a second full set of share
 * workers on top of the ones still running, which would double the RAM share
 * holds in order to buy 2.77 points of a logarithm.
 */

const SHARE = "/scripts/share.js";

/** A pool of known size, so the fraction arithmetic has an exact answer. */
function poolNs(hosts = { home: 1024, p0: 4096, p1: 2048 }) {
  return makeNs({
    hosts,
    files: { "/scripts/hack.js": "x" },
  });
}

export const tests = {
  // -------------------------------------------------------------- marker ----

  "the marker reads on, off, and a bare fraction": async () => {
    const { config } = await loadScripts();
    assert(config.shareFractionFrom("on") === config.SHARE_FRACTION, "on -> the default");
    assert(config.shareFractionFrom("off") === 0, "off -> 0");
    assert(config.shareFractionFrom("0.4") === 0.4, "a fraction passes through");
    // sharemode.js writes the fraction then a timestamp, so only line 1 counts.
    assert(config.shareFractionFrom("0.4\n1730000000000") === 0.4, "trailing timestamp ignored");
    assert(config.shareFractionFrom("  ON  ") === config.SHARE_FRACTION, "trimmed and case-folded");
  },

  // A worker asks this function whether to keep sharing. Anything that is not a
  // usable fraction has to stop it, because a NaN compares false against every
  // bound and would leave the RAM held with no way to reclaim it but a kill.
  "anything unreadable in the marker means OFF, never a made-up number": async () => {
    const { config } = await loadScripts();
    for (const junk of ["", "   ", "yes please", "NaN", "-0.5", "abc", "\n\n"]) {
      const f = config.shareFractionFrom(junk);
      assert(f === 0, `"${junk}" should read as off, got ${f}`);
    }
    assert(config.shareFractionFrom(undefined) === 0, "a missing file reads as off");
    assert(config.shareFractionFrom(null) === 0, "null reads as off");
  },

  // 100% starves the prep gate, which then waits out POOL_WAIT_CYCLES and stops
  // the manager - and boot restarts it into the same wall a tick later.
  "the fraction is clamped so prep always has somewhere to stand": async () => {
    const { config } = await loadScripts();
    assert(config.SHARE_MAX_FRACTION < 1, "the cap must leave the pool some room");
    assert(config.shareFractionFrom("1") === config.SHARE_MAX_FRACTION, "1 clamps");
    assert(config.shareFractionFrom("99") === config.SHARE_MAX_FRACTION, "a typo clamps");
  },

  // Pinned to src/NetworkShare/Share.ts. If the fork changes the formula, the
  // whole sizing argument in config.js changes with it, and this fails first.
  "the bonus formula matches the one in the game": async () => {
    const { config } = await loadScripts();
    assert(config.shareBonusFor(0) === 1, "no threads is no bonus");
    assert(config.shareBonusFor(1) === 1, "one thread is no bonus - ln(1) is 0");
    for (const t of [10, 1000, 209000]) {
      assertClose(config.shareBonusFor(t), 1 + Math.log(t) / 25, 1e-12, `bonus at ${t} threads`);
    }
    // The property the whole design rests on: a DOUBLING is worth a flat
    // 2.77 points however much is already running.
    const step = config.shareBonusFor(2000) - config.shareBonusFor(1000);
    assertClose(step, config.shareBonusFor(800000) - config.shareBonusFor(400000), 1e-12,
      "doubling must be worth the same at any scale - that is why the fraction is capped low");
    assertClose(step, Math.log(2) / 25, 1e-12, "and that constant is ln(2)/25");
  },

  // -------------------------------------------------------------- census ----

  "the census counts share threads and nothing else": async () => {
    const { managerCore } = await loadScripts();
    const ns = poolNs();

    ns.exec(SHARE, "p0", 100);
    ns.exec(SHARE, "p0", 50); // two share processes on one host
    ns.exec(SHARE, "p1", 25);
    ns.exec("/scripts/grow.js", "p1", 999); // a batch worker, not ours
    ns.exec("/scripts/weaken.js", "home", 7);

    const c = managerCore.shareCensus(ns, ["home", "p0", "p1"]);
    assert(c.threads === 175, `expected 175 share threads, got ${c.threads}`);
    assert(c.hosts === 2, `expected 2 hosts sharing, got ${c.hosts}`);
    assert(c.procs === 3, `expected 3 share processes, got ${c.procs}`);
  },

  // ps reports "scripts/share.js"; SHARE_WORKER carries a leading slash. Compare
  // them raw and every census reads zero, so the manager launches a fresh set of
  // workers every cycle until the pool is full.
  "the census survives the leading-slash mismatch": async () => {
    const { managerCore } = await loadScripts();
    const ns = poolNs();
    ns.exec(SHARE, "p0", 40);
    assert(ns.ps("p0")[0].filename === "scripts/share.js", "the mock must report the form the game does");
    assert(managerCore.shareCensus(ns, ["p0"]).threads === 40, "census missed a slash-stripped path");
  },

  // ---------------------------------------------------------------- plan ----

  "the wanted thread count is a fraction of the whole fleet": async () => {
    const { managerCore, prepper } = await loadScripts();
    const ns = poolNs();
    const pool = prepper.buildWorkerPool(ns);
    const usable = pool.usableRam;
    const p = managerCore.planShare(pool, 4.0, 0.25, 0);
    assert(p.want === Math.floor((usable * 0.25) / 4.0), `want was ${p.want} of ${usable}GB usable`);
    assert(p.deficit === p.want, "with nothing running the deficit is the whole want");
  },

  // usableRam, not freeRam. Free RAM swings between almost all of the pool and
  // almost none of it depending where in a cycle you ask, so a fraction of it
  // would size share differently every time it was asked.
  "the size does not move when the pool is busy": async () => {
    const { managerCore, prepper } = await loadScripts();
    const ns = poolNs();
    const idle = managerCore.planShare(prepper.buildWorkerPool(ns), 4.0, 0.25, 0).want;
    ns._used.p0 = 4000; // a volley in flight
    const busy = managerCore.planShare(prepper.buildWorkerPool(ns), 4.0, 0.25, 0).want;
    assert(idle === busy, `want moved with free RAM: ${idle} idle vs ${busy} busy`);
  },

  // Asking for the same fraction repeatedly must be idempotent, or every cycle
  // would add another quarter of the pool until nothing was left for hacking.
  "asking twice for the same fraction adds nothing the second time": async () => {
    const { managerCore, prepper } = await loadScripts();
    const ns = poolNs();
    const pool = prepper.buildWorkerPool(ns);
    const { want } = managerCore.planShare(pool, 4.0, 0.25, 0);
    assert(managerCore.planShare(pool, 4.0, 0.25, want).deficit === 0,
      "a satisfied want must ask for nothing");
  },

  // Turning share down is the job of the WORKERS - they poll the marker and
  // exit. The manager owning a shrink would mean owning ns.kill (0.50 GB) too.
  "an over-supply is never turned into a negative deficit": async () => {
    const { managerCore, prepper } = await loadScripts();
    const ns = poolNs();
    const pool = prepper.buildWorkerPool(ns);
    const p = managerCore.planShare(pool, 4.0, 0.10, 999999);
    assert(p.deficit === 0, `deficit should floor at 0, got ${p.deficit}`);
  },

  "share off wants no threads at all, however much RAM is free": async () => {
    const { managerCore, prepper } = await loadScripts();
    const ns = poolNs();
    const pool = prepper.buildWorkerPool(ns);
    assert(managerCore.planShare(pool, 4.0, 0, 0).want === 0, "fraction 0 wants nothing");
    assert(managerCore.planShare(pool, 0, 0.25, 0).want === 0, "an unknown thread cost wants nothing");
  },

  // -------------------------------------------------------------- top-up ----

  // getCoreBonus is 1 + (cores - 1) / 16, and home is the only host with more
  // than one core - so a home share thread is worth up to 1.44 of anyone else.
  // It is the one placement in this codebase decided by host identity, not size.
  "the top-up fills home first, then the biggest hosts": async () => {
    const { managerCore, prepper } = await loadScripts();
    const ns = poolNs();
    const pool = prepper.buildWorkerPool(ns);

    const res = managerCore.topUpShare(ns, pool, 4.0, 0.25, 0);
    assert(res.placements[0].host === "home", `home must be first, got ${res.placements[0].host}`);
    const rest = res.placements.slice(1).map((p) => p.host);
    assert(rest.length <= 1 || rest.join(",") === "p0,p1",
      `after home, largest first: got ${rest.join(",")}`);
    assert(res.launched === res.deficit, `launched ${res.launched} of ${res.deficit} wanted`);
  },

  "the top-up hands the same bytes to only one host": async () => {
    const { managerCore, prepper } = await loadScripts();
    const ns = poolNs({ home: 64, p0: 128 });
    const pool = prepper.buildWorkerPool(ns);

    const res = managerCore.topUpShare(ns, pool, 4.0, 0.90, 0);
    for (const p of res.placements) {
      const cap = ns.getServerMaxRam(p.host) / 4.0;
      assert(p.threads <= cap, `${p.host} was given ${p.threads}t, only ${cap} fit`);
    }
    const total = res.placements.reduce((n, p) => n + p.threads, 0);
    assert(total === res.launched, "placements must add up to the launch count");
  },

  // A reservation would be released at the end of a cycle, but a share worker is
  // not - it runs until the marker says stop. Worse, prepGroup refreshes the pool
  // after the hook, and refresh() re-reads the game's used RAM without clearing
  // `pending`: these bytes would be subtracted once as used and again as
  // reserved, and the next prep wave sized against a pool short by all of share.
  "the top-up leaves no reservation behind": async () => {
    const { managerCore, prepper } = await loadScripts();
    const ns = poolNs();
    const pool = prepper.buildWorkerPool(ns);

    const res = managerCore.topUpShare(ns, pool, 4.0, 0.25, 0);
    assert(res.launched > 0, "nothing was launched, so this proves nothing");
    assert(pool.pendingRam === 0,
      `share left ${pool.pendingRam}GB reserved - refresh() will double-count it`);
  },

  // deploy.js has not reached every host the moment a server is bought, and exec
  // returns 0 there. One unreachable host must not stop the rest of the fleet.
  "a host that cannot run the worker is skipped, not fatal": async () => {
    const { managerCore, prepper } = await loadScripts();
    const ns = poolNs();
    const realExec = ns.exec;
    ns.exec = (file, host, ...rest) => (host === "home" ? 0 : realExec(file, host, ...rest));

    const res = managerCore.topUpShare(ns, prepper.buildWorkerPool(ns), 4.0, 0.25, 0);
    assert(res.launched > 0, "the rest of the fleet should still share");
    assert(!res.placements.some((p) => p.host === "home"),
      "home refused the exec, so it must not be recorded as placed");
  },

  // The whole point of the census: workers outlive the manager that started them.
  "a restarted manager adopts the running workers instead of doubling them": async () => {
    const { managerCore, prepper } = await loadScripts();
    const ns = poolNs();

    const first = managerCore.topUpShare(ns, prepper.buildWorkerPool(ns), 4.0, 0.25, 0);
    assert(first.launched > 0, "the first manager launched nothing");

    // Fresh pool, fresh census - exactly what a restarted manager sees.
    const pool = prepper.buildWorkerPool(ns);
    const alive = managerCore.shareCensus(ns, pool.servers.map((s) => s.hostname)).threads;
    assert(alive === first.launched, `census saw ${alive} of ${first.launched} live threads`);

    const second = managerCore.topUpShare(ns, pool, 4.0, 0.25, alive);
    assert(second.launched === 0, `a restart launched ${second.launched} duplicate threads`);
  },
};
