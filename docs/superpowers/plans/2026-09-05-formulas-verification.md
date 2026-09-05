# Formulas Integration Verification Results

**This file is unfilled.** In-game runs are the real sign-off gate. Fill this in after completing
Steps 2–5 below.

## In-game commands

Run these in sequence in the Bitburner terminal. Record the figures from the last two runs in
the table below.

```
run scripts/deploy.js
run scripts/calibrate.js
run scripts/manager.js --dry-run
```

Record the output from the analyze build, then:

```
run scripts/manager-formulas.js --dry-run
```

Record the output from the formulas build.

Next, fire one volley with each:

```
run scripts/manager.js --once
run scripts/manager-formulas.js --once
```

Both must report: all batches `ok`, `0 mistimed`, `0 incomplete`, jitter under `SPACER_MS`,
and the target back on baseline.

Finally, verify the live swap. With `run scripts/boot.js` running and Formulas.exe owned:

```
ps
```

Confirm the log shows `stopped /scripts/manager.js - switching to /scripts/manager-formulas.js`
and that `ps` lists exactly one manager.

## Results

| Figure | manager.js (analyze) | manager-formulas.js (formulas) |
|---|---|---|
| Chosen steal % | | |
| Hack threads | | |
| Weaken-1 threads | | |
| Grow threads | | |
| Weaken-2 threads | | |
| Batch RAM (GB) | | |
| Batch count | | |
| Yield per volley ($/ms) | | |

## What to expect

- **Thread counts** should agree within a few percent.
- **Grow threads** should be slightly **lower** on the formulas build, because `growThreads`
  models the additive term that `GROW_MARGIN` was padding for.
- **A divergence over 20%** means a bug — stop and investigate before firing anything.
- Both builds should complete one volley without mistiming, incomplete batches, or security drift.
- The boot supervisor should detect Formulas.exe and swap from analyze to formulas cleanly.
