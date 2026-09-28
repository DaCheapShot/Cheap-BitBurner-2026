/**
 * The last N lines of a text file, in this script's own tail window - the
 * fork's terminal has no tail for files (`tail` is the script log window), and
 * grep's -m counts from the top.
 *
 *   run scripts/last.js /data/sleeves.log.txt        last 10
 *   run scripts/last.js /data/sleeves.log.txt 30     last 30
 *
 * The window outlives the script (it shows under Recently killed), so this
 * prints and exits rather than holding RAM to keep it open.
 *
 * RAM: ns.read, ns.print and ns.ui.openTail are 0 GB, so this is the 1.60 base.
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const [file, n = 10] = ns.args;
  ns.disableLog("ALL");
  ns.ui.openTail();
  const text = ns.read(String(file ?? ""));
  if (!text) {
    ns.print(`ERROR: ${file === undefined ? "usage: run scripts/last.js <file> [lines]" : `${file} is empty or missing`}`);
    return;
  }
  ns.print(text.trimEnd().split("\n").slice(-Number(n)).join("\n"));
}
