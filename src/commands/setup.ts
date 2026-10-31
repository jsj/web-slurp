import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { agentBrowserCli, agentBrowserEnv } from "../agent-browser";
import { absolute, run } from "../harness";
import { doctor } from "./doctor";

export const packageRoot = resolve(import.meta.dir, "../..");
export const skillRoot = resolve(packageRoot, ".runtime/skill");
export type InstallOptions = { skillsDir: string; binDir: string; backupExisting?: boolean; skipBrowser?: boolean; withCdp?: boolean };
export const defaultSkillsDir = resolve(homedir(), ".agents/skills");
export const defaultBinDir = resolve(homedir(), ".local/bin");

function links(options: InstallOptions): Array<[string, string]> {
  return [
    [skillRoot, resolve(absolute(options.skillsDir), "web-slurp")],
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
function legacySource(source: string): string {
  return source === skillRoot ? packageRoot : resolve(packageRoot, "src/cli.ts");
}
function prepareSkill(): void {
  mkdirSync(resolve(skillRoot, "scripts"), { recursive: true });
  // Export only instructions and references. Registering the package root also
  // exposes dependency SKILL.md files to recursive skill discovery.
  for (const name of ["SKILL.md", "references", "agents"]) {
    const source = resolve(packageRoot, name), target = resolve(skillRoot, name);
    if (!owned(source, target)) {
      if (present(target)) throw new Error(`Unexpected file in generated skill: ${target}`);
      symlinkSync(source, target);
    }
  }
  for (const [name, command] of [["setup", "../../setup"], ["scripts/agent-browser.sh", "../../../scripts/agent-browser.sh"]]) {
    writeFileSync(resolve(skillRoot, name!), `#!/bin/sh\nset -eu\nslurp_skill=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec "$slurp_skill/${command}" "$@"\n`, { mode: 0o755 });
  }
}
export function register(options: InstallOptions): void {
  const entries = links(options);
  for (const [source, target] of entries) {
    if (present(target) && !owned(source, target) && !owned(legacySource(source), target) && !options.backupExisting) {
      throw new Error(`Existing installation: ${target}. Use --backup-existing to preserve it and install this package.`);
    }
    if (source === target) throw new Error(`Cannot install over the package itself: ${source}`);
  }
  prepareSkill();
  for (const [source, target] of entries) {
    if (owned(source, target)) continue;
    if (owned(legacySource(source), target)) unlinkSync(target);
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
    if (owned(source, target) || owned(legacySource(source), target)) { unlinkSync(target); console.log(`Removed link: ${target}`); }
  }
  console.log("Package files, backups, browser runtime, and captures were preserved.");
}
