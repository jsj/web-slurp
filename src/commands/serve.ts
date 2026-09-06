import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { AssetManifest } from "../assets";
import { absolute, requireFile } from "../harness";

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
};

export function startReplay(targetInput: string, options: { host: string; port: number; liveAssets?: boolean }) {
  const target = absolute(targetInput);
  const metadataPath = resolve(target, 'input/page-source/capture-metadata.json');
  requireFile(metadataPath);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { url?: string; source?: string; baseUrl?: string };
  if (!metadata.url) throw new Error('Capture metadata does not contain the final page URL.');
  const capturedUrl = new URL(metadata.url);
  if (!['http:', 'https:'].includes(capturedUrl.protocol)) throw new Error('Capture source must use HTTP or HTTPS.');
  const htmlPath = resolve(target, 'input/page-source', metadata.source === 'chrome-cdp' ? 'cdp.rendered.html' : 'codex.rendered.html');
  requireFile(htmlPath);
  const cache = resolve(target, 'output/replay-cache-v2');
  mkdirSync(cache, { recursive: true });
  const manifestPath = resolve(target, 'input/assets/manifest.json');
  const manifest: AssetManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { version: 1, assets: [] };
  const route = (url: URL) => (url.origin === capturedUrl.origin ? '' : `/_web-slurp/${Buffer.from(url.origin).toString('base64url')}`) + url.pathname + url.search;
  const assets = new Map(manifest.assets.filter(asset => asset.status === 'saved' && /^input\/assets\/[a-f0-9]{64}(?:\.[a-zA-Z0-9]{1,10})?$/.test(asset.path)).map(asset => [route(new URL(asset.url)), asset]));
  const localUrl = (value: string, base: string): string => {
    if (!value || value.startsWith('#') || /^(data|blob):/i.test(value)) return value;
    try {
      const url = new URL(value, base);
      const path = route(url);
      return assets.has(path) || url.origin === capturedUrl.origin ? path + url.hash : url.href;
    } catch { return value; }
  };
  const css = (value: string, base: string) => value
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi, (_match, double, single, bare) => `url(${JSON.stringify(localUrl(double ?? single ?? bare, base))})`)
    .replace(/@import\s+(["'])(.*?)\1/gi, (_match, _quote, url) => `@import ${JSON.stringify(localUrl(url, base))}`);
  const documentBase = metadata.baseUrl ?? capturedUrl.href;
  let styleText = "";
  const basePath = capturedUrl.pathname.replace(/[^/]*$/, '');
  const html = new HTMLRewriter()
    .on('base', { element(element) { element.remove(); } })
    .on('meta[http-equiv="content-security-policy"]', { element(element) { element.remove(); } })
    .on('head', { element(element) { element.prepend(`<base href="${basePath}">`, { html: true }); } })
    .on('style', { text(chunk) {
      styleText += chunk.text;
      if (chunk.lastInTextNode) { chunk.replace(css(styleText, documentBase), { html: true }); styleText = ''; }
      else chunk.remove();
    } })
    .on('*', { element(element) {
      for (const name of ['src', 'href', 'poster']) {
        const value = element.getAttribute(name);
        if (value) element.setAttribute(name, localUrl(value, documentBase));
      }
      const srcset = element.getAttribute('srcset');
      if (srcset && !srcset.includes('data:')) element.setAttribute('srcset', srcset.split(/,\s*/).map(candidate => {
        const [url, ...descriptor] = candidate.trim().split(/\s+/);
        return [localUrl(url ?? '', documentBase), ...descriptor].join(' ');
      }).join(', '));
      const style = element.getAttribute('style');
      if (style) element.setAttribute('style', css(style, documentBase));
      // Assets are now served locally; origin-specific integrity/CORS no longer applies.
      element.removeAttribute('crossorigin');
      element.removeAttribute('integrity');
    } })
    .transform(new Response(readFileSync(htmlPath, 'utf8'))).text();
  // The header also blocks absolute third-party URLs embedded in captured scripts/CSS.
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; sandbox allow-scripts allow-same-origin",
  };
  const server = Bun.serve({
    hostname: options.host, port: options.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Replay is read-only.\n', { status: 405 });
      if (['/', '/index.html', capturedUrl.pathname].includes(url.pathname)) {
        return new Response(request.method === 'HEAD' ? null : await html, { headers });
      }
      const asset = assets.get(url.pathname + url.search);
      if (asset) {
        const path = resolve(target, asset.path);
        if (!existsSync(path)) return new Response('Captured asset is missing.\n', { status: 404 });
        const body = asset.type === 'Stylesheet' ? css(readFileSync(path, 'utf8'), asset.url) : Bun.file(path);
        return new Response(request.method === 'HEAD' ? null : body, { headers: { 'content-type': asset.mimeType } });
      }
      if (url.pathname.startsWith('/_web-slurp/')) return new Response('CDN asset was not captured.\n', { status: 404 });
      const type = contentTypes[extname(url.pathname).toLowerCase()];
      if (!type) return new Response('Only static asset paths are supported.\n', { status: 403 });
      const upstream = new URL(capturedUrl.origin);
      upstream.pathname = url.pathname;
      upstream.search = url.search;
      const key = createHash('sha256').update(upstream.href).digest('hex');
      const cachePath = resolve(cache, key);
      if (existsSync(cachePath)) return new Response(request.method === 'HEAD' ? null : Bun.file(cachePath), { headers: { 'content-type': type } });
      if (!options.liveAssets) return new Response('Asset is not cached. Use --live-assets to fetch it from the source.\n', { status: 404 });
      const response = await fetch(upstream, {
        headers: { referer: capturedUrl.href }, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return new Response(`Asset fetch failed: HTTP ${response.status}\n`, { status: 502 });
      const body = new Uint8Array(await response.arrayBuffer());
      writeFileSync(cachePath, body);
      return new Response(request.method === 'HEAD' ? null : body, { headers: { 'content-type': type } });
    },
  });
  const url = new URL(server.url);
  url.pathname = capturedUrl.pathname;
  url.search = capturedUrl.search;
  url.hash = capturedUrl.hash;
  return { server, url };
}

export async function serve(targetInput: string, options: { host: string; port: number; liveAssets?: boolean }): Promise<void> {
  const replay = startReplay(targetInput, options);
  console.log(`Replay: ${replay.url}\nMode: ${options.liveAssets ? 'live same-origin static assets' : 'offline (cached assets only)'}`);
  await new Promise(() => {});
}
