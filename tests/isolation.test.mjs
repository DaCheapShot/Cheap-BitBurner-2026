import { readScript, assert } from "./harness.mjs";

/** Everything a script can reach through ./x.js imports, transitively. */
function importClosure(bare, seen = new Set()) {
  if (seen.has(bare)) return seen;
  seen.add(bare);
  const src = readScript(bare);
  for (const m of src.matchAll(/from\s+"\.\/([\w-]+)\.js"/g)) importClosure(m[1], seen);
  return seen;
}

export const tests = {
  "manager.js cannot reach mathFormulas": () => {
    const closure = importClosure("manager");
    assert(!closure.has("mathFormulas"),
      `manager.js reaches mathFormulas - it would be charged 2.50 GB for math it never uses. Closure: ${[...closure]}`);
    assert(closure.has("mathAnalyze"), "manager.js should reach mathAnalyze");
  },

  "manager-formulas.js cannot reach mathAnalyze": () => {
    const closure = importClosure("manager-formulas");
    assert(!closure.has("mathAnalyze"),
      `manager-formulas.js reaches mathAnalyze - it would be charged 2.00 GB for hackAnalyze and growthAnalyze it never uses. Closure: ${[...closure]}`);
    assert(!closure.has("rpc"),
      "manager-formulas.js has no *Analyze function to move off, so it must not pay rpc.js's 1.00 GB");
  },

  "managerCore and prepper are math-free": () => {
    for (const bare of ["managerCore", "prepper"]) {
      const closure = importClosure(bare);
      assert(!closure.has("mathAnalyze") && !closure.has("mathFormulas"),
        `${bare}.js must not import a math implementation - the entry scripts inject one`);
    }
  },
};
