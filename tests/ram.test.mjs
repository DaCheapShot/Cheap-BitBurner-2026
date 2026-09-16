import { readScript, assert, loadScripts, scriptNames } from "./harness.mjs";

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
  getPlayer: 0.5, nuke: 0.05, brutessh: 0.05, ftpcrack: 0.05,
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
  // API call for a number already in hand. tick.js reads it as a computed key
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
  // Names nothing here CALLS, listed because the game charges for the NAME.
  // attempt is ns.codingcontract.attempt; probe is this fork's ns.dnet.probe.
  attempt: 10, probe: 0.2, disableLog: 0,
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
  for (const m of src.matchAll(/from\s+"scripts\/([\w\-/]+)"/g)) {
    closure(m[1].replace(/\.js$/, ""), seen);
  }
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
  for (const mod of closure(bare)) {
    const src = codeOnly(readScript(mod));
    // The optional leading dot is the MemberExpression case: `times.hack` is
    // charged for `hack` just as a bare `hack` would be.
    for (const m of src.matchAll(/(?<![\w$])(\.?)([A-Za-z_$][\w$]*)\s*(:?)/g)) {
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
  }
  return BASE + [...refs].reduce((n, f) => n + COST[f], 0);
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

  // The analyze build is now CHEAPER than the formulas one, which it never was
  // before - mathFormulas still holds getServer (2.00) and getPlayer (0.50)
  // resident, because ns.formulas.* needs the objects in hand and is itself
  // 0 GB. Moving those two would cost it the same 1.00 for ns.run and save
  // 1.50; worth doing only alongside the twin merge, where one module holds
  // both backends and the saving is counted once.
  "the analyze build is no longer the expensive one": () => {
    assert(ramOf("manager") < ramOf("manager-formulas"),
      `analyze ${ramOf("manager").toFixed(2)} should now undercut formulas ${ramOf("manager-formulas").toFixed(2)}`);
  },

  // Unchanged: mathFormulas holds no *Analyze function to move, so it does not
  // import rpc.js and pays no entry fee. Its prepare() went async only to keep
  // the two backends' contract identical.
  "manager-formulas.js is unmoved by rpc.js at 6.90 GB": () => {
    const ram = ramOf("manager-formulas");
    assert(Math.abs(ram - 6.90) < 0.011, `expected 6.90 GB, got ${ram.toFixed(2)}`);
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
    for (const entry of ["manager", "manager-formulas", "boot"]) {
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

  "neither entry pays for the other's backend": () => {
    assert(ramOf("manager") < 8, "analyze entry is paying formulas cost");
    assert(ramOf("manager-formulas") < 8, "formulas entry is paying analyze cost");
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
  "the continuous managers fit a fresh 32 GB home": () => {
    for (const entry of ["continuous/manager", "continuous/manager-formulas"]) {
      const ram = ramOf(entry);
      assert(ram < 16, `${entry}.js is ${ram.toFixed(2)} GB; boot + cloud + this must clear 32`);
    }
  },

  // The whole reason the gang subsystem is split into a scheduler and four
  // transients. ns.gang is priced off GangApiBase = 4, and the surface this
  // needs comes to ~37 GB held together - which would not start on a fresh
  // BitNode's 32 GB home beside boot (3.60), cloud (5.75) and a continuous
  // manager (9.40+).
  //
  // Exact pins rather than a ceiling: every one of these is a fixed set of API
  // calls, and a figure that moves means a call was added, not that the
  // controller grew. The numbers to hold are the SUM of the resident and the
  // largest transient (2.80 + 14.70 = 17.50), since gang.js awaits each one.
  "each gang transient stays at its pinned cost": () => {
    const pinned = {
      "gang/gang": 2.80,      // 1.60 + run 1.00 + ps 0.20; holds no gang API at all
      "gang/tick": 11.60,     // + getGangInformation 2 + getMemberNames 1 + getMemberInformation 2
                              //   + getTaskStats 1 + setMemberTask 2 + recruitMember 2
      "gang/ascend": 8.60,    // + getMemberNames 1 + getAscensionResult 2 + ascendMember 4
      "gang/equip": 14.70,    // + getMemberNames 1 + getMemberInformation 2 + getEquipmentCost 2
                              //   + getEquipmentType 2 + getEquipmentStats 2 + purchaseEquipment 4
                              //   + getServerMoneyAvailable 0.10
      "gang/war": 11.60,      // + getGangInformation 2 + getAllGangInformation 2
                              //   + getChanceToWinClash 4 + setTerritoryWarfare 2
      "gang/create": 2.60,    // + createGang 1
    };
    for (const [entry, want] of Object.entries(pinned)) {
      const ram = ramOf(entry);
      assert(Math.abs(ram - want) < 0.011,
        `${entry}.js: expected ${want.toFixed(2)} GB, got ${ram.toFixed(2)}`);
    }
  },

  // config.js, math.js and marker.js are imported by every transient, so one
  // billed identifier in them is charged four or five times over. marker.js is
  // allowed ns.read, which is 0 GB, exactly as calib.js is.
  "the gang's shared modules are free to import": () => {
    for (const mod of ["gang/config", "gang/math", "gang/marker", "gang/report"]) {
      const ram = ramOf(mod);
      assert(Math.abs(ram - BASE) < 0.011,
        `${mod}.js costs ${(ram - BASE).toFixed(2)} GB to import; it must be 0 - it is ` +
          `imported by every gang transient`);
    }
  },

  // The check is ns.gang.inGang(), which is 0 GB, and findFunc resolves a bare
  // `gang` to nothing (it matches a key only when the value is a function or a
  // number, and the namespace is an object). So supervising a gang must cost
  // boot exactly nothing.
  "boot.js still costs 3.60 GB with the gang service wired in": () => {
    const ram = ramOf("boot");
    assert(Math.abs(ram - 3.60) < 0.011, `expected 3.60 GB, got ${ram.toFixed(2)}`);
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
    for (const entry of ["boot", "manager", "manager-formulas", "capacity", "cloud", "deploy",
                         "root", "sharemode", "connectme", "prep", "prep-formulas",
                         "continuous/manager", "continuous/manager-formulas", "continuous/servers",
                         "continuous/capacity", "gang/gang", "gang/tick", "gang/ascend",
                         "gang/equip", "gang/war", "gang/create"]) {
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
    const BANNED = { window: 25, document: 25, attempt: 10, share: 2.4, run: 1, probe: 0.2 };
    const entries = new Set();
    for (const e of ["boot", "manager", "manager-formulas", "capacity", "cloud", "deploy",
                     "root", "sharemode", "connectme", "prep", "prep-formulas",
                     "continuous/manager", "continuous/manager-formulas", "continuous/servers",
                     "continuous/capacity",
                     "gang/gang", "gang/tick", "gang/ascend", "gang/equip", "gang/war",
                     "gang/create"]) {
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
      const BANNED_RE = /(?<![\w$])(\.?)(window|document|attempt|share|run|probe)(?![\w$])(?!\s*:)/g;
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
  "rpc.js costs 2.60 GB and imports nothing": () => {
    const ram = ramOf("rpc");
    assert(Math.abs(ram - 2.60) < 0.011, `expected 2.60 GB, got ${ram.toFixed(2)}`);
    assert(!codeOnly(readScript("rpc")).includes('from "./'),
      "rpc.js must import nothing - scripts/continuous/ imports it, and a dependency would cross that tree's self-containment rule for no RAM saving");
  },
};
