/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.tail();

  while (true) {
    ns.clearLog();
    ns.print("Dashboard initializing...");
    await ns.sleep(5_000);
  }
}
