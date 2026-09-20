import { readScript, assert, loadScripts, scriptNames, scriptFiles } from "./harness.mjs";

// Verified against src/Netscript/RamCostGenerator.ts in this fork.
const COST = {
  scan: 0.2, hack: 0.1, grow: 0.15, weaken: 0.15,
  hackAnalyze: 1, hackAnalyzeSecurity: 1, hackAnalyzeThreads: 1, hackAnalyzeChance: 1,
  growthAnalyze: 1, growthAnalyzeSecurity: 1, weakenAnalyze: 1,
  exec: 1.3, run: 1, spawn: 2, scp: 0.6, kill: 0.5, killall: 0.5,
  hasRootAccess: 0.05, getHostname: 0.05, getHackingLevel: 0.05,
  getServer: 2, getServerMoneyAvailable: 0.1, getServerSecurityLevel: 0.1,
  getServerMinSecurityLevel: 0.1, getServerMaxMoney: 0.1,
  getServerRequiredHackingLevel: 0.1, getServerNumPortsRequired: 0.1,
  getServerGrowth: 0.1, getServerMaxRam: 0.05, getServerUsedRam: 0.05,
  fileExists: 0.1, isRunning: 0.1, ps: 0.2, ls: 0.2,
  getScriptRam: 0.1, getHackTime: 0.05, getGrowTime: 0.05, getWeakenTime: 0.05,
  getPlayer: 0.5, getFavorToDonate: 0.1, getBitNodeMultipliers: 4, nuke: 0.05, brutessh: 0.05, ftpcrack: 0.05,
  relaysmtp: 0.05, httpworm: 0.05, sqlinject: 0.05,
  share: 2.4, getSharePower: 0.2,
  // The fork's ns.cloud namespace, which replaces vanilla's top-level purchased
  // server functions. findFunc in RamCalculations.ts searches RamCosts
  // RECURSIVELY by bare name, so a namespaced function is charged by its last
  // segment exactly like a top-level one.
  getServerLimit: 0.05, getRamLimit: 0.05, getServerCost: 0.25,
  getServerUpgradeCost: 0.1, getServerNames: 1.05, upgradeServer: 0.25,
  purchaseServer: 2.25, deleteServer: 2.25,
  // ns.gang, every entry priced off RamCostConstants.GangApiBase = 4 - the
  // table in RamCostGenerator.ts is written as GangApiBase, /2 and /4.
  //
  // respectForNextRecruit is the one to watch: it is BOTH a 1.00 GB function
  // and a field on GangGenInfo, so `info.respectForNextRecruit` costs a full
  // API call for a number already in hand. gang.js's tick body reads it as a computed key
  // for that reason. getMemberInformation's `hack` field is the same class of
  // trap at 0.10 GB, which is what STAT_KEYS in gang/config.js exists to dodge.
  createGang: 1, getMemberNames: 1, canRecruitMember: 1, getRecruitsAvailable: 1,
  respectForNextRecruit: 1, getTaskStats: 1,
  getGangInformation: 2, getAllGangInformation: 2, getMemberInformation: 2,
  recruitMember: 2, setMemberTask: 2, getEquipmentCost: 2, getEquipmentType: 2,
  getEquipmentStats: 2, getAscensionResult: 2, getInstallResult: 2,
  setTerritoryWarfare: 2,
  purchaseEquipment: 4, ascendMember: 4, getChanceToWinClash: 4,
  // Free, and listed so their absence reads as verified rather than forgotten.
  // nextUpdate is RamCostConstants.CycleTiming, which is 0.
  inGang: 0, nextUpdate: 0, getBonusTime: 0, getTaskNames: 0,
  getEquipmentNames: 0, renameMember: 0,
  // ns.codingcontract, priced off RamCostConstants.CodingContractBase = 10.
  // Every one of these is a NAME to avoid in scripts/contracts/solvers.js,
  // which has to stay at exactly BASE - `getData` alone would be 5.00 GB.
  attempt: 10, getContract: 15, getContractType: 5, getData: 5,
  getDescription: 5, getNumTriesRemaining: 2, createDummyContract: 2,
  getContractTypes: 0,
  // The clock the contract gate reads. lastAugReset / lastNodeReset are the
  // only route to it: ns.getPlayer() carries totalPlaytime, not
  // playtimeSinceLastAug.
  getResetInfo: 1,
  // ns.singularity, the WHOLE namespace rather than what sing/ calls, so a later
  // phase cannot collide with a name nobody thought to add. At BitNode 4's 1x:
  // SF4Cost() in RamCostGenerator.ts returns the base cost when bitNodeN === 4,
  // and the base is SingularityFn1 = 2, Fn2 = 3, Fn3 = 5 and their fractions.
  // Outside BN4 the game multiplies these by 16/4/1 by SF4 level - but only the
  // rpc transients hold them, so no resident pin here depends on which.
  //
  // `connect` (2.00) and `cat` (0.50) are the realistic accidents: obvious local
  // names in any routing or file code. connect is in BANNED below.
  universityCourse: 2, gymWorkout: 2, travelToCity: 2, goToLocation: 5,
  purchaseTor: 2, purchaseProgram: 2, getCurrentServer: 2,
  getCompanyPositionInfo: 2, getCompanyPositions: 2, cat: 0.5, connect: 2,
  manualHack: 2, installBackdoor: 2, getDarkwebProgramCost: 0.5, getDarkwebPrograms: 0.5,
  hospitalize: 0.5, isBusy: 0.5, stopAction: 1, upgradeHomeRam: 3, upgradeHomeCores: 3,
  getUpgradeHomeRamCost: 1.5, getUpgradeHomeCoresCost: 1.5, workForCompany: 3,
  applyToCompany: 3, quitJob: 3, getCompanyRep: 1, getCompanyFavor: 1,
  getCompanyFavorGain: 0.75, getFactionInviteRequirements: 3, getFactionEnemies: 3,
  checkFactionInvitations: 3, joinFaction: 3, workForFaction: 3, getFactionWorkTypes: 1,
  getFactionRep: 1, getFactionFavor: 1, getFactionFavorGain: 0.75, donateToFaction: 5,
  createProgram: 5, getHackingLevelRequirementOfProgram: 5, commitCrime: 5,
  getCrimeChance: 5, getCrimeStats: 5, getOwnedAugmentations: 5, getOwnedSourceFiles: 5,
  getAugmentationFactions: 5, getAugmentationsFromFaction: 5, getAugmentationPrereq: 5,
  getAugmentationPrice: 2.5, getAugmentationBasePrice: 2.5, getAugmentationRepReq: 2.5,
  getAugmentationStats: 5, purchaseAugmentation: 5, softReset: 5, installAugmentations: 5,
  isFocused: 0.1, setFocus: 0.1, getSaveData: 1, exportGame: 1, exportGameBonus: 0.5,
  b1tflum3: 16, destroyW0r1dD43m0n: 32, getCurrentWork: 0.5, getUnlockedAchievements: 5,
  // Top-level, not ns.singularity, but only the singularity bodies reach for it.
  hasTorRouter: 0.05,
  // probe is this fork's ns.dnet.probe.
  probe: 0.2, disableLog: 0,
  // Not functions. RamCalculations.ts resolves a ref named `window` or
  // `document` to RamCostConstants.Dom and adds it, whatever the ref really is.
  window: 25, document: 25,
};
const BASE = 1.6;

