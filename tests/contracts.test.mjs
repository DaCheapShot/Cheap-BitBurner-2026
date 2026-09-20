import { loadScripts, assert } from "./harness.mjs";
import { makeNs } from "./mockNs.mjs";

/**
 * The contract subsystem.
 *
 * Everything worth testing lives in contracts/solvers.js on purpose: the rpc
 * bodies are thin (walk the network, read type and data, attempt) and the
 * supervisor only sequences them. The fixtures below are the EXAMPLES PRINTED
 * IN THE GAME'S OWN PROBLEM DESCRIPTIONS wherever one exists, so they check the
 * transcription against the fork rather than against a second copy of my own
 * reasoning - which is the trap tests/gang.test.mjs names for the gang
 * formulas.
 *
 * The real gate is still in-game: `run scripts/contracts/contracts.js --dummy`
 * mints one contract of every type and solves it against the game's own
 * checker. A fixture I transcribe wrong agrees with a solver I write wrong.
 */

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The only contract name carrying a non-ASCII character.
 *
 * Built from an ESCAPE, not pasted as a literal, and that is the whole point:
 * the first version of solvers.js ASCII-folded it to "Vigenere", the lookup
 * missed and solve() answered null - and this file carried the SAME fold, so
 * "every type has a solver" agreed with the bug and passed. A live --dummy run
 * is what caught it, at 29 of 30.
 *
 * A test that can be broken by the same slip as the code it checks is not a
 * check. This one cannot be: a fold would have to be typed twice, in two
 * different notations.
 */
const VIGENERE = "Encryption II: Vigen\u00e8re Cipher";
const sorted = (a) => [...a].sort();

/** Every type the fork defines, from src/CodingContract/Enums.ts. */
const FORK_TYPES = [
  "Find Largest Prime Factor",
  "Subarray with Maximum Sum",
  "Total Ways to Sum",
  "Total Ways to Sum II",
  "Spiralize Matrix",
  "Array Jumping Game",
  "Array Jumping Game II",
  "Merge Overlapping Intervals",
  "Generate IP Addresses",
  "Algorithmic Stock Trader I",
  "Algorithmic Stock Trader II",
  "Algorithmic Stock Trader III",
  "Algorithmic Stock Trader IV",
  "Minimum Path Sum in a Triangle",
  "Unique Paths in a Grid I",
  "Unique Paths in a Grid II",
  "Shortest Path in a Grid",
  "Sanitize Parentheses in Expression",
  "Find All Valid Math Expressions",
  "HammingCodes: Integer to Encoded Binary",
  "HammingCodes: Encoded Binary to Integer",
  "Proper 2-Coloring of a Graph",
  "Compression I: RLE Compression",
  "Compression II: LZ Decompression",
  "Compression III: LZ Compression",
  "Encryption I: Caesar Cipher",
  VIGENERE,
  "Square Root",
  "Total Number of Primes",
  "Largest Rectangle in a Matrix",
];

/**
 * Run ONE sweep of contracts.js against a fake network.
 *
 * The mock's ns.run really executes each generated rpc transient, so the FIND
 * and SUBMIT bodies run for real and import the real solvers.js - which is the
 * only way the bigint conversion gets exercised where it lives.
 *
 * `store` carries /data files ACROSS calls, which is how a test drives two
 * sweeps the way boot does: contracts.js is a transient now and remembers
 * nothing except what it wrote to disk.
 */
