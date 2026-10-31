import { OPPONENTS, STATUS_FILE, GAME_LOG_FILE, GAME_LOG_KEEP, ARMS_FILE, STUCK_MS, WORLD, SLICE_MS } from "./config.js";
import { chooseArm, chooseMove, searchMoves, learn, armKey } from "./plan.js";
import { startSearch } from "./search.js";
import { rpc } from "scripts/rpc.js";
import { SETTINGS_FILE, setting } from "scripts/settings.js";

/**
 * The IPvGO player: resident, one game after another, on every node.
 *
 * WHY. A game pays node power on its result, win or lose, and each opponent's
 * power is a permanent-until-install multiplier on one stat (effects/effect.ts):
 * hacking money, hack speed, rep, hacking level. ns.go has no node gate, so this
 * runs everywhere. BitNode 14 multiplies the power by 4; the weights in config.js
 * make it play to finish that node and for the usual stats everywhere else.
 *
 * RESIDENT, not rpc bodies. The game is a turn loop that awaits the AI between
 * every call, so a body per move costs a process per move and lowers no peak.
 *
 * AN INSTALL ZEROES NODE POWER (Go.prestigeAugmentation), and kills this
 * mid-game, while the game itself survives. So startup RESUMES whatever is on the
 * board: resetBoardState on a game with moves in it resets that opponent's streak.
 * The first games after an install are the most valuable ones of the cycle, since
 * the effect curve is steepest at zero.
 *
 * Usage:  run scripts/go/go.js            (boot does this; --no-go opts out)
 *         cat /data/go.txt               each opponent's bonus, streak and record
 *         cat /data/go.log.txt            one line per game
 *
 * RAM: 1.60 base + run 1.00 + makeMove 4.00 + getBoardState 4.00 = 10.60 GB
 *
 * ponytail: getBoardState could be replaced by replaying moves through board.js
 * with a getGameState score check, for 4.00 GB, if 10.60 ever blocks a fresh node.
 */

/**
 * Fixed for the node: which node, SF14 and GoPower, for the effect curve.
 * getBitNodeMultipliers needs SF5, so GoPower may stay null. ownedSF is a Map, so
 * it never leaves the body.
 */
const ENV = `
const r = ns.getResetInfo();
let goPower = null;
try { goPower = ns.getBitNodeMultipliers().GoPower ?? null; } catch {}
return { node: r.currentNode, sf14: r.ownedSF.get(14) ?? 0, goPower };
`;

/** Without SF5 only the node is known, and BN14 is the only GoPower not 1 (BitNode.tsx). */
const goPowerFor = (node, read) => read ?? (node === 14 ? 4 : 1);

