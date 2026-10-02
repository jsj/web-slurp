import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { agentBrowserCli, agentBrowserEnv } from "../agent-browser";
import { findHarness, pythonExecutable } from "../harness";
import { wakaruCommand } from "./recover";

function executable(name: string): string | null {
  return Bun.which(name);
}

export async function doctor(cdp: string, options: { skipBrowser?: boolean; requireCdp?: boolean } = {}): Promise<void> {
  const checks: Array<[string, string | null]> = [
    ["harness", findHarness()],
    ["bun", executable("bun")],
    ["python3", executable(pythonExecutable())],
    ["agent-browser", existsSync(agentBrowserCli) ? agentBrowserCli : null],
  ];
  let failed = false;
  for (const [name, value] of checks) {
    console.log(`${value ? "OK" : "MISSING"} ${name}: ${value ?? "-"}`);
    failed ||= !value;
  }

  const websocket = spawnSync(pythonExecutable(), ["-c", "import websocket"], { stdio: "ignore" }).status === 0;
  console.log(`${websocket ? "OK" : options.requireCdp ? "MISSING" : "OPTIONAL"} python websocket-client`);
  failed ||= Boolean(options.requireCdp && !websocket);

  try {
    const [command, ...args] = wakaruCommand();
    const recovery = spawnSync(command!, [...args, "--version"], { encoding: "utf8", timeout: 10_000 });
    console.log(`${recovery.status === 0 ? "OK" : "OPTIONAL"} wakaru: ${recovery.status === 0 ? recovery.stdout.trim() : "unavailable; recover needs Wakaru"}`);
  } catch {
    console.log("OPTIONAL wakaru: unavailable; recover needs Wakaru");
  }

  const browserRuntime = options.skipBrowser || spawnSync("bun", [agentBrowserCli, "doctor", "--offline", "--json"], {
    env: agentBrowserEnv(),
    stdio: "ignore",
  }).status === 0;
  console.log(`${options.skipBrowser ? "SKIPPED" : browserRuntime ? "OK" : "MISSING"} agent-browser runtime`);
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