async function sweepOnce(mods, {
  contracts = [], sinceReset = 20 * 60 * 1000, factions = ["CyberSec"], resetInfo = null,
  reward = (kind) => `Gained 1234 faction reputation for CyberSec (${kind})`,
  args = [], dummyTypes = null, noRam = false, store = {}, live = null,
} = {}) {
  const contractsLive = live ?? contracts.map((c) => ({ ...c }));
  const attempts = [];
  const minted = [];
  const now = Date.now();

  const codingcontract = {
    getContractType: (file, host) => contractsLive.find((c) => c.file === file && c.host === host).kind,
    getData: (file, host) => contractsLive.find((c) => c.file === file && c.host === host).data,
    attempt: (answer, file, host) => {
      const c = contractsLive.find((x) => x.file === file && x.host === host);
      // The real one throws when the contract is no longer there, which is what
      // an overlapping sweep or an install leaves behind. `vanish` marks a
      // fixture that is readable but gone by the time it is attempted.
      if (!c || c.vanish) throw new Error(`Cannot find contract '${file}' on server '${host}'`);
      attempts.push({ host, file, kind: c.kind, answer });
      const paid = reward(c.kind);
      // The game removes a solved contract; a failed one keeps its file.
      if (paid) contractsLive.splice(contractsLive.indexOf(c), 1);
      return paid;
    },
    getContractTypes: () => dummyTypes ?? [],
    createDummyContract: (kind, host) => {
      const file = `dummy-${minted.length}.cct`;
      minted.push(kind);
      contractsLive.push({ host, file, kind, data: DUMMY_DATA[kind] });
      return file;
    },
  };

  const hosts = Object.fromEntries(
    [...new Set(["home", ...contractsLive.map((c) => c.host)])].map((h) => [h, 1024]),
  );
  const ns = makeNs({
    hosts,
    files: store,
    extra: {
      args,
      codingcontract,
      ls: (host, sub) => contractsLive.filter((c) => c.host === host && c.file.includes(sub)).map((c) => c.file),
      getPlayer: () => ({ factions }),
      getResetInfo: () => resetInfo ?? { lastAugReset: now - sinceReset, lastNodeReset: now - sinceReset },
    },
  });

  if (noRam) {
    const real = ns.run;
    ns.run = (file, ...rest) => (file.includes("rpc-") ? 0 : real(file, ...rest));
  }

  await mods["contracts/contracts"].main(ns);
  // A transient keeps nothing but its files, so the caller gets those back to
  // feed into the next sweep.
  return { ns, attempts, minted, live: contractsLive, store: ns._files };
}

/** Enough data per type for --dummy to have something real to solve. */
const DUMMY_DATA = {
  "Find Largest Prime Factor": 13195,
  "Subarray with Maximum Sum": [-2, 1, -3, 4, -1, 2, 1, -5, 4],
  "Total Ways to Sum": 8,
  "Total Ways to Sum II": [12, [1, 2, 3]],
  "Spiralize Matrix": [[1, 2], [3, 4]],
  "Array Jumping Game": [2, 3, 1, 1, 4],
  "Array Jumping Game II": [2, 3, 1, 1, 4],
  "Merge Overlapping Intervals": [[1, 3], [2, 6]],
  "Generate IP Addresses": "1938718066",
  "Algorithmic Stock Trader I": [3, 1, 4, 1, 5],
  "Algorithmic Stock Trader II": [3, 1, 4, 1, 5],
  "Algorithmic Stock Trader III": [3, 1, 4, 1, 5],
  "Algorithmic Stock Trader IV": [2, [3, 1, 4, 1, 5]],
  "Minimum Path Sum in a Triangle": [[2], [3, 4], [6, 5, 7]],
  "Unique Paths in a Grid I": [3, 4],
  "Unique Paths in a Grid II": [[0, 0], [0, 0]],
  "Shortest Path in a Grid": [[0, 1, 0], [0, 0, 0]],
  "Sanitize Parentheses in Expression": "()())()",
  "Find All Valid Math Expressions": ["123", 6],
  "HammingCodes: Integer to Encoded Binary": 21,
  "HammingCodes: Encoded Binary to Integer": "1001101011",
  "Proper 2-Coloring of a Graph": [4, [[0, 2], [0, 3], [1, 2], [1, 3]]],
  "Compression I: RLE Compression": "aaaaabccc",
  "Compression II: LZ Decompression": "5aaabb450723abb",
  "Compression III: LZ Compression": "abracadabra",
  "Encryption I: Caesar Cipher": ["MEDIA LINUX", 3],
  [VIGENERE]: ["DASHBOARD", "LINUX"],
  "Square Root": 17n,
  "Total Number of Primes": [0, 20],
  "Largest Rectangle in a Matrix": [[1, 0, 0], [0, 0, 0]],
};

