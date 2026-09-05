import { resolve } from "node:path";

export const agentBrowserCli = resolve(import.meta.dir, "../node_modules/agent-browser/bin/agent-browser.js");

export function agentBrowserEnv(): NodeJS.ProcessEnv {
  const userId = typeof process.getuid === "function" ? process.getuid() : "user";
  const socketDir = process.env.WEB_SLURP_AGENT_BROWSER_SOCKET_DIR
    ?? (process.platform === "win32" ? resolve(process.env.TEMP ?? ".", "ws-ab") : `/tmp/ws-ab-${userId}`);
  return { ...process.env, AGENT_BROWSER_SOCKET_DIR: socketDir };
}
