/**
 * Every coding-contract solver, as pure functions. 0 GB.
 *
 * Each one is a transcription of the matching `getAnswer` / `solver` in
 * src/CodingContract/contracts/*.ts of this fork. They are transcribed rather
 * than reasoned out because the game checks the answer against ITS algorithm,
 * not against the problem statement: "Largest Rectangle" accepts any rectangle
 * of the optimal AREA, "Shortest Path" accepts any path of optimal length,
 * "Compression III" accepts any encoding no longer than its own, and
 * "Array Jumping Game II" answers 0 - not Infinity - when the end is
 * unreachable. Guessing at the statement gets those four wrong.
 *
 * RAM: 0 GB, and tests/ram.test.mjs pins that at exactly BASE. It has to,
 * because the game bills IDENTIFIERS and the natural names here are the
 * expensive ones: a sliding-`window` counter is 25.00 GB, the `run` lengths in
 * RLE are 1.00, and `attempt` is 10.00. See scripts/continuous/lib/prep.js:96,
 * where the loop counter is called `step` for exactly this reason. Nothing in
 * this file may be named after an ns function - including `ls`, `ps`, `scan`,
 * `share`, `probe` and every ns.codingcontract name (`getData` alone is 5.00).
 */

// ------------------------------------------------------------- primitives ---

/** Largest prime factor. Transcribed - the trial division bound is (fac-1)^2. */
function largestPrimeFactor(n) {
  let fac = 2;
  let left = n;
  while (left > (fac - 1) * (fac - 1)) {
    while (left % fac === 0) left = Math.round(left / fac);
    ++fac;
  }
  return left === 1 ? fac - 1 : left;
}

/** Sieve of Eratosthenes up to max, returning the primes themselves. */
function simpleSieve(max) {
  const primes = [];
  const marked = Array(max);
  for (let i = 2; i * i <= max; i++) {
    if (!marked[i]) {
      for (let p = i * i; p <= max; p += i) marked[p] = 1;
    }
  }
  for (let i = 2; i <= max; i++) if (!marked[i]) primes.push(i);
  return primes;
}

/**
 * Count primes in [low, high]. Segmented, because high can be 6e6 while the
 * window is only 1e6 wide - a full sieve to high is the slow way round.
 */
function countPrimesInRange(low, high) {
  const from = low < 2 ? 2 : low;
  let total = 0;
  const marked = Array(high - from + 1);
  for (const i of simpleSieve(Math.ceil(Math.sqrt(high)))) {
    const first = Math.max(i, Math.ceil(from / i)) * i;
    for (let j = first; j <= high; j += i) marked[j - from] = 1;
  }
  for (let a = 0; a <= high - from; a++) if (!marked[a]) ++total;
  return total;
}

/** Integer square root of a BigInt, by Newton's method. */
function bigIntSqrt(value) {
  if (value < 2n) return value;
  let guess = value;
  let next = (guess + 1n) / 2n;
  while (next < guess) {
    guess = next;
    next = (guess + value / guess) / 2n;
  }
  return guess;
}

// ------------------------------------------------------------ compression ---

/**
 * Run-length encode with the minimum output length.
 *
 * The counter is `count`, NOT `run`: `run` is billed as ns.run at 1.00 GB, and
 * this module has to stay at exactly 0.
 */
function rleEncode(plain) {
  if (plain.length === 0) return "";
  let out = "";
  let count = 1;
  for (let i = 1; i < plain.length; i++) {
    if (count < 9 && plain[i] === plain[i - 1]) {
      count++;
      continue;
    }
    out += count + plain[i - 1];
    count = 1;
  }
  out += count + plain[plain.length - 1];
  return out;
}

/** Decode this fork's LZ variant, or null when the input is malformed. */
function lzDecode(compr) {
  let plain = "";
  for (let i = 0; i < compr.length; ) {
    const literalLength = compr.charCodeAt(i) - 0x30;
    if (literalLength < 0 || literalLength > 9 || i + 1 + literalLength > compr.length) return null;

    plain += compr.substring(i + 1, i + 1 + literalLength);
    i += 1 + literalLength;
    if (i >= compr.length) break;

    const backrefLength = compr.charCodeAt(i) - 0x30;
    if (backrefLength < 0 || backrefLength > 9) return null;
    if (backrefLength === 0) {
      ++i;
      continue;
    }
    if (i + 1 >= compr.length) return null;
    const backrefOffset = compr.charCodeAt(i + 1) - 0x30;
    if (backrefOffset < 1 || backrefOffset > 9 || backrefOffset > plain.length) return null;
    for (let j = 0; j < backrefLength; ++j) plain += plain[plain.length - backrefOffset];
    i += 2;
  }
  return plain;
}

