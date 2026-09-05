import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { agentBrowserCli, agentBrowserEnv } from "../agent-browser";
import { absolute, harnessScript, requireFile, run } from "../harness";

type AgentBrowserEvaluation<T> = {
  success: boolean;
  data?: { result?: T };
  error?: { message?: string } | null;
};

function agentBrowser(args: string[], input?: string): string {
  const result = spawnSync("bun", [agentBrowserCli, ...args], {
    encoding: "utf8",
    env: agentBrowserEnv(),
    input,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `agent-browser failed with exit code ${result.status ?? "unknown"}`);
  }
  return result.stdout;
}

export async function capture(url: string, targetInput: string): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Capture URL must use HTTP or HTTPS.");
  const target = absolute(targetInput);
  const pageSource = resolve(target, "input/page-source");
  const bundles = resolve(target, "input/bundles");
  mkdirSync(pageSource, { recursive: true });
  mkdirSync(bundles, { recursive: true });

  const session = `web-slurp-${process.pid}-${Date.now()}`;
  try {
    agentBrowser(["--session", session, "open", parsed.toString()]);
    agentBrowser(["--session", session, "wait", "5000"]);
    const response = JSON.parse(agentBrowser(
      ["--session", session, "eval", "--stdin", "--json"],
      `(() => {
        const documentClone = document.documentElement.cloneNode(true);
        const base = document.createElement('base');
        base.href = location.href;
        documentClone.querySelector('head')?.prepend(base);
        documentClone.querySelectorAll('[crossorigin]').forEach((node) => node.removeAttribute('crossorigin'));
        return {
        capturedAt: new Date().toISOString(),
        html: '<!doctype html>\\n' + documentClone.outerHTML,
        scripts: [...new Set([...document.scripts].map((node) => node.src).filter(Boolean))],
        stylesheets: [...new Set([...document.querySelectorAll('link[rel="stylesheet"]')].map((node) => node.href).filter(Boolean))],
        title: document.title,
        url: location.href
        };
      })()`,
    )) as AgentBrowserEvaluation<CdpCapture>;
    const capture = response.data?.result;
    if (!response.success || !capture) {
      throw new Error(response.error?.message ?? "agent-browser returned no rendered page data.");
    }
    const htmlPath = resolve(pageSource, "codex.rendered.html");
    writeFileSync(htmlPath, capture.html);
    writeFileSync(resolve(pageSource, "capture-metadata.json"), `${JSON.stringify({
      capturedAt: capture.capturedAt,
      scriptCount: capture.scripts.length,
      stylesheetCount: capture.stylesheets.length,
      title: capture.title,
      url: capture.url,
      source: "agent-browser",
    }, null, 2)}\n`);
    writeFileSync(resolve(bundles, "script-urls.txt"), `${capture.scripts.join("\n")}\n`);
    writeFileSync(resolve(bundles, "stylesheet-urls.txt"), `${capture.stylesheets.join("\n")}\n`);
    console.log(`Navigated: ${capture.url}`);
    console.log(`Saved HTML: ${htmlPath}`);
    console.log(`Saved script list: ${resolve(bundles, "script-urls.txt")}`);
    console.log(`Scripts found: ${capture.scripts.length}`);
  } finally {
    agentBrowser(["--session", session, "close"]);
  }
}

export function download(urlListInput: string, outdirInput: string, referer: string, cdp: string): void {
  const urls = absolute(urlListInput);
  const outdir = absolute(outdirInput);
  requireFile(urls);
  run("python3", [
    harnessScript("cdp_download_urls.py"),
    urls,
    outdir,
    "--referer",
    new URL(referer).toString(),
    "--cdp",
    cdp,
  ]);
}

type CdpTarget = {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

type CdpCapture = {
  capturedAt: string;
  html: string;
  scripts: string[];
  stylesheets: string[];
  title: string;
  url: string;
};

async function evaluate<T>(webSocketUrl: string, expression: string): Promise<T> {
  return await new Promise<T>((resolveResult, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out while reading the Chrome page through CDP."));
    }, 15_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        error?: { message?: string };
        result?: { exceptionDetails?: unknown; result?: { value?: T } };
      };
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(message.error?.message ?? "Chrome could not evaluate the capture expression."));
        return;
      }
      const value = message.result?.result?.value;
      if (value === undefined) reject(new Error("Chrome returned no rendered page data."));
      else resolveResult(value);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`Could not connect to Chrome page at ${webSocketUrl}`));
    });
  });
}

export async function captureCdp(targetInput: string, pageUrl: string | undefined, cdp: string): Promise<void> {
  const target = absolute(targetInput);
  const endpoint = new URL(cdp);
  const targetsResponse = await fetch(new URL("/json/list", endpoint));
  if (!targetsResponse.ok) throw new Error(`CDP target discovery failed with HTTP ${targetsResponse.status}.`);
  const targets = await targetsResponse.json() as CdpTarget[];
  const pages = targets.filter((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
  const page = pageUrl
    ? pages.find((candidate) => candidate.url === pageUrl || candidate.url.startsWith(pageUrl))
    : pages[0];
  if (!page?.webSocketDebuggerUrl) {
    const available = pages.map((candidate) => candidate.url).join(", ") || "none";
    throw new Error(`No matching Chrome page found. Available page URLs: ${available}`);
  }

  const capture = await evaluate<CdpCapture>(page.webSocketDebuggerUrl, `(() => {
    const documentClone = document.documentElement.cloneNode(true);
    const base = document.createElement('base');
    base.href = location.href;
    documentClone.querySelector('head')?.prepend(base);
    documentClone.querySelectorAll('[crossorigin]').forEach((node) => node.removeAttribute('crossorigin'));
    return {
      capturedAt: new Date().toISOString(),
      html: '<!doctype html>\\n' + documentClone.outerHTML,
      scripts: [...new Set([...document.scripts].map((node) => node.src).filter(Boolean))],
      stylesheets: [...new Set([...document.querySelectorAll('link[rel="stylesheet"]')].map((node) => node.href).filter(Boolean))],
      title: document.title,
      url: location.href
    };
  })()`);

  const pageSource = resolve(target, "input/page-source");
  const bundles = resolve(target, "input/bundles");
  mkdirSync(pageSource, { recursive: true });
  mkdirSync(bundles, { recursive: true });
  writeFileSync(resolve(pageSource, "cdp.rendered.html"), capture.html);
  writeFileSync(resolve(pageSource, "capture-metadata.json"), `${JSON.stringify({
    capturedAt: capture.capturedAt,
    scriptCount: capture.scripts.length,
    stylesheetCount: capture.stylesheets.length,
    title: capture.title,
    url: capture.url,
    source: "chrome-cdp",
  }, null, 2)}\n`);
  writeFileSync(resolve(bundles, "script-urls.txt"), `${capture.scripts.join("\n")}\n`);
  writeFileSync(resolve(bundles, "stylesheet-urls.txt"), `${capture.stylesheets.join("\n")}\n`);
  console.log(`${capture.url}\n${resolve(pageSource, "cdp.rendered.html")}`);
}
