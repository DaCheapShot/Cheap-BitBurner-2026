import { CONTRACT_DELAY_MS, REQUIRE_FACTION, REFUSED_FILE, GATE_MARKER } from "./config.js";
import { solve } from "./solvers.js";
import { rpc } from "scripts/rpc.js";

/**
 * The coding-contract solver: ONE sweep, then exit.
 *
 * WHY A TRANSIENT, NOT A SERVICE. boot.js runs this once a tick (60 s), the way
 * it runs root.js and deploy.js, so nothing is held between sweeps. It was a
 * resident service first and that was the wrong trade: 4.10 GB pinned forever
 * to re-read a clock, against a gated run that costs 4.10 GB for about 300 ms
 * and nothing at all in between. Contracts appear roughly every ten minutes;
 * there is no state worth keeping warm for that.
 *
 * WHY THE GATE IS IN THIS FILE and not in the find body: a shut gate is the
 * common case for the first ten minutes, and it must not cost a 12.00 GB
 * transient once a minute to discover that. Reading getResetInfo (1.00) and
 * getPlayer (0.50) here makes the gated run 4.10 GB and over in milliseconds.
 *
 * WHY THE CONTRACT API IS STILL SPLIT OUT. ns.codingcontract is priced off
 * RamCostConstants.CodingContractBase = 10 - attempt 10, getContractType 5,
 * getData 5 - so reading and attempting in one process is ~22 GB with the
 * network walk. Split across FIND (12.00) and SUBMIT (11.60) the peak is
 * 4.10 + 12.00 = 16.10 while sweeping. The solving happens HERE, between the
 * two, because it is pure arithmetic and solvers.js is 0 GB.
 *
 * WHY THE GATE EXISTS AT ALL. The reward faction is chosen when a contract is
 * ATTEMPTED, not when it is generated. ContractGenerator.getRandomReward stores
 * a bare type; gainCodingContractReward resolves it, and both faction reward
 * types filter Player.factions by offerHackingWork and fall back to Money when
 * that list is empty. Three of the four reward types pay reputation, and
 * solving before any faction is joined turns every one of them into cash.
 * See contracts/config.js.
 *
 * NOTHING HERE MAY ASSUME IT RAN BEFORE. A transient's memory dies with it, so
 * the skip list is a file and the gate message is a marker - and ns.print dies
 * with the log window a moment after exit, which is why anything the user has
 * to see goes to ns.tprint instead.
 *
 * Usage:  run scripts/contracts/contracts.js            (one sweep; boot does this)
 *         run scripts/contracts/contracts.js --dummy    (mint one of every type
 *                                                        on home and solve it)
 *         run scripts/contracts/contracts.js --forget   (clear the skip list,
 *                                                        after fixing a solver)
 *
 * RAM: 1.60 base + run 1.00 + getResetInfo 1.00 + getPlayer 0.50 = 4.10 GB
 */

// ------------------------------------------------------------------ bodies ---
//
// Plain template literals: rpc() rejects interpolation and tests/rpc.test.mjs
// parses every one. Imports inside a body are spelled with a LEADING SLASH so
// the test harness's rewriter leaves them alone and the RAM model bills them to
// the transient, not to this file.

/**
 * Every contract on the network, with its type and data.
 *
 * ns.scan is walked inline - a fifth copy of the four-line BFS. Importing
 * ram.js for it would drag getServerMaxRam, getServerUsedRam and hasRootAccess
 * along for a list of names, exactly as boot.js:144 documents. Root access is
 * not required to read or attempt a contract, so every reachable host counts,
 * not just the rooted ones.
 *
 * BIGINTS ARE STRINGIFIED HERE. "Square Root" hands back a bigint and rpc.js
 * returns every value through JSON.stringify, which throws on one. Unconverted,
 * a single Square Root contract anywhere on the network would take down the
 * whole sweep, not just itself.
 */
const FIND = `
const seen = new Set(["home"]);
const queue = ["home"];
for (let i = 0; i < queue.length; i++) {
  for (const next of ns.scan(queue[i])) {
    if (!seen.has(next)) {
      seen.add(next);
      queue.push(next);
    }
  }
}
const found = [];
for (const host of seen) {
  for (const file of ns.ls(host, ".cct")) {
    const kind = ns.codingcontract.getContractType(file, host);
    const raw = ns.codingcontract.getData(file, host);
    found.push({ host: host, file: file, kind: kind, body: typeof raw === "bigint" ? raw.toString() : raw });
  }
}
return { found: found, hosts: seen.size };
`;

