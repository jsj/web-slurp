import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { agentBrowserCli, agentBrowserEnv } from "../agent-browser";
import { absolute, run } from "../harness";
import { doctor } from "./doctor";

export const packageRoot = resolve(import.meta.dir, "../..");
export type InstallOptions = { skillsDir: string; binDir: string; backupExisting?: boolean; skipBrowser?: boolean; withCdp?: boolean };
export const defaultSkillsDir = resolve(homedir(), ".agents/skills");
export const defaultBinDir = resolve(homedir(), ".local/bin");

function links(options: InstallOptions): Array<[string, string]> {
  return [
    [packageRoot, resolve(absolute(options.skillsDir), "web-slurp")],
    [resolve(packageRoot, "scripts/web-slurp"), resolve(absolute(options.binDir), "web-slurp")],
  ];
}
function present(path: string): boolean {
  return existsSync(path) || (() => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } })();
}
function owned(source: string, target: string): boolean {
  return present(target) && lstatSync(target).isSymbolicLink()
    && resolve(dirname(target), readlinkSync(target)) === source;
}
function legacySkill(source: string, target: string): boolean {
  if (source !== packageRoot || !present(target) || lstatSync(target).isSymbolicLink()) return false;
  try { return JSON.parse(readFileSync(resolve(target, "package.json"), "utf8")).name === "web-slurp"; }
  catch { return false; }
}
export function register(options: InstallOptions): void {
  const entries = links(options);
  for (const [source, target] of entries) {
    if (present(target) && !owned(source, target) && !owned(resolve(packageRoot, "src/cli.ts"), target) && !legacySkill(source, target) && !options.backupExisting) {
      throw new Error(`Existing installation: ${target}. Use --backup-existing to preserve it and install this package.`);
    }
    if (source === target) throw new Error(`Cannot install over the package itself: ${source}`);
  }
  for (const [source, target] of entries) {
    if (owned(source, target)) continue;
    if (owned(resolve(packageRoot, "src/cli.ts"), target)) unlinkSync(target);
    if (legacySkill(source, target)) {
      rmSync(target, { recursive: true });
      console.log(`Removed legacy installation: ${target}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    if (present(target)) {
      // Backups must live outside skills/ so agents do not discover stale skills.
      const backupRoot = resolve(dirname(target), '../web-slurp-backups');
      mkdirSync(backupRoot, { recursive: true });
      const backup = resolve(mkdtempSync(resolve(backupRoot, 'web-slurp-')), 'web-slurp');
      renameSync(target, backup);
      console.log(`Preserved: ${backup}`);
    }
    symlinkSync(source, target);
    console.log(`Linked: ${target} → ${source}`);
  }
}
export async function setup(options: InstallOptions): Promise<void> {
  if (!options.skipBrowser) {
    run("bun", [agentBrowserCli, "install"], agentBrowserEnv());
  }
  if (options.withCdp) {
    const venv = resolve(packageRoot, ".venv");
    if (!existsSync(resolve(venv, "bin/python3"))) run("python3", ["-m", "venv", venv]);
    run(resolve(venv, "bin/python3"), ["-m", "pip", "install", "websocket-client==1.8.0"]);
  }
  await doctor("http://127.0.0.1:9222", { skipBrowser: options.skipBrowser, requireCdp: options.withCdp });
  register(options);
  console.log("Ready: web-slurp capture https://example.com --out ./targets/example");
  if (!(process.env.PATH ?? "").split(":").includes(absolute(options.binDir))) {
    console.log(`Add ${absolute(options.binDir)} to PATH to use web-slurp by name.`);
  }
}
export function uninstall(options: InstallOptions): void {
  for (const [source, target] of links(options)) {
    if (owned(source, target)) { unlinkSync(target); console.log(`Removed link: ${target}`); }
  }
  console.log("Package files, backups, browser runtime, and captures were preserved.");
}
