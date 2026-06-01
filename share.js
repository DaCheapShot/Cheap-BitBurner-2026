const SHARE_MS = 10_000; // ns.share() runs for exactly 10s

/** @param {NS} ns */
export async function main(ns) {
  const duration = Number(ns.args[0] ?? 60_000);
  const deadline = Date.now() + duration;
  while (Date.now() + SHARE_MS <= deadline) {
    await ns.share();
  }
}
