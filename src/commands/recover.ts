import { spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { absolute, requireFile } from "../harness";
import { javascriptFiles, moduleIndex, sha256 } from "../module-index";

export type RecoveryOptions = {
  out: string; mode: "auto" | "strict" | "inspect" | "file";
  level: "minimal" | "standard" | "aggressive"; raw?: boolean; sourceMap?: string;
};

export function wakaruCommand(): string[] {
  if (process.env.WEB_SLURP_WAKARU) return [absolute(process.env.WEB_SLURP_WAKARU)];
  const cli = resolve(import.meta.dir, "../../node_modules/@wakaru/cli/bin/wakaru");
  if (!existsSync(cli)) throw new Error("Wakaru is unavailable. Install dependencies with ./setup, or set WEB_SLURP_WAKARU to an installed Wakaru executable.");
  return [process.execPath, cli];
}

function engine(command: string[], args: string[]) {
  const result = spawnSync(command[0]!, [...command.slice(1), ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 300_000 });
  if (result.error) throw result.error;
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
}

type LocalMap = { origin: string; bytes: Buffer; embedded: number };
type RecoveryInput = { original: string; file?: string; url?: string };

function captureInputs(target: string, warnings: string[]): RecoveryInput[] | undefined {
  const manifest = resolve(target, "input/assets/manifest.json");
  if (!existsSync(manifest)) return;
  const data = JSON.parse(readFileSync(manifest, "utf8")) as { version?: number; assets?: Array<{ type: string; status: string; path: string; url: string }> };
  if (data.version !== 1 || !Array.isArray(data.assets)) throw new Error(`Invalid capture asset manifest: ${manifest}`);
  return data.assets.filter(asset => asset.type === "Script").flatMap(asset => {
    if (asset.status !== "saved") { warnings.push(`Captured script unavailable: ${asset.url}`); return []; }
    const original = resolve(target, asset.path);
    const path = relative(target, original);
    if (path === ".." || path.startsWith("../") || isAbsolute(path)) throw new Error(`Captured script path escapes target: ${asset.path}`);
    const url = new URL(asset.url);
    const origin = sha256(Buffer.from(url.origin)).slice(0, 16);
    let file = url.pathname.replace(/^\/+/, "") || "index.js";
    if (!/\.(?:[cm]?js|jsx|tsx?)$/.test(file)) file += ".js";
    if (url.search) {
      const extension = extname(file);
      file = file.slice(0, -extension.length) + `~${sha256(Buffer.from(url.search)).slice(0, 16)}` + extension;
    }
    return [{ original, file: `origins/${origin}/${file}`, url: url.href }];
  });
}
function localMap(input: string, explicit?: string): LocalMap | undefined {
  if (explicit) {
    requireFile(explicit);
    const bytes = readFileSync(explicit);
    const map = JSON.parse(bytes.toString("utf8"));
    return { origin: explicit, bytes, embedded: embeddedCount(map) };
  }
  const source = readFileSync(input, "utf8");
  const directives = [...source.matchAll(/(?:\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\/)/g)];
  const last = directives.at(-1);
  const url = last?.[1] ?? last?.[2];
  if (url?.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma < 0) throw new Error("Malformed inline source map");
    const bytes = /;base64$/i.test(url.slice(0, comma))
      ? Buffer.from(url.slice(comma + 1), "base64")
      : Buffer.from(decodeURIComponent(url.slice(comma + 1)));
    return { origin: `${input}#inline`, bytes, embedded: embeddedCount(JSON.parse(bytes.toString("utf8"))) };
  }
  // Only follow local sibling maps automatically. Remote URLs and parent paths
  // need explicit retrieval/selection; target comments are untrusted data.
  const candidate = url && !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(url)
    ? resolve(dirname(input), decodeURIComponent(url.split(/[?#]/)[0]!)) : `${input}.map`;
  if (relative(dirname(input), candidate).startsWith("..") || !existsSync(candidate) || !lstatSync(candidate).isFile()) return;
  const bytes = readFileSync(candidate);
  return { origin: candidate, bytes, embedded: embeddedCount(JSON.parse(bytes.toString("utf8"))) };
}

function embeddedCount(value: unknown): number {
  const map = value as { version?: unknown; sources?: unknown; sourcesContent?: unknown } | null;
  if (!map || map.version !== 3 || !Array.isArray(map.sources)) throw new Error("Expected a version 3 source map with a sources array");
  return Array.isArray(map.sourcesContent) ? map.sourcesContent.filter((source: unknown) => typeof source === "string").length : 0;
}

export function recover(inputPaths: string[], options: RecoveryOptions): void {
  if (!inputPaths.length) throw new Error("Specify at least one JavaScript input.");
  if (options.raw && options.mode === "file") throw new Error("--raw requires a bundle recovery mode.");
  if (options.sourceMap && (options.mode !== "file" || inputPaths.length !== 1)) throw new Error("--source-map requires one input with --mode file.");
  const warnings: string[] = [];
  const selected: RecoveryInput[] = inputPaths.flatMap<RecoveryInput>(path => {
    const input = absolute(path);
    const stat = lstatSync(input);
    if (stat.isSymbolicLink()) throw new Error(`Select an input file or directory directly, not a symlink: ${input}`);
    return stat.isDirectory() ? captureInputs(input, warnings) ?? javascriptFiles(input).map(original => ({ original })) : [{ original: input }];
  });
  const inputs = [...new Map(selected.map(input => [input.original, input])).values()].sort((a, b) => a.original.localeCompare(b.original));
  if (!inputs.length) throw new Error("No JavaScript inputs found.");
  if (options.mode === "file" && inputs.length !== 1) throw new Error("--mode file requires exactly one input file.");
  for (const input of inputs) {
    requireFile(input.original);
    if (!lstatSync(input.original).isFile()) throw new Error(`Input is not a file: ${input.original}`);
  }
  const out = absolute(options.out);
  if (existsSync(out)) throw new Error(`Recovery output already exists: ${out}. Choose a fresh directory.`);
  const command = wakaruCommand();
  const version = engine(command, ["--version"]);
  if (version.code !== 0) throw new Error(`Wakaru is unavailable: ${version.stderr || version.stdout}`);
  let root = dirname(inputs[0]!.original);
  while (inputs.some(input => relative(root, input.original).startsWith("..") || isAbsolute(relative(root, input.original)))) root = dirname(root);
  const maps = inputs.map(input => {
    try { return localMap(input.original, options.sourceMap ? absolute(options.sourceMap) : undefined); }
    catch (error) {
      if (options.sourceMap) throw error;
      warnings.push(`Source map for ${input.original}: ${error instanceof Error ? error.message : error}`);
      return undefined;
    }
  });
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(out); // Exclusive creation protects existing evidence, including concurrent runs.
  const snapshots: Array<{ original: string; file: string; url?: string; sha256?: string }> = inputs.map(input => {
    const file = input.file ?? relative(root, input.original);
    const snapshot = resolve(out, "inputs", file);
    return { original: input.original, file: relative(out, snapshot), url: input.url };
  });
  const report: Record<string, unknown> = { version: 1, engine: version.stdout.trim(), mode: options.mode, level: options.level, raw: Boolean(options.raw), inputs: snapshots, maps: [], warnings, status: "partial" };
  const saveReport = () => writeFileSync(resolve(out, "recovery.json"), JSON.stringify(report, null, 2) + "\n");
  saveReport();
  try {
    for (const input of snapshots) {
      const snapshot = resolve(out, input.file);
      mkdirSync(dirname(snapshot), { recursive: true });
      copyFileSync(input.original, snapshot, constants.COPYFILE_EXCL);
      input.sha256 = sha256(readFileSync(snapshot));
    }
    saveReport();
    // Originals from maps are additive, and preferred over reconstructed code.
    const mapReports: Array<Record<string, unknown>> = [];
    for (const [index, map] of maps.entries()) {
      if (!map) continue;
      const path = resolve(out, "maps", `${index + 1}.map`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, map.bytes);
      const entry: Record<string, unknown> = { input: snapshots[index]!.file, origin: map.origin, file: relative(out, path), sha256: sha256(map.bytes), embedded: map.embedded };
      mapReports.push(entry);
      if (map.embedded) {
        const sources = resolve(out, "sources", String(index + 1));
        const result = engine(command, ["extract", path, "-o", sources]);
        entry.extraction = result;
        if (result.code) warnings.push(`Original source extraction failed for ${map.origin}: ${result.stderr}`);
        else entry.sources = relative(out, sources);
      }
    }
    report.maps = mapReports;
    const modules = resolve(out, "modules");
    const args = ["--json", "--diagnostics", "--level", options.level];
    if (options.mode === "file") {
      mkdirSync(modules);
      args.push(resolve(out, snapshots[0]!.file), "-o", resolve(modules, "recovered.js"), "--emit-source-map");
      if (maps[0]) args.push("--source-map", resolve(out, "maps/1.map"));
    } else {
      args.push(`--unpack=${options.mode}`, "--provenance", "-o", modules, ...snapshots.map(input => resolve(out, input.file)));
      if (options.raw) args.push("--raw");
      else args.push("--emit-source-map");
    }
    const result = engine(command, args);
    report.exitCode = result.code;
    report.stderr = result.stderr;
    let validReport = false;
    try { report.result = JSON.parse(result.stdout); validReport = Boolean(report.result && typeof report.result === "object"); }
    catch { report.stdout = result.stdout; }
    const sourceUrls = new Map<string, string>();
    const provenance = resolve(modules, "provenance.json");
    if (existsSync(provenance)) {
      const data = JSON.parse(readFileSync(provenance, "utf8")) as { modules?: Record<string, { input: string }> };
      const inputUrls = new Map(snapshots.filter(input => input.url).map(input => [resolve(out, input.file), input.url!]));
      for (const [file, source] of Object.entries(data.modules ?? {})) {
        const input = resolve(modules, source.input);
        const url = inputUrls.get(input);
        if (url) sourceUrls.set(file, url);
        source.input = relative(modules, input);
      }
      writeFileSync(provenance, JSON.stringify(data, null, 2) + "\n");
    }
    const index = existsSync(modules) ? moduleIndex(modules, sourceUrls) : undefined;
    if (index) writeFileSync(resolve(out, "module-index.json"), JSON.stringify(index, null, 2) + "\n");
    if (existsSync(resolve(out, "sources"))) writeFileSync(resolve(out, "source-index.json"), JSON.stringify(moduleIndex(resolve(out, "sources")), null, 2) + "\n");
    const output = report.result as { failed?: number; warnings?: Array<{ is_error?: boolean }> } | undefined;
    if (result.code || !validReport || !index?.modules.length || output?.failed || output?.warnings?.some(warning => warning.is_error)
      || (!options.raw && index.modules.some(module => module.parseError))) throw new Error(`Wakaru recovery failed; partial evidence preserved at ${out}. See recovery.json.`);
    report.status = "complete";
    saveReport();
    console.log(`Recovered: ${out}\nModule index: ${resolve(out, "module-index.json")}\nReport: ${resolve(out, "recovery.json")}`);
    const warningCount = warnings.length + (output?.warnings?.length ?? 0);
    if (warningCount) console.log(`Warnings: ${warningCount} (see recovery.json)`);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    saveReport();
    throw error;
  }
}
