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

};
