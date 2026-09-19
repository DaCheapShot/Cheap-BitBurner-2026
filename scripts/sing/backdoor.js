/**
 * Backdoor one server: walk its route from home, install, return the terminal.
 *
 *   run scripts/sing/backdoor.js home n00dles CSEC
 *
 * A real file rather than an rpc body, because the install is fire-and-forget:
 * installBackdoor takes hackTime / 4, far past rpc's 10 s, and a transient that
 * returned early would take its pending backdoor down with it. sing.js starts
 * one of these per server and does not wait.
 *
 * SEVERAL CAN RUN AT ONCE. installBackdoor reads Player.getCurrentServer() once,
 * when it is CALLED (Singularity.ts), then only awaits a timer. The connect hops
 * and that call run with no await between them, so no other script can move the
 * terminal in the middle - each captures its own server.
 *
 * The route is walked hop by hop from home: always legal, since each hop is the
 * last one's neighbour. This moves the player's terminal; the finally puts it
 * back on home even when a hop or the install throws. w0r1d_d43m0n is refused
 * outright - its backdoor ends the BitNode, and that is the user's call.
 *
 * Imports nothing: every name a module brings in is billed to each copy.
 *
 * RAM: 1.60 base + connect 2.00 + installBackdoor 2.00 = 5.60 GB
 */

/** @param {NS} ns */
export async function main(ns) {
  const route = ns.args.map(String);
  if (route.includes("w0r1d_d43m0n")) throw new Error("refusing w0r1d_d43m0n - its backdoor ends the BitNode");
  try {
    for (const h of route) if (!ns.singularity.connect(h)) return;
    await ns.singularity.installBackdoor();
  } finally {
    ns.singularity.connect("home");
  }
}
