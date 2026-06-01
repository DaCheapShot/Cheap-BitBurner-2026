/** @param {NS} ns */
export async function main(ns) {
  // Never spend more than this fraction of cash in a single action.
  const BUDGET_PCT = 0.10;
  const SLEEP_MS   = 10_000;
  const PREFIX     = "cheap";

  // All valid RAM tiers: 2, 4, 8 ... 2^20 (1 TB max per Bitburner docs)
  const RAM_TIERS = Array.from({ length: 20 }, (_, i) => 2 ** (i + 1));

  ns.disableLog("ALL");
  ns.print("buy.js started — budget cap: 10% of cash per purchase");

  while (true) {
    const money  = ns.getPlayer().money;
    const budget = money * BUDGET_PCT;
    const owned  = ns.cloud.getServerNames();
    const limit  = ns.cloud.getServerLimit();
    let didSomething = false;

    if (owned.length < limit) {
      // Open slot — buy the highest-RAM server we can afford within budget.
      const ram = bestAffordableTier(ns, RAM_TIERS, budget);
      if (ram > 0) {
        const cost     = ns.cloud.getServerCost(ram);
        const hostname = ns.cloud.purchaseServer(PREFIX, ram);
        if (hostname !== "") {
          ns.print(`BOUGHT ${hostname} (${ns.format.ram(ram)}) for ${ns.format.number(cost)}`);
          didSomething = true;
        }
      } else {
        ns.print(`Waiting — cheapest server > budget (${ns.format.number(budget)})`);
      }
    } else {
      // All slots filled — upgrade the weakest server if affordable.
      const target = weakestServer(ns, owned);
      if (target !== null) {
        const curRam  = ns.getServerMaxRam(target);
        const nextRam = curRam * 2;

        if (nextRam > 1048576) {
          // Every server is at max RAM; nothing left to do.
          ns.print("All servers at max RAM (2^20 GB). buy.js done.");
          break;
        }

        const cost = ns.cloud.getServerUpgradeCost(target, nextRam);
        if (cost > 0 && cost <= budget) {
          const ok = ns.cloud.upgradeServer(target, nextRam);
          if (ok) {
            ns.print(`UPGRADED ${target}: ${ns.format.ram(curRam)} → ${ns.format.ram(nextRam)} for ${ns.format.number(cost)}`);
            didSomething = true;
          }
        } else {
          ns.print(`Waiting — upgrade ${target} → ${ns.format.ram(nextRam)} costs ${ns.format.number(cost)} (budget: ${ns.format.number(budget)})`);
        }
      }
    }

    if (!didSomething) await ns.sleep(SLEEP_MS);
  }
}

/**
 * Returns the highest RAM tier whose purchase cost fits within budget.
 * Returns 0 if even the cheapest tier is unaffordable.
 */
function bestAffordableTier(ns, tiers, budget) {
  let best = 0;
  for (const ram of tiers) {
    // Costs increase monotonically — stop as soon as we overshoot.
    if (ns.cloud.getServerCost(ram) <= budget) best = ram;
    else break;
  }
  return best;
}

/**
 * Returns the hostname of the owned server with the least RAM,
 * or null if the list is empty.
 */
function weakestServer(ns, owned) {
  let weakest    = null;
  let weakestRam = Infinity;
  for (const host of owned) {
    const ram = ns.getServerMaxRam(host);
    if (ram < weakestRam) { weakestRam = ram; weakest = host; }
  }
  return weakest;
}