/**
 * Attempt every answered contract. attempt() returns the reward description on
 * success and an EMPTY STRING on failure, which is what the caller keys its
 * skip list off.
 */
const SUBMIT = `
const jobs = JSON.parse(args[0]);
const done = [];
for (const job of jobs) {
  // Per job, not per batch. attempt() THROWS when the contract is no longer
  // there ("Cannot find contract ... on server ..."), and one throw would
  // otherwise lose every other answer in the same call. Two sweeps overlapping
  // is the ordinary cause - a hand-run beside boot's own.
  try {
    done.push({
      host: job.host,
      file: job.file,
      kind: job.kind,
      reward: ns.codingcontract.attempt(job.answer, job.file, job.host),
    });
  } catch (err) {
    done.push({ host: job.host, file: job.file, kind: job.kind, gone: true });
  }
}
return done;
`;

/**
 * --dummy only: one contract of every type the fork knows, on home.
 *
 * getContractTypes is 0 GB and is asked rather than hardcoded, so a fork that
 * adds a type is caught by the self-test instead of silently skipped by it.
 * Dummy contracts carry a null reward, so a wrong answer costs nothing.
 */
const DUMMY = `
const made = [];
for (const kind of ns.codingcontract.getContractTypes()) {
  const file = ns.codingcontract.createDummyContract(kind, "home");
  if (file) made.push({ kind: kind, file: file });
}
return made;
`;

// ------------------------------------------------------------------- state ---

/**
 * Say something to the terminal, but only when it changed.
 *
 * A transient cannot remember what it said last run, and a gate reason repeated
 * once a minute for ten minutes is spam. The marker holds the last message; an
 * empty one clears it, so a gate that shuts again later - after an install,
 * which resets both the clock and the faction list - speaks again rather than
 * staying silent because it once said the same thing.
 *
 * ns.read and ns.write are 0 GB, and both resolve against home, which is the
 * only server this ever runs on.
 */
function announce(ns, message) {
  if (ns.read(GATE_MARKER).trim() === message.trim()) return;
  ns.write(GATE_MARKER, message, "w");
  if (message) ns.tprint(message);
}

