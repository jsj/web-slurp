import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recover } from "../src/commands/recover";
import { moduleIndex } from "../src/module-index";
import { buildRecoveryFixture, recoveryBuilds } from "./fixtures/recovery-builds";
import { build as esbuild } from "esbuild";

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() {
  const root = mkdtempSync(resolve(tmpdir(), "web-slurp-recovery-"));
  temporary.push(root);
  return root;
}
function allFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? allFiles(resolve(root, entry.name)) : [resolve(root, entry.name)]);
}

for (const kind of recoveryBuilds) {
  test(`recovers real ${kind} builds with originals, readable modules, provenance, and an index`, async () => {
    const root = directory();
    const input = await buildRecoveryFixture(root, kind);
    const before = allFiles(input).map(file => [file, readFileSync(file)] as const);
    const out = resolve(root, "recovery");
    recover([input], { out, mode: "auto", level: "standard" });
    const report = JSON.parse(readFileSync(resolve(out, "recovery.json"), "utf8"));
    expect(report.status).toBe("complete");
    expect(report.result.failed).toBe(0);
    expect(report.result.total).toBeGreaterThan(0);
    expect(report.maps.some((map: any) => map.embedded > 0 && map.extraction.code === 0)).toBe(true);
    const index = moduleIndex(resolve(out, "modules"));
    expect(index.modules.length).toBeGreaterThan(0);
    expect(index.modules.every(module => !module.parseError)).toBe(true);
    const recovered = index.modules.map(module => readFileSync(resolve(out, "modules", module.file), "utf8")).join("\n");
    const originals = allFiles(resolve(out, "sources")).map(file => readFileSync(file, "utf8"));
    expect(originals).toContain(readFileSync(resolve(root, "src/app.js"), "utf8"));
    expect(recovered).toContain("calculate");
    expect(recovered).toContain("lazy-recovery-marker");
    if (kind !== "vite-svelte") expect(recovered).toContain("<section");
    else {
      expect(recovered).toContain("Captured Svelte");
      expect(originals).toContain(readFileSync(resolve(root, "src/App.svelte"), "utf8"));
      expect(moduleIndex(resolve(out, "sources")).modules.some(module => module.language === "svelte")).toBe(true);
    }
    const provenance = JSON.parse(readFileSync(resolve(out, "modules/provenance.json"), "utf8"));
    expect(Object.keys(provenance.modules).length).toBeGreaterThan(0);
    for (const module of Object.values(provenance.modules) as Array<{ input: string; ranges: Array<[number, number]> }>) {
      const input = resolve(out, "modules", module.input);
      expect(existsSync(input)).toBe(true);
      const bytes = readFileSync(input);
      for (const [start, end] of module.ranges) {
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(bytes.length);
        expect(end).toBeGreaterThan(start);
      }
    }
    expect(allFiles(resolve(out, "modules")).some(file => file.endsWith(".map"))).toBe(true);
    for (const [file, bytes] of before) expect(readFileSync(file)).toEqual(bytes);
    expect(() => recover([input], { out, mode: "auto", level: "standard" })).toThrow("already exists");
  }, 120_000);
}

test("module index follows static imports, reexports and literal dynamic imports without reading comments as edges", () => {
  const root = directory();
  writeFileSync(resolve(root, "main.jsx"), `import { value } from './value.js'; export { value as renamed } from './value.js';
    export const { a: renamedBinding, b } = { a: 1, b: 2 }; export const [first] = [1];
    export default () => <div>{value}</div>; const lazy = () => import('./lazy.js');
    const dynamic = x => import(x); import 'react'; import './missing.js';
    // import './comment.js';
  `);
  writeFileSync(resolve(root, "value.js"), "export const value = 42;");
  writeFileSync(resolve(root, "lazy.js"), "export default 'loaded';");
  writeFileSync(resolve(root, "broken.js"), "export const = ;");
  const index = moduleIndex(root);
  const main = index.modules.find(module => module.file === "main.jsx")!;
  expect(main.exports).toEqual(["b", "default", "first", "renamed", "renamedBinding"]);
  expect(main.imports.filter(edge => edge.resolution === "internal").map(edge => edge.target)).toEqual(["value.js", "value.js", "lazy.js"]);
  expect(main.imports.find(edge => edge.specifier === "react")?.resolution).toBe("external");
  expect(main.imports.find(edge => edge.specifier === "./missing.js")?.resolution).toBe("missing");
  expect(main.imports.some(edge => edge.specifier === "./comment.js")).toBe(false);
  expect(index.modules.find(module => module.file === "broken.js")?.parseError).toBeDefined();
});

