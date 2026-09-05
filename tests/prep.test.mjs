import { loadScripts, assert } from "./harness.mjs";

export const tests = {
  // Regression: prepper once re-exported its tolerances without importing them,
  // so measure() threw ReferenceError. Static parsing cannot catch that - only
  // calling the function does.
  "prepper.measure resolves its tolerance constants": async () => {
    const { prepper } = await loadScripts();
    const ns = {
      getServerMaxMoney: () => 100, getServerMoneyAvailable: () => 100,
      getServerMinSecurityLevel: () => 1, getServerSecurityLevel: () => 1,
    };
    const m = prepper.measure(ns, "x");
    assert(m.moneyOk === true, "moneyOk should be true at max money");
    assert(m.secOk === true, "secOk should be true at min security");
  },
};
