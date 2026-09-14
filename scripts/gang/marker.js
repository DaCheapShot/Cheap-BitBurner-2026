import { GANG_MARKER } from "./config.js";

/**
 * Reader for the status marker tick.js writes. Zero RAM - ns.read is 0 GB.
 *
 * Same split, and the same reasons, as calib.js against calibrate.js: the
 * writer pays for the expensive API and the readers pay nothing. It saves
 * ascend.js and equip.js a 2.00 GB ns.gang.getGangInformation each for three
 * numbers that are at most one tick old.
 *
 * Missing, corrupt and schema-invalid all collapse to null - never a partial
 * object, never a throw. A caller that gets null has not yet seen a tick and
 * must do nothing, rather than let an undefined propagate into a respect guard
 * as NaN and compare false against every bound.
 */
export function readMarker(ns) {
  const lines = ns.read(GANG_MARKER).split("\n");
  if (lines.length < 6) return null;
  const state = {
    phase: lines[0].trim(),
    respect: Number(lines[1]),
    nextRecruitAt: Number(lines[2]),
    memberCount: Number(lines[3]),
    territory: Number(lines[4]),
    written: Number(lines[5]),
    // Line 7, and deliberately NOT length-checked: a marker written before this
    // field existed is six lines long and was a combat gang, which is exactly
    // what undefined reads as here. Bumping the length guard instead would make
    // every reader skip a whole sweep on the first tick after an update.
    isHacking: lines[6]?.trim() === "1",
  };
  if (!state.phase) return null;
  for (const k of ["respect", "memberCount", "territory"]) {
    if (!Number.isFinite(state[k])) return null;
  }
  // nextRecruitAt is INFINITY at a full roster, not a number.
  // Gang.respectForNextRecruit() returns Infinity verbatim once members.length
  // reaches MaximumGangMembers, tick.js writes it through, and Number("Infinity")
  // reads it back as Infinity - so a finiteness check on this one field rejected
  // the whole marker from the instant the 12th member joined and never stopped.
  // ascend.js and equip.js then reported "no gang marker yet" forever, which is
  // the one message that reads like the loop has not started.
  //
  // NaN is still fatal: an unreachable threshold is a legal value, an unparseable
  // one is not, and NaN compares false against every bound in shouldAscend.
  if (Number.isNaN(state.nextRecruitAt)) return null;
  return state;
}