test("minimal recovery preserves shared initialization and computed results in an authored esbuild fixture", async () => {
  const root = directory();
  const source = resolve(root, "src");
  mkdirSync(source);
  writeFileSync(resolve(source, "state.js"), 'module.exports = { events: [] };');
  writeFileSync(resolve(source, "first.js"), 'const state = require("./state"); state.events.push("first"); module.exports = x => x * 3 + 1;');
  writeFileSync(resolve(source, "second.js"), 'const first = require("./first"); const state = require("./state"); state.events.push("second"); module.exports = x => ({ result: first(x), events: [...state.events] });');
  writeFileSync(resolve(source, "main.js"), 'const run = require("./second"); console.log(JSON.stringify(run(5)));');
  const bundle = resolve(root, "bundle.js");
  await esbuild({ entryPoints: [resolve(source, "main.js")], outfile: bundle, bundle: true, minify: true, format: "cjs" });
  const out = resolve(root, "recovery");
  recover([bundle], { out, mode: "auto", level: "minimal" });
  const execute = async (file: string) => {
    const child = Bun.spawn([process.execPath, file], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    return stdout;
  };
  const original = await execute(bundle);
  expect(original.trim()).toBe('{"result":16,"events":["first","second"]}');
  expect(await execute(resolve(out, "modules/entry.js"))).toBe(original);
}, 60_000);

test("recover CLI exposes inspection safety and raw output without output maps", async () => {
  const root = directory();
  const input = resolve(root, "app.js");
  writeFileSync(input, 'export const greeting = "hello";');
  for (const raw of [false, true]) {
    const out = resolve(root, raw ? "raw" : "inspect");
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "recover", input, "--out", out, "--mode", "inspect", ...(raw ? ["--raw"] : [])], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Recovered:");
    const report = JSON.parse(readFileSync(resolve(out, "recovery.json"), "utf8"));
    expect(report.raw).toBe(raw);
    expect(report.result.safety).toBe("inspection-only");
    expect(allFiles(resolve(out, "modules")).some(file => file.endsWith(".map"))).toBe(!raw);
  }
});

test("single-file mode uses embedded original sources and never follows remote map URLs", () => {
  const root = directory();
  const input = resolve(root, "app.js");
  const source = "export const original = 42;";
  const map = { version: 3, sources: ["../Original.ts"], sourcesContent: [source], names: [], mappings: "" };
  writeFileSync(input, `export const a=42;\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`);
  const out = resolve(root, "inline");
  recover([input], { out, mode: "file", level: "minimal" });
  const report = JSON.parse(readFileSync(resolve(out, "recovery.json"), "utf8"));
  expect(report.status).toBe("complete");
  expect(report.maps[0].embedded).toBe(1);
  expect(allFiles(resolve(out, "sources")).some(file => readFileSync(file, "utf8") === source)).toBe(true);
  expect(existsSync(resolve(root, "Original.ts"))).toBe(false);
  writeFileSync(input, 'export const a=42;\n//# sourceMappingURL=https://example.invalid/app.js.map');
  recover([input], { out: resolve(root, "remote"), mode: "file", level: "minimal" });
  expect(JSON.parse(readFileSync(resolve(root, "remote/recovery.json"), "utf8")).maps).toEqual([]);
});

