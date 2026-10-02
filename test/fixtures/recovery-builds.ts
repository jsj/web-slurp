import { build as esbuild } from "esbuild";
import { rollup } from "rollup";
import { compile } from "svelte/compiler";
import { build as vite } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const recoveryBuilds = ["webpack-react", "rspack-react", "rollup-react", "vite-react", "esbuild-react", "bun-react", "vite-svelte"] as const;
export type RecoveryBuild = typeof recoveryBuilds[number];

export async function buildRecoveryFixture(root: string, kind: RecoveryBuild): Promise<string> {
  const source = resolve(root, "src");
  const dist = resolve(root, "dist");
  mkdirSync(source, { recursive: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(resolve(source, "math.js"), "export const calculate = value => value * 3 + 1;\n");
  writeFileSync(resolve(source, "lazy.js"), "export const message = 'lazy-recovery-marker';\n");
  const entry = resolve(source, "app.js");
  if (kind === "vite-svelte") {
    const component = '<script>let count = $state(0);</script><button onclick={() => count++}>Captured Svelte: {count}</button>';
    const filename = resolve(source, "App.svelte");
    writeFileSync(filename, component);
    writeFileSync(entry, 'export { default as App } from "./App.svelte"; export { calculate } from "./math.js"; export const load = () => import("./lazy.js");\n');
  } else {
    writeFileSync(entry, 'import { createElement } from "react"; export function App() { return createElement("section", { className: "recovered-app" }, "Captured React"); } export { calculate } from "./math.js"; export const load = () => import("./lazy.js");\n');
  }
  const output = resolve(dist, "app.js");
  if (kind === "esbuild-react") {
    await esbuild({ entryPoints: [entry], outfile: output, bundle: true, minify: true, sourcemap: true, format: "cjs", target: "es2015", external: ["react"] });
  } else if (kind === "bun-react") {
    const result = await Bun.build({ entrypoints: [entry], outdir: dist, naming: "app.js", target: "browser", minify: true, sourcemap: "external", external: ["react"] });
    if (!result.success) throw new Error(result.logs.join("\n"));
  } else if (kind === "rollup-react") {
    const bundle = await rollup({ input: entry, external: ["react"] });
    try { await bundle.write({ dir: dist, format: "es", sourcemap: true }); }
    finally { await bundle.close(); }
  } else if (kind.startsWith("vite-")) {
    await vite({ configFile: false, root, logLevel: "silent", plugins: [{ name: "svelte-fixture", enforce: "pre", transform(code, id) {
      if (!id.endsWith(".svelte")) return;
      const compiled = compile(code, { filename: id, generate: "client", dev: false });
      return { code: compiled.js.code, map: JSON.parse(compiled.js.map!.toString()) };
    } }], build: {
      outDir: dist, sourcemap: true, minify: true, lib: { entry, formats: ["es"], fileName: "app" },
      rollupOptions: { external: [/^react(?:\/|$)/, /^svelte(?:\/|$)/] },
    } });
  } else {
    const webpack = (await import("webpack")).default;
    const { rspack } = await import("@rspack/core");
    const config = {
      mode: "production" as const, context: root, entry, devtool: "source-map" as const,
      output: { path: dist, filename: "app.js", library: { type: "commonjs2" } },
      externals: { react: "commonjs react" }, optimization: { minimize: true },
    };
    await new Promise<void>((accept, reject) => {
      const compiler = kind === "webpack-react" ? webpack(config) : rspack(config);
      compiler.run((error, stats) => {
        compiler.close(closeError => {
          if (error || closeError || stats?.hasErrors()) reject(error ?? closeError ?? new Error(stats?.toString({ all: false, errors: true })));
          else accept();
        });
      });
    });
  }
  return dist;
}
