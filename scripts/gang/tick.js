import { MAX_MEMBERS, MEMBER_PREFIX, GANG_MARKER } from "./config.js";
import { phaseFor, planTasks, wantedHeadroom } from "./math.js";
import { report } from "./report.js";

/**
 * The hot path: recruit, pick every member's task, hold the wanted level down.
 *
 * A transient. It reads the gang, decides, acts and exits - gang.js runs it
 * every TICK_EVERY gang updates and waits for it. Nothing is carried between
 * runs except GANG_MARKER, which exists so ascend.js and equip.js can skip a
 * 2.00 GB getGangInformation.
 *
 * Run on home only, never scp'd, so its imports resolve where they live. The
 * "a worker's imports must be deployed with it" trap in CLAUDE.md applies to
 * things exec'd onto other hosts; nothing here leaves home.
 *
 * RAM: 1.60 base + getGangInformation 2.00 + getMemberNames 1.00
 *      + getMemberInformation 2.00 + getTaskStats 1.00 + setMemberTask 2.00
 *      + recruitMember 2.00 = 11.60 GB
 * (getTaskNames is 0 GB; config.js and math.js hold no ns call.)
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const info = ns.gang.getGangInformation();
  if (info.isHacking) {
    report(ns, "tick", "REFUSED - this is a hacking gang, tick.js assigns combat tasks only");
    ns.tprint(
      "ERROR: gang/tick.js is written for a COMBAT gang and this one is a hacking gang. " +
        "It would filter every task out (task.isCombat) and assign nobody. Refusing rather " +
        "than mis-assigning the whole roster.",
    );
    return;
  }

  // Recruiting: just call recruitMember and read its boolean. That is strictly
  // cheaper than canRecruitMember (1.00 GB) plus recruitMember, and
  // respectForNextRecruit is already a field on the info above.
  const names = ns.gang.getMemberNames();
  const used = new Set(names);
  let next = 0;
  let recruited = 0;
  while (names.length < MAX_MEMBERS) {
    while (used.has(MEMBER_PREFIX + next)) next++;
    const candidate = MEMBER_PREFIX + next;
    if (!ns.gang.recruitMember(candidate)) break;
    used.add(candidate);
    names.push(candidate);
    recruited++;
  }

  const members = names.map((n) => ns.gang.getMemberInformation(n));

  // Task stats come from the game, not from a table copied into config.js.
  // getTaskNames is free and getTaskStats is billed once however many times it
  // is called, and a hardcoded table is exactly the kind of thing that drifts
  // between fork versions without a symptom.
  const tasks = ns.gang.getTaskNames().map((n) => ns.gang.getTaskStats(n));

  const phase = phaseFor({ members, territory: info.territory });
  const result = planTasks(info, members, tasks, phase);

  let moved = 0;
  for (const m of members) {
    const want = result.plan.get(m.name);
    if (want && want !== m.task) {
      ns.gang.setMemberTask(m.name, want);
      moved++;
    }
  }

  // info["respectForNextRecruit"], NOT info.respectForNextRecruit. That name is
  // a GangGenInfo field AND a 1.00 GB ns.gang function, and the game bills bare
  // identifiers wherever they appear - so the dotted spelling would charge this
  // script a full gang API call for a number it already has in hand. A computed
  // key is a Literal node and costs nothing. Same trick as STAT_KEYS.
  ns.write(
    GANG_MARKER,
    [
      phase,
      info.respect,
      info["respectForNextRecruit"],
      members.length,
      info.territory,
      Date.now(),
    ].join("\n"),
    "w",
  );

  report(
    ns,
    "tick",
    `${phase}, ${members.length} members` +
      `${recruited ? ` (+${recruited})` : ""}, ${moved} reassigned | ` +
      `${result.trainees} training, ${result.vigilantes} penance, ` +
      `${result.warSlots} territory | respect ${info.respect.toFixed(0)} ` +
      `(next recruit at ${info["respectForNextRecruit"].toFixed(0)}) | ` +
      `wanted ${info.wantedLevel.toFixed(2)}, ` +
      `${(wantedHeadroom(info) * 100).toFixed(1)}% of achievable`,
  );
}
