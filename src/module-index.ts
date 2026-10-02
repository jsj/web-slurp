import { parse } from "@babel/parser";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export function javascriptFiles(directory: string, includeComponents = false): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(path, includeComponents));
    else if (entry.isFile() && (/\.(?:[cm]?js|jsx|tsx?)$/.test(entry.name) || (includeComponents && /\.(?:svelte|vue)$/.test(entry.name)))) files.push(path);
  }
  return files;
}

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type Reference = { kind: "import" | "reexport" | "dynamic-import"; specifier: string; target?: string; resolution: "internal" | "missing" | "external" };
export type IndexedModule = {
  file: string; bytes: number; sha256: string; imports: Reference[]; exports: string[];
  language: "javascript" | "svelte" | "vue";
  parseError?: string;
};

// Traverse Babel nodes without interpreting target code or invoking its exports.
function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const child of value) walk(child, visit); return; }
  const node = value as Record<string, unknown>;
  if (typeof node.type !== "string") return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (!["loc", "start", "end", "extra", "comments", "tokens"].includes(key)) walk(child, visit);
  }
}

function name(value: unknown): string | undefined {
  const node = value as { name?: string; value?: string } | null;
  return node?.name ?? node?.value;
}

export function moduleIndex(directory: string, sourceUrls = new Map<string, string>()): { version: 1; modules: IndexedModule[] } {
  const paths = javascriptFiles(directory, true);
  const known = new Set(paths);
  const urlFiles = new Map<string, string[]>();
  for (const [file, url] of sourceUrls) urlFiles.set(url, [...(urlFiles.get(url) ?? []), file]);
  const modules = paths.map(path => {
    const bytes = readFileSync(path);
    const language = path.endsWith(".svelte") ? "svelte" : path.endsWith(".vue") ? "vue" : "javascript";
    const module: IndexedModule = { file: relative(directory, path), bytes: bytes.length, sha256: sha256(bytes), language, imports: [], exports: [] };
    if (language !== "javascript") return module;
    try {
      const ast = parse(bytes.toString("utf8"), {
        sourceType: "unambiguous", createImportExpressions: true,
        plugins: ["jsx", ...( /\.[cm]?tsx?$/.test(path) ? ["typescript" as const] : [])],
      });
      walk(ast, node => {
        let kind: Reference["kind"] | undefined;
        if (node.type === "ImportDeclaration") kind = "import";
        if (node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") kind = "reexport";
        if (node.type === "ImportExpression") kind = "dynamic-import";
        const source = node.source as { type?: string; value?: string } | undefined;
        if (kind && source?.type === "StringLiteral" && typeof source.value === "string") {
          const specifier = source.value;
          const reference: Reference = { kind, specifier, resolution: "external" };
          if (specifier.startsWith("./") || specifier.startsWith("../")) {
            const base = resolve(dirname(path), specifier);
            const target = [base, ...[".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].map(extension => base + extension), resolve(base, "index.js")].find(candidate => known.has(candidate));
            reference.resolution = target ? "internal" : "missing";
            if (target) reference.target = relative(directory, target);
          }
          const sourceUrl = sourceUrls.get(relative(directory, path));
          if (reference.resolution !== "internal" && sourceUrl && /^(?:\.{1,2}\/|\/|https?:\/\/)/.test(specifier)) {
            const targets = urlFiles.get(new URL(specifier, sourceUrl).href);
            // A whole captured native chunk has a unique target. A split
            // bundle can have many modules for one URL; do not guess an entry.
            if (targets?.length === 1) { reference.resolution = "internal"; reference.target = targets[0]; }
          }
          module.imports.push(reference);
        }
        if (node.type === "ExportDefaultDeclaration") module.exports.push("default");
        if (node.type === "ExportAllDeclaration") module.exports.push(name(node.exported) ?? "*");
        if (node.type === "ExportNamedDeclaration") {
          for (const specifier of (node.specifiers ?? []) as Array<{ exported?: unknown }>) {
            const exported = name(specifier.exported);
            if (exported) module.exports.push(exported);
          }
          const declaration = node.declaration as Record<string, unknown> | undefined;
          if (declaration) {
            const id = name(declaration.id);
            if (id) module.exports.push(id);
            for (const binding of (declaration.declarations ?? []) as Array<{ id?: unknown }>) {
              // Binding patterns contain identifiers, including aliased object values.
              const collect = (value: unknown): void => {
                if (!value || typeof value !== "object") return;
                const pattern = value as Record<string, unknown>;
                if (pattern.type === "Identifier" && typeof pattern.name === "string") module.exports.push(pattern.name);
                else if (pattern.type === "ObjectPattern") for (const property of pattern.properties as Array<Record<string, unknown>>) collect(property.type === "RestElement" ? property.argument : property.value);
                else if (pattern.type === "ArrayPattern") for (const element of pattern.elements as unknown[]) collect(element);
                else if (pattern.type === "RestElement") collect(pattern.argument);
                else if (pattern.type === "AssignmentPattern") collect(pattern.left);
              };
              collect(binding.id);
            }
          }
        }
      });
      module.exports = [...new Set(module.exports)].sort();
    } catch (error) {
      module.parseError = error instanceof Error ? error.message : String(error);
    }
    return module;
  });
  return { version: 1, modules };
}
