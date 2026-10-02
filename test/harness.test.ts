import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { agentBrowserCli, agentBrowserEnv } from "../src/agent-browser";
import { absolute, detectFormat, findHarness } from "../src/harness";
import { split } from "../src/commands/bundles";

describe("harness utilities", () => {
  test("expands home-relative paths", () => {
    expect(absolute("~/capture")).toEndWith("/capture");
    expect(absolute("~/capture")).not.toContain("~");
  });

  test("detects webpack and Turbopack wrappers", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "web-slurp-formats-"));
    const webpack = resolve(directory, "webpack.js");
    const turbopack = resolve(directory, "turbopack.js");
    writeFileSync(webpack, "self.webpackChunk.push([[1], { 12: () => {} }]);");
    writeFileSync(turbopack, "globalThis.TURBOPACK = globalThis.TURBOPACK || [];");
    expect(detectFormat(webpack)).toBe("webpack");
    expect(detectFormat(turbopack)).toBe("turbopack");
  });

  test("uses the harness bundled with the skill", () => {
    expect(findHarness()).toBe(resolve(import.meta.dir, "../harness"));
  });

  test("auto split rejects unknown inputs without changing input or creating output", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "web-slurp-unknown-"));
    try {
      const input = resolve(directory, "app.js");
      const output = resolve(directory, "modules");
      for (const source of [
        'export const greet = () => "hello";',
        'globalThis.queue.push(["ordinary data"]);',
        'import { mount } from "./vendor.js"; mount(document.body);',
      ]) {
        writeFileSync(input, source);
        expect(detectFormat(input)).toBeUndefined();
        expect(() => split(input, output, "auto")).toThrow("Bundle format not recognized");
        expect(existsSync(output)).toBe(false);
        expect(readFileSync(input, "utf8")).toBe(source);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("isolates the bundled agent-browser daemon", () => {
    expect(agentBrowserCli).toBe(resolve(import.meta.dir, "../node_modules/agent-browser/bin/agent-browser.js"));
    expect(agentBrowserEnv().AGENT_BROWSER_SOCKET_DIR).toContain("ws-ab-");
  });
});
