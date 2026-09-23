import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { register, uninstall } from '../src/commands/setup';
import { startReplay } from '../src/commands/serve';
import { beautify } from '../src/commands/bundles';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function temporary() {
  const path = mkdtempSync(resolve(tmpdir(), 'web-slurp-test-'));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function cli(args: string[]) {
  const child = Bun.spawn(['bun', resolve(import.meta.dir, '../src/cli.ts'), ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test('registration preserves conflicts, repeats cleanly, and removes only owned links', async () => {
  const root = temporary();
  const options = { skillsDir: resolve(root, 'skills'), binDir: resolve(root, 'bin') };
  const skill = resolve(options.skillsDir, 'web-slurp');
  mkdirSync(skill, { recursive: true });
  writeFileSync(resolve(skill, 'mine.md'), 'keep me');
  expect(() => register(options)).toThrow('Existing installation');
  register({ ...options, backupExisting: true });
  register(options);
  expect(lstatSync(skill).isSymbolicLink()).toBe(true);
  const backupRoot = resolve(root, 'web-slurp-backups');
  const backup = readdirSync(backupRoot)[0]!;
  expect(readdirSync(options.skillsDir)).toEqual(['web-slurp']);
  expect(readFileSync(resolve(backupRoot, backup, 'web-slurp/mine.md'), 'utf8')).toBe('keep me');
  const child = Bun.spawn([resolve(options.binDir, 'web-slurp'), '--version'], { stdout: 'pipe' });
  expect(await new Response(child.stdout).text()).toBe('0.3.0\n');
  expect(await child.exited).toBe(0);
  uninstall(options);
  expect(existsSync(skill)).toBe(false);
  mkdirSync(skill);
  uninstall(options);
  expect(existsSync(skill)).toBe(true);
});

test('registration replaces a legacy web-slurp skill without an upgrade flag', () => {
  const root = temporary();
  const options = { skillsDir: resolve(root, 'skills'), binDir: resolve(root, 'bin') };
  const skill = resolve(options.skillsDir, 'web-slurp');
  mkdirSync(skill, { recursive: true });
  writeFileSync(resolve(skill, 'package.json'), JSON.stringify({ name: 'web-slurp', version: '0.1.0' }));
  register(options);
  expect(lstatSync(skill).isSymbolicLink()).toBe(true);
  expect(existsSync(resolve(root, 'web-slurp-backups'))).toBe(false);
});

test('capture discovers imports, waits for the page, and preserves evidence', async () => {
  const target = resolve(temporary(), 'capture');
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    switch (new URL(request.url).pathname) {
      case '/page': return new Response('<!doctype html><html><head><title>Fixture</title><link rel="stylesheet" href="/style.css"></head><body><script type="module" src="/app.js"></script></body></html>', { headers: { 'content-type': 'text/html' } });
      case '/app.js': return new Response("await import('/dynamic.js'); const p = document.createElement('p'); p.id = 'ready'; p.textContent = 'ready'; document.body.append(p)", { headers: { 'content-type': 'text/javascript' } });
      case '/dynamic.js': return new Response('export const value = 42;', { headers: { 'content-type': 'text/javascript' } });
      case '/style.css': return new Response('body {color: red}', { headers: { 'content-type': 'text/css' } });
      default: return new Response('', { status: 404 });
    }
  } });
  cleanup.push(() => server.stop(true));
  const result = await cli(['capture', new URL('/page', server.url).href, '--out', target, '--wait-for', '#ready']);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  const scripts = readFileSync(resolve(target, 'input/bundles/script-urls.txt'), 'utf8');
  expect(scripts).toContain('/dynamic.js');
  const htmlPath = resolve(target, 'input/page-source/codex.rendered.html');
  const before = readFileSync(htmlPath, 'utf8');
  expect(before).toContain('id="ready"');
  expect(before).toStartWith('<!DOCTYPE html>\n');
  const repeated = await cli(['capture', server.url.href, '--out', target]);
  expect(repeated.code).toBe(1);
  expect(repeated.stderr).toContain('already exists');
  expect(readFileSync(htmlPath, 'utf8')).toBe(before);
  expect(existsSync(resolve(target, '.capture-lock'))).toBe(false);
  const input = resolve(target, 'input/bundles/raw/app.js');
  const output = resolve(target, 'input/bundles/js-assets/beautified/app.js');
  writeFileSync(input, 'const x={a:1,b:2};');
  beautify(input, output);
  expect(readFileSync(output, 'utf8')).toContain('a: 1');
}, 120_000);

test('replay stays offline by default, separates query variants, and rejects writes', async () => {
  const root = temporary();
  let requests = 0;
  const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    requests++;
    return new Response(new URL(request.url).searchParams.get('v'), { headers: { 'content-type': 'text/javascript' } });
  } });
  cleanup.push(() => upstream.stop(true));
  mkdirSync(resolve(root, 'input/page-source'), { recursive: true });
  writeFileSync(resolve(root, 'input/page-source/capture-metadata.json'), JSON.stringify({ url: new URL('/nested/page?tab=usage#chart', upstream.url).href }));
  writeFileSync(resolve(root, 'input/page-source/codex.rendered.html'), '<html><head></head><body>replay</body></html>');
  const offline = startReplay(root, { port: 0, host: '127.0.0.1' });
  cleanup.push(() => offline.server.stop(true));
  expect((await fetch(new URL('/app.js?v=1', offline.url))).status).toBe(404);
  expect(requests).toBe(0);
  expect(offline.url.pathname + offline.url.search + offline.url.hash).toBe('/nested/page?tab=usage#chart');
  const html = await fetch(offline.url);
  expect(html.headers.get('content-security-policy')).toContain("connect-src 'self'");
  expect(await html.text()).toContain('<base href="/nested/">');
  const live = startReplay(root, { port: 0, host: '127.0.0.1', liveAssets: true });
  cleanup.push(() => live.server.stop(true));
  for (const version of ['1', '2']) expect(await (await fetch(new URL(`/app.js?v=${version}`, live.url))).text()).toBe(version);
  expect(requests).toBe(2);
  for (const version of ['1', '2']) expect(await (await fetch(new URL(`/app.js?v=${version}`, offline.url))).text()).toBe(version);
  expect((await fetch(new URL('/api/delete', live.url))).status).toBe(403);
  expect((await fetch(new URL('/app.js', live.url), { method: 'POST' })).status).toBe(405);
  expect(requests).toBe(2);
});
