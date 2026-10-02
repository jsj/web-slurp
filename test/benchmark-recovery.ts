import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { absolute } from "../src/harness";
import { recover } from "../src/commands/recover";
import { moduleIndex } from "../src/module-index";
import { buildRecoveryFixture, recoveryBuilds } from "./fixtures/recovery-builds";

const options = new Command().requiredOption("--out <path>", "Fresh directory for fixtures and recovery evidence").parse().opts<{ out: string }>();
const root = absolute(options.out);
if (existsSync(root)) throw new Error(`Benchmark output already exists: ${root}`);
mkdirSync(root, { recursive: true });
const results: Array<Record<string, unknown>> = [];
for (const build of recoveryBuilds) {
  const fixture = resolve(root, build);
  const input = await buildRecoveryFixture(fixture, build);
  const output = resolve(fixture, "recovery");
  const start = performance.now();
  try {
    recover([input], { out: output, mode: "auto", level: "standard" });
    const report = JSON.parse(readFileSync(resolve(output, "recovery.json"), "utf8"));
    const index = moduleIndex(resolve(output, "modules"));
    const sources = moduleIndex(resolve(output, "sources"));
    const code = index.modules.map(module => readFileSync(resolve(output, "modules", module.file), "utf8")).join("\n");
    const missing = index.modules.flatMap(module => module.imports).filter(edge => edge.resolution === "missing").length;
    const jsx = build === "vite-svelte" ? null : code.includes("<section");
    const markers = code.includes("calculate") && code.includes("lazy-recovery-marker");
    const sourceRecovery = sources.modules.length > 0;
    const passed = report.status === "complete" && markers && sourceRecovery && jsx !== false && index.modules.every(module => !module.parseError) && missing === 0;
    results.push({ build, passed, engine: report.engine, formats: report.result.detected_formats,
      modules: index.modules.length, originals: sources.modules.length, jsx, missingImports: missing,
      recoveryMs: Math.round(performance.now() - start), engineMs: report.result.elapsed_ms });
  } catch (error) {
    results.push({ build, passed: false, error: error instanceof Error ? error.message : String(error) });
  }
  writeFileSync(resolve(root, "results.json"), JSON.stringify({ version: 1, note: "Small compiler fixtures; this does not measure arbitrary-site reconstruction or execution parity.", results }, null, 2) + "\n");
}
console.table(results);
if (results.some(result => !result.passed)) process.exitCode = 1;
