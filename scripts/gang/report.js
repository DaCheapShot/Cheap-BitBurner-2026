import { GANG_PORT } from "./config.js";

/**
 * The transient -> supervisor channel. Zero RAM: port functions are free.
 *
 * Both halves live here so they cannot disagree about the format or the port.
 *
 * Ports hold PORT_CAPACITY (50) entries and discard the OLDEST on overflow, so
 * a supervisor that stopped draining would silently lose the earliest lines
 * rather than block. gang.js drains after every transient, so the queue never
 * holds more than one run's worth.
 *
 * read(), not peek(): this is a queue to be consumed, not a setting to be
 * observed. That is the opposite of the share gate on port 2, and the reason
 * the two must never share a port.
 */
export function report(ns, tag, line) {
  ns.getPortHandle(GANG_PORT).write(`${tag}: ${line}`);
}

/** Take everything queued. Only gang.js may call this. */
export function drainReports(ns) {
  const gate = ns.getPortHandle(GANG_PORT);
  const lines = [];
  while (!gate.empty()) lines.push(String(gate.read()));
  return lines;
}
