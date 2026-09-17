/**
 * Coding-contract tunables.
 *
 * Plain constants only - no ns call, no import, so this file is 0 GB to import
 * and boot.js can take the service path from it without moving off 3.50 GB.
 * Same rule as scripts/config.js and scripts/gang/config.js.
 */

// ------------------------------------------------------------------ paths ---

export const CONTRACTS_SERVICE = "/scripts/contracts/contracts.js";

// ------------------------------------------------------------------- gate ---

/**
 * How long after a reset before anything is solved, and why there is a gate at
 * all.
 *
 * The reward FACTION is chosen when the contract is attempted, not when it is
 * generated. ContractGenerator.getRandomReward stores a bare type
 * ({ type: 0|1|2|3 }); PlayerObjectGeneralMethods.gainCodingContractReward then
 * resolves it, and both faction types filter Player.factions by offerHackingWork
 * and RECURSE INTO Money when that list is empty. CompanyReputation needs a job
 * and otherwise coin-flips into the two faction types, which fall back the same
 * way.
 *
 * So three of the four reward types pay reputation, but only to a faction you
 * have already joined. Solving at minute one of a BitNode converts every one of
 * them into cash, which is the resource that is never the constraint. Contracts
 * do not expire and accumulate while we wait, so waiting costs nothing at all.
 */
export const CONTRACT_DELAY_MS = 10 * 60 * 1000;

/**
 * The clock is necessary but NOT sufficient, so the gate also requires one
 * joined faction. Ten minutes into a fresh BitNode the faction list is often
 * still empty - you are grinding hacking level for CyberSec - and the clock
 * alone would fire straight into the money fallback above.
 */
export const REQUIRE_FACTION = true;

// --------------------------------------------------------------- cadence ---
//
// There isn't one here, deliberately. contracts.js does ONE sweep and exits;
// boot.js runs it once per tick (60 s by default). Holding 4.10 GB resident
// between sweeps to re-read a clock is the trade this subsystem refuses - the
// gated run costs 4.10 GB for about 300 ms and nothing in between.

// ------------------------------------------------------------------ state ---
//
// A transient forgets everything when it exits, so the two things that must
// outlive a run are files. Both are read and written with ns.read / ns.write,
// which are 0 GB.

/**
 * Contracts whose answer was refused, one `host:file` per line.
 *
 * This HAS to persist now. The solvers are deterministic, so a wrong answer
 * repeated once a minute spends all ten tries in ten minutes and the contract
 * self-destructs - and "Array Jumping Game" allows exactly one try, so it is
 * gone on the second run. As a resident service an in-memory set was enough;
 * as a per-minute transient it is not.
 *
 * `--forget` clears it, which is what to run after fixing a solver: entries are
 * otherwise skipped for the life of the BitNode.
 */
export const REFUSED_FILE = "/data/contracts-refused.txt";

/**
 * The last gate message announced to the terminal.
 *
 * A transient's ns.print dies with its log window a moment after it exits, so
 * the only durable channel is the terminal - and a gate reason repeated once a
 * minute for ten minutes is spam. Storing the last one makes it speak on a
 * CHANGE only, the same idea as boot.js's cloudMaxedLogged.
 */
export const GATE_MARKER = "/data/contracts-gate.txt";
