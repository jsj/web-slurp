#!/usr/bin/env bun
import { setup, uninstall, defaultSkillsDir, defaultBinDir, packageRoot } from "./commands/setup";
import { run } from "./harness";
import { resolve } from "node:path";
import packageJson from "../package.json";
import { Command, Option } from "commander";
import { beautify, chunks, rename, split } from "./commands/bundles";
import { capture, captureCdp, captureResponsive, compare, download } from "./commands/capture";
import { browserStatus, openBrowser, closeBrowser } from "./commands/browser";
import { captureFlow } from "./commands/flow";
import { doctor } from "./commands/doctor";
import { styles } from "./commands/styles";
import { serve } from "./commands/serve";
import { initTarget } from "./commands/target";

const program = new Command()
  .name("web-slurp")
  .description("Capture and decompose modern web bundles")
  .version(packageJson.version)
  .showHelpAfterError();

for (const name of ["setup", "uninstall", "update"] as const) {
  const command = program.command(name)
    .description(name === "uninstall" ? "Remove only this package's CLI and skill links" : name === "update" ? "Fast-forward a clean Git checkout and rerun setup" : "Verify dependencies and register CLI and skill links")
    .option("--skills-dir <path>", "Skill registration directory", defaultSkillsDir)
    .option("--bin-dir <path>", "CLI registration directory", defaultBinDir);
  if (name !== "uninstall") command
    .option("--backup-existing", "Preserve conflicting installations before linking", false)
    .option("--skip-browser", "Register without installing or checking Chromium", false)
    .option("--with-cdp", "Install optional authenticated-download dependency in a local venv", false);
  command.action(name === "setup" ? setup : name === "uninstall" ? uninstall : () => run("sh", [resolve(packageRoot, "update"), ...process.argv.slice(3)]));
}

const browser = program.command('browser').description('Manage persistent Chrome profiles for authenticated captures');
browser.command('open').argument('[url]', 'Page to open', 'about:blank')
  .option('--profile <name>', 'Named Chrome profile', 'default')
  .action((url, options) => openBrowser(options.profile, url));
browser.command('status').option('--profile <name>', 'Named Chrome profile', 'default')
  .action(async options => console.log(JSON.stringify(await browserStatus(options.profile), null, 2)));
browser.command('close').option('--profile <name>', 'Named Chrome profile', 'default')
  .action(options => closeBrowser(options.profile));

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
  .argument("[target]", "Target artifact directory (legacy positional form)")
  .option("--out <path>", "Target artifact directory")
  .option("--viewport <size>", "Viewport WIDTHxHEIGHT", "1440x900")
  .option("--device-scale-factor <number>", "Screenshot pixel density", Number, 1)
  .option("--wait-for <selector>", "Wait for a visible element before capturing")
  .option("--profile <name>", "Use a persistent visible Chrome profile; requires --wait-for")
  .option("--ready-url <url>", "Expected signed-in URL if it differs from the requested URL")
  .option("--auth-timeout <seconds>", "Time allowed for sign-in and page readiness", Number, 300)
  .addOption(new Option("--wait-until <state>", "Browser readiness state").choices(["load", "domcontentloaded", "networkidle"]).default("networkidle"))
  .action((url, target, options) => {
    if (target && options.out) throw new Error("Use either a positional target or --out, not both.");
    if (!target && !options.out) throw new Error("Specify an artifact directory with --out <path>.");
    return capture(url, options.out ?? target, options);
  });

for (const name of ['capture-responsive', 'compare'] as const) {
  const command = program.command(name)
    .description(name === 'compare' ? 'Capture a clone at the reference viewport and write a visual diff' : 'Capture desktop and mobile layouts together');
  if (name === 'compare') command.argument('<reference>', 'Reference capture directory');
  command.argument('<url>', 'Page URL').requiredOption('--out <path>', 'New artifact directory')
    .option('--wait-for <selector>', 'Visible readiness selector')
    .option('--profile <name>', 'Persistent Chrome profile')
    .option('--ready-url <url>', 'Expected signed-in URL')
    .option('--auth-timeout <seconds>', 'Sign-in timeout', Number, 300);
  if (name === 'compare') command.action((reference, url, options) => compare(reference, url, options.out, options));
  else command.action((url, options) => captureResponsive(url, options.out, options));
}

program.command('flow').description('Capture named interaction states from an explicit JSON walkthrough')
  .argument('<url>', 'Page URL').requiredOption('--out <path>', 'New artifact directory')
  .requiredOption('--steps <file>', 'JSON array of named click/hover/scroll/waitFor steps')
  .option('--profile <name>', 'Persistent Chrome profile for signed-in pages')
  .option('--viewport <size>', 'Viewport WIDTHxHEIGHT', '1440x900')
  .option('--timeout <seconds>', 'Readiness timeout per step', Number, 30)
  .action((url, options) => captureFlow(url, options.out, options.steps, options));

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
  .option("--live-assets", "Fetch missing same-origin static assets from the source", false)
  .action((target: string, options: { host: string; port: number; liveAssets: boolean }) => serve(target, options));

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`web-slurp: ${message}`);
  process.exitCode ||= 1;
});
