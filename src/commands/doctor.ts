import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { agentBrowserCli, agentBrowserEnv } from "../agent-browser";
import { findHarness } from "../harness";

function executable(name: string): string | null {
  return Bun.which(name);
}

export async function doctor(cdp: string): Promise<void> {
  const checks: Array<[string, string | null]> = [
    ["harness", findHarness()],
    ["bun", executable("bun")],
    ["python3", executable("python3")],
    ["npx", executable("npx")],
    ["agent-browser", existsSync(agentBrowserCli) ? agentBrowserCli : null],
  ];
  let failed = false;
  for (const [name, value] of checks) {
    console.log(`${value ? "OK" : "MISSING"} ${name}: ${value ?? "-"}`);
    failed ||= !value;
  }

  const websocket = spawnSync("python3", ["-c", "import websocket"], { stdio: "ignore" }).status === 0;
  console.log(`${websocket ? "OK" : "MISSING"} python websocket-client`);
  failed ||= !websocket;

  const browserRuntime = spawnSync("bun", [agentBrowserCli, "doctor", "--offline", "--json"], {
    env: agentBrowserEnv(),
    stdio: "ignore",
  }).status === 0;
  console.log(`${browserRuntime ? "OK" : "MISSING"} agent-browser runtime`);
  failed ||= !browserRuntime;

  let cdpHealthy = false;
  try {
    const response = await fetch(`${cdp.replace(/\/$/, "")}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    cdpHealthy = response.ok;
  } catch {
    // CDP is optional until an authenticated download is requested.
  }
  console.log(`${cdpHealthy ? "OK" : "OPTIONAL"} cdp: ${cdp}`);
  if (failed) throw new Error("Required web-slurp prerequisites are missing.");
}
