/** @param {NS} ns */
export async function main(ns) {
  const CONFIG_PORT = 1;
  const [key, val]  = ns.args;
  const port        = ns.getPortHandle(CONFIG_PORT);

  if (!key || key === "status") {
    const raw = port.empty() ? "NULL" : port.peek();
    const cfg = raw === "NULL" ? {} : JSON.parse(raw);
    ns.tprint(`Config: ${JSON.stringify(cfg)}`);
    return;
  }

  const raw = port.empty() ? "NULL" : port.read();
  const cfg = raw === "NULL" ? {} : JSON.parse(raw);
  cfg[key]  = val === "on" || val === "true";
  port.write(JSON.stringify(cfg));
  ns.tprint(`Config: ${JSON.stringify(cfg)}`);
}
