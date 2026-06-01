/** @param {NS} ns */
export async function main(ns) {
  const duration = Number(ns.args[0] ?? 60_000);
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    await ns.share();
  }
}
