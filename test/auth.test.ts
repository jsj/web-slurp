import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { browserStatus, closeBrowser, ensureBrowser, profileDirectory } from '../src/commands/browser';
import { evaluate, pageTargets } from '../src/cdp';

async function waitUntil<T>(read: () => Promise<T | undefined>, seconds = 15): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error('Fixture did not reach expected state');
}

function startCapture(args: string[]) {
  const child = Bun.spawn(['bun', resolve(import.meta.dir, '../src/cli.ts'), 'capture', ...args], { stdout: 'pipe', stderr: 'pipe', env: process.env });
  const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { child, result };
}

test('profile capture resumes after login, preserves cookies across restart, and leaves timeout retryable', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-auth-'));
  const previous = process.env.WEB_SLURP_PROFILE_ROOT;
  process.env.WEB_SLURP_PROFILE_ROOT = resolve(root, 'profiles');
  const name = 'fixture';
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/private') {
      if (!request.headers.get('cookie')?.includes('fixture-session=yes')) return Response.redirect(new URL('/login', request.url));
      return new Response('<html><head><title>Private fixture</title></head><body><h1 id="account-ready">Signed in</h1></body></html>', { headers: { 'content-type': 'text/html' } });
    }
    if (path === '/spa') return new Response('<html><body><h1 id="account-ready">SPA fixture</h1></body></html>', { headers: { 'content-type': 'text/html' } });
    if (path === '/sign-in') return new Response(null, { status: 302, headers: { location: '/private', 'set-cookie': 'fixture-session=yes; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600' } });
    return new Response('<html><body><a id="login" href="/sign-in">Sign in</a></body></html>', { headers: { 'content-type': 'text/html' } });
  } });
  const captures: ReturnType<typeof startCapture>[] = [];
  try {
    const first = await ensureBrowser(name, true);
    expect((await ensureBrowser(name, true)).websocketUrl).toBe(first.websocketUrl);
    const url = new URL('/private', server.url).href;
    const target = resolve(root, 'first');
    const capture = startCapture([url, '--out', target, '--profile', name, '--wait-for', '#account-ready', '--auth-timeout', '20']);
    captures.push(capture);
    const login = await waitUntil(async () => (await pageTargets(first.endpoint)).find(page => page.url === new URL('/login', server.url).href));
    expect(existsSync(resolve(target, 'input/page-source/capture-metadata.json'))).toBe(false);
    await waitUntil(async () => await evaluate<boolean>(login.webSocketDebuggerUrl!, "Boolean(document.querySelector('#login'))") ? true : undefined);
    await evaluate(login.webSocketDebuggerUrl!, "document.querySelector('#login').click(); true");
    const [code, stdout, stderr] = await capture.result;
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('Sign in to continue');
    expect(readFileSync(resolve(target, 'input/page-source/cdp.rendered.html'), 'utf8')).toContain('Signed in');
    await closeBrowser(name);
    const second = await ensureBrowser(name, true);
    expect(second.websocketUrl).not.toBe(first.websocketUrl);
    const capture2 = startCapture([url, '--out', resolve(root, 'second'), '--profile', name, '--wait-for', '#account-ready', '--auth-timeout', '10']);
    captures.push(capture2);
    const [secondCode, , secondError] = await capture2.result;
    expect(secondError).toBe('');
    expect(secondCode).toBe(0);
    const spaTarget = resolve(root, 'spa');
    const spa = startCapture([new URL('/spa#login', server.url).href, '--out', spaTarget, '--profile', name,
      '--ready-url', new URL('/spa#private', server.url).href, '--wait-for', '#account-ready', '--auth-timeout', '10']);
    captures.push(spa);
    const spaPage = await waitUntil(async () => (await pageTargets(second.endpoint)).find(page => page.url.endsWith('/spa#login')));
    await Bun.sleep(800);
    expect(existsSync(resolve(spaTarget, 'input/page-source/capture-metadata.json'))).toBe(false);
    await evaluate(spaPage.webSocketDebuggerUrl!, "location.hash = 'private'; true");
    expect((await spa.result)[0]).toBe(0);
    expect(JSON.parse(readFileSync(resolve(spaTarget, 'input/page-source/capture-metadata.json'), 'utf8')).url).toEndWith('#private');
    const invalid = startCapture([url, '--out', resolve(root, 'invalid'), '--profile', name, '--wait-for', '[', '--auth-timeout', '10']);
    captures.push(invalid);
    const [invalidCode, , invalidError] = await invalid.result;
    expect(invalidCode).toBe(1);
    expect(invalidError).toContain('selector');
    const cancelledTarget = resolve(root, 'cancelled');
    const cancelled = startCapture([url, '--out', cancelledTarget, '--profile', name, '--wait-for', '#never', '--auth-timeout', '10']);
    captures.push(cancelled);
    await waitUntil(async () => existsSync(resolve(cancelledTarget, '.capture-lock')) ? true : undefined);
    cancelled.child.kill('SIGINT');
    expect((await cancelled.result)[0]).toBe(130);
    expect(existsSync(resolve(cancelledTarget, '.capture-lock'))).toBe(false);
    const retryTarget = resolve(root, 'retry');
    const timeout = startCapture([url, '--out', retryTarget, '--profile', name, '--wait-for', '#missing', '--auth-timeout', '0.5']);
    captures.push(timeout);
    const [timeoutCode, , timeoutError] = await timeout.result;
    expect(timeoutCode).toBe(1);
    expect(timeoutError).toContain('timed out');
    expect(existsSync(resolve(retryTarget, 'input/page-source/capture-metadata.json'))).toBe(false);
    expect(existsSync(resolve(retryTarget, '.capture-lock'))).toBe(false);
    const retry = startCapture([url, '--out', retryTarget, '--profile', name, '--wait-for', '#account-ready', '--auth-timeout', '10']);
    captures.push(retry);
    expect((await retry.result)[0]).toBe(0);

    const activePort = resolve(profileDirectory(name), 'DevToolsActivePort');
    const original = readFileSync(activePort, 'utf8');
    try {
      writeFileSync(activePort, `${new URL(second.endpoint).port}\n/devtools/browser/wrong-browser-id`);
      expect(await browserStatus(name)).toBeNull();
      await expect(ensureBrowser(name, true)).rejects.toThrow('locked');
      expect(readFileSync(activePort, 'utf8')).toContain('wrong-browser-id');
      await expect(closeBrowser(name)).rejects.toThrow('locked');
      expect((await pageTargets(second.endpoint)).length).toBeGreaterThan(0);
    } finally { writeFileSync(activePort, original); }
  } finally {
    for (const capture of captures) { if (capture.child.exitCode === null) capture.child.kill(); await capture.result; }
    await closeBrowser(name);
    server.stop(true);
    if (previous === undefined) delete process.env.WEB_SLURP_PROFILE_ROOT; else process.env.WEB_SLURP_PROFILE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
