/**
 * IPvGO tunables and the game's opponent table. Pure, 0 GB: no ns anywhere -
 * boot.js and settings.js import it.
 *
 * Transcribed from the fork's src/Go/: Constants.ts (opponentDetails),
 * effects/effect.ts (which multiplier each opponent pays) and the GoOpponent
 * enum. The enum is why the secret opponent's name is twelve question marks:
 * that is the string resetBoardState takes, not "w0r1d_d43m0n".
 */

/** The resident player, started by boot on every node - ns.go has no node gate. */
export const GO_SERVICE = "/scripts/go/go.js";

/** Rewritten after every game: the current arm and a row per opponent. `cat /data/go.txt` */
export const STATUS_FILE = "/data/go.txt";

/** One line per game, last GAME_LOG_KEEP kept. */
export const GAME_LOG_FILE = "/data/go.log.txt";
export const GAME_LOG_KEEP = 500;

/**
 * What the engine has measured per arm. It describes the ENGINE, not the cycle,
 * so an install keeps it. The number in the name moves when the engine does: a
 * --forget beside the resident player is undone by its next write, because it
 * holds the table in memory.
 */
export const ARMS_FILE = "/data/go-arms-2.txt";

export const WORLD = "????????????";

/** `stat` keys the weight tables below. Strings, so no field name is ever billed. */
export const OPPONENTS = {
  "Netburners": { komi: 1.5, power: 1.3, stat: "hacknet" },
  "Slum Snakes": { komi: 3.5, power: 1.2, stat: "crime" },
  "The Black Hand": { komi: 3.5, power: 0.9, stat: "money" },
  "Tetrads": { komi: 5.5, power: 0.7, stat: "combat" },
  "Daedalus": { komi: 5.5, power: 1.1, stat: "rep" },
  "Illuminati": { komi: 7.5, power: 0.7, stat: "speed" },
  [WORLD]: { komi: 9.5, power: 2, stat: "level" },
};

/** resetBoardState's sizes (19 is the secret opponent's fixed board, and its only one). */
export const SIZES = [5, 7, 9, 13];
export const WORLD_SIZE = 19;

/**
 * How much a log-point of each bonus is worth. Bonuses multiply, so comparing
 * them in log terms is what makes a 2% on one stat equal a 2% on another.
 *
 * NORMAL is every other node: hacking income, its speed and rep are the game
 * this repo plays; the rest barely move it.
 */
export const NORMAL_WEIGHTS = { money: 1, speed: 1, rep: 1, level: 1, hacknet: 0.1, crime: 0.1, combat: 0.1 };

/**
 * Per-node overrides. BN14 plays to END the node: rep work there is x0.2 and the
 * Red Pill needs 2.5m Daedalus rep, so rep leads; once the pill is in, the secret
 * opponent's hacking level is what x5 daemon difficulty and x0.4 hacking level
 * block. BN8: hacking pays $0. BN9: the hacknet is an income.
 */
export const NODE_WEIGHTS = {
  8: { money: 0 },
  9: { hacknet: 1 },
  14: { rep: 3, level: 3, speed: 1.5 },
};

/**
 * How fast an arm's averages follow new games. Plain mean until 1/n reaches this,
 * then an EWMA, so a stronger engine or a higher-stat save is learned in ~5 games.
 */
export const EWMA_RATE = 0.2;

/**
 * What an untried arm is assumed to do: on the high side, so it gets its game.
 * Fractions of the board's points, a win rate, and seconds per point.
 */
export const PRIOR_SCORE_SHARE = 0.6;
export const PRIOR_WIN = 0.7;
export const PRIOR_SECONDS_PER_POINT = 2;

/**
 * Boards the search plays. A playout grows with the square of the side and a move
 * gets the same budget, so past this the heuristic is the better use of the time.
 */
export const SEARCH_MAX_SIZE = 7;

/**
 * Search per move and the most it may hold the game's one thread at a stretch.
 * The batcher dispatches on a 25 ms tick, so a slice has to stay well under it.
 */
export const SEARCH_MS = 500;
export const SLICE_MS = 5;

/** UCB exploration. Rewards run 0 to 1, so this is low for a value near 0.5. */
export const SEARCH_UCB = 0.5;

/** No answer from the AI for this long is a stuck game, not a slow one. */
export const STUCK_MS = 30_000;
