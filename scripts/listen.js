import { REPORT_PORT, BATCH_OPS } from "./config.js";

/**
 * Phase 2 test harness: drain the report port and print what arrives.
 *
 * Proves the worker -> manager round trip before any batching exists:
 *   - reports arrive at all
 *   - planned vs actual land time (drift) is small
 *   - landings arrive in H, W1, G, W2 order within a batch
 *   - the port isn't silently dropping messages under load
 *
 * RAM: 1.60 base. Every port function is 0 GB, and config.js is plain
 * constants, so this is as cheap as a script gets.
 *
 * Usage:  run scripts/listen.js               (runs until killed)
 *         run scripts/listen.js --clear       (empty the port first)
 *         run scripts/listen.js --port 3      (listen on a different port)
 */

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/** @param {NS} ns */
export async function main(ns) {
  const args = ns.args.map(String);
  const pIdx = args.indexOf("--port");
  const portNum = pIdx >= 0 ? Number(args[pIdx + 1]) : REPORT_PORT;

  const port = ns.getPortHandle(portNum);
  if (args.includes("--clear")) port.clear();

  // ns.tail() does not exist in this fork - it moved to ns.ui.openTail(). Both
  // this and disableLog are 0 GB.
  ns.ui.openTail();
  ns.disableLog("ALL");
  ns.print(`listening on port ${portNum} (${BATCH_OPS.join(",")} expected per batch)`);
  ns.print(pad("BATCH", 10) + pad("OP", 5) + padL("THR", 5) + padL("DRIFT", 10) + "  ORDER");

  // Per-batch: which ops we've seen, in arrival order. Lets us flag a landing
  // that arrives out of the required H,W1,G,W2 sequence.
  const arrivals = new Map();
  let count = 0;
  let wasFull = false;

  while (true) {
    // nextWrite resolves when something is written - no polling, no sleep.
    await port.nextWrite();

    // A full port means writePort has been popping older reports to make room:
    // messages were lost before we got here. Worth knowing now, not in Phase 5.
    if (port.full() && !wasFull) {
      ns.print("WARN: port FULL - older reports were dropped to make room");
      wasFull = true;
    } else if (!port.full()) {
      wasFull = false;
    }

    // Drain everything queued, not just the one write that woke us.
    while (!port.empty()) {
      const msg = port.read();
      count++;

      if (typeof msg !== "object" || msg === null) {
        ns.print(`?? non-object on port: ${String(msg)}`);
        continue;
      }

      const seq = arrivals.get(msg.b) ?? [];
      seq.push(msg.op);
      arrivals.set(msg.b, seq);

      // Expected op for this position in the batch.
      const expected = BATCH_OPS[seq.length - 1];
      const inOrder = msg.op === expected;
      const extra = seq.length > BATCH_OPS.length;

      // planned <= 0 means "no planned time given" - the manual-exec case, where
      // typing an absolute epoch timestamp by hand isn't practical. Only the
      // manager fills it in for real.
      const planned = Number(msg.p);
      const drift = Number(msg.a) - planned;
      const driftStr =
        planned > 0 && Number.isFinite(drift) ? `${drift >= 0 ? "+" : ""}${drift}ms` : "n/a";

      let note = "ok";
      if (extra) note = `EXTRA (${seq.length} ops for one batch)`;
      else if (!inOrder) note = `OUT OF ORDER - expected ${expected}`;
      else if (seq.length === BATCH_OPS.length) note = "batch complete";

      ns.print(
        pad(msg.b, 10) + pad(msg.op, 5) + padL(msg.t ?? "-", 5) + padL(driftStr, 10) + `  ${note}`,
      );
    }

    ns.print(`-- ${count} report(s), ${arrivals.size} batch(es) seen --`);
  }
}