/**
 * Minimal-length LZ encoding. state[0][j] is a literal of length j in progress,
 * state[i][j] a backreference of offset i and length j.
 *
 * The game's own encoder picks RANDOMLY between two candidates of equal length,
 * to widen the pool of inputs it can hand Compression II. That is dropped here
 * and only a strictly shorter candidate replaces the incumbent: a tie-break
 * cannot change the LENGTH, and the check is
 * `answer.length <= encoded.length && lzDecode(answer) === plain`.
 */
function lzEncode(plain) {
  let curState = Array.from(Array(10), () => new Array(10).fill(null));
  let newState = Array.from(Array(10), () => new Array(10).fill(null));

  const keep = (state, i, j, str) => {
    const current = state[i][j];
    if (current === null || str.length < current.length) state[i][j] = str;
  };

  curState[0][1] = "";

  for (let i = 1; i < plain.length; ++i) {
    for (const row of newState) row.fill(null);
    const c = plain[i];

    // Literals in progress.
    for (let len = 1; len <= 9; ++len) {
      const str = curState[0][len];
      if (str === null) continue;
      if (len < 9) keep(newState, 0, len + 1, str);
      else keep(newState, 0, 1, str + "9" + plain.substring(i - 9, i) + "0");

      for (let offset = 1; offset <= Math.min(9, i); ++offset) {
        if (plain[i - offset] === c) keep(newState, offset, 1, str + String(len) + plain.substring(i - len, i));
      }
    }

    // Backreferences in progress.
    for (let offset = 1; offset <= 9; ++offset) {
      for (let len = 1; len <= 9; ++len) {
        const str = curState[offset][len];
        if (str === null) continue;

        if (plain[i - offset] === c) {
          if (len < 9) keep(newState, offset, len + 1, str);
          else keep(newState, offset, 1, str + "9" + String(offset) + "0");
        }
        keep(newState, 0, 1, str + String(len) + String(offset));
        for (let nextOffset = 1; nextOffset <= Math.min(9, i); ++nextOffset) {
          if (plain[i - nextOffset] === c) {
            keep(newState, nextOffset, 1, str + String(len) + String(offset) + "0");
          }
        }
      }
    }

    const swap = newState;
    newState = curState;
    curState = swap;
  }

  let result = null;
  const better = (candidate) => {
    if (result === null || candidate.length < result.length) result = candidate;
  };
  for (let len = 1; len <= 9; ++len) {
    const str = curState[0][len];
    if (str !== null) better(str + String(len) + plain.substring(plain.length - len, plain.length));
  }
  for (let offset = 1; offset <= 9; ++offset) {
    for (let len = 1; len <= 9; ++len) {
      const str = curState[offset][len];
      if (str !== null) better(str + String(len) + String(offset));
    }
  }
  return result ?? "";
}

// ----------------------------------------------------------- hamming code ---

/**
 * Extended Hamming encode. The data bits are written back to front, which looks
 * like a bug and is the game's documented behaviour - the comment in
 * HammingCode.ts keeps it "like it was".
 */
function hammingEncode(value) {
  const enc = [0];
  const dataBits = value
    .toString(2)
    .split("")
    .reverse()
    .map((b) => parseInt(b, 10));

  let k = dataBits.length;
  for (let i = 1; k > 0; i++) {
    if ((i & (i - 1)) !== 0) enc[i] = dataBits[--k];
    else enc[i] = 0;
  }

  let parityNumber = 0;
  for (let i = 0; i < enc.length; i++) if (enc[i]) parityNumber ^= i;

  const parityArray = parityNumber
    .toString(2)
    .split("")
    .reverse()
    .map((b) => parseInt(b, 10));
  for (let i = 0; i < parityArray.length; i++) enc[2 ** i] = parityArray[i] ? 1 : 0;

  parityNumber = 0;
  for (let i = 0; i < enc.length; i++) if (enc[i]) parityNumber++;
  enc[0] = parityNumber % 2 === 0 ? 0 : 1;

  return enc.join("");
}

