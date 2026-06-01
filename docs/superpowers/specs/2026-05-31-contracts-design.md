# Contracts Finder & Solver Design
**Date:** 2026-05-31
**Version:** Bitburner 3.0.1
**Status:** Approved

---

## Overview

A contract scanner and auto-solver system. Each manager cycle, a one-shot helper scans all servers for `.cct` files, copies them to an organized folder structure on home, and attempts to solve each one using a library of known algorithms. Results are reported via `ns.tprint()`.

---

## File Structure

```
contracts.js        — one-shot helper: scan, file, dispatch, report
solvers.js          — pure JS library: exports SOLVERS map (type → solver fn)
contracts/
  pending/          — contracts found but not yet solved
  solved/           — contracts successfully solved (permanent record)
```

---

## Architecture

### `solvers.js`

Pure JavaScript — no `ns` calls, no RAM cost. Exports a single object:

```js
export const SOLVERS = {
  "Find Largest Prime Factor": (data) => { ... },
  // ... all 27 known types
};
```

`contracts.js` imports it: `import { SOLVERS } from "solvers.js";`
Since `solvers.js` has zero NS calls, importing it adds 0 GB to `contracts.js`'s RAM footprint.

### `contracts.js`

One-shot helper (exits after each run, like `root.js`). Uses:
- `ns.scan()` — BFS network discovery
- `ns.ls()` — list files on a server (0 GB)
- `ns.scp()` — copy `.cct` from remote server to home
- `ns.mv()` — rename/move files on home (pending → solved)
- `ns.fileExists()` — check if home copy already exists
- `ns.codingcontract.getContractType()`
- `ns.codingcontract.getData()`
- `ns.codingcontract.getNumTriesRemaining()`
- `ns.codingcontract.attempt()`
- `ns.tprint()` — always-visible terminal output for results

### Manager integration

`manager.js` launches `contracts.js` at the top of each cycle:

```js
ns.exec("contracts.js", "home", 1);
```

No interval guard needed — if a previous instance is still running when the next cycle begins, `exec` returns 0 and the launch is skipped naturally.

---

## Contract File Management

File naming uses `host.filename` to avoid collisions when multiple servers hold contracts with the same filename.

**Paths:**
- Pending: `contracts/pending/n00dles.contract-001.cct`
- Solved:  `contracts/solved/n00dles.contract-001.cct`

**Per-contract logic on each run:**

1. Check if `contracts/solved/host.filename` exists → skip (already done)
2. Check if `contracts/pending/host.filename` exists → skip copy (already filed)
3. If new: `ns.scp(filename, "home", host)` → `ns.mv(filename, "contracts/pending/host.filename")`
4. On successful solve: `ns.mv("contracts/pending/...", "contracts/solved/...")`
5. On expiry (original gone from server): pending copy is left as an orphan, silently skipped

> **Dependency:** `ns.mv()` must support `.cct` files. Verify in-game on first run.

---

## Solve Workflow

For each file in `contracts/pending/` on home:

1. Strip the `contracts/pending/` prefix, then split on the first `.` to recover `host` and `filename`
2. If original no longer exists on `host`: skip silently (contract expired)
3. If `numTriesRemaining < 5`: `tprint` warning and skip — preserves margin for manual solving
4. Look up type in `SOLVERS`
5. **Unknown type:** `tprint("CONTRACTS: Unknown type '${type}' at ${host}/${filename} — ${triesLeft} tries remaining")`
6. **Known type:** compute answer, call `ns.codingcontract.attempt(answer, filename, host)`
   - **Success** (non-empty reward string): `ns.mv` pending → solved, `tprint("CONTRACTS: Solved '${type}' on ${host} — ${reward}")`
   - **Failure** (empty string): `tprint("CONTRACTS: Failed '${type}' on ${host}/${filename} — ${triesLeft} tries remaining")`

One attempt per contract per run. Solvers are deterministic — retrying the same solver in the same run would produce the same wrong answer.

---

## Solver Coverage

All 27 known contract types:

| Type | Algorithm |
|------|-----------|
| Find Largest Prime Factor | Trial division |
| Subarray with Maximum Sum | Kadane's algorithm |
| Total Ways to Sum I | Integer partition DP |
| Total Ways to Sum II | Coin change DP |
| Spiralize Matrix | Simulation (boundary walk) |
| Array Jumping Game I | Greedy reachability |
| Array Jumping Game II | BFS min jumps |
| Merge Overlapping Intervals | Sort + merge |
| Generate IP Addresses | Backtracking |
| Algorithmic Stock Trader I | Single transaction max profit |
| Algorithmic Stock Trader II | Unlimited transactions |
| Algorithmic Stock Trader III | Two transactions (DP) |
| Algorithmic Stock Trader IV | K transactions (DP) |
| Minimum Path Sum in a Triangle | Bottom-up DP |
| Unique Paths in a Grid I | Combinatorics |
| Unique Paths in a Grid II | DP with obstacles |
| Shortest Path in a Grid | BFS |
| Sanitize Parentheses in Expression | BFS level-order |
| Find All Valid Math Expressions | Backtracking |
| HammingCodes: Integer to Encoded Binary | Bit manipulation |
| HammingCodes: Encoded Binary to Integer | Error-correcting decode |
| Compression I: RLE Compression | Run-length encode |
| Compression II: LZ Decompression | Lempel-Ziv decompress |
| Compression III: LZ Compression | Lempel-Ziv compress |
| Encryption I: Caesar Cipher | Modular char shift |
| Encryption II: Vigenère Cipher | Polyalphabetic cipher |
| Proper 2-Coloring of a Graph | BFS graph coloring |

Any contract type not in this table hits the "unknown type" tprint path and is left in `contracts/pending/` for manual inspection.

---

## RAM Notes

`contracts.js` is a one-shot helper — its RAM is freed on exit. The `ns.codingcontract.*` functions are relatively expensive (5–10 GB each in some versions); use `ns.getScriptRam("contracts.js")` at runtime to see total cost. This does not add to `manager.js`'s permanent reservation.

`solvers.js` is a pure-JS import with no NS calls — adds 0 GB to `contracts.js`.
