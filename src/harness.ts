import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const requiredScripts = [
  "cdp_download_urls.py",
  "split_modules.py",
  "split_modules_turbopack.py",
  "rename_modules.py",
  "extract_style_inventory.py",
  "download_chunks.py",
] as const;

const bundledHarness = resolve(import.meta.dir, "../harness");

export type BundleFormat = "webpack" | "turbopack";

export function absolute(input: string): string {
  const expanded = input === "~" || input.startsWith("~/")
    ? input.replace(/^~/, homedir())
    : input;
  return resolve(expanded);
}

export function findHarness(): string {
  const complete = existsSync(bundledHarness)
    && requiredScripts.every((name) => existsSync(resolve(bundledHarness, "scripts", name)));
  if (!complete) {
    throw new Error(
      `The bundled webpack decomp harness is incomplete: ${bundledHarness}`,
    );
  }
  return bundledHarness;
}

export function harnessScript(name: typeof requiredScripts[number]): string {
  return resolve(findHarness(), "scripts", name);
}

export function requireFile(path: string): void {
  if (!existsSync(path) || !Bun.file(path).size) {
    throw new Error(`Input file not found or empty: ${path}`);
  }
}

export function pythonExecutable(): string {
  const local = resolve(import.meta.dir, "../.venv/bin/python3");
  return existsSync(local) ? local : "python3";
}

export function run(command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  if (command === "python3") command = pythonExecutable();
  console.log(`+ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status ?? "unknown"}: ${command}`);
  }
}

export function detectFormat(path: string): BundleFormat {
  const sample = readFileSync(path, "utf8").slice(0, 2_000_000);
  const turbopackMarkers = ["TURBOPACK", "__turbopack", "turbopackContext", ".push([\""];
  return turbopackMarkers.some((marker) => sample.includes(marker)) ? "turbopack" : "webpack";
}
