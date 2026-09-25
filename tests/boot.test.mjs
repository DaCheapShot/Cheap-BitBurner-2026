import { loadScripts, assert } from "./harness.mjs";

// Scripts boot runs with runToCompletion - they must EXIT, or the poll loop
// below spins for the full TRANSIENT_TIMEOUT_MS of real wall time. The two
// hacknet sweeps run unconditionally on tick 0 (ticks starts at 0, and
// HACKNET_EVERY divides it), so every runBoot() call exercises them - leaving
// either out of this list hangs the whole suite for real minutes, not just
// fails a test.
const TRANSIENT = [
  "scripts/root.js", "scripts/deploy.js", "scripts/contracts/contracts.js",
  "scripts/hacknet/hacknet.js", "scripts/hacknet/hashes.js",
];

/**
 * Drive boot for a fixed number of ticks against a fake network.
 * Paths are stored WITHOUT a leading slash, exactly as the game does.
 *
 * ps() is host-aware here, unlike the shared mock in mockNs.mjs. It has to be:
 * killOrphanWorkers walks the network and kills by host, and a ps that returned
 * every process for every host would report the same worker once per host and
 * make the count meaningless.
 *
 * @param {string[]} running  scripts already alive on home
 * @param {object[]} workers  {filename, host, threads} already alive out on the
 *                            network, as a killed manager's batches would be
 */
async function runBoot({
  args = [], files = {}, running = [], workers = [], ticks = 3, hasFormulas = false,
  inGang = false, onTprint = () => {}, onTick = (_tick, procs) => procs, onSleep = () => {},
}) {
  const { main } = (await loadScripts())["boot"];
  let procs = running.map((f, i) => ({ filename: f, host: "home", pid: i + 1, args: [], threads: 1 }));
  let nextPid = procs.length + 1;
  for (const w of workers) {
    procs.push({ filename: w.filename, host: w.host, pid: nextPid++, args: [], threads: w.threads ?? 1 });
  }

  const network = ["home", ...new Set(workers.map((w) => w.host))].filter((h) => h !== undefined);
  let tick = 0;
  const launched = [];
  const killed = [];
  const logs = [];
  const store = { ...files };
  if (hasFormulas) store["home:Formulas.exe"] = "x";

  const ns = {
    args, disableLog: () => {}, ui: { openTail: () => {} },
    // Boot's own pid, above anything in `running`: the boot under test is the
    // one just typed, so every boot.js already listed there is older.
    pid: 9000,
    // Default OFF, which is every BitNode before gangs are available. boot
    // gates the gang service on this rather than starting it blind: without a
    // gang the supervisor exits at once, and ensureService would relaunch it
    // every tick forever.
    gang: { inGang: () => inGang },
    print: (msg) => logs.push(String(msg)), tprint: (msg) => onTprint(String(msg)),
    read: (f) => store[f] ?? "",
    write: (f, d) => { store[f] = d; },
    fileExists: (f, host = "home") => Boolean(store[`${host}:${f}`]),
    scan: (h) => (h === "home" ? network.filter((x) => x !== "home") : []),
    ps: (host = "home") => procs.filter((p) => p.host === host).map((p) => ({ ...p })),
    kill: (pid) => { killed.push(procs.find((p) => p.pid === pid)?.filename); procs = procs.filter((p) => p.pid !== pid); return true; },
    run: (file, threads, ...a) => {
      const stored = file.replace(/^\/+/, "");
      launched.push(stored);
      procs.push({ filename: stored, host: "home", pid: nextPid, life: 2, args: a, threads: 1 });
      return nextPid++;
    },
    sleep: async (ms) => {
      if (ms >= 1000) onSleep(ms);
      for (const p of procs) if (TRANSIENT.includes(p.filename)) p.life--;
      procs = procs.filter((p) => !TRANSIENT.includes(p.filename) || (p.life ?? 99) > 0);
      if (ms >= 1000) { tick++; if (tick >= ticks) throw new Error("STOP"); procs = onTick(tick, procs, store); }
      await new Promise((r) => setTimeout(r, 1));
    },
  };

  try { await main(ns); } catch (e) { if (e.message !== "STOP") throw e; }
  return { launched, killed, procs, store, logs };
}

