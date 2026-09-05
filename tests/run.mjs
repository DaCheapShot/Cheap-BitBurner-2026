import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = import.meta.dirname;
const only = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !only || f.includes(only));

let pass = 0, fail = 0;
for (const f of files) {
  const mod = await import(pathToFileURL(path.join(dir, f)).href);
  for (const [name, fn] of Object.entries(mod.tests ?? {})) {
    try {
      await fn();
      console.log(`  PASS  ${f.replace(".test.mjs", "")} :: ${name}`);
      pass++;
    } catch (e) {
      console.log(`  FAIL  ${f.replace(".test.mjs", "")} :: ${name}`);
      console.log(`        ${e.message}`);
      fail++;
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