export const tests = {
  "every contract type this fork defines has a solver": async () => {
    const { solvableTypes } = (await loadScripts())["contracts/solvers"];
    const have = new Set(solvableTypes());
    for (const t of FORK_TYPES) {
      assert(have.has(t), `no solver for "${t}" - the sweep would skip it forever`);
    }
    assert(have.size === FORK_TYPES.length,
      `solvers.js answers ${have.size} types, the fork defines ${FORK_TYPES.length}: ` +
        `${[...have].filter((t) => !FORK_TYPES.includes(t)).join(", ")} is not one of them`);
  },

  /**
   * The bug a live run found and the suite did not. Both halves are asserted:
   * the accented name IS a key, and the folded one is NOT - because "fix it by
   * adding both spellings" would pass the first assert while leaving the real
   * question (which one does the game actually send?) unanswered.
   */
  "the accented type name is not ASCII-folded": async () => {
    const { solvableTypes, solve } = (await loadScripts())["contracts/solvers"];
    const have = new Set(solvableTypes());
    assert(have.has(VIGENERE),
      `the Vigenere key is folded or missing - the game sends U+00E8 and the lookup ` +
        `would answer null forever. Keys present: ${[...have].filter((t) => t.includes("Encryption"))}`);
    assert(!have.has("Encryption II: Vigenere Cipher"),
      "the ASCII-folded spelling is a key too - one of them is dead weight and hides which is right");
    assert(solve(VIGENERE, ["DASHBOARD", "LINUX"]) === "OIFBYZIEX",
      "the accented key resolves but the cipher is wrong");
  },

  // The examples in the game's own contract descriptions.
  "the documented examples come out right": async () => {
    const { solve } = (await loadScripts())["contracts/solvers"];
    const cases = [
      ["Compression I: RLE Compression", "aaaaabccc", "5a1b3c"],
      ["Compression I: RLE Compression", "aAaAaA", "1a1A1a1A1a1A"],
      ["Compression I: RLE Compression", "111112333", "511233"],
      // A run of 19 splits, because a length is a single ASCII digit.
      ["Compression I: RLE Compression", "zzzzzzzzzzzzzzzzzzz", "9z9z1z"],
      ["Compression II: LZ Decompression", "5aaabb450723abb", "aaabbaaababababaabb"],
      ["HammingCodes: Integer to Encoded Binary", 8, "11110000"],
      ["HammingCodes: Integer to Encoded Binary", 21, "1001101011"],
      ["HammingCodes: Encoded Binary to Integer", "11110000", 8],
      // One flipped bit, corrected from the parity before the value is read.
      ["HammingCodes: Encoded Binary to Integer", "1001101010", 21],
      ["Generate IP Addresses", "25525511135", ["255.255.11.135", "255.255.111.35"]],
      ["Generate IP Addresses", "1938718066", ["193.87.180.66"]],
      ["Spiralize Matrix", [[1, 2, 3], [4, 5, 6], [7, 8, 9]], [1, 2, 3, 6, 9, 8, 7, 4, 5]],
      ["Spiralize Matrix", [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]],
        [1, 2, 3, 4, 8, 12, 11, 10, 9, 5, 6, 7]],
      ["Merge Overlapping Intervals", [[1, 3], [8, 10], [2, 6], [10, 16]], [[1, 6], [8, 16]]],
      ["Minimum Path Sum in a Triangle", [[2], [3, 4], [6, 5, 7], [4, 1, 8, 3]], 11],
      ["Total Ways to Sum", 4, 4],
      ["Total Number of Primes", [0, 20], 8],
      ["Largest Rectangle in a Matrix", [[1, 0, 0], [0, 0, 0]], [[0, 1], [1, 2]]],
      ["Proper 2-Coloring of a Graph", [4, [[0, 2], [0, 3], [1, 2], [1, 3]]], [0, 0, 1, 1]],
      // Not 2-colourable: a triangle. The empty array is the answer, and the
      // game accepts it ONLY when it has proved that itself.
      ["Proper 2-Coloring of a Graph", [3, [[0, 1], [0, 2], [1, 2]]], []],
    ];
    for (const [kind, data, want] of cases) {
      const got = solve(kind, data);
      assert(eq(got, want), `${kind}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  },

  // Order is not part of the answer for these three - the checker compares as
  // a set, and the count as well.
  "the set-valued answers hold every solution and no more": async () => {
    const { solve } = (await loadScripts())["contracts/solvers"];
    const cases = [
      ["Find All Valid Math Expressions", ["123", 6], ["1+2+3", "1*2*3"]],
      ["Find All Valid Math Expressions", ["105", 5], ["1*0+5", "10-5"]],
      ["Sanitize Parentheses in Expression", "()())()", ["()()()", "(())()"]],
      ["Sanitize Parentheses in Expression", "(a)())()", ["(a)()()", "(a())()"]],
      // Nothing can be salvaged, so the answer is an array holding one empty
      // string - not an empty array.
      ["Sanitize Parentheses in Expression", ")(", [""]],
    ];
    for (const [kind, data, want] of cases) {
      const got = solve(kind, data);
      assert(eq(sorted(got), sorted(want)),
        `${kind}: got ${JSON.stringify(sorted(got))}, want ${JSON.stringify(sorted(want))}`);
    }
  },

  /**
   * Compression III is scored as `answer.length <= ours && lzDecode(answer) === plain`,
   * so the encoding has to be MINIMAL, not merely valid. These lengths are the
   * game's own worked examples; the round trip is what makes them meaningful.
   */
  "LZ compression is minimal and round-trips": async () => {
    const { solve } = (await loadScripts())["contracts/solvers"];
    const LENGTHS = {
      abracadabra: 10,
      mississippi: 11,
      aAAaAAaAaAA: 9,
      2718281828: 9,
      abcdefghijk: 14,
      aaaaaaaaaaaa: 6,
      aaaaaaaaaaaaa: 7,
      aaaaaaaaaaaaaa: 7,
    };
    for (const [plain, len] of Object.entries(LENGTHS)) {
      const encoded = solve("Compression III: LZ Compression", plain);
      assert(encoded.length === len,
        `encoding "${plain}" gave ${encoded.length} chars ("${encoded}"), the game's own is ${len}`);
      const back = solve("Compression II: LZ Decompression", encoded);
      assert(back === plain, `"${plain}" encoded to "${encoded}" which decodes to "${back}"`);
    }
  },

  /**
   * Square Root crosses the rpc port as a DECIMAL STRING in both directions.
   *
   * ns.codingcontract.getData returns a bigint for this type and rpc.js returns
   * every value through JSON.stringify, which throws on a BigInt outright - so
   * one unconverted Square Root contract would take down a whole sweep, not
   * just itself. The find body stringifies; this checks the solver accepts that
   * and answers in kind, since attempt() feeds a string to BigInt().
   */
  "Square Root takes and returns decimal strings": async () => {
    const { solve } = (await loadScripts())["contracts/solvers"];
    // The integers rounding to n are [n^2-n+1, n^2+n+1), so 21 is the first
    // that rounds to 5 and 20 still rounds to 4. Both edges, deliberately.
    for (const [value, want] of [["17", "4"], ["20", "4"], ["21", "5"], ["0", "0"], ["1", "1"]]) {
      const got = solve("Square Root", value);
      assert(got === want, `sqrt(${value}) gave ${JSON.stringify(got)}, want "${want}"`);
      assert(typeof got === "string", `sqrt(${value}) returned a ${typeof got}, which JSON cannot carry`);
    }
    // A real one: 200 digits, well past Number.MAX_SAFE_INTEGER.
    const root = 12345678901234567890123456789012345678901234567890n;
    const got = solve("Square Root", (root * root + 7n).toString());
    assert(got === root.toString(), `200-digit square root gave ${got}`);
  },

  /**
   * Both jumping games answer 0 for "cannot reach the end" - Array Jumping
   * Game II does NOT answer Infinity, and Array Jumping Game answers the
   * numbers 1 and 0, not booleans. Array Jumping Game also allows exactly one
   * try, so there is no second chance at either.
   */
  "the jumping games answer in the numbers the checker accepts": async () => {
    const { solve } = (await loadScripts())["contracts/solvers"];
    assert(solve("Array Jumping Game", [2, 3, 1, 1, 4]) === 1, "reachable should be 1");
    assert(solve("Array Jumping Game", [3, 2, 1, 0, 4]) === 0, "unreachable should be 0");
    assert(solve("Array Jumping Game II", [2, 3, 1, 1, 4]) === 2, "two jumps");
    assert(solve("Array Jumping Game II", [3, 2, 1, 0, 4]) === 0, "unreachable should be 0, not Infinity");
  },

  /**
   * Any path of the optimal length is accepted, so this checks the length and
   * that the path actually walks the grid - not that it matches some string.
   */
  "the shortest path is optimal, legal and empty when there is none": async () => {
    const { solve } = (await loadScripts())["contracts/solvers"];
    const grid = [[0, 1, 0, 0, 0], [0, 0, 0, 1, 0]];
    const path = solve("Shortest Path in a Grid", grid);
    assert(path.length === 7, `expected 7 moves (the game's example is DRRURRD), got "${path}"`);

    let y = 0;
    let x = 0;
    for (const move of path) {
      if (move === "U") y--;
      else if (move === "D") y++;
      else if (move === "L") x--;
      else if (move === "R") x++;
      else assert(false, `"${move}" is not one of UDLR`);
      assert(grid[y] !== undefined && grid[y][x] === 0, `path "${path}" steps onto ${y},${x}`);
    }
    assert(y === grid.length - 1 && x === grid[0].length - 1, `path "${path}" ends at ${y},${x}`);

    assert(solve("Shortest Path in a Grid", [[0, 1], [1, 0]]) === "",
      "a walled-off destination is the empty string");
  },

  "an unknown type and a throwing solver both answer null, never a guess": async () => {
    const { solve } = (await loadScripts())["contracts/solvers"];
    assert(solve("Some Type A Later Fork Adds", 1) === null, "unknown type must be null");
    // Malformed data for a real type: the solver throws and that must surface
    // as "no answer", not as an attempt. A wrong answer spends a try.
    assert(solve("Spiralize Matrix", null) === null, "a throwing solver must be null");
  },

  /**
   * The supervisor, driven for real: the mock's ns.run executes each generated
   * rpc transient, so the FIND and SUBMIT bodies run and import the real
   * solvers.js. Anything this catches is a boundary bug, which is where the
   * bigint and the gate both live.
   */
  "a sweep reads, solves and attempts every contract on the network": async () => {
    const mods = await loadScripts();
    const { ns, attempts } = await sweepOnce(mods, {
      contracts: [
        { host: "home", file: "a.cct", kind: "Total Ways to Sum", data: 4 },
        { host: "n00dles", file: "b.cct", kind: "Find Largest Prime Factor", data: 13195 },
      ],
    });
    assert(attempts.length === 2, `expected 2 attempts, got ${attempts.length}`);
    assert(attempts[0].answer === 4, `Total Ways to Sum answered ${attempts[0].answer}`);
    assert(attempts[1].answer === 29, `Find Largest Prime Factor answered ${attempts[1].answer}`);
    assert(ns._log.some((l) => l.includes("2 contracts")), `no sweep summary in:\n${ns._log.join("\n")}`);
  },

  /**
   * The reward reaches the TERMINAL, not just the script log.
   *
   * ns.print goes to a window nobody has open. The reward line is the only
   * reason this subsystem exists, so it is one of exactly two lines mirrored to
   * the terminal - the other being a wrong answer. The mock tags tprint as
   * "[T] ", so this cannot pass on the ns.print alone.
   *
   * The string is the game's own, straight off attempt(): re-deriving it here
   * would mean formatting money without ns.format.number.
   */
  "the reward reaches the terminal, verbatim from the game": async () => {
    const mods = await loadScripts();
    const { ns } = await sweepOnce(mods, {
      contracts: [{ host: "omega-net", file: "a.cct", kind: "Total Ways to Sum", data: 4 }],
      reward: () => "Gained 8250 faction reputation for CyberSec",
    });
    const shouted = ns._log.filter((l) => l.startsWith("[T] "));
    assert(shouted.some((l) => l.includes("Gained 8250 faction reputation for CyberSec")),
      `the reward must reach the terminal:
${ns._log.join("\n")}`);
    assert(shouted.some((l) => l.includes("omega-net")),
      "the terminal line must say which host it came off");
    // The 10-minute summary is log-only: mostly "0 solved", and terminal spam.
    assert(!shouted.some((l) => l.includes("sweep:")),
      `the sweep summary must NOT be tprinted:
${shouted.join("\n")}`);
  },

  /**
   * A wrong answer is a solver bug that has just spent a try, and every other
   * contract of that type will spend one too. Louder than a success, not quieter.
   */
  "a wrong answer is shouted to the terminal too": async () => {
    const mods = await loadScripts();
    const { ns } = await sweepOnce(mods, {
      contracts: [{ host: "home", file: "a.cct", kind: "Total Ways to Sum", data: 4 }],
      reward: () => "",
    });
    assert(ns._log.some((l) => l.startsWith("[T] ") && l.includes("WRONG ANSWER")),
      `a wrong answer must reach the terminal:
${ns._log.join("\n")}`);
  },

  /**
   * A contract that vanished between the read and the attempt.
   *
   * attempt() THROWS in that case, and per-batch error handling would lose
   * every other answer in the same call. It happens whenever two sweeps overlap
   * - a hand-run --once beside the resident service, which is the right thing
   * to do before installing augmentations, since prestigeAllServers() destroys
   * every unsolved contract.
   *
   * It must not be treated as a wrong answer: nothing is broken, so it does not
   * go in the skip list and does not shout at the terminal.
   */
  "a contract that disappeared mid-sweep costs the rest of the batch nothing": async () => {
    const mods = await loadScripts();
    const { ns, attempts } = await sweepOnce(mods, {
      contracts: [
        { host: "home", file: "gone.cct", kind: "Total Ways to Sum", data: 4, vanish: true },
        { host: "home", file: "ok.cct", kind: "Find Largest Prime Factor", data: 13195 },
      ],
    });
    assert(attempts.some((a) => a.file === "ok.cct"),
      `one throw lost the whole batch: ${JSON.stringify(attempts)}`);
    assert(ns._log.some((l) => l.includes("already gone")),
      `the sweep summary must account for it: ${ns._log.join(" | ")}`);
    assert(!ns._log.some((l) => l.includes("WRONG ANSWER")),
      "a vanished contract is not a wrong answer");
  },

  /**
   * The bigint boundary, end to end.
   *
   * getData hands a bigint back for Square Root and rpc.js returns every value
   * through JSON.stringify, which throws on one - so without the conversion in
   * the FIND body the whole sweep dies and the OTHER contract here is never
   * attempted either. That collateral damage is the reason this is a test.
   */
  "one Square Root contract does not take the sweep down with it": async () => {
    const mods = await loadScripts();
    const root = 99999999999999999999n;
    const { attempts } = await sweepOnce(mods, {
      contracts: [
        { host: "home", file: "sqrt.cct", kind: "Square Root", data: root * root + 3n },
        { host: "home", file: "sum.cct", kind: "Total Ways to Sum", data: 4 },
      ],
    });
    assert(attempts.length === 2, `the bigint killed the sweep: only ${attempts.length} attempt(s)`);
    assert(attempts[0].answer === root.toString(),
      `Square Root answered ${JSON.stringify(attempts[0].answer)}, want the decimal string`);
  },

  "a type with no solver is never attempted": async () => {
    const mods = await loadScripts();
    const { ns, attempts } = await sweepOnce(mods, {
      contracts: [{ host: "home", file: "x.cct", kind: "Some Type A Later Fork Adds", data: 1 }],
    });
    assert(attempts.length === 0, "an unsolved type must not spend a try");
    assert(ns._log.some((l) => l.includes("unsolved")), `the log must name it:\n${ns._log.join("\n")}`);
  },

  /**
   * A wrong answer is never retried, and the skip list has to SURVIVE THE
   * PROCESS to manage it.
   *
   * As a resident service an in-memory Set was enough. As a per-minute transient
   * it is not: the solvers are deterministic, so the same wrong answer once a
   * minute spends all ten of a contract's tries inside ten minutes, and
   * "Array Jumping Game" allows exactly one - it would be destroyed on the very
   * next run. So this drives two separate sweeps, passing only the FILES
   * between them, exactly as boot does.
   */
  "a refused answer is not attempted again by the next process": async () => {
    const mods = await loadScripts();
    const first = await sweepOnce(mods, {
      contracts: [{ host: "home", file: "a.cct", kind: "Total Ways to Sum", data: 4 }],
      reward: () => "",
    });
    assert(first.attempts.length === 1, "the first sweep should attempt it once");
    assert(first.ns._log.some((l) => l.startsWith("[T] ") && l.includes("WRONG ANSWER")),
      "a wrong answer must reach the terminal");

    // Second process. It shares only /data and the network, like boot's next tick.
    const second = await sweepOnce(mods, {
      live: first.live,
      store: first.store,
      reward: () => "",
    });
    assert(second.attempts.length === 0,
      `the skip list did not survive the exit - it would burn every try: ${JSON.stringify(second.attempts)}`);
    assert(second.ns._log.some((l) => l.includes("1 skipped")),
      `the sweep summary must account for the skip: ${second.ns._log.join(" | ")}`);
  },

  /**
   * --forget is the way out of a permanent skip. Without it a contract refused
   * by a solver bug stays skipped for the life of the BitNode even after the
   * solver is fixed, because the skip list is now a file.
   */
  "--forget clears the skip list": async () => {
    const mods = await loadScripts();
    const first = await sweepOnce(mods, {
      contracts: [{ host: "home", file: "a.cct", kind: "Total Ways to Sum", data: 4 }],
      reward: () => "",
    });
    const second = await sweepOnce(mods, {
      live: first.live,
      store: first.store,
      args: ["--forget"],
    });
    assert(second.attempts.length === 1,
      "--forget must put a previously refused contract back in play");
  },

  /**
   * The gate message goes to the terminal ONCE, not once a minute.
   *
   * A transient's ns.print dies with its log window, so the terminal is the only
   * durable channel - and boot runs this every tick. Ten identical "holding off"
   * lines before the gate even opens would be the reason to turn it off.
   */
  "the gate says why once, not every run": async () => {
    const mods = await loadScripts();
    const shut = { contracts: [], sinceReset: 0, factions: [] };
    const first = await sweepOnce(mods, shut);
    const firstShout = first.ns._log.filter((l) => l.startsWith("[T] "));
    assert(firstShout.some((l) => l.includes("holding off")),
      `the first run must say why: ${first.ns._log.join(" | ")}`);

    const second = await sweepOnce(mods, { ...shut, store: first.store });
    assert(second.ns._log.filter((l) => l.startsWith("[T] ")).length === 0,
      `the second run must be silent: ${second.ns._log.join(" | ")}`);

    // Gate opens, then shuts again - an install resets both halves of it. The
    // marker has to clear on the way through, or the reason is never said again.
    const open = await sweepOnce(mods, { contracts: [], store: second.store });
    const shutAgain = await sweepOnce(mods, { ...shut, store: open.store });
    assert(shutAgain.ns._log.some((l) => l.startsWith("[T] ") && l.includes("holding off")),
      "after the gate opened and shut again it must say why once more");
  },

  /**
   * The whole point of the subsystem. Three of the four reward types pay
   * reputation, and gainCodingContractReward resolves the faction AT ATTEMPT
   * TIME - filtering Player.factions and falling back to Money when it is
   * empty. So solving before a faction is joined is what the gate prevents, and
   * both halves of it have to hold on their own.
   */
  "nothing is attempted before the clock and a faction": async () => {
    const mods = await loadScripts();
    const TEN_MIN = 10 * 60 * 1000;

    const early = await sweepOnce(mods, {
      contracts: [{ host: "home", file: "a.cct", kind: "Total Ways to Sum", data: 4 }],
      sinceReset: TEN_MIN - 1000,
      factions: ["CyberSec"],
    });
    assert(early.attempts.length === 0, "the clock alone must hold it shut");
    assert(early.ns._log.some((l) => l.includes("left on the clock")),
      `the log must say which half is shut:\n${early.ns._log.join("\n")}`);

    const factionless = await sweepOnce(mods, {
      contracts: [{ host: "home", file: "a.cct", kind: "Total Ways to Sum", data: 4 }],
      sinceReset: TEN_MIN * 5,
      factions: [],
    });
    assert(factionless.attempts.length === 0,
      "an empty faction list must hold it shut - every faction reward would pay money instead");
    assert(factionless.ns._log.some((l) => l.includes("no faction joined yet")),
      `the log must say which half is shut:\n${factionless.ns._log.join("\n")}`);

    const open = await sweepOnce(mods, {
      contracts: [{ host: "home", file: "a.cct", kind: "Total Ways to Sum", data: 4 }],
      sinceReset: TEN_MIN * 5,
      factions: ["CyberSec"],
    });
    assert(open.attempts.length === 1, "both conditions met, so it should sweep");
  },

  /**
   * The clock runs from the LATER of the two resets. Entering a BitNode sets
   * lastNodeReset and an install sets lastAugReset; taking only one of them
   * would let a fresh BitNode inherit an old aug timestamp and sweep at once.
   */
  "the clock runs from whichever reset was later": async () => {
    const mods = await loadScripts();
    const now = Date.now();
    const { attempts } = await sweepOnce(mods, {
      contracts: [{ host: "home", file: "a.cct", kind: "Total Ways to Sum", data: 4 }],
      factions: ["CyberSec"],
      resetInfo: { lastAugReset: now - 60 * 60 * 1000, lastNodeReset: now - 1000 },
    });
    assert(attempts.length === 0, "an hour-old aug reset must not excuse a one-second-old node reset");
  },

  /** --dummy exists to prove the solvers in-game, so it must ignore the gate. */
  "--dummy mints one of every type and sweeps past the gate": async () => {
    const mods = await loadScripts();
    const { ns, minted, attempts } = await sweepOnce(mods, {
      args: ["--dummy"],
      sinceReset: 0,
      factions: [],
      dummyTypes: FORK_TYPES,
    });
    assert(minted.length === FORK_TYPES.length,
      `expected ${FORK_TYPES.length} dummy contracts, got ${minted.length}`);
    assert(attempts.length === FORK_TYPES.length,
      `every minted type should be attempted, got ${attempts.length}`);
    assert(ns._log.some((l) => l.includes("dummy contracts on home")),
      `the log must report the mint:\n${ns._log.join("\n")}`);
  },

  /**
   * --dummy ignores the gate, so without a restriction it would also sweep the
   * REAL contracts - spending them at exactly the moment every faction reward
   * falls back to money, which is the thing the gate exists to prevent.
   */
  "--dummy touches only the contracts it minted": async () => {
    const mods = await loadScripts();
    const { attempts } = await sweepOnce(mods, {
      args: ["--dummy"],
      sinceReset: 0,
      factions: [],
      dummyTypes: ["Total Ways to Sum"],
      contracts: [{ host: "n00dles", file: "real.cct", kind: "Find Largest Prime Factor", data: 13195 }],
    });
    assert(attempts.length === 1, `expected only the dummy, got ${JSON.stringify(attempts)}`);
    assert(attempts[0].file.startsWith("dummy-"), `it spent a real contract: ${attempts[0].file}`);
  },

  /**
   * A transient that will not start is the expected failure on a fresh 32 GB
   * home, where the 13.50 GB FIND body does not fit beside boot, cloud and the
   * manager. It must log and carry on, not throw: a throw stops the service and
   * boot restarts it into the same wall a minute later.
   */
  "a body that will not start logs a warning and keeps the service alive": async () => {
    const mods = await loadScripts();
    const { ns } = await sweepOnce(mods, {
      contracts: [{ host: "home", file: "a.cct", kind: "Total Ways to Sum", data: 4 }],
      noRam: true,
      sweeps: 2,
    });
    assert(ns._log.some((l) => l.includes("WARN: find failed")),
      `the cause must be named:\n${ns._log.join("\n")}`);
    // No free RAM is the ordinary state for a fresh BitNode's first minutes, and
    // boot retries every tick - the terminal is no place for it (the user's call).
    assert(!ns._log.some((l) => l.includes("[T]") && l.includes("WARN")),
      `a failed body must not reach the terminal:\n${ns._log.join("\n")}`);
  },
};