/**
 * Blank out comments and every kind of string literal, leaving code.
 *
 * Literals are Literal nodes to the game's parser and cost nothing, so counting
 * them would flag "run scripts/deploy.js first" in a tprint as 1.00 GB of ns.run.
 * Replaced with spaces rather than removed so nothing on either side joins up
 * into a new identifier.
 */
function codeOnly(src) {
  const blank = (m) => " ".repeat(m.length);
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/.*$/gm, blank)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, blank)
    .replace(/"(?:\\.|[^"\\])*"/g, blank)
    .replace(/'(?:\\.|[^'\\])*'/g, blank);
}

function closure(bare, seen = new Set()) {
  if (seen.has(bare)) return seen;
  seen.add(bare);
  // Comments stripped, strings KEPT - an import specifier is a string literal,
  // so codeOnly() would blank the very thing this is looking for. The strip is
  // needed because continuous/config.js shows `import { ServerPool } from
  // "scripts/continuous/lib/server"` inside a doc comment as an example, and
  // following that charged boot.js 0.15 GB for a module it does not import.
  const src = readScript(bare)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  // Two import spellings. Top-level scripts use "./name.js"; the continuous
  // tree imports by absolute in-game path, "scripts/continuous/lib/plan".
  //
  // "./name.js" resolves against the IMPORTER'S directory, not scripts/. Until
  // the gang subtree existed nothing nested used the relative form, so the old
  // version read gang/tick.js's `from "./math.js"` as scripts/math.js and threw
  // ENOENT. Resolving it properly is also what lets a nested module import a
  // sibling at all.
  const dir = bare.includes("/") ? bare.slice(0, bare.lastIndexOf("/") + 1) : "";
  for (const m of src.matchAll(/from\s+"\.\/([\w\-/]+)\.js"/g)) closure(dir + m[1], seen);
  // The optional ".js" matters: a re-export must spell it (see the export-from
  // test below), and without it here closure() silently skipped the module.
  for (const m of src.matchAll(/from\s+"scripts\/([\w\-/]+?)(?:\.js)?"/g)) closure(m[1], seen);
  return seen;
}


