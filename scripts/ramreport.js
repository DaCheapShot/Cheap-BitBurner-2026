/**
 * Write the GAME's RAM figure for every .js on a host to a text file.
 *
 * tests/ram.test.mjs models the calculator, and a model is only as good as its
 * last disagreement with the real thing - the config re-export passed every test
 * and still would not start. This is the other side of that comparison, in one
 * file that can be pasted back rather than read off the editor one script at a
 * time.
 *
 * 0 GB means the RAM check FAILED, not that the script is free: getScriptRam
 * returns 0 both for a missing file and for a script the calculator rejects (an
 * import that does not resolve, a syntax error). ls only lists files that exist,
 * so here it is always the second. `mem <file>` in the terminal names the cause.
 *
 * rpc.js's generated /tmp/rpc-*.js are counted, not listed: their names are
 * hashes and each one's cost is the body it was written for.
 *
 * Usage:  run scripts/ramreport.js            -> /data/ram-report.txt
 *         run scripts/ramreport.js <host>
 * Then:   download /data/ram-report.txt       (filesync only pushes disk -> game)
 *
 * RAM: 1.60 base + ls 0.20 + getScriptRam 0.10 = 1.90 GB
 */

const OUT = "/data/ram-report.txt";

/** @param {NS} ns */
export async function main(ns) {
  const host = String(ns.args[0] ?? "home");
  const files = ns.ls(host, ".js").filter((f) => f.endsWith(".js"));
  const generated = files.filter((f) => f.startsWith("tmp/rpc-") || f.startsWith("/tmp/rpc-"));
  const scripts = files.filter((f) => !generated.includes(f));

  const rows = scripts.map((f) => ({ f, gb: ns.getScriptRam(f, host) }));
  const failed = rows.filter((r) => r.gb === 0);
  const width = Math.max(...rows.map((r) => r.f.length), 10);

  const lines = [
    `RAM report - ${host} - ${new Date().toISOString()}`,
    `${rows.length} scripts, ${failed.length} failed the RAM check, ${generated.length} rpc transients not listed`,
    "",
    ...rows.map((r) =>
      `${r.f.padEnd(width)}  ${r.gb === 0 ? "FAILED - run: mem " + r.f : ns.format.ram(r.gb)}`),
  ];

  ns.write(OUT, lines.join("\n") + "\n", "w");
  ns.tprint(`ram report: ${rows.length} scripts, ${failed.length} failed -> ${OUT}  (download ${OUT})`);
}
