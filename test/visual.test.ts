import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { compareImages } from '../src/visual';
import { startReplay } from '../src/commands/serve';

async function cli(args: string[]) {
  const child = Bun.spawn(['bun', resolve(import.meta.dir, '../src/cli.ts'), ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw new Error(`CLI failed (${code}): ${stderr}\n${stdout}`);
}

test('pixel comparison reports changed areas and handles size differences', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-diff-'));
  try {
    const reference = new PNG({ width: 20, height: 20 });
    reference.data.fill(255);
    const original = resolve(root, 'original.png');
    writeFileSync(original, PNG.sync.write(reference));
    expect(compareImages(original, original, resolve(root, 'identical')).changedPixels).toBe(0);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) {
      const offset = (y * 20 + x) * 4;
      reference.data[offset] = reference.data[offset + 1] = reference.data[offset + 2] = 0;
    }
    const changed = resolve(root, 'changed.png');
    writeFileSync(changed, PNG.sync.write(reference));
    const result = compareImages(original, changed, resolve(root, 'different'));
    expect(result.changedPixels).toBeGreaterThan(50);
    expect(result.largestRegions[0]!.x).toBeGreaterThanOrEqual(10);
    const small = resolve(root, 'small.png');
    const resized = new PNG({ width: 10, height: 10 }); resized.data.fill(0);
    writeFileSync(small, PNG.sync.write(resized));
    expect(compareImages(original, small, resolve(root, 'resized')).actual.width).toBe(10);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('responsive capture, offline CDN replay, and clone comparison use matching viewports', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-responsive-'));
  let requests = 0;
  const png = new PNG({ width: 24, height: 24 }); png.data.fill(255);
  const imageBytes = PNG.sync.write(png);
  const cdn = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests++;
    return new URL(request.url).pathname.endsWith('.css')
      ? new Response('body{margin:0;background:#eef0f4;font-family:Arial} .card{background:white;margin:24px;padding:24px;border:1px solid #ddd} .logo{width:24px;height:24px;background:url("./logo.png")} @media(max-width:600px){.card{margin:12px}}', { headers: { 'content-type': 'text/css' } })
      : new Response(new Uint8Array(imageBytes), { headers: { 'content-type': 'image/png' } });
  } });
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${cdn.url}assets/main.css"><style>.embedded{background:url("${cdn.url}assets/logo.png")}</style></head><body><div class="card" id="ready"><div class="logo embedded"></div><h1>Reference fixture</h1><p>Capture a design. Inspect the evidence.</p><img src="${cdn.url}assets/logo.png"></div></body></html>`, { headers: { 'content-type': 'text/html' } });
  } });
  let replay: ReturnType<typeof startReplay> | undefined;
  try {
    await expect(cli(['capture', site.url.href, '--out', resolve(root, 'invalid-viewport'), '--viewport', 'bad'])).rejects.toThrow('Viewport');
    expect(existsSync(resolve(root, 'invalid-viewport/.capture-lock'))).toBe(false);
    await cli(['capture-responsive', site.url.href, '--out', resolve(root, 'reference'), '--wait-for', '#ready']);
    const reference = resolve(root, 'reference/desktop');
    expect(PNG.sync.read(readFileSync(resolve(reference, 'input/page-source/page.png'))).width).toBe(1440);
    expect(PNG.sync.read(readFileSync(resolve(root, 'reference/mobile/input/page-source/page.png'))).width).toBe(390);
    const manifest = JSON.parse(readFileSync(resolve(reference, 'input/assets/manifest.json'), 'utf8'));
    expect(manifest.assets.some((asset: { type: string; status: string }) => asset.type === 'Image' && asset.status === 'saved')).toBe(true);
    const beforeReplay = requests;
    site.stop(true); cdn.stop(true);
    await cli(['styles', reference]);
    const styles = JSON.parse(readFileSync(resolve(reference, 'output/style-inventory/stylesheets.json'), 'utf8'));
    expect(styles.downloads.some((source: { status: string }) => source.status === 'existing')).toBe(true);
    replay = startReplay(reference, { host: '127.0.0.1', port: 0 });
    const html = await (await fetch(replay.url)).text();
    expect(html).toContain('/_web-slurp/');
    const cssUrl = /href="([^" ]+main\.css)"/.exec(html)![1]!;
    const cssResponse = await fetch(new URL(cssUrl, replay.url));
    expect(cssResponse.status).toBe(200);
    const css = await cssResponse.text();
    const imageUrl = /url\("([^" ]+)"\)/.exec(css)![1]!;
    expect(new Uint8Array(await (await fetch(new URL(imageUrl, replay.url))).arrayBuffer())).toEqual(new Uint8Array(imageBytes));
    await cli(['compare', reference, replay.url.href, '--out', resolve(root, 'comparison'), '--wait-for', '#ready']);
    const comparison = JSON.parse(readFileSync(resolve(root, 'comparison/output/comparison.json'), 'utf8'));
    expect(comparison.actual.width).toBe(comparison.reference.width);
    expect(comparison.changedPercent).toBeLessThan(0.5);
    const retina = resolve(root, 'retina');
    await cli(['capture', replay.url.href, '--out', retina, '--viewport', '320x240', '--device-scale-factor', '2', '--wait-for', '#ready']);
    await cli(['compare', retina, replay.url.href, '--out', resolve(root, 'retina-comparison'), '--wait-for', '#ready']);
    const retinaComparison = JSON.parse(readFileSync(resolve(root, 'retina-comparison/output/comparison.json'), 'utf8'));
    expect(retinaComparison.reference.width).toBe(640);
    expect(retinaComparison.actual.width).toBe(640);
    expect(retinaComparison.changedPercent).toBeLessThan(0.5);
    expect(requests).toBe(beforeReplay);
    if (process.env.WEB_SLURP_KEEP_FIXTURE) console.log(`Visual fixture: ${root}`);
  } finally {
    replay?.server.stop(true); site.stop(true); cdn.stop(true);
    if (!process.env.WEB_SLURP_KEEP_FIXTURE) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
