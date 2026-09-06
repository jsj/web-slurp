import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { collectAssets } from '../src/assets';
import { closeBrowser, ensureBrowser } from '../src/commands/browser';
import { cdpCall, evaluate, pageTargets } from '../src/cdp';

test('collects loaded static bytes and dynamic modules without collecting API responses or requesting new URLs', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-assets-'));
  const previous = process.env.WEB_SLURP_PROFILE_ROOT;
  process.env.WEB_SLURP_PROFILE_ROOT = resolve(root, 'profiles');
  const requests: string[] = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const url = new URL(request.url); requests.push(url.pathname + url.search);
    if (url.pathname === '/') return new Response(`<html><head><link rel="stylesheet" href="/style.css?v=1"><link rel="stylesheet" href="/style.css?v=2"></head><body><img src="/image.png"><script type="module">await import('/dynamic.js'); await fetch('/api'); window.fixtureReady = true;</script></body></html>`, { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/style.css') return new Response(`body { --version: ${url.searchParams.get('v')}; }`, { headers: { 'content-type': 'text/css' } });
    if (url.pathname === '/image.png') return new Response(png, { headers: { 'content-type': 'image/png' } });
    if (url.pathname === '/dynamic.js') return new Response('export const loaded = true;', { headers: { 'content-type': 'text/javascript' } });
    if (url.pathname === '/api') return Response.json({ privateData: 'excluded' });
    return new Response('missing', { status: 404 });
  } });
  try {
    const browser = await ensureBrowser('assets-fixture', true);
    const { targetId } = await cdpCall<{ targetId: string }>(browser.websocketUrl, 'Target.createTarget', { url: server.url.href });
    const page = (await pageTargets(browser.endpoint)).find(page => page.id === targetId)!;
    const deadline = Date.now() + 15000;
    while (!await evaluate<boolean>(page.webSocketDebuggerUrl!, 'window.fixtureReady === true && document.readyState === "complete"')) {
      if (Date.now() > deadline) throw new Error('Fixture timeout');
      await Bun.sleep(100);
    }
    const before = new Set(requests.filter(path => path !== '/favicon.ico'));
    const manifest = await collectAssets(page.webSocketDebuggerUrl!, root);
    expect(new Set(requests.filter(path => path !== '/favicon.ico'))).toEqual(before);
    expect(manifest.assets.some(asset => asset.url.endsWith('/api'))).toBe(false);
    expect(manifest.assets.some(asset => asset.url === server.url.href)).toBe(false);
    const styles = manifest.assets.filter(asset => asset.type === 'Stylesheet');
    expect(styles.length).toBe(2);
    expect(styles[0]!.path).not.toBe(styles[1]!.path);
    for (const style of styles) expect(readFileSync(resolve(root, style.path), 'utf8')).toContain(`--version: ${new URL(style.url).searchParams.get('v')}`);
    const image = manifest.assets.find(asset => asset.url.endsWith('/image.png'))!;
    expect(image.status).toBe('saved');
    expect(readFileSync(resolve(root, image.path))).toEqual(png);
    const module = manifest.assets.find(asset => asset.url.endsWith('/dynamic.js'))!;
    expect(module.status).toBe('saved');
    expect(readFileSync(resolve(root, module.path), 'utf8')).toContain('export const loaded');
    expect(JSON.parse(readFileSync(resolve(root, 'input/assets/manifest.json'), 'utf8'))).toEqual(manifest);
  } finally {
    await closeBrowser('assets-fixture'); server.stop(true);
    if (previous === undefined) delete process.env.WEB_SLURP_PROFILE_ROOT; else process.env.WEB_SLURP_PROFILE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('records unavailable browser resources instead of silently omitting them', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-assets-failed-'));
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request, server) {
    if (server.upgrade(request)) return;
    return new Response('WebSocket required', { status: 400 });
  }, websocket: { message(socket, raw) {
    const request = JSON.parse(String(raw));
    const result = request.method === 'Page.getResourceTree' ? { frameTree: { frame: { id: 'fixture' }, resources: [
      { url: 'https://fixture.test/font.woff2', mimeType: 'font/woff2', type: 'Font' },
      { url: 'https://fixture.test/private', mimeType: 'application/json', type: 'Fetch' },
    ] } } : {};
    socket.send(JSON.stringify(request.method === 'Page.getResourceContent'
      ? { id: request.id, error: { message: 'Resource evicted' } }
      : { id: request.id, result }));
  } } });
  try {
    const manifest = await collectAssets(server.url.href.replace('http:', 'ws:'), root);
    expect(manifest.assets.length).toBe(1);
    expect(manifest.assets[0]!.status).toBe('failed');
    expect(manifest.assets[0]!.error).toContain('Resource evicted');
    expect(JSON.parse(readFileSync(resolve(root, 'input/assets/manifest.json'), 'utf8'))).toEqual(manifest);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