/**
 * Sum what the game would charge an entry script and its import closure.
 *
 * This counts IDENTIFIERS, not call sites, because that is what the game does.
 * From src/Script/RamCalculations.ts in this fork: addRef does `s.add(name)` -
 * commented "For builtins like hack." - and the MemberExpression visitor walks
 * node.object AND node.property. So a local named `share`, a parameter named
 * `window` or a loop counter named `attempt` is billed exactly like a call.
 *
 * The previous version of this function matched only `ns.fn(`. It was therefore
 * blind to the whole class, and reported continuous/manager-formulas.js at
 * 9.00 GB while the game charged 48.00 and refused to start it on a 32 GB home:
 * 25.00 for a parameter named `window`, 10.00 for a counter named `attempt`,
 * 2.40 for a local named `share`, 1.00 for an export named `run`, 0.20 for a
 * local named `probe`.
 *
 * ponytail: regex, not a parser - no package.json here by design, so there is no
 * acorn to walk with. Two known differences from the game, both harmless:
 * non-computed object KEYS are skipped below (the game does not walk them
 * either), and a `${}` interpolation inside a template literal is blanked along
 * with the literal, so an ns call made only from inside one would be missed.
 * Write such a call outside the template if that ever matters.
 */
function ramOf(bare) {
  const refs = new Set();
  for (const mod of closure(bare)) addRefs(codeOnly(readScript(mod)), refs);
  return BASE + [...refs].reduce((n, f) => n + COST[f], 0);
}

/** Every billed name in `code` (already through codeOnly), added to `refs`. */
function addRefs(code, refs) {
  // The optional leading dot is the MemberExpression case: `times.hack` is
  // charged for `hack` just as a bare `hack` would be.
  for (const m of code.matchAll(/(?<![\w$])(\.?)([A-Za-z_$][\w$]*)\s*(:?)/g)) {
    const [, dot, name, colon] = m;
    // hasOwn, not a truthiness check: COST inherits `constructor`, `toString`
    // and the rest of Object.prototype, and every one of them appears in real
    // code. The game skips the same list, by name, in parseOnlyCalculateDeps.
    if (!Object.hasOwn(COST, name)) continue;
    // `{ hack: 1.70 }` costs nothing: acorn-walk's Property visitor walks the
    // key only when it is computed. A dotted name is never a key.
    if (colon && !dot) continue;
    refs.add(name);
  }
  return refs;
}

/**
 * What the game charges the transient each rpc body in `bare` runs in: BASE
 * plus every billed name in the body, keyed by the body's const name. A body's
 * own imports are 0 GB modules pinned separately, so they are not followed.
 *
 * ramOf() cannot see a body - to it the whole thing is one template literal,
 * blanked by codeOnly(). This is the only place a body is priced before the
 * game does it.
 */
function bodiesOf(bare) {
  const out = {};
  for (const m of readScript(bare).matchAll(/\bconst\s+([A-Z_]+)\s*=\s*`([\s\S]*?)`;/g)) {
    out[m[1]] = BASE + [...addRefs(codeOnly(m[2]), new Set())].reduce((n, f) => n + COST[f], 0);
  }
  return out;
}

