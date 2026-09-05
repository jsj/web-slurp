#!/usr/bin/env bun
import { Command, Option } from "commander";
import { beautify, chunks, rename, split } from "./commands/bundles";
import { capture, captureCdp, download } from "./commands/capture";
import { doctor } from "./commands/doctor";
import { styles } from "./commands/styles";
import { serve } from "./commands/serve";
import { initTarget } from "./commands/target";

const program = new Command()
  .name("web-slurp")
  .description("Capture and decompose modern web bundles")
  .version("0.1.0")
  .showHelpAfterError();

program.command("doctor")
  .description("Check harness and tool prerequisites")
  .option("--cdp <url>", "Chrome DevTools endpoint", "http://127.0.0.1:9222")
  .action(async ({ cdp }: { cdp: string }) => doctor(cdp));

program.command("init")
  .description("Create the stable target directory contract")
  .argument("<target>", "Target artifact directory")
  .option("--allow-existing", "Add missing directories to a non-empty target", false)
  .action((target: string, { allowExisting }: { allowExisting: boolean }) => initTarget(target, allowExisting));

program.command("capture")
  .description("Capture rendered HTML and script URLs with headless Chromium")
  .argument("<url>", "HTTP(S) page URL")
  .argument("<target>", "Target artifact directory")
  .action(capture);

program.command("capture-cdp")
  .description("Capture the rendered page and static asset URLs from an authorized Chrome CDP session")
  .argument("<target>", "Target artifact directory")
  .option("--page-url <url>", "Exact or prefix URL of the Chrome page to capture")
  .option("--cdp <url>", "Chrome DevTools endpoint", "http://127.0.0.1:9222")
  .action((target: string, options: { pageUrl?: string; cdp: string }) => captureCdp(target, options.pageUrl, options.cdp));

program.command("download")
  .description("Download a URL list through an authorized Chrome CDP session")
  .argument("<urls>", "Newline-delimited URL list")
  .argument("<outdir>", "Raw asset output directory")
  .requiredOption("--referer <url>", "Page URL used to establish browser context")
  .option("--cdp <url>", "Chrome DevTools endpoint", "http://127.0.0.1:9222")
  .action((urls: string, outdir: string, options: { referer: string; cdp: string }) =>
    download(urls, outdir, options.referer, options.cdp));

program.command("beautify")
  .description("Beautify a JavaScript bundle")
  .argument("<input>", "Raw JavaScript bundle")
  .argument("<output>", "Beautified JavaScript path")
  .action(beautify);

program.command("split")
  .description("Split a beautified bundle into modules")
  .argument("<input>", "Beautified JavaScript bundle")
  .argument("<outdir>", "Module output directory")
  .addOption(new Option("--format <format>", "Bundle wrapper format").choices(["auto", "webpack", "turbopack"]).default("auto"))
  .action((input: string, outdir: string, { format }: { format: "auto" | "webpack" | "turbopack" }) =>
    split(input, outdir, format));

program.command("rename")
  .description("Rename split module files")
  .argument("<modules>", "Split module directory")
  .option("--yes", "Apply names without confirmation", false)
  .option("--heuristic-only", "Keep naming deterministic and local", false)
  .action((modules: string, options: { yes: boolean; heuristicOnly: boolean }) => rename(modules, options));

program.command("chunks")
  .description("List or download lazy webpack chunks from a runtime map")
  .requiredOption("--app-js <path>", "Beautified webpack runtime bundle")
  .requiredOption("--outdir <path>", "Chunk output directory")
  .option("--base-url <url>", "Base URL for chunk assets")
  .option("--url-template <template>", "Template using base_url, id, name, and hash placeholders")
  .option("--filter <regex>", "Filter named chunks")
  .option("--list", "List resolved chunks without downloading", false)
  .option("--all", "Include all named and unnamed chunks", false)
  .option("--unnamed", "Include unnamed chunks", false)
  .action(chunks);

program.command("styles")
  .description("Extract CSS and style-token inventory")
  .argument("<target>", "Target artifact directory")
  .option("--download-css", "Download linked stylesheets", false)
  .option("--force", "Redownload existing stylesheet assets", false)
  .action((target: string, options: { downloadCss: boolean; force: boolean }) => styles(target, options));

program.command("serve")
  .description("Serve captured HTML and cached same-origin static assets for local reference")
  .argument("<target>", "Target artifact directory")
  .option("--host <host>", "Local bind address", "127.0.0.1")
  .option("--port <port>", "Local port", (value) => Number(value), 4174)
  .action((target: string, options: { host: string; port: number }) => serve(target, options));

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`web-slurp: ${message}`);
  process.exitCode = 1;
});