/** Extended Hamming decode, correcting the single flipped bit if there is one. */
function hammingDecode(text) {
  let err = 0;
  const bits = [];
  const chars = text.split("");
  for (let i = 0; i < chars.length; ++i) {
    const bit = parseInt(chars[i], 10);
    bits[i] = bit;
    if (bit) err ^= i;
  }
  if (err) bits[err] = bits[err] ? 0 : 1;

  let ans = "";
  for (let i = 1; i < bits.length; i++) {
    if ((i & (i - 1)) !== 0) ans += bits[i];
  }
  return parseInt(ans, 2);
}

// -------------------------------------------------------------- the table ---

/**
 * Keyed by the exact string ns.codingcontract.getContractType returns.
 *
 * String keys, not identifiers: a non-computed object key is a Literal to the
 * game's RAM calculator and costs nothing, which is the same trick STAT_KEYS
 * plays in gang/config.js.
 */
const SOLVERS = {
  "Find Largest Prime Factor": (data) => largestPrimeFactor(data),

  "Subarray with Maximum Sum": (data) => {
    const nums = data.slice();
    for (let i = 1; i < nums.length; i++) nums[i] = Math.max(nums[i], nums[i] + nums[i - 1]);
    return Math.max(...nums);
  },

  "Total Ways to Sum": (data) => {
    const ways = [1];
    ways.length = data + 1;
    ways.fill(0, 1);
    for (let i = 1; i < data; ++i) {
      for (let j = i; j <= data; ++j) ways[j] += ways[j - i];
    }
    return ways[data];
  },

  "Total Ways to Sum II": (data) => {
    const target = data[0];
    const coins = data[1];
    const ways = [1];
    ways.length = target + 1;
    ways.fill(0, 1);
    for (let i = 0; i < coins.length; i++) {
      for (let j = coins[i]; j <= target; j++) ways[j] += ways[j - coins[i]];
    }
    return ways[target];
  },

  "Spiralize Matrix": (data) => {
    const spiral = [];
    let up = 0;
    let down = data.length - 1;
    let left = 0;
    let right = data[0].length - 1;
    let k = 0;
    for (;;) {
      for (let col = left; col <= right; col++) spiral[k++] = data[up][col];
      if (++up > down) break;
      for (let row = up; row <= down; row++) spiral[k++] = data[row][right];
      if (--right < left) break;
      for (let col = right; col >= left; col--) spiral[k++] = data[down][col];
      if (--down < up) break;
      for (let row = down; row >= up; row--) spiral[k++] = data[row][left];
      if (++left > right) break;
    }
    return spiral;
  },

  // 1 or 0, never true/false: validateAnswer insists on the numbers.
  "Array Jumping Game": (data) => {
    const n = data.length;
    let i = 0;
    for (let reach = 0; i < n && i <= reach; ++i) reach = Math.max(i + data[i], reach);
    return i === n ? 1 : 0;
  },

  // 0 means UNREACHABLE here, not "already there" - transcribed, not inferred.
  "Array Jumping Game II": (data) => {
    const n = data.length;
    let reach = 0;
    let jumps = 0;
    let lastJump = -1;
    while (reach < n - 1) {
      let jumpedFrom = -1;
      for (let i = reach; i > lastJump; i--) {
        if (i + data[i] > reach) {
          reach = i + data[i];
          jumpedFrom = i;
        }
      }
      if (jumpedFrom === -1) {
        jumps = 0;
        break;
      }
      lastJump = jumpedFrom;
      jumps++;
    }
    return jumps;
  },

  "Merge Overlapping Intervals": (data) => {
    const intervals = data.slice().sort((a, b) => a[0] - b[0]);
    const result = [];
    let start = intervals[0][0];
    let end = intervals[0][1];
    for (const interval of intervals) {
      if (interval[0] <= end) {
        end = Math.max(end, interval[1]);
      } else {
        result.push([start, end]);
        start = interval[0];
        end = interval[1];
      }
    }
    result.push([start, end]);
    return result;
  },

  "Generate IP Addresses": (data) => {
    const out = [];
    for (let a = 1; a <= 3; ++a) {
      for (let b = 1; b <= 3; ++b) {
        for (let c = 1; c <= 3; ++c) {
          for (let d = 1; d <= 3; ++d) {
            if (a + b + c + d !== data.length) continue;
            const A = parseInt(data.substring(0, a), 10);
            const B = parseInt(data.substring(a, a + b), 10);
            const C = parseInt(data.substring(a + b, a + b + c), 10);
            const D = parseInt(data.substring(a + b + c, a + b + c + d), 10);
            if (A > 255 || B > 255 || C > 255 || D > 255) continue;
            const ip = [A, ".", B, ".", C, ".", D].join("");
            // Rejects a leading zero: "010" parses to 10 and shortens the join.
            if (ip.length === data.length + 3) out.push(ip);
          }
        }
      }
    }
    return out;
  },

  "Algorithmic Stock Trader I": (data) => {
    let maxCur = 0;
    let maxSoFar = 0;
    for (let i = 1; i < data.length; ++i) {
      maxCur = Math.max(0, (maxCur += data[i] - data[i - 1]));
      maxSoFar = Math.max(maxCur, maxSoFar);
    }
    return maxSoFar;
  },

  "Algorithmic Stock Trader II": (data) => {
    let profit = 0;
    for (let p = 1; p < data.length; ++p) profit += Math.max(data[p] - data[p - 1], 0);
    return profit;
  },

  "Algorithmic Stock Trader III": (data) => {
    let hold1 = Number.MIN_SAFE_INTEGER;
    let hold2 = Number.MIN_SAFE_INTEGER;
    let release1 = 0;
    let release2 = 0;
    for (const price of data) {
      release2 = Math.max(release2, hold2 + price);
      hold2 = Math.max(hold2, release1 - price);
      release1 = Math.max(release1, hold1 + price);
      hold1 = Math.max(hold1, price * -1);
    }
    return release2;
  },

  "Algorithmic Stock Trader IV": (data) => {
    const k = data[0];
    const prices = data[1];
    const len = prices.length;
    if (len < 2) return 0;
    if (k > len / 2) {
      let res = 0;
      for (let i = 1; i < len; ++i) res += Math.max(prices[i] - prices[i - 1], 0);
      return res;
    }
    const hold = [];
    const rele = [];
    hold.length = k + 1;
    rele.length = k + 1;
    for (let i = 0; i <= k; ++i) {
      hold[i] = Number.MIN_SAFE_INTEGER;
      rele[i] = 0;
    }
    for (let i = 0; i < len; ++i) {
      const cur = prices[i];
      for (let j = k; j > 0; --j) {
        rele[j] = Math.max(rele[j], hold[j] + cur);
        hold[j] = Math.max(hold[j], rele[j - 1] - cur);
      }
    }
    return rele[k];
  },

  "Minimum Path Sum in a Triangle": (data) => {
    const n = data.length;
    const dp = data[n - 1].slice();
    for (let i = n - 2; i > -1; --i) {
      for (let j = 0; j < data[i].length; ++j) dp[j] = Math.min(dp[j], dp[j + 1]) + data[i][j];
    }
    return dp[0];
  },

  "Unique Paths in a Grid I": (data) => {
    const n = data[0];
    const m = data[1];
    const currentRow = [];
    currentRow.length = n;
    for (let i = 0; i < n; i++) currentRow[i] = 1;
    for (let row = 1; row < m; row++) {
      for (let i = 1; i < n; i++) currentRow[i] += currentRow[i - 1];
    }
    return currentRow[n - 1];
  },

  "Unique Paths in a Grid II": (data) => {
    const grid = data.map((row) => row.slice());
    for (let i = 0; i < grid.length; i++) {
      for (let j = 0; j < grid[0].length; j++) {
        if (grid[i][j] === 1) grid[i][j] = 0;
        else if (i === 0 && j === 0) grid[0][0] = 1;
        else grid[i][j] = (i > 0 ? grid[i - 1][j] : 0) + (j > 0 ? grid[i][j - 1] : 0);
      }
    }
    return grid[grid.length - 1][grid[0].length - 1];
  },

  /**
   * BFS, then walk the distance field back from the destination. Any path of
   * the optimal length is accepted, so the reconstruction order is free.
   * Unreachable is the empty string, which the checker tests for explicitly.
   */
  "Shortest Path in a Grid": (data) => {
    const height = data.length;
    const width = data[0].length;
    const dstY = height - 1;
    const dstX = width - 1;
    if (data[0][0] === 1) return "";

    const distance = [];
    for (let y = 0; y < height; y++) distance.push(new Array(width).fill(Infinity));

    const MOVES = [
      [-1, 0, "U"],
      [1, 0, "D"],
      [0, -1, "L"],
      [0, 1, "R"],
    ];

    distance[0][0] = 0;
    const queue = [[0, 0]];
    for (let head = 0; head < queue.length; head++) {
      const [y, x] = queue[head];
      for (const [dy, dx] of MOVES) {
        const ny = y + dy;
        const nx = x + dx;
        if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
        if (data[ny][nx] !== 0 || distance[ny][nx] !== Infinity) continue;
        distance[ny][nx] = distance[y][x] + 1;
        queue.push([ny, nx]);
      }
    }
    if (!Number.isFinite(distance[dstY][dstX])) return "";

    let path = "";
    let y = dstY;
    let x = dstX;
    while (y !== 0 || x !== 0) {
      for (const [dy, dx, letter] of MOVES) {
        const py = y - dy;
        const px = x - dx;
        if (py < 0 || py >= height || px < 0 || px >= width) continue;
        if (distance[py][px] !== distance[y][x] - 1) continue;
        path = letter + path;
        y = py;
        x = px;
        break;
      }
    }
    return path;
  },

  "Sanitize Parentheses in Expression": (data) => {
    let left = 0;
    let right = 0;
    for (let i = 0; i < data.length; ++i) {
      if (data[i] === "(") ++left;
      else if (data[i] === ")") left > 0 ? --left : ++right;
    }

    const res = [];
    const dfs = (pair, index, lo, ro, solution) => {
      if (data.length === index) {
        if (lo === 0 && ro === 0 && pair === 0 && !res.includes(solution)) res.push(solution);
        return;
      }
      if (data[index] === "(") {
        if (lo > 0) dfs(pair, index + 1, lo - 1, ro, solution);
        dfs(pair + 1, index + 1, lo, ro, solution + data[index]);
      } else if (data[index] === ")") {
        if (ro > 0) dfs(pair, index + 1, lo, ro - 1, solution);
        if (pair > 0) dfs(pair - 1, index + 1, lo, ro, solution + data[index]);
      } else {
        dfs(pair, index + 1, lo, ro, solution + data[index]);
      }
    };
    dfs(0, 0, left, right, "");
    return res;
  },

  "Find All Valid Math Expressions": (data) => {
    const digits = data[0];
    const target = data[1];
    const res = [];

    const walk = (path, pos, evaluated, multed) => {
      if (pos === digits.length) {
        if (target === evaluated) res.push(path);
        return;
      }
      for (let i = pos; i < digits.length; ++i) {
        // No leading zeroes: "1+01" is not a valid expression.
        if (i !== pos && digits[pos] === "0") break;
        const cur = parseInt(digits.substring(pos, i + 1), 10);
        if (pos === 0) {
          walk(path + cur, i + 1, cur, cur);
        } else {
          walk(path + "+" + cur, i + 1, evaluated + cur, cur);
          walk(path + "-" + cur, i + 1, evaluated - cur, -cur);
          walk(path + "*" + cur, i + 1, evaluated - multed + multed * cur, multed * cur);
        }
      }
    };
    walk("", 0, 0, 0);
    return res;
  },

  "HammingCodes: Integer to Encoded Binary": (data) => hammingEncode(data),

  "HammingCodes: Encoded Binary to Integer": (data) => hammingDecode(data),

  /**
   * Greedy 2-colouring over every component. The empty array is the answer for
   * a graph that is NOT 2-colourable, and only then - the checker verifies
   * non-colourability itself before accepting it.
   */
  "Proper 2-Coloring of a Graph": (data) => {
    const size = data[0];
    const edges = data[1];
    const adjacency = Array.from({ length: size }, () => []);
    for (const [a, b] of edges) {
      adjacency[a].push(b);
      adjacency[b].push(a);
    }

    const coloring = new Array(size).fill(-1);
    for (let start = 0; start < size; start++) {
      if (coloring[start] !== -1) continue;
      coloring[start] = 0;
      const frontier = [start];
      for (let head = 0; head < frontier.length; head++) {
        const v = frontier[head];
        for (const u of adjacency[v]) {
          if (coloring[u] === -1) {
            coloring[u] = coloring[v] === 0 ? 1 : 0;
            frontier.push(u);
          } else if (coloring[u] === coloring[v]) {
            return [];
          }
        }
      }
    }
    return coloring;
  },

  "Compression I: RLE Compression": (data) => rleEncode(data),

  "Compression II: LZ Decompression": (data) => lzDecode(data),

  "Compression III: LZ Compression": (data) => lzEncode(data),

  "Encryption I: Caesar Cipher": (data) =>
    [...data[0]]
      .map((a) => (a === " " ? a : String.fromCharCode(((a.charCodeAt(0) - 65 - data[1] + 26) % 26) + 65)))
      .join(""),

  // The ONE contract name with a non-ASCII character in it, and the only key
  // here written as an ESCAPE rather than a literal.
  //
  // It has to be byte-for-byte what getContractType returns. An ASCII-folded
  // "Vigenere" misses the lookup, solve() answers null, and the contract reads
  // as permanently unsolved with no error anywhere - which is how the first
  // version shipped and why a live --dummy run scored 29 of 30.
  //
  // The escape keeps this whole file ASCII, so nothing on the way into the game
  // can re-encode it. Two hops get a chance to: the filesync extension, and
  // ns.scp. CLAUDE.md already names filesync as the least reliable link here.
  "Encryption II: Vigen\u00e8re Cipher": (data) =>
    [...data[0]]
      .map((a, i) =>
        a === " "
          ? a
          : String.fromCharCode(((a.charCodeAt(0) - 2 * 65 + data[1].charCodeAt(i % data[1].length)) % 26) + 65),
      )
      .join(""),

  /**
   * Takes and returns a DECIMAL STRING, not a BigInt.
   *
   * ns.codingcontract.getData hands this one back as a bigint, and rpc.js
   * returns every value through JSON.stringify - which throws outright on a
   * BigInt. One Square Root contract anywhere on the network would take the
   * whole sweep down with it, so the find body stringifies before returning and
   * the answer goes back as a string, which attempt() feeds to BigInt().
   *
   * round(sqrt(x)) is r+1 exactly when x >= r*r + r + 1, r being floor(sqrt(x)):
   * the integers rounding to n are [n^2-n+1, n^2+n+1).
   */
  "Square Root": (data) => {
    const value = BigInt(data);
    const r = bigIntSqrt(value);
    return (value - r * r >= r + 1n ? r + 1n : r).toString();
  },

  "Total Number of Primes": (data) => countPrimesInRange(data[0], data[1]),

  /**
   * Largest all-zero rectangle, as [[topRow, leftCol], [bottomRow, rightCol]].
   * Histogram per column, then the widest span at each height. Only the AREA
   * has to match the game own answer, not the position.
   */
  "Largest Rectangle in a Matrix": (data) => {
    const histograms = Array.from({ length: data.length }, () => new Array(data[0].length).fill(0));
    for (let i = 0; i < data[0].length; i++) {
      let count = 0;
      for (let j = 0; j < data.length; j++) {
        count = data[j][i] === 0 ? count + 1 : 0;
        histograms[j][i] = count;
      }
    }
    let maxArea = 0;
    let maxL = 0;
    let maxR = 0;
    let maxU = 0;
    let maxD = 0;
    for (let i = 0; i < histograms.length; i++) {
      const row = histograms[i];
      for (let j = 0; j < row.length; j++) {
        if (row[j] === 0) continue;
        let left = j;
        let right = j;
        // Out of bounds reads undefined, and undefined >= n is false - which is
        // the loop only stop condition. Transcribed deliberately.
        while (row[left - 1] >= row[j]) left--;
        while (row[right + 1] >= row[j]) right++;
        if ((right - left + 1) * row[j] > maxArea) {
          maxArea = (right - left + 1) * row[j];
          maxL = left;
          maxR = right;
          maxU = i - row[j] + 1;
          maxD = i;
        }
      }
    }
    return [
      [maxU, maxL],
      [maxD, maxR],
    ];
  },
};

// ---------------------------------------------------------------- the API ---

/** Every contract type this module can answer. */
export function solvableTypes() {
  return Object.keys(SOLVERS);
}

/**
 * The answer for one contract, or null.
 *
 * null for an unknown type AND for a solver that threw. Never a guess: a wrong
 * answer spends one of a contract handful of tries, and the contract
 * self-destructs when they run out.
 */
export function solve(type, data) {
  const solver = SOLVERS[type];
  if (!solver) return null;
  try {
    const answer = solver(data);
    return answer === undefined ? null : answer;
  } catch {
    return null;
  }
}
