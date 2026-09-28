/**
 * The last N lines of a text file, printed to the terminal - the fork's
 * terminal has no tail for files (`tail` is the script log window), and grep's
 * -m counts from the top.
 *
 *   run scripts/last.js /data/sleeves.log.txt        last 10
 *   run scripts/last.js /data/sleeves.log.txt 30     last 30
 *
 * RAM: ns.read and ns.tprint are 0 GB, so this is the 1.60 base.
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const [file, n = 10] = ns.args;
  const text = ns.read(String(file ?? ""));
  if (!text) {
    ns.tprint(`ERROR: ${file === undefined ? "usage: run scripts/last.js <file> [lines]" : `${file} is empty or missing`}`);
    return;
  }
  ns.tprint("\n" + text.trimEnd().split("\n").slice(-Number(n)).join("\n"));
}