test("invalid option combinations fail before output creation; parse failures preserve snapshots and diagnostics", () => {
  const root = directory();
  const input = resolve(root, "ordinary.js");
  const out = resolve(root, "recovery");
  writeFileSync(input, 'export const result = 1;');
  expect(() => recover([input], { out, mode: "file", level: "standard", raw: true })).toThrow("--raw");
  expect(() => recover([input], { out, mode: "auto", level: "standard", sourceMap: "unknown.map" })).toThrow("--source-map");
  expect(existsSync(out)).toBe(false);
  writeFileSync(input, 'export const = ;');
  expect(() => recover([input], { out, mode: "strict", level: "standard" })).toThrow("partial evidence");
  const report = JSON.parse(readFileSync(resolve(out, "recovery.json"), "utf8"));
  expect(report.status).toBe("partial");
  expect(readFileSync(resolve(out, report.inputs[0].file), "utf8")).toBe(readFileSync(input, "utf8"));
  expect(report.error).toBeDefined();
});

test("strict mode retains plain JavaScript as a single file without inventing module boundaries", () => {
  const root = directory();
  const input = resolve(root, "ordinary.js");
  writeFileSync(input, 'export const result = 1;');
  const out = resolve(root, "strict");
  recover([input], { out, mode: "strict", level: "minimal" });
  const report = JSON.parse(readFileSync(resolve(out, "recovery.json"), "utf8"));
  expect(report.result.total).toBe(1);
  expect(report.result.detected_formats).toEqual([]);
  expect(moduleIndex(resolve(out, "modules")).modules[0]?.exports).toEqual(["result"]);
  const moved = resolve(root, "moved");
  renameSync(out, moved);
  const provenance = JSON.parse(readFileSync(resolve(moved, "modules/provenance.json"), "utf8"));
  for (const source of Object.values(provenance.modules) as Array<{ input: string }>) expect(existsSync(resolve(moved, "modules", source.input))).toBe(true);
});

test("capture manifests restore URL paths, query variants, extensionless scripts and missing-asset evidence", () => {
  const root = directory();
  const assets = resolve(root, "capture/input/assets");
  mkdirSync(assets, { recursive: true });
  const entries = [
    { path: "input/assets/hash-a.js", url: "https://fixture.test/assets/app.js", code: 'export { value } from "./value.js"; export const lazy = () => import("/assets/lazy.js?v=1");' },
    { path: "input/assets/hash-b.js", url: "https://fixture.test/assets/value.js", code: 'export const value = 42;' },
    { path: "input/assets/hash-c.js", url: "https://fixture.test/assets/lazy.js?v=1", code: 'export const marker = "variant-one";' },
    { path: "input/assets/hash-d.js", url: "https://fixture.test/assets/lazy.js?v=2", code: 'export const marker = "variant-two";' },
    { path: "input/assets/hash-e", url: "https://fixture.test/script", code: 'globalThis.extensionless = true;' },
  ];
  const target = resolve(root, "capture");
  for (const entry of entries) writeFileSync(resolve(target, entry.path), entry.code);
  const manifest = entries.map(({ code, ...asset }) => ({ ...asset, status: "saved", type: "Script" }));
  writeFileSync(resolve(assets, "manifest.json"), JSON.stringify({ version: 1, assets: [...manifest,
    { type: "Script", status: "failed", url: "https://fixture.test/missing.js", path: "input/assets/missing.js" },
    { type: "Image", status: "saved", url: "https://fixture.test/logo.png", path: "input/assets/missing.png" },
  ] }));
  const out = resolve(root, "recovery");
  recover([target], { out, mode: "auto", level: "minimal" });
  const report = JSON.parse(readFileSync(resolve(out, "recovery.json"), "utf8"));
  expect(report.inputs).toHaveLength(5);
  expect(report.warnings).toContain("Captured script unavailable: https://fixture.test/missing.js");
  const index = JSON.parse(readFileSync(resolve(out, "module-index.json"), "utf8"));
  const main = index.modules.find((module: any) => module.file.endsWith("/app.js"));
  expect(main.imports.map((edge: any) => edge.resolution)).toEqual(["internal", "internal"]);
  expect(main.imports[1].target).toContain("lazy~");
  for (const entry of entries) expect(readFileSync(resolve(target, entry.path), "utf8")).toBe(entry.code);
});
