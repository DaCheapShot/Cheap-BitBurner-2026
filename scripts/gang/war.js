import { warDecision } from "./math.js";

/**
 * Territory warfare: engage only when the WORST matchup is winnable.
 *
 * Territory multiplies every gain (it appears in territoryMult and again in the
 * gain exponent), so it is worth fighting for - but a lost clash kills a member,
 * and clashes are drawn against one rival at a time. Averaging win chances
 * would happily walk into a 20% fight on the strength of five 90% ones, so
 * warDecision takes the minimum across rivals that actually hold territory.
 *
 * The thresholds have hysteresis, which nothing else in this subsystem does:
 * a gang toggling warfare on a single threshold parks exactly on it, and the
 * cost of flapping here is members rather than a few seconds of income.
 *
 * This does not assign anyone to the Territory Warfare TASK - tick.js does that
 * from the phase. Engagement and staffing are separate decisions: power is
 * built by the task, and the clash chance is what decides whether to spend it.
 *
 * Territory and power update every GangConstants.CyclesPerTerritoryAndPowerUpdate
 * = 100 cycles (20 s), so gang.js runs this every WAR_EVERY = 10 updates.
 *
 * RAM: 1.60 base + getGangInformation 2.00 + getAllGangInformation 2.00
 *      + getChanceToWinClash 4.00 + setTerritoryWarfare 2.00 = 11.60 GB
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const info = ns.gang.getGangInformation();
  const others = ns.gang.getAllGangInformation();

  // Rivals holding no territory cannot be clashed with and would otherwise
  // report a chance that has nothing to do with the fights we would actually
  // get - including our own gang, which is in this map too.
  const chances = [];
  for (const [name, other] of Object.entries(others)) {
    if (name === info.faction) continue;
    if (!other || (other.territory ?? 0) <= 0) continue;
    chances.push(ns.gang.getChanceToWinClash(name));
  }

  const engage = warDecision(info.territoryWarfareEngaged, chances);
  if (engage !== info.territoryWarfareEngaged) {
    ns.gang.setTerritoryWarfare(engage);
    const worst = chances.length ? Math.min(...chances) : 0;
    ns.print(
      `territory warfare ${engage ? "ON" : "OFF"} - worst win chance ` +
        `${(worst * 100).toFixed(1)}% across ${chances.length} rivals, ` +
        `holding ${(info.territory * 100).toFixed(1)}%`,
    );
  }
}