/** A file that will not parse is a lost history, not a reason to stop playing. */
function loadArms(text) {
  try {
    const arms = JSON.parse(text);
    return arms && typeof arms === "object" ? arms : {};
  } catch {
    return {};
  }
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const warned = new Set();
  const event = (l) => {
    const kept = ns.read(GAME_LOG_FILE).split("\n").filter(Boolean);
    ns.write(GAME_LOG_FILE, [...kept, `${new Date().toLocaleString()}  ${l}`].slice(-GAME_LOG_KEEP).join("\n") + "\n", "w");
  };
  const warnOnce = (l) => {
    if (warned.has(l)) return;
    warned.add(l);
    event(`WARN: ${l}`);
  };

  // A failed read is a busy home on a fresh node. Asked again before every game
  // until it lands: a wrong GoPower skews the arm picks, it does not stop play.
  let env = null;
  const readEnv = async () => {
    if (env) return env;
    try {
      const got = await rpc(ns, ENV);
      env = { ...got, goPower: goPowerFor(got.node, got.goPower) };
      return env;
    } catch (e) {
      warnOnce(`could not read the node: ${e}`);
      return { node: 0, sf14: 0, goPower: 1 };
    }
  };

  const arms = loadArms(ns.read(ARMS_FILE));
  // An arm the game refused - the secret opponent, before The Red Pill. For this
  // process: installing the pill restarts it, which is the retry.
  const gone = new Set();
  let current = "starting";

  const report = () => {
    const stats = ns.go.analysis.getStats();
    const rows = Object.entries(OPPONENTS).filter(([opp]) => stats[opp]).map(([opp, o]) => {
      const s = stats[opp];
      return `${(opp === WORLD ? "w0r1d_d43m0n" : opp).padEnd(15)} ${o.stat.padEnd(8)} ` +
        `+${ns.format.percent(s.bonusPercent / 100, 2).padEnd(9)} streak ${String(s.winStreak).padStart(3)}  ${s.wins}-${s.losses}`;
    });
    const lines = [`playing ${current}`, ...rows];
    ns.write(STATUS_FILE, lines.join("\n") + "\n", "w");
    ns.clearLog();
    for (const l of lines) ns.print(l);
  };

  /** A Go await, or null when the AI has said nothing for STUCK_MS. asleep races: sleep would trip the concurrency check. */
  const within = (turn) => Promise.race([turn, ns.asleep(STUCK_MS).then(() => null)]);

  /** Start the best game, or return null when no arm can be had. */
  const startArm = async () => {
    const e = await readEnv();
    for (;;) {
      const arm = chooseArm({ ...e, stats: ns.go.analysis.getStats(), arms, gone });
      if (!arm) return null;
      try {
        ns.go.resetBoardState(arm.opp, arm.size);
        return arm;
      } catch (err) {
        gone.add(armKey(arm.opp, arm.size));
        warnOnce(`${arm.opp} ${arm.size}x${arm.size} refused: ${err}`);
      }
    }
  };

  /**
   * The heuristic's move, or the search's where it applies. Slices with a yield
   * between them, or a search would hold the thread through the batcher's dispatch
   * ticks. asleep, because a game await may still be pending after a timeout.
   */
  const pickMove = async (rows, history, s) => {
    const quick = chooseMove(rows, history, s);
    const budget = setting(ns.read(SETTINGS_FILE), "go.searchMs");
    const moves = budget > 0 ? searchMoves(rows, history, s, quick) : null;
    if (!moves) return quick;
    const search = startSearch(rows, moves, s.komi);
    const end = Date.now() + budget;
    while (Date.now() < end) {
      search.step(SLICE_MS);
      await ns.asleep(0);
    }
    return search.best() ?? quick;
  };

  const playOut = async () => {
    for (;;) {
      const who = ns.go.getCurrentPlayer();
      if (who === "None") return;
      if (who === "White") {
        if ((await within(ns.go.opponentNextTurn(false))) === null) await unstick();
        continue;
      }
      const history = ns.go.getMoveHistory();
      const state = ns.go.getGameState();
      const opponentPassed = state.previousMove === null && history.length > 0;
      const m = await pickMove(ns.go.getBoardState(), history, { komi: state.komi, opponentPassed });
      try {
        const turn = m ? ns.go.makeMove(m.x, m.y) : ns.go.passTurn();
        if ((await within(turn)) === null) await unstick();
      } catch (err) {
        // A hand on the board took the turn. The next pass of this loop reads who
        // is to move; anything else is a real failure.
        if (!/not your turn/i.test(String(err))) throw err;
      }
    }
  };

  /** The AI went silent: the case passTurn's docs name. A stuck game earns nothing, so a reset costs less. */
  const unstick = async () => {
    warnOnce("the AI stopped answering");
    try {
      if ((await within(ns.go.passTurn())) !== null) return;
    } catch {}
    ns.go.resetBoardState(ns.go.getOpponent(), ns.go.getBoardState().length);
  };

  for (;;) {
    try {
      const fresh = ns.go.getCurrentPlayer() === "None" || ns.go.getMoveHistory().length === 0 ||
        ns.go.getOpponent() === "No AI";
      const arm = fresh ? await startArm() : { opp: ns.go.getOpponent(), size: ns.go.getBoardState().length };
      if (!arm) {
        warnOnce("no arm to play");
        await ns.sleep(60_000);
        continue;
      }
      const shown = `${arm.opp === WORLD ? "w0r1d_d43m0n" : arm.opp} ${arm.size}x${arm.size}`;
      current = fresh ? shown : `${shown} (resumed)`;
      report();
      const started = Date.now();
      await playOut();
      const end = ns.go.getGameState();
      const win = end.blackScore >= end.whiteScore;
      const key = armKey(arm.opp, arm.size);
      // A resumed game's clock started at some unknown earlier point.
      arms[key] = learn(arms[key], { score: end.blackScore, win, secs: fresh ? (Date.now() - started) / 1000 : null });
      ns.write(ARMS_FILE, JSON.stringify(arms), "w");
      event(`${shown}: ${win ? "won" : "lost"} ${end.blackScore} to ${end.whiteScore} in ${ns.format.time(Date.now() - started)}`);
      report();
      warned.clear();
      await ns.sleep(50);
    } catch (err) {
      warnOnce(`game failed: ${err}`);
      await ns.sleep(5000);
    }
  }
}