/** A killed manager's batches, still running out on the network. */
const ORPHANS = [
  { filename: "scripts/hack.js", host: "p0", threads: 400 },
  { filename: "scripts/grow.js", host: "p0", threads: 900 },
  { filename: "scripts/weaken.js", host: "p1", threads: 200 },
];

export const tests = {
  // --no-manager KILLS NOTHING: killDuplicates for managers lives inside
  // ensureOneManager, which that branch skips. So the marker clear on it has to
  // be gated on liveness, or a boot run beside a live batcher - which is the
  // whole point of the flag - blanks the target list its manager owns.
  // hashes.js would then report "no targets published - no manager is running"
  // until the next rescan republished it. Behavioural rather than a source
  // regex, so deleting the guard reddens this.
  "--no-manager leaves a live manager's published targets alone": async () => {
    const r = await runBoot({
      args: ["--no-manager"],
      running: ["scripts/continuous/manager.js"],
      files: { "/data/targets.txt": "phantasy\n" },
      ticks: 1,
    });
    assert(r.store["/data/targets.txt"] === "phantasy\n",
      `a live manager's targets were cleared: ${JSON.stringify(r.store["/data/targets.txt"])}`);
  },

  // The positive control for the test above: with no manager of any system up,
  // nothing will publish this run, so a previous boot's list is stale and the
  // clear must still happen. Without this, "never clear" would pass.
  "--no-manager with no manager running clears a stale target list": async () => {
    const r = await runBoot({
      args: ["--no-manager"],
      files: { "/data/targets.txt": "phantasy\n" },
      ticks: 1,
    });
    assert(r.store["/data/targets.txt"] === "",
      `a stale target list survived with no manager up: ${JSON.stringify(r.store["/data/targets.txt"])}`);
  },
  // Two boots with different flags each read the OTHER's manager as a rival and
  // kill it, every tick, forever - a live run swapped shotgun and continuous
  // once a minute, killing 262 threads of workers each time. The newest boot is
  // the one just typed, so it wins; the old one's managers are then handled by
  // the normal swap.
  "a new boot stops any older boot": async () => {
    const r = await runBoot({ running: ["scripts/boot.js"], ticks: 1 });
    assert(r.killed.includes("scripts/boot.js"), `the older boot should be stopped, killed: ${r.killed}`);
    assert(!r.procs.some((p) => p.filename === "scripts/boot.js"), "an older boot survived");
  },

  // MANAGERS became a list per system and this check kept reading .analyze and
  // .formulas off it - both undefined - so it logged "manager is not running"
  // every tick while the manager ran fine, and cried wolf on the one line whose
  // job is to notice a real exit.
  "a running manager is not reported as exited": async () => {
    const r = await runBoot({ ticks: 3 });
    assert(!r.logs.some((l) => l.includes("is not running")),
      `a live manager was reported dead: ${r.logs.filter((l) => l.includes("not running"))}`);
  },

  "a manager that did exit is reported": async () => {
    // The manager dies on its own after the first tick.
    const r = await runBoot({
      ticks: 3,
      onTick: (t, procs) => (t === 1 ? procs.filter((p) => !p.filename.includes("manager")) : procs),
    });
    assert(r.logs.some((l) => l.includes("is not running")), `the exit was not reported: ${r.logs}`);
  },

  // Adding a worker file roots nothing, so ROOT_MARKER never moves, so deploy
  // never runs and the file sits on home while every host runs without it. The
  // only symptom is exec returning a bare 0 far away - share.js ran on one host
  // out of 69 that way, twice, the second time after a manual deploy.
  "a changed worker set triggers a redeploy on its own": async () => {
    const { DEPLOY_LIST, DEPLOY_MANIFEST } = (await loadScripts())["config"];

    // Steady state: manifest already records exactly what boot wants.
    const settled = await runBoot({
      files: { [DEPLOY_MANIFEST]: DEPLOY_LIST.join(" ") },
      hasFormulas: false, ticks: 3,
    });
    const deploys = settled.launched.filter((f) => f === "scripts/deploy.js").length;
    assert(deploys === 1, `only the first pass should deploy, got ${deploys}`);

    // A worker file was added since the last broadcast.
    const stale = await runBoot({
      files: { [DEPLOY_MANIFEST]: "scripts/hack.js" },
      hasFormulas: false, ticks: 3,
    });
    assert(stale.launched.filter((f) => f === "scripts/deploy.js").length > 1,
      "a manifest missing a worker should force a redeploy every tick until it is fixed");
  },

  // The failure that outlasted the first fix. deploy.js records the list it
  // ACTUALLY broadcast, so a mismatch surviving a run means the copy of
  // deploy.js inside the game is older than the one on disk - filesync has not
  // delivered it, and re-running it cannot help. This repo's most expensive
  // recurring failure, which until now had no detector at all.
  "a stale in-game deploy.js is named rather than retried forever": async () => {
    const { DEPLOY_MANIFEST } = (await loadScripts())["config"];
    const said = [];

    const r = await runBoot({
      // deploy runs, but the manifest never catches up - exactly what an older
      // deploy.js with a shorter DEPLOY_LIST would leave behind.
      files: { [DEPLOY_MANIFEST]: "scripts/hack.js" },
      hasFormulas: false, ticks: 2, onTprint: (s) => said.push(s),
    });

    assert(r.launched.includes("scripts/deploy.js"), "deploy should have been attempted");
    assert(said.some((s) => /older than the one on disk/.test(s)),
      `boot should name the stale copy, said: ${JSON.stringify(said)}`);
  },

  // Neither system has a formulas BUILD any more: each math module picks per
  // process, and the continuous one re-checks every rescan. So owning
  // Formulas.exe must not change which file boot runs.
  "with Formulas, boot still launches the one continuous manager": async () => {
    const r = await runBoot({ files: {}, hasFormulas: true });
    assert(r.launched.includes("scripts/continuous/manager.js"),
      `expected continuous/manager.js, launched: ${r.launched}`);
    assert(!r.launched.includes("scripts/continuous/manager-formulas.js"),
      "manager-formulas.js is retired and must never be started");
  },

  // What used to be a swap is now nothing at all - the running manager
  // switches backend at its next rescan. Killing it would cost its whole
  // pipeline for no reason.
  "buying Formulas leaves the running manager alone": async () => {
    const r = await runBoot({ hasFormulas: true, running: ["scripts/continuous/manager.js"] });
    assert(!r.killed.includes("scripts/continuous/manager.js"),
      `the manager should be kept, killed: ${r.killed}`);
    assert(!r.launched.some((f) => f.startsWith("scripts/continuous/manager")),
      `nothing should be relaunched, launched: ${r.launched}`);
  },

  "--no-formulas reaches the continuous manager": async () => {
    const r = await runBoot({ args: ["--no-formulas"], hasFormulas: true });
    const proc = r.procs.find((x) => x.filename === "scripts/continuous/manager.js");
    assert(proc, `continuous/manager.js should be running, procs: ${r.procs.map((x) => x.filename)}`);
    assert(proc.args.includes("--no-formulas"),
      `--no-formulas must be forwarded, got args: ${JSON.stringify(proc.args)}`);
  },

  // filesync never deletes from the game, so the retired formulas build is
  // still on home - and possibly still RUNNING from before the upgrade. The
  // continuous manager aborts beside any rival, so one left alive would stop
  // the new manager starting, once a tick, forever.
  "a retired manager-formulas.js still running is stopped": async () => {
    const r = await runBoot({ running: ["scripts/continuous/manager-formulas.js"] });
    assert(r.killed.includes("scripts/continuous/manager-formulas.js"),
      `the retired build should be stopped, killed: ${r.killed}`);
    assert(r.launched.includes("scripts/continuous/manager.js"), "the one manager should start");
  },

  // A manager killed mid-volley leaves hundreds of batches running. They hold
  // the RAM the replacement needs - a live swap left 2.7TB reserved, and the new
  // manager could not prep its target - and they keep hacking and growing that
  // target on a plan nobody owns any more.
  "swapping managers kills the workers the old one left behind": async () => {
    const r = await runBoot({
      hasFormulas: true,
      running: ["scripts/continuous/manager-formulas.js"], workers: ORPHANS,
    });
    assert(r.killed.includes("scripts/continuous/manager-formulas.js"), "the retired build should be stopped");
    for (const w of ORPHANS) {
      assert(r.killed.includes(w.filename), `${w.filename} should have been killed, killed: ${r.killed}`);
    }
    assert(!r.procs.some((p) => p.filename.endsWith("hack.js")), "a worker survived the swap");
    assert(r.launched.includes("scripts/continuous/manager.js"), "the continuous manager should start");
  },

  // Share workers are NOT in WORKER_LIST, and that is deliberate: none of the
  // reasoning behind killOrphanWorkers applies to them. They are tied to no
  // target, so they cannot churn a server nobody owns; they hold a bounded
  // fraction of the pool rather than a whole volley's worth; and the incoming
  // manager adopts them through shareCensus instead of launching duplicates.
  // Killing them would drop the reputation bonus for a tick and buy nothing.
  "a manager swap spares the share workers": async () => {
    const r = await runBoot({
      hasFormulas: true,
      running: ["scripts/continuous/manager-formulas.js"],
      workers: [...ORPHANS, { filename: "scripts/share.js", host: "p1", threads: 2921 }],
    });
    assert(!r.killed.includes("scripts/share.js"),
      `share workers must survive a build swap, killed: ${r.killed}`);
    assert(r.procs.some((p) => p.filename === "scripts/share.js"),
      "the share worker should still be running after the swap");
  },

  // The dangerous mistake is killing workers whenever a manager is killed:
  // killDuplicates keeps a survivor whose own volley is in flight, and its
  // workers are indistinguishable from a dead manager's without reading batch
  // ids out of argv. Only a swap that leaves NO manager may clear the network.
  "deduplicating managers leaves the survivor's workers alone": async () => {
    const r = await runBoot({
      hasFormulas: false,
      running: ["scripts/continuous/manager.js", "scripts/continuous/manager.js"], workers: ORPHANS,
    });
    assert(r.killed.includes("scripts/continuous/manager.js"), "the duplicate should be killed");
    assert(r.procs.filter((p) => p.filename === "scripts/continuous/manager.js").length === 1,
      "exactly one manager should survive");
    for (const w of ORPHANS) {
      assert(!r.killed.includes(w.filename),
        `${w.filename} belongs to the surviving manager and must not be killed`);
    }
  },

  "a swap with nothing in flight kills nothing extra": async () => {
    const r = await runBoot({
      hasFormulas: true,
      running: ["scripts/continuous/manager-formulas.js"],
    });
    assert(r.killed.filter(Boolean).join(",") === "scripts/continuous/manager-formulas.js",
      `only the old manager should be killed, killed: ${r.killed}`);
  },

  // ------------------------------------------------------ retired shotgun --

  "boot runs the continuous batcher": async () => {
    const r = await runBoot({ hasFormulas: false });
    assert(r.launched.includes("scripts/continuous/manager.js"),
      `expected the continuous manager, launched: ${r.launched}`);
    assert(!r.launched.includes("scripts/manager.js"),
      "the retired shotgun must never be started");
  },

  // manager.js was the shotgun batcher. It is gone from disk but filesync never
  // deletes from the game, so a copy can still be running. scripts/continuous/
  // core.js findRivals REFUSES to start beside it, so a survivor does not merely
  // coexist - the incoming manager aborts and exits, boot sees no manager next
  // tick, starts it again, and watches it abort again. Once a minute, forever,
  // earning nothing. Both systems ran the same worker files, so its in-flight
  // batches are cleared as orphans too.
  "a retired shotgun manager still running is stopped": async () => {
    const r = await runBoot({
      hasFormulas: false,
      running: ["scripts/manager.js"], workers: ORPHANS,
    });
    assert(r.killed.includes("scripts/manager.js"),
      `the retired shotgun is a rival and must be stopped, killed: ${r.killed}`);
    assert(r.launched.includes("scripts/continuous/manager.js"), "continuous should start");
    for (const w of ORPHANS) {
      assert(r.killed.includes(w.filename),
        `${w.filename} would hold RAM for a weaken window against a plan nobody owns`);
    }
  },

  // Passed through rather than interpreted.
  "--target and --targets reach the manager": async () => {
    const r = await runBoot({
      args: ["--target", "phantasy", "--targets", "5"],
      hasFormulas: false,
    });
    const mgr = r.procs.find((p) => p.filename === "scripts/continuous/manager.js");
    assert(mgr, `the continuous manager should be running, procs: ${r.procs.map((p) => p.filename)}`);
    assert(mgr.args.join(" ") === "--target phantasy --targets 5",
      `both flags should be forwarded, got: ${JSON.stringify(mgr.args)}`);
  },

  // The gang supervisor exits immediately when there is no gang, so starting it
  // unconditionally would relaunch it on every tick forever - the same trap
  // CLOUD_DONE_MARKER exists to close for cloud.js. ns.gang.inGang() is 0 GB,
  // so gating on it costs boot nothing on the BitNodes that never have one.
  "boot does not start the gang supervisor without a gang": async () => {
    const r = await runBoot({ inGang: false, ticks: 3 });
    assert(!r.launched.includes("scripts/gang/gang.js"),
      `nothing should have started the gang supervisor, launched: ${r.launched}`);
  },

  "boot starts the gang supervisor once, and adopts it afterwards": async () => {
    const r = await runBoot({ inGang: true, ticks: 4 });
    const starts = r.launched.filter((f) => f === "scripts/gang/gang.js").length;
    assert(starts === 1,
      `the supervisor should be started once and then found running, got ${starts} starts`);
    assert(r.procs.some((p) => p.filename === "scripts/gang/gang.js"), "it should still be up");
  },

  "--no-gang leaves the gang alone": async () => {
    const r = await runBoot({ inGang: true, args: ["--no-gang"], ticks: 3 });
    assert(!r.launched.includes("scripts/gang/gang.js"),
      `--no-gang should suppress it, launched: ${r.launched}`);
  },

  // Always on, unlike the gang: there is no 0 GB availability check to gate on,
  // and none is needed - sing.js parks without Source-File 4 instead of exiting,
  // so there is no relaunch loop for a gate to prevent.
  "boot starts the singularity supervisor by default, once": async () => {
    const r = await runBoot({ ticks: 4 });
    const starts = r.launched.filter((f) => f === "scripts/sing/sing.js").length;
    assert(starts === 1, `sing should be started once and then adopted, got ${starts} starts`);
    assert(r.procs.some((p) => p.filename === "scripts/sing/sing.js"), "it should still be up");
  },

  "--no-sing leaves singularity alone": async () => {
    const r = await runBoot({ args: ["--no-sing"], ticks: 3 });
    assert(!r.launched.includes("scripts/sing/sing.js"),
      `--no-sing should suppress it, launched: ${r.launched}`);
  },

  // The contract solver is a TRANSIENT, not a service - the opposite of the gang
  // supervisor above. It does one sweep and exits, so boot runs it EVERY tick
  // and nothing is held in between. A service would pin 4.10 GB forever to
  // re-read a clock that only matters once every ten minutes.
  "boot runs the contract solver every tick, and holds nothing between": async () => {
    const r = await runBoot({ ticks: 4 });
    const runs = r.launched.filter((f) => f === "scripts/contracts/contracts.js").length;
    assert(runs >= 3, `expected a run per tick, got ${runs}: ${r.launched}`);
    assert(!r.procs.some((p) => p.filename === "scripts/contracts/contracts.js"),
      "it must not still be resident - that is the RAM this change exists to give back");
  },

  "--no-contracts leaves the contract solver alone": async () => {
    const r = await runBoot({ args: ["--no-contracts"], ticks: 3 });
    assert(!r.launched.includes("scripts/contracts/contracts.js"),
      `--no-contracts should suppress it, launched: ${r.launched}`);
  },

  // The live switches (scripts/set.js X.enabled off). Unlike the --no-X flags
  // they STOP a running resident, and they are re-read every tick - so a switch
  // flipped mid-run lands on the next tick with no boot restart.
  "a switch turned off mid-run stops the running resident": async () => {
    const r = await runBoot({
      inGang: true, ticks: 4,
      onTick: (tick, procs, store) => {
        if (tick === 2) store["/data/settings.txt"] = JSON.stringify({ "gang.enabled": 0, "cloud.enabled": 0 });
        return procs;
      },
    });
    for (const f of ["scripts/gang/gang.js", "scripts/cloud.js"]) {
      assert(r.launched.includes(f), `${f} should have run before the switch`);
      assert(r.killed.includes(f), `${f} should have been stopped, killed: ${r.killed}`);
      assert(!r.procs.some((p) => p.filename === f), `${f} is still running`);
    }
    assert(r.logs.some((l) => l.includes("switched off")), "the stop should be logged");
  },

  "sing switched off is stopped AND its share hold released": async () => {
    const r = await runBoot({
      running: ["scripts/sing/sing.js"], ticks: 2,
      files: { "/data/settings.txt": '{"sing.enabled":0}', "/data/share-hold.txt": "hold" },
    });
    assert(r.killed.includes("scripts/sing/sing.js"), `sing should be stopped, killed: ${r.killed}`);
    assert(!r.launched.includes("scripts/sing/sing.js"), "and not relaunched");
    assert(r.store["/data/share-hold.txt"] === "", "a dead sing cannot release its hold, so boot must");
  },

  "transients switched off are skipped": async () => {
    const r = await runBoot({
      ticks: 3, files: { "/data/settings.txt": '{"hacknet.enabled":0,"contracts.enabled":0}' },
    });
    for (const f of ["scripts/hacknet/hacknet.js", "scripts/hacknet/hashes.js", "scripts/contracts/contracts.js"]) {
      assert(!r.launched.includes(f), `${f} should not run while off, launched: ${r.launched}`);
    }
  },

  "a switch turned back on restarts the service": async () => {
    const r = await runBoot({
      ticks: 4, files: { "/data/settings.txt": '{"sing.enabled":0}' },
      onTick: (tick, procs, store) => {
        if (tick === 2) store["/data/settings.txt"] = "{}";
        return procs;
      },
    });
    assert(r.launched.includes("scripts/sing/sing.js"), `sing should start once switched back on: ${r.launched}`);
  },

  // boot.tick and hacknet.every are re-read every tick, and --interval still
  // pins the tick over the setting.
  "boot.tick is live, and --interval overrides it": async () => {
    const slept = [];
    await runBoot({
      ticks: 3, files: { "/data/settings.txt": '{"boot.tick":30}' },
      onTick: (tick, procs, store) => { if (tick === 1) store["/data/settings.txt"] = '{"boot.tick":45}'; return procs; },
      onSleep: (ms) => slept.push(ms),
    });
    assert(slept.includes(30000) && slept.includes(45000), `expected 30s then 45s ticks, slept ${slept}`);
    slept.length = 0;
    await runBoot({
      ticks: 2, args: ["--interval", "7000"], files: { "/data/settings.txt": '{"boot.tick":30}' },
      onSleep: (ms) => slept.push(ms),
    });
    assert(slept.includes(7000) && !slept.includes(30000), `--interval should win, slept ${slept}`);
  },

  "hacknet.every changes the sweep cadence": async () => {
    const r = await runBoot({ ticks: 6, files: { "/data/settings.txt": '{"hacknet.every":3}' } });
    const runs = r.launched.filter((f) => f === "scripts/hacknet/hacknet.js").length;
    assert(runs === 2, `every 3rd of 6 ticks is 2 sweeps, got ${runs}`);
  },

  "boot logs overrides at start and each change as it lands": async () => {
    const r = await runBoot({
      ticks: 3, files: { "/data/settings.txt": '{"boot.tick":30}' },
      onTick: (tick, procs, store) => {
        if (tick === 1) store["/data/settings.txt"] = '{"boot.tick":30,"gang.enabled":0}';
        return procs;
      },
    });
    assert(r.logs.some((l) => l.includes("settings (vs default): boot.tick 60 -> 30")),
      `start line missing: ${r.logs.join(" | ")}`);
    const changes = r.logs.filter((l) => l.includes("settings changed"));
    assert(changes.length === 1 && changes[0].includes("gang.enabled on -> off") && !changes[0].includes("boot.tick"),
      `expected one line naming only the gang switch: ${changes}`);
  },
};
