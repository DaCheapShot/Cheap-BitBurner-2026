// solvers.js — pure JS algorithm library, zero NS calls.
// Imported by contracts.js. Each key is the exact contract type string.

export const SOLVERS = {

  "Find Largest Prime Factor": (n) => {
    let largest = 1, d = 2;
    while (d * d <= n) {
      while (n % d === 0) { largest = d; n /= d; }
      d++;
    }
    return n > 1 ? n : largest;
  },

  "Subarray with Maximum Sum": (arr) => {
    let max = -Infinity, cur = 0;
    for (const x of arr) {
      cur = Math.max(x, cur + x);
      max = Math.max(max, cur);
    }
    return max;
  },

  "Total Ways to Sum I": (n) => {
    const dp = new Array(n + 1).fill(0);
    dp[0] = 1;
    for (let i = 1; i < n; i++) {
      for (let j = i; j <= n; j++) dp[j] += dp[j - i];
    }
    return dp[n];
  },

  "Total Ways to Sum II": ([n, coins]) => {
    const dp = new Array(n + 1).fill(0);
    dp[0] = 1;
    for (const coin of coins) {
      for (let j = coin; j <= n; j++) dp[j] += dp[j - coin];
    }
    return dp[n];
  },

  "Algorithmic Stock Trader I": (prices) => {
    let minPrice = Infinity, maxProfit = 0;
    for (const p of prices) {
      minPrice = Math.min(minPrice, p);
      maxProfit = Math.max(maxProfit, p - minPrice);
    }
    return maxProfit;
  },

  "Algorithmic Stock Trader II": (prices) => {
    let profit = 0;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > prices[i - 1]) profit += prices[i] - prices[i - 1];
    }
    return profit;
  },

  "Algorithmic Stock Trader III": (prices) => {
    let buy1 = -Infinity, sell1 = 0, buy2 = -Infinity, sell2 = 0;
    for (const p of prices) {
      buy1  = Math.max(buy1,  -p);
      sell1 = Math.max(sell1, buy1  + p);
      buy2  = Math.max(buy2,  sell1 - p);
      sell2 = Math.max(sell2, buy2  + p);
    }
    return sell2;
  },

  "Algorithmic Stock Trader IV": ([k, prices]) => {
    const n = prices.length;
    if (n === 0 || k === 0) return 0;
    if (k >= Math.floor(n / 2)) {
      let profit = 0;
      for (let i = 1; i < n; i++) {
        if (prices[i] > prices[i - 1]) profit += prices[i] - prices[i - 1];
      }
      return profit;
    }
    const dp = Array.from({ length: k + 1 }, () => new Array(n).fill(0));
    for (let t = 1; t <= k; t++) {
      let maxSoFar = -prices[0];
      for (let d = 1; d < n; d++) {
        dp[t][d]  = Math.max(dp[t][d - 1], prices[d] + maxSoFar);
        maxSoFar  = Math.max(maxSoFar, dp[t - 1][d] - prices[d]);
      }
    }
    return dp[k][n - 1];
  },

  "Minimum Path Sum in a Triangle": (triangle) => {
    const dp = [...triangle[triangle.length - 1]];
    for (let r = triangle.length - 2; r >= 0; r--) {
      for (let c = 0; c < triangle[r].length; c++) {
        dp[c] = triangle[r][c] + Math.min(dp[c], dp[c + 1]);
      }
    }
    return dp[0];
  },

  "Unique Paths in a Grid I": ([m, n]) => {
    const k = Math.min(m, n) - 1;
    const steps = m + n - 2;
    let result = 1;
    for (let i = 0; i < k; i++) result = result * (steps - i) / (i + 1);
    return Math.round(result);
  },

  "Unique Paths in a Grid II": (grid) => {
    const m = grid.length, n = grid[0].length;
    const dp = Array.from({ length: m }, () => new Array(n).fill(0));
    for (let i = 0; i < m && grid[i][0] === 0; i++) dp[i][0] = 1;
    for (let j = 0; j < n && grid[0][j] === 0; j++) dp[0][j] = 1;
    for (let i = 1; i < m; i++) {
      for (let j = 1; j < n; j++) {
        if (grid[i][j] === 0) dp[i][j] = dp[i - 1][j] + dp[i][j - 1];
      }
    }
    return dp[m - 1][n - 1];
  },

  "Spiralize Matrix": (matrix) => {
    const result = [];
    let top = 0, bottom = matrix.length - 1, left = 0, right = matrix[0].length - 1;
    while (top <= bottom && left <= right) {
      for (let i = left; i <= right; i++)  result.push(matrix[top][i]);
      top++;
      for (let i = top; i <= bottom; i++)  result.push(matrix[i][right]);
      right--;
      if (top <= bottom) {
        for (let i = right; i >= left; i--) result.push(matrix[bottom][i]);
        bottom--;
      }
      if (left <= right) {
        for (let i = bottom; i >= top; i--) result.push(matrix[i][left]);
        left++;
      }
    }
    return result;
  },

  "Array Jumping Game I": (arr) => {
    let reach = 0;
    for (let i = 0; i < arr.length; i++) {
      if (i > reach) return 0;
      reach = Math.max(reach, i + arr[i]);
    }
    return 1;
  },

  "Array Jumping Game II": (arr) => {
    const n = arr.length;
    if (n <= 1) return 0;
    let jumps = 0, curEnd = 0, farthest = 0;
    for (let i = 0; i < n - 1; i++) {
      farthest = Math.max(farthest, i + arr[i]);
      if (i === curEnd) {
        if (farthest <= curEnd) return 0;
        jumps++;
        curEnd = farthest;
        if (curEnd >= n - 1) break;
      }
    }
    return jumps;
  },

  "Merge Overlapping Intervals": (intervals) => {
    intervals.sort((a, b) => a[0] - b[0]);
    const result = [intervals[0].slice()];
    for (let i = 1; i < intervals.length; i++) {
      const last = result[result.length - 1];
      if (intervals[i][0] <= last[1]) last[1] = Math.max(last[1], intervals[i][1]);
      else result.push(intervals[i].slice());
    }
    return result;
  },

  "Generate IP Addresses": (s) => {
    const result = [];
    for (let a = 1; a <= 3; a++) {
      for (let b = 1; b <= 3; b++) {
        for (let c = 1; c <= 3; c++) {
          const d = s.length - a - b - c;
          if (d < 1 || d > 3) continue;
          const parts = [s.slice(0,a), s.slice(a,a+b), s.slice(a+b,a+b+c), s.slice(a+b+c)];
          if (parts.some(p => p.length > 1 && p[0] === "0")) continue;
          if (parts.some(p => parseInt(p) > 255)) continue;
          result.push(parts.join("."));
        }
      }
    }
    return result;
  },

  "Shortest Path in a Grid": (grid) => {
    const m = grid.length, n = grid[0].length;
    if (grid[0][0] === 1 || grid[m-1][n-1] === 1) return "";
    const dirs = [[-1,0,"U"],[1,0,"D"],[0,-1,"L"],[0,1,"R"]];
    const visited = Array.from({ length: m }, () => new Array(n).fill(false));
    const queue = [[0, 0, ""]];
    visited[0][0] = true;
    while (queue.length > 0) {
      const [r, c, path] = queue.shift();
      if (r === m-1 && c === n-1) return path;
      for (const [dr, dc, dir] of dirs) {
        const nr = r+dr, nc = c+dc;
        if (nr >= 0 && nr < m && nc >= 0 && nc < n && !visited[nr][nc] && grid[nr][nc] === 0) {
          visited[nr][nc] = true;
          queue.push([nr, nc, path + dir]);
        }
      }
    }
    return "";
  },

  "Sanitize Parentheses in Expression": (s) => {
    const isValid = (str) => {
      let cnt = 0;
      for (const c of str) {
        if (c === "(") cnt++;
        else if (c === ")") { if (--cnt < 0) return false; }
      }
      return cnt === 0;
    };
    const result = [], visited = new Set([s]);
    let queue = [s], found = false;
    while (queue.length > 0) {
      const next = [];
      for (const cur of queue) {
        if (isValid(cur)) { result.push(cur); found = true; }
        if (found) continue;
        for (let i = 0; i < cur.length; i++) {
          if (cur[i] !== "(" && cur[i] !== ")") continue;
          const candidate = cur.slice(0, i) + cur.slice(i + 1);
          if (!visited.has(candidate)) { visited.add(candidate); next.push(candidate); }
        }
      }
      if (found) break;
      queue = next;
    }
    return result.length > 0 ? result : [""];
  },

  "Find All Valid Math Expressions": ([digits, target]) => {
    const result = [];
    const dfs = (idx, path, value, last) => {
      if (idx === digits.length) {
        if (value === target) result.push(path);
        return;
      }
      for (let len = 1; len <= digits.length - idx; len++) {
        const str = digits.slice(idx, idx + len);
        if (str.length > 1 && str[0] === "0") break;
        const num = parseInt(str);
        if (idx === 0) {
          dfs(idx + len, str, num, num);
        } else {
          dfs(idx + len, path + "+" + str, value + num,           num);
          dfs(idx + len, path + "-" + str, value - num,          -num);
          dfs(idx + len, path + "*" + str, value - last + last * num, last * num);
        }
      }
    };
    dfs(0, "", 0, 0);
    return result;
  },

  "HammingCodes: Integer to Encoded Binary": (n) => {
    const bin = n.toString(2);
    let r = 0;
    while ((1 << r) < bin.length + r + 1) r++;
    const total = bin.length + r;
    const encoded = new Array(total + 1).fill(0); // 1-indexed positions
    let dataIdx = 0;
    for (let i = 1; i <= total; i++) {
      if ((i & (i - 1)) !== 0) encoded[i] = parseInt(bin[dataIdx++]);
    }
    for (let p = 0; p < r; p++) {
      const pos = 1 << p;
      let parity = 0;
      for (let i = pos; i <= total; i++) { if (i & pos) parity ^= encoded[i]; }
      encoded[pos] = parity;
    }
    let overall = 0;
    for (let i = 1; i <= total; i++) overall ^= encoded[i];
    return `${overall}${encoded.slice(1).join("")}`;
  },

  "HammingCodes: Encoded Binary to Integer": (s) => {
    const bits = s.split("").map(Number);
    const n = bits.length;
    const overall = bits.reduce((a, b) => a ^ b, 0);
    let errorPos = 0;
    for (let p = 1; p < n; p <<= 1) {
      let parity = 0;
      for (let i = p; i < n; i++) { if (i & p) parity ^= bits[i]; }
      if (parity !== 0) errorPos += p;
    }
    if (errorPos !== 0 && overall !== 0) bits[errorPos] ^= 1;
    let binary = "";
    for (let i = 1; i < n; i++) { if ((i & (i - 1)) !== 0) binary += bits[i]; }
    return parseInt(binary, 2);
  },

  "Compression I: RLE Compression": (s) => {
    let result = "", i = 0;
    while (i < s.length) {
      let count = 1;
      while (count < 9 && i + count < s.length && s[i + count] === s[i]) count++;
      result += count + s[i];
      i += count;
    }
    return result;
  },

  "Compression II: LZ Decompression": (s) => {
    let out = "", i = 0;
    while (i < s.length) {
      const l1 = Number(s[i++]);
      out += s.slice(i, i + l1);
      i += l1;
      if (i >= s.length) break;
      const l2 = Number(s[i++]);
      const offset = Number(s[i++]);
      if (l2 > 0) { for (let j = 0; j < l2; j++) out += out[out.length - offset]; }
    }
    return out;
  },

  "Compression III: LZ Compression": (plain) => {
    const n = plain.length;
    // best[i][t]: shortest encoded string reaching position i with next chunk type t
    // t=0: need to emit Type1, t=1: need to emit Type2
    const best = Array.from({ length: n + 1 }, () => [null, null]);
    best[0][0] = "";
    for (let i = 0; i <= n; i++) {
      for (let t = 0; t <= 1; t++) {
        if (best[i][t] === null) continue;
        const cur = best[i][t];
        if (t === 0) {
          // Type1: emit digit L + L literal chars, transition to t=1
          for (let len = 0; len <= Math.min(9, n - i); len++) {
            const next = cur + len + plain.slice(i, i + len);
            const j = i + len;
            if (best[j][1] === null || next.length < best[j][1].length) best[j][1] = next;
          }
        } else {
          // Type2 L=0: emit "00", stay at i, transition to t=0
          const zero = cur + "00";
          if (best[i][0] === null || zero.length < best[i][0].length) best[i][0] = zero;
          // Type2 L>0: emit L + offset, advance by L, transition to t=0
          for (let len = 1; len <= Math.min(9, n - i); len++) {
            for (let offset = 1; offset <= Math.min(9, i); offset++) {
              let ok = true;
              for (let k = 0; k < len; k++) {
                if (plain[i + k] !== plain[i - offset + k]) { ok = false; break; }
              }
              if (!ok) continue;
              const next = cur + len + offset;
              const j = i + len;
              if (best[j][0] === null || next.length < best[j][0].length) best[j][0] = next;
            }
          }
        }
      }
    }
    const a = best[n][0], b = best[n][1];
    if (a === null) return b ?? "";
    if (b === null) return a;
    return a.length <= b.length ? a : b;
  },

  "Encryption I: Caesar Cipher": ([text, shift]) =>
    text.split("").map(c =>
      c === " " ? " " : String.fromCharCode(((c.charCodeAt(0) - 65 + shift) % 26) + 65)
    ).join(""),

  "Encryption II: Vigenère Cipher": ([text, key]) => {
    let result = "", ki = 0;
    for (const c of text) {
      if (c === " ") { result += " "; continue; }
      const shift = key[ki % key.length].charCodeAt(0) - 65;
      result += String.fromCharCode(((c.charCodeAt(0) - 65 + shift) % 26) + 65);
      ki++;
    }
    return result;
  },

  "Proper 2-Coloring of a Graph": ([n, edges]) => {
    const adj = Array.from({ length: n }, () => []);
    for (const [u, v] of edges) { adj[u].push(v); adj[v].push(u); }
    const color = new Array(n).fill(-1);
    for (let start = 0; start < n; start++) {
      if (color[start] !== -1) continue;
      color[start] = 0;
      const queue = [start];
      while (queue.length > 0) {
        const node = queue.shift();
        for (const nb of adj[node]) {
          if (color[nb] === -1) { color[nb] = 1 - color[node]; queue.push(nb); }
          else if (color[nb] === color[node]) return [];
        }
      }
    }
    return color;
  },

};
