/** @param {NS} ns */
export async function main(ns) {
  // Raw GitHub base URL — update branch name here if needed
  const BASE = "https://raw.githubusercontent.com/DaCheapShot/Cheap-BitBurner-2026/main";

  const FILES = [
    "hack.js",
    "grow.js",
    "weaken.js",
    "deploy.js",
    "root.js",
    "manager.js",
  ];

  ns.tprint("Syncing files from GitHub...");

  let ok = 0;
  let fail = 0;

  for (const file of FILES) {
    const url = `${BASE}/${file}`;
    const success = await ns.wget(url, file, "home");
    if (success) {
      ns.tprint(`  ✓ ${file}`);
      ok++;
    } else {
      ns.tprint(`  ✗ ${file}  — FAILED (check CORS or URL)`);
      fail++;
    }
  }

  ns.tprint(`Done: ${ok} downloaded, ${fail} failed.`);
  if (fail === 0) ns.tprint("Run: run root.js  then  run manager.js");
}
