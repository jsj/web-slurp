import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { absolute, requireFile } from "../harness";

type CaptureMetadata = { url?: string };

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function capturedHtml(target: string): string {
  const cdp = resolve(target, "input/page-source/cdp.rendered.html");
  const headless = resolve(target, "input/page-source/codex.rendered.html");
  const html = existsSync(cdp) ? cdp : headless;
  requireFile(html);
  return html;
}

function replayHtml(htmlPath: string, origin: string): string {
  const html = readFileSync(htmlPath, "utf8");
  return html
    .replace(/<base\b[^>]*>/i, '<base href="/">')
    .replace(/<meta\b[^>]*http-equiv=["']content-security-policy["'][^>]*>/gi, "")
    .replaceAll(`${origin}/`, "/");
}

function safeCachePath(cache: string, pathname: string): string {
  const normalized = pathname.split("/").filter((part) => part && part !== "." && part !== "..");
  return resolve(cache, ...normalized);
}

export async function serve(targetInput: string, options: { host: string; port: number }): Promise<void> {
  const target = absolute(targetInput);
  const htmlPath = capturedHtml(target);
  const metadataPath = resolve(target, "input/page-source/capture-metadata.json");
  requireFile(metadataPath);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as CaptureMetadata;
  const sourceUrl = metadata.url;
  if (!sourceUrl) throw new Error("Capture metadata does not contain the final page URL.");
  const capturedUrl = new URL(sourceUrl);
  const origin = capturedUrl.origin;
  const cache = resolve(target, "output/replay-cache");
  mkdirSync(cache, { recursive: true });
  const html = replayHtml(htmlPath, origin);
  const capturedPathname = capturedUrl.pathname;

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Replay server is read-only.\n", { status: 405 });
      if (
        url.pathname === "/" ||
        url.pathname === "/index.html" ||
        url.pathname === capturedPathname
      ) {
        return new Response(request.method === "HEAD" ? null : html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      const cachePath = safeCachePath(cache, url.pathname);
      if (existsSync(cachePath)) {
        return new Response(request.method === "HEAD" ? null : Bun.file(cachePath), { headers: { "content-type": contentTypes[extname(cachePath)] ?? "application/octet-stream" } });
      }

      const upstream = new URL(`${url.pathname}${url.search}`, origin);
      const response = await fetch(upstream, { headers: { referer: sourceUrl } });
      if (!response.ok) return new Response(`Static asset fetch failed with HTTP ${response.status}.\n`, { status: response.status });
      const body = await response.arrayBuffer();
      mkdirSync(resolve(cachePath, ".."), { recursive: true });
      writeFileSync(cachePath, new Uint8Array(body));
      return new Response(request.method === "HEAD" ? null : body, { headers: { "content-type": response.headers.get("content-type") ?? contentTypes[extname(cachePath)] ?? "application/octet-stream" } });
    },
  });

  const replayUrl = new URL(sourceUrl);
  replayUrl.protocol = "http:";
  replayUrl.hostname = options.host;
  replayUrl.port = String(server.port);
  console.log(`Replay: ${replayUrl.toString()}`);
  console.log(`Source: ${sourceUrl}`);
  console.log(`Cache: ${cache}`);
  await new Promise(() => {});
}
