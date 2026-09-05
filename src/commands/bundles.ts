import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { absolute, BundleFormat, detectFormat, harnessScript, requireFile, run } from "../harness";

export function beautify(inputPath: string, outputPath: string): void {
  const input = absolute(inputPath);
  const output = absolute(outputPath);
  requireFile(input);
  mkdirSync(dirname(output), { recursive: true });
  run("npx", ["-y", "js-beautify", input, "-o", output]);
}

export function split(inputPath: string, outdirPath: string, requested: BundleFormat | "auto"): void {
  const input = absolute(inputPath);
  const outdir = absolute(outdirPath);
  requireFile(input);
  const format = requested === "auto" ? detectFormat(input) : requested;
  console.log(`Detected format: ${format}`);
  const splitter = format === "turbopack" ? "split_modules_turbopack.py" : "split_modules.py";
  run("python3", [harnessScript(splitter), input, outdir]);
}

export function rename(modulesPath: string, options: { yes: boolean; heuristicOnly: boolean }): void {
  const modules = absolute(modulesPath);
  const args = [harnessScript("rename_modules.py"), modules];
  if (options.yes) args.push("--yes");
  if (options.heuristicOnly) args.push("--heuristic-only");
  run("python3", args);
}

export function chunks(options: {
  appJs: string;
  outdir: string;
  baseUrl?: string;
  urlTemplate?: string;
  list: boolean;
  all: boolean;
  unnamed: boolean;
  filter?: string;
}): void {
  const appJs = absolute(options.appJs);
  requireFile(appJs);
  const args = [harnessScript("download_chunks.py"), "--app-js", appJs, "--outdir", absolute(options.outdir)];
  if (options.baseUrl) args.push("--base-url", options.baseUrl);
  if (options.urlTemplate) args.push("--url-template", options.urlTemplate);
  if (options.list) args.push("--list");
  if (options.all) args.push("--all");
  if (options.unnamed) args.push("--unnamed");
  if (options.filter) args.push("--filter", options.filter);
  run("python3", args);
}