/** The skip list, one `host:file` per line. */
function readRefused(ns) {
  return new Set(
    ns.read(REFUSED_FILE)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

// -------------------------------------------------------------------- main ---

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const log = (s) => ns.print(`${new Date().toLocaleTimeString()}  ${s}`);

  /**
   * One body, and a failure that says so - in the log only. Not fatal: early in
   * a BitNode home may have no room for a 12.00 GB transient, and boot runs this
   * again in a minute anyway. It used to go to the terminal too, since this
   * process's log window dies with it, but "no free RAM" is the ordinary state
   * of a fresh node's first minutes and a line a minute of it was noise (the
   * user's call). Kept out of GATE_MARKER as well, so it cannot make the gate
   * reason repeat.
   */
  const call = async (tag, body, ...args) => {
    try {
      return await rpc(ns, body, ...args);
    } catch (e) {
      log(`WARN: ${tag} failed - ${e.message ?? e}`);
      return null;
    }
  };

  const args = ns.args.map(String);
  const dummy = args.includes("--dummy");

  if (args.includes("--forget")) {
    ns.write(REFUSED_FILE, "", "w");
    ns.tprint("contracts: skip list cleared - previously refused contracts will be attempted again.");
  }

  const refused = readRefused(ns);

  // The gate, unless --dummy - whose whole point is to prove the solvers BEFORE
  // the gate ever opens.
  if (!dummy) {
    const info = ns.getResetInfo();
    // The LATER of the two. Entering a BitNode sets lastNodeReset and an install
    // sets lastAugReset; taking only one lets a fresh node inherit an old
    // timestamp and sweep at once, with no factions to pay the reward to.
    const since = Date.now() - Math.max(info.lastAugReset, info.lastNodeReset);
    const waitMs = Math.max(0, CONTRACT_DELAY_MS - since);
    const joined = ns.getPlayer().factions.length;

    if (waitMs > 0 || (REQUIRE_FACTION && joined === 0)) {
      const parts = [];
      if (waitMs > 0) parts.push(`${ns.format.time(waitMs)} left on the clock`);
      if (REQUIRE_FACTION && joined === 0) parts.push("no faction joined yet");
      announce(ns, `contracts: holding off - ${parts.join(", ")}. Contracts keep until then.`);
      return;
    }
    // Open. Clearing the marker is what lets the message above be said again if
    // an install shuts the gate later.
    announce(ns, "");
  }

  /**
   * --dummy only: the contracts this run minted.
   *
   * --dummy ignores the gate, and without this it would then sweep the REAL
   * contracts too and spend them at exactly the moment every faction reward
   * falls back to money. Empty means no restriction, which is the normal path.
   */
  const onlyFiles = new Set();

  if (dummy) {
    const made = await call("dummy", DUMMY);
    if (!made) {
      ns.tprint("ERROR: could not mint dummy contracts - see the script log.");
      return;
    }
    for (const m of made) onlyFiles.add(`home:${m.file}`);
    log(`minted ${made.length} dummy contracts on home`);
  }

  const sweep = await call("find", FIND);
  if (!sweep) return;

  const jobs = [];
  const unsolved = [];
  let skipped = 0;

  for (const c of sweep.found) {
    if (onlyFiles.size > 0 && !onlyFiles.has(`${c.host}:${c.file}`)) continue;
    if (refused.has(`${c.host}:${c.file}`)) {
      skipped++;
      continue;
    }
    const answer = solve(c.kind, c.body);
    // null is "no solver, or the solver threw". Never attempt on a guess: a
    // wrong answer spends a try, and some types only grant one.
    if (answer === null) unsolved.push(c.kind);
    else jobs.push({ host: c.host, file: c.file, kind: c.kind, answer: answer });
  }

  let solved = 0;
  let failed = 0;
  let vanished = 0;

  if (jobs.length > 0) {
    const results = await call("submit", SUBMIT, JSON.stringify(jobs));
    for (const r of results ?? []) {
      // Vanished between the read and the attempt - another sweep solved it, or
      // an install wiped the server. NOT a wrong answer: it must not go in the
      // skip list and must not shout, because nothing is broken.
      if (r.gone) {
        vanished++;
        continue;
      }
      // Both outcomes go to the TERMINAL, and they are the only lines that do.
      // This process's log window dies moments after it exits, so ns.print alone
      // would mean nobody ever sees the reward - which is the entire point of
      // the subsystem. The reward string is the GAME's, straight off attempt().
      const line = r.reward
        ? `solved ${r.kind} on ${r.host} - ${r.reward}`
        : `WRONG ANSWER for ${r.kind} on ${r.host} (${r.file}) - not retrying, the solver is deterministic`;
      log(line);
      ns.tprint(`contracts: ${line}`);
      if (r.reward) solved++;
      else {
        failed++;
        refused.add(`${r.host}:${r.file}`);
      }
    }
    // Written every sweep that attempted anything, because this process is about
    // to forget it. Repeating a wrong answer once a minute would spend all ten
    // of a contract's tries inside ten minutes - and "Array Jumping Game" allows
    // exactly one, so it would be destroyed on the very next run.
    if (failed > 0) ns.write(REFUSED_FILE, [...refused].join("\n"), "w");
  }

  const considered = onlyFiles.size > 0 ? jobs.length + unsolved.length : sweep.found.length;
  log(
    `sweep: ${considered} contract${considered === 1 ? "" : "s"} across ${sweep.hosts} hosts, ` +
      `${solved} solved, ${failed} wrong, ${vanished} already gone, ${unsolved.length} unsolved, ` +
      `${skipped} skipped`,
  );

  // A missing solver is the one summary line worth the terminal: it is
  // actionable and it does not go away on its own. A quiet sweep says nothing -
  // at once a minute, "0 contracts, 0 solved" would drown the rewards.
  if (unsolved.length > 0) {
    ns.tprint(`contracts: ${unsolved.length} unsolved - no solver for ${[...new Set(unsolved)].join(", ")}`);
  }

  if (dummy) {
    ns.tprint(
      unsolved.length === 0 && failed === 0
        ? `contracts: self-test PASSED - ${solved} of ${jobs.length + unsolved.length} dummy contracts solved.`
        : `contracts: self-test FAILED - ${failed} wrong, ${unsolved.length} unsolved ` +
            `(${[...new Set(unsolved)].join(", ") || "none"}). See the script log.`,
    );
  }
}