export const tests = {
  // 6.15 before share mode; ps (0.20) pays for the census that stops a restarted
  // manager double-launching share workers, and getSharePower (0.20) for the only
  // reading of the bonus that includes the intelligence and home-core multipliers.
  //
  // 0.40 of the total is `hack`, `grow` and `weaken` read as PROPERTY names -
  // times.hack, ram.grow, threads.weaken1. The game charges those like calls.
  // Left alone: they are the clearest names available for what they hold, and
  // 0.40 GB does not buy renaming eight files' worth of them.
  // 6.95 before rpc.js, 7.95 with only the startup constants moved, 5.40 now
  // that mathAnalyze reaches the *Analyze API entirely through rpc bodies. The
  // whole of its 2.55 is gone and what remains of it is the 1.00 GB ns.run.
  //
  // Two round trips per cycle buy that, not seven: snapshot() bundles the four
  // getServer* fields, the three op times, hackAnalyze and the growth constant
  // into one call, and maxMoneyOfAll asks about the whole network in another.
  // Everything downstream reads the snapshot and stays synchronous.
  "manager.js (analyze) costs 5.40 GB": () => {
    const ram = ramOf("manager");
    assert(Math.abs(ram - 5.40) < 0.011, `expected 5.40 GB, got ${ram.toFixed(2)}`);
  },

  // 6.55 before. Same story as manager.js, one module further down.
  "prep.js (analyze) costs 5.00 GB": () => {
    const ram = ramOf("prep");
    assert(Math.abs(ram - 5.00) < 0.011, `expected 5.00 GB, got ${ram.toFixed(2)}`);
  },

  // The pair this replaced cost 6.95 and 6.90, and one of them was always
  // wrong for the current state of Formulas.exe.
  "one shotgun manager replaced the pair": () => {
    assert(!scriptNames().includes("manager-formulas"),
      "manager-formulas.js should be gone - math.js picks the backend per process");
    assert(!scriptNames().includes("prep-formulas"), "prep-formulas.js should be gone too");
    assert(!scriptNames().includes("mathAnalyze") && !scriptNames().includes("mathFormulas"),
      "the twin math modules should be gone - scripts/math.js holds both");
  },

  // Charged PER THREAD, and the manager places tens of thousands of them, so a
  // stray import costs more here than anywhere else in the repo: pulling in
  // ram.js would add 0.35 GB to every single thread.
  //
  // It must import NOTHING, like the three batch workers. A worker's imports have
  // to exist on every host it runs on, and importing config.js for one constant
  // made exec return 0 on all 68 hosts that lacked it. The port number arrives as
  // an argument instead.
  "share.js is exactly 4.00 GB and imports nothing": () => {
    const ram = ramOf("share");
    assert(Math.abs(ram - 4.00) < 0.011, `expected 4.00 GB, got ${ram.toFixed(2)}`);
    assert(!readScript("share").includes('from "./'),
      "share.js must import nothing - its imports would have to exist on every host it runs on");
  },

  // The bug that survived every other check. ns.read resolves against the server
  // the calling script runs on (NetscriptFunctions.ts: `const server =
  // ctx.workerScript.getServer()`), so a worker reading /data/share.txt sees ""
  // on every host but home, treats it as off, and exits milliseconds after exec
  // returned it a perfectly valid pid. The manager counted 66 hosts sharing while
  // 65 had already quit.
  //
  // No worker may read a file. Their settings arrive on ports, which are global.
  "no worker depends on host-local files": () => {
    for (const w of ["hack", "grow", "weaken", "share"]) {
      const src = readScript(w).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert(!/\bns\.read\s*\(/.test(src),
        `${w}.js calls ns.read - that resolves on the host it RUNS on, so it reads "" ` +
          `everywhere but home. Use a port; ports are shared across all servers.`);
    }
  },

  // A hand-run toggle, so prepper.js's 2.00 GB is affordable - and it buys the
  // guarantee that the pool it reports is the pool the manager will divide.
  "sharemode.js costs 4.20 GB": () => {
    const ram = ramOf("sharemode");
    assert(Math.abs(ram - 4.20) < 0.011, `expected 4.20 GB, got ${ram.toFixed(2)}`);
  },

  // Bitburner resolves imports on the server a script STARTS on, and
  // RamCalculations.ts returns ImportError when one is missing - so exec returns
  // a bare 0, indistinguishable from the script itself being absent.
  //
  // share.js imports config.js, config.js was not deployed, and share therefore
  // ran on home alone (the one host that has config.js) while every other host
  // refused. Three live runs went into finding that, two of them chasing a
  // diagnostic that blamed deploy. This test is the fix for the CLASS: anything
  // the workers import must ship with them.
  "DEPLOY_LIST is closed under imports": async () => {
    const { DEPLOY_LIST } = (await loadScripts())["config"];
    const deployed = new Set(DEPLOY_LIST.map((f) => f.replace(/^\/+/, "")));

    for (const file of DEPLOY_LIST) {
      const bare = file.replace(/^\/+/, "").replace(/^scripts\//, "").replace(/\.js$/, "");
      for (const m of readScript(bare).matchAll(/from\s+"\.\/([\w-]+)\.js"/g)) {
        assert(deployed.has(`scripts/${m[1]}.js`),
          `${file} imports ${m[1]}.js, which is not in DEPLOY_LIST - exec will return 0 on ` +
            `every host but home, and fileExists will insist the worker is there`);
      }
    }
  },

  // The manager reaches SHARE_WORKER as a STRING from config.js and must never
  // import the worker itself: ns.share is 2.40 GB for a function it never calls.
  "no manager build pays for ns.share": () => {
    for (const entry of ["manager", "boot"]) {
      assert(!closure(entry).has("share"),
        `${entry}.js imports share.js - 2.40 GB for a function it never calls`);
    }
  },

  // A hand-run tool, so its 2 GB getServer is affordable - but it must not
  // drift into importing the batcher and dragging that cost somewhere it bites.
  "connectme.js costs 3.85 GB and imports nothing": () => {
    const ram = ramOf("connectme");
    assert(Math.abs(ram - 3.85) < 0.011, `expected 3.85 GB, got ${ram.toFixed(2)}`);
    assert(!readScript("connectme").includes('from "./'), "connectme.js should import no other script");
  },

  // This replaces "neither entry pays for the other's backend", which guarded
  // the twin split. math.js now holds BOTH backends: every *Analyze name is
  // inside an rpc body, and ns.formulas.* was always 0 GB - what used to cost
  // 2.50 was getServer and getPlayer, and snapshot() fetches those through rpc
  // too, because helpers.server() only checks that 14 plain data keys are
  // present and those survive JSON.
  //
  // If this ever exceeds 1.00, a backend has leaked out of an rpc body and
  // every importer is paying for math it may not use.
  "math.js holds both backends for 1.00 GB": () => {
    const marginal = ramOf("math") - BASE;
    assert(Math.abs(marginal - 1.00) < 0.011,
      `expected 1.00 GB marginal (ns.run alone), got ${marginal.toFixed(2)}`);
  },

  // The continuous tree was never priced here at all - closure() only followed
  // "./name.js", so nothing under scripts/continuous/ was reachable from this
  // file. It went unmeasured until the game refused to start manager.js on a
  // 32 GB home, at 48.00 GB, 39.00 of which was identifier collisions.
  //
  // A ceiling rather than an exact figure: the continuous entries move as the
  // controller grows, and the number that matters is whether the manager still
  // launches beside boot (3.75) and cloud (1.75) on the smallest home a fresh
  // BitNode hands you.
  "the continuous manager fits a fresh 32 GB home": () => {
    const ram = ramOf("continuous/manager");
    assert(ram < 16, `continuous/manager.js is ${ram.toFixed(2)} GB; boot + cloud + this must clear 32`);
  },

  // One entry for both backends. The analyze build was 13.35 and the formulas
  // build 9.40; the merged file pays for both backends' LIVE reads and nothing
  // else. weakenAnalyze, hackAnalyzeSecurity and growthAnalyzeSecurity (3.00)
  // moved into one rpc body at prepare(); getServer was already paid by
  // lib/cores.js and now also replaces four getServer* reads (0.40); what is
  // added is ns.run (1.00) and getPlayer (0.50).
  //
  // The formulas path is 2.15 GB dearer than its old entry - the price of
  // hackAnalyze, hackAnalyzeChance and growthAnalyze staying reachable so that
  // losing or never owning Formulas.exe needs no second file. They cannot move
  // to rpc: stream.dispatch() calls them every cadence tick.
  "continuous/manager.js holds both backends for 11.55 GB": () => {
    const ram = ramOf("continuous/manager");
    assert(Math.abs(ram - 11.55) < 0.011, `expected 11.55 GB, got ${ram.toFixed(2)}`);
  },

  // ns.gang is priced off GangApiBase = 4, and the surface the gang needs comes
  // to ~37 GB held together - which would not start on a fresh BitNode's 32 GB
  // home beside boot, cloud and the continuous manager. So gang.js holds no
  // gang call at all: every one lives in an rpc body, billed to a transient for
  // as long as it runs. It was four transient FILES and a 2.80 GB scheduler;
  // ps went with the files, because rpc() waits on a reply rather than a pid.
  //
  // The bodies are string literals to this model and cannot be priced here -
  // tests/rpc.test.mjs parses them, and ramreport.js is how their transients'
  // real cost comes back from the game.
  "gang.js holds no gang API: 2.60 GB": () => {
    const ram = ramOf("gang/gang");
    assert(Math.abs(ram - 2.60) < 0.011, `expected 2.60 GB (1.60 + run 1.00), got ${ram.toFixed(2)}`);
  },

  // config.js and math.js are imported by every rpc body, so one billed
  // identifier in them is charged to every gang transient.
  "the gang's shared modules are free to import": () => {
    for (const mod of ["gang/config", "gang/math"]) {
      const ram = ramOf(mod);
      assert(Math.abs(ram - BASE) < 0.011,
        `${mod}.js costs ${(ram - BASE).toFixed(2)} GB to import; it must be 0 - every gang ` +
          `rpc body imports it`);
    }
  },

  // The singularity surface phase 1 needs is 30.30 GB held together, against a
  // fresh BN4 home's 32 shared with boot and the batcher. So sing.js holds no
  // singularity call at all: 1.60 + ns.run 1.00, exactly gang.js's shape.
  // backdoor.js is started once per server and many run at once, so what one
  // copy costs is what sing.js budgets launches by - BACKDOOR_GB must match.
  "sing's backdoor.js is 5.60 GB, and BACKDOOR_GB says so": async () => {
    const ram = ramOf("sing/backdoor");
    assert(Math.abs(ram - 5.60) < 0.011, `expected 5.60 GB (1.60 + connect + installBackdoor), got ${ram.toFixed(2)}`);
    const { BACKDOOR_GB } = (await loadScripts())["sing/config"];
    assert(Math.abs(BACKDOOR_GB - ram) < 0.011, `BACKDOOR_GB ${BACKDOOR_GB} but backdoor.js costs ${ram.toFixed(2)}`);
  },

  "sing.js holds no singularity API: 2.60 GB": () => {
    const ram = ramOf("sing/sing");
    assert(Math.abs(ram - 2.60) < 0.011, `expected 2.60 GB (1.60 + run 1.00), got ${ram.toFixed(2)}`);
  },

  // config.js is imported by boot.js (pinned at 3.50) and by the UPGRADE and
  // PROGS bodies; plan.js is imported by sing.js. One billed name in either is
  // charged to all of them.
  "the singularity subsystem's shared modules are free to import": () => {
    for (const mod of ["sing/config", "sing/plan"]) {
      const ram = ramOf(mod);
      assert(Math.abs(ram - BASE) < 0.011,
        `${mod}.js costs ${(ram - BASE).toFixed(2)} GB to import; it must be 0`);
    }
  },

  // The split rule. rpc() allows one call in flight per process, so the free RAM
  // sing/ needs is the MAX over its bodies, never the sum - and commitCrime alone
  // is 5.00, so CRIME at 6.60 is the floor of that max. Every other body is held
  // at or under it: work was one 12.70 ACT body (stop, focus, gym, crime,
  // faction) and joining was 7.60 until each was split.
  //
  // Every body is pinned, not just the max. Without this nothing notices a body
  // re-fattening until a fresh home refuses to run it - a runtime ns.run -> 0,
  // logged once as a WARN, and the subsystem quietly doing nothing.
  "every sing body is priced, and none exceeds CRIME's 6.60": () => {
    const want = {
      UPGRADE: 6.25, TOR: 3.65, PROGS: 4.70, INVITES: 4.60, JOIN: 4.60,
      // 5.60 -> 6.60 for getCompanyRep, which puts READ exactly on the ceiling.
      // Anything more READ needs is a second read body, not a bigger one.
      READ: 6.60, GYM: 3.60, CRIME: 6.60, FACTION: 4.60,
      COMPANY: 4.60, APPLY: 4.60, TRAVEL: 3.60,
      // The aug reads, one call each: together they would be 14.10.
      OWNED: 6.60, FAC_AUGS: 6.60, PREREQ: 6.60, AUG_INFO: 6.60, BUY: 6.60,
      // Favor split from READ (full); DONATE is donateToFaction alone.
      FAVOR: 2.70, DONATE: 6.60, BN_MULTS: 5.60,
      // getFactionFavorGain alone, for the Red Pill faction's favor-bar install.
      FAVOR_GAIN: 2.35,
      // The install: the sweep (run + isRunning) is split off installAugmentations,
      // which is 5.00 alone - together 7.70.
      SWEEP: 2.70, INSTALL: 6.60,
      // The idle money crime: getCrimeStats and getCrimeChance, 5.00 each.
      CRIME_STATS: 6.60, CRIME_CHANCE: 6.60,
      // getAugmentationStats alone, rating each aug for tier 1 once per process.
      AUG_STATS: 6.60,
      // The backdoor read: scan + getServer + ps + three 0.05 reads. The install
      // itself is backdoor.js, a real file - it is fire-and-forget, see below.
      BACKDOORS: 4.15,
    };
    const got = bodiesOf("sing/sing");
    assert(JSON.stringify(Object.keys(got).sort()) === JSON.stringify(Object.keys(want).sort()),
      `sing.js bodies ${Object.keys(got)} - every body must be pinned here`);
    for (const [name, gb] of Object.entries(want)) {
      assert(Math.abs(got[name] - gb) < 0.011,
        `${name} body: expected ${gb.toFixed(2)} GB, got ${got[name].toFixed(2)}`);
      assert(got[name] <= 6.60 + 0.001,
        `${name} body is ${got[name].toFixed(2)} GB - split it under CRIME's 6.60`);
    }
  },

  // ns.codingcontract is priced off CodingContractBase = 10, and reading plus
  // attempting in one process is ~22 GB with the network walk - more than a
  // fresh BitNode's 32 GB home has free beside boot, cloud and the continuous
  // manager. So contracts.js holds no contract call at all: the FIND body
  // (scan + ls + getContractType + getData) and the SUBMIT body (attempt) are
  // billed to their own transients, and the solving in between is pure.
  //
  // 2.60 -> 4.10: the GATE moved out of the find body and into this file, which
  // is the whole reason the subsystem can run once a MINUTE. boot runs it as a
  // transient now, so a shut gate has to be answered without paying for a
  // 12.00 GB body to discover it - getResetInfo (1.00) and getPlayer (0.50)
  // here make the gated run 4.10 GB for about 300 ms, against 4.10 GB held
  // forever as a service. Nothing is held between sweeps.
  "contracts.js holds no contract API: 4.10 GB": () => {
    const ram = ramOf("contracts/contracts");
    assert(Math.abs(ram - 4.10) < 0.011,
      `expected 4.10 GB (1.60 + run 1.00 + getResetInfo 1.00 + getPlayer 0.50), got ${ram.toFixed(2)}`);
  },

  // solvers.js is 30 transcribed algorithms and the single most likely place in
  // this repo for the identifier tax to land: a sliding-`window` counter is
  // 25.00 GB, the `run` lengths in RLE are 1.00, `attempt` is 10.00 and
  // `getData` is 5.00. The BANNED guard below covers six names; this covers
  // every name in the cost table, which is why it is the real check.
  //
  // config.js is imported by the FIND body as well as by boot.js, so one billed
  // identifier in it would be charged to boot - which is pinned at 3.50.
  "the contract subsystem's shared modules are free to import": () => {
    for (const mod of ["contracts/config", "contracts/solvers"]) {
      const ram = ramOf(mod);
      assert(Math.abs(ram - BASE) < 0.011,
        `${mod}.js costs ${(ram - BASE).toFixed(2)} GB to import; it must be 0 - boot.js and ` +
          `the contract rpc bodies both reach it`);
    }
  },

  // The check is ns.gang.inGang(), which is 0 GB, and findFunc resolves a bare
  // `gang` to nothing (it matches a key only when the value is a function or a
  // number, and the namespace is an object). So supervising a gang must cost
  // boot exactly nothing.
  //
  // 3.60 -> 3.50: fileExists went with the per-tick Formulas.exe check, which
  // existed only to pick between two continuous files that are now one.
  "boot.js still costs 3.50 GB with the gang service wired in": () => {
    const ram = ramOf("boot");
    assert(Math.abs(ram - 3.50) < 0.011, `expected 3.50 GB, got ${ram.toFixed(2)}`);
  },

  // Vanilla's formatters. Neither exists in this fork - formatting is an
  // ns.format NAMESPACE - so either call is `undefined is not a function` at
  // the call site and nowhere earlier. Costs nothing to ban and cannot false
  // positive: no correct script in this repo can contain either name.
  "nothing calls a formatter this fork does not have": () => {
    for (const name of scriptNames()) {
      const src = codeOnly(readScript(name));
      for (const gone of ["formatNumber", "nFormat"]) {
        assert(!new RegExp(`\\bns\\.${gone}\\s*\\(`).test(src),
          `${name}.js calls ns.${gone}, which does not exist in this fork. ` +
            `Use ns.format.number / .ram / .percent / .time - all 0 GB.`);
      }
    }
  },

  // The suffix list is the game's and must not be re-typed. A copy that stops
  // early does not error; the mantissa grows without bound instead, and a live
  // report read "$2219301.35b" for what the game calls "$2.22q".
  //
  // ponytail: an allowlist, because five copies predate the rule and converting
  // them means threading ns through their callers. It exists to stop a SIXTH,
  // which is the failure that actually keeps happening. Shrink it whenever one
  // of these files is being edited anyway; never grow it.
  "no new script re-types the money suffix list": () => {
    const GRANDFATHERED = new Set([
      "capacity", "cloud", "managerCore", "prepper", "continuous/lib/fmt",
    ]);
    // Either shape that has actually been written here: the divisor/suffix
    // pair list, and the bare powers-of-1000 array.
    const COPY = /\[\s*1e(?:9|12)\s*,\s*"[a-zA-Z]"\s*\]|"k"\s*,\s*"m"\s*,\s*"b"/;

    const seen = new Set();
    for (const entry of ["boot", "manager", "capacity", "cloud", "deploy",
                         "root", "sharemode", "connectme", "prep",
                         "continuous/manager", "continuous/servers",
                         "gang/gang", "contracts/contracts", "sing/sing"]) {
      for (const mod of closure(entry)) seen.add(mod);
    }

    for (const mod of [...seen].sort()) {
      if (GRANDFATHERED.has(mod)) continue;
      // Comments stripped, strings KEPT. codeOnly() blanks string literals, so
      // `[1e12, "t"]` would arrive here as `[1e12,    ]` and this pattern could
      // never match - the first version of this test passed vacuously against a
      // planted violation. Same trap closure() documents one screen up.
      const src = readScript(mod)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      assert(!COPY.test(src),
        `${mod}.js re-types the money suffix list. Use ns.format.number (0 GB) - it is the ` +
          `function the UI itself calls, and the list runs to "n", not "t".`);
    }
  },

  // The class, not the instance. Every name below is charged by the game to any
  // script that so much as declares a variable with it - RamCalculations.ts adds
  // the bare identifier, "For builtins like hack" - and none of them is called
  // anywhere in this repo. A parameter named `window` cost 25.00 GB and a loop
  // counter named `attempt` cost 10.00; between them they were four fifths of
  // the continuous manager.
  //
  // Only names that are both expensive and easy to reach for by accident. The
  // cheap ones (`hack`, `grow`, `weaken` as property names) are deliberate and
  // priced into the totals above.
  "no script names a variable after an expensive ns function": () => {
    const BANNED = { window: 25, document: 25, attempt: 10, share: 2.4, run: 1, probe: 0.2, connect: 2 };
    const entries = new Set();
    for (const e of ["boot", "manager", "capacity", "cloud", "deploy",
                     "root", "sharemode", "connectme", "prep",
                     "continuous/manager", "continuous/servers",
                     "gang/gang", "contracts/contracts", "sing/sing"]) {
      for (const mod of closure(e)) entries.add(mod);
    }

    for (const mod of [...entries].sort()) {
      const src = codeOnly(readScript(mod));
      // Only the file that really calls it may hold the name. ns.share lives in
      // share.js and nowhere else; ns.run is called by boot and by capacity.
      const calls = new Set();
      for (const m of src.matchAll(/\bns\.(?:[\w$]+\.)*([\w$]+)\s*\(/g)) calls.add(m[1]);

      // A regex LITERAL, alternating over the names, rather than one built per
      // name from a string. Both string forms got this wrong once: a template
      // literal resolves \w to a bare w, so `[\w$]` becomes `[w$]`, and a plain
      // string needs the backslashes doubled. Either slip turns `\.?` into `.?`,
      // which matches the space in `function runToCompletion` and reports a
      // collision in a file that has none.
      //
      // The trailing (?!\s*:) skips object keys - `{ hack: 1.70 }` costs nothing,
      // because acorn-walk only walks a Property key when it is computed.
      const BANNED_RE = /(?<![\w$])(\.?)(window|document|attempt|share|run|probe|connect)(?![\w$])(?!\s*:)/g;
      for (const m of src.matchAll(BANNED_RE)) {
        const name = m[2];
        if (calls.has(name)) continue;
        assert(false,
          `${mod}.js has an identifier named \`${name}\` and never calls ns.${name} - ` +
            `the game charges it ${BANNED[name].toFixed(2)} GB anyway, to this file and to ` +
            `every script that imports it. Rename the variable.`);
      }
    }
  },

  // 1.60 base + ns.run 1.00, and that is the whole point: a caller pays for the
  // generated script's ENTRY, never for what the body calls. write, read,
  // getPortHandle, nextPortWrite, clear and asleep are all 0 GB in this fork.
  //
  // If this ever reads higher, something in rpc.js has been named after a
  // billed function and every importer is paying for it.
  // The report exists to catch THIS file's model being wrong, so it has to stay
  // runnable on the smallest home that could need it.
  "ramreport.js costs 1.90 GB": () => {
    const ram = ramOf("ramreport");
    assert(Math.abs(ram - 1.90) < 0.011, `expected 1.90 GB, got ${ram.toFixed(2)}`);
  },

  "rpc.js costs 2.60 GB and imports nothing": () => {
    const ram = ramOf("rpc");
    assert(Math.abs(ram - 2.60) < 0.011, `expected 2.60 GB, got ${ram.toFixed(2)}`);
    assert(!codeOnly(readScript("rpc")).includes('from "./'),
      "rpc.js must import nothing - scripts/continuous/ imports it, and a dependency would cross that tree's self-containment rule for no RAM saving");
  },

  // RamCalculations.ts resolves an IMPORT through getModuleScript, which adds
  // ".js" and handles "./". Its ExportNamedDeclaration branch does not: it
  // pushes node.source.value raw and looks that string up in the server's
  // script map, whose keys are "scripts/config.js" - no leading slash, with the
  // extension. So `export { X } from "scripts/config"` loads fine in the module
  // loader and fails the RAM check with `Import Error "scripts/config" does not
  // exist on server: home`, and the entry script will not start. It did: the
  // continuous manager, on the first live run of the config re-export.
  "every re-export spells its source exactly as the game stores it": () => {
    const bad = [];
    for (const rel of scriptFiles()) {
      const src = readScript(rel.replace(/\.js$/, ""))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const m of src.matchAll(/export\s*(?:\*|\{[^}]*\})\s*from\s*"([^"]+)"/g)) {
        if (!/^scripts\/[\w\-/]+\.js$/.test(m[1])) bad.push(`${rel}: "${m[1]}"`);
      }
    }
    assert(bad.length === 0,
      `re-exports must use "scripts/<path>.js" - the RAM calculator does not resolve them: ${bad.join(", ")}`);
  },
};
