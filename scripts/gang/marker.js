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
  };
  if (!state.phase) return null;
  for (const k of ["respect", "nextRecruitAt", "memberCount", "territory"]) {
    if (!Number.isFinite(state[k])) return null;
  }
  return state;
}
