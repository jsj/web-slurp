import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { captureFlow } from '../src/commands/flow';
import { browserStatus, closeBrowser, ensureBrowser, profileDirectory } from '../src/commands/browser';
import { pageTargets } from '../src/cdp';

test('flow captures ordered dropdown, hover, and scroll states and preserves partial results', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-flow-'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(`<html><head><style>
      #panel { background: red; width: 200px; height: 100px; } #card { width: 200px; height: 80px; background: blue; }
      #card:hover { background: green; } #bottom { margin-top: 1500px; }
      </style></head><body><button id="menu" onclick="document.querySelector('#panel').hidden=false">Menu</button>
      <div id="panel" hidden>Dropdown content</div><div id="card" onmouseenter="this.dataset.hovered='yes'">Hover</div><div id="bottom">Bottom</div></body></html>`, { headers: { 'content-type': 'text/html' } });
  } });
  try {
    const steps = resolve(root, 'steps.json');
    writeFileSync(steps, JSON.stringify([{ name: 'initial', waitFor: '#menu' }, { name: 'menu', click: '#menu', waitFor: '#panel' }, { name: 'hover', hover: '#card' }, { name: 'bottom', scroll: '#bottom' }]));
    const target = resolve(root, 'capture');
    await captureFlow(server.url.href, target, steps, { viewport: '600x400', timeout: 10 });
    const index = JSON.parse(readFileSync(resolve(target, 'flow.json'), 'utf8'));
    expect(index.complete).toBe(true);
    expect(index.steps.map((step: { name: string }) => step.name)).toEqual(['initial', 'menu', 'hover', 'bottom']);
    const html = (name: string) => readFileSync(resolve(target, 'states', name, 'input/page-source/cdp.rendered.html'), 'utf8');
    const png = (name: string) => readFileSync(resolve(target, 'states', name, 'input/page-source/page.png'));
    expect(html('initial')).toContain('id="panel" hidden');
    expect(html('menu')).not.toContain('id="panel" hidden');
    expect(html('hover')).toContain('data-hovered="yes"');
    expect(png('initial').equals(png('menu'))).toBe(false);
    expect(png('menu').equals(png('hover'))).toBe(false);
    expect(png('hover').equals(png('bottom'))).toBe(false);
    for (const step of index.steps) expect(existsSync(resolve(target, step.path, 'input/assets/manifest.json'))).toBe(true);
    const before = readFileSync(resolve(target, 'flow.json'), 'utf8');
    await expect(captureFlow(server.url.href, target, steps)).rejects.toThrow('already exists');
    expect(readFileSync(resolve(target, 'flow.json'), 'utf8')).toBe(before);
    writeFileSync(steps, JSON.stringify([{ name: 'first' }, { name: 'missing', waitFor: '#missing' }]));
    const partial = resolve(root, 'partial');
    await expect(captureFlow(server.url.href, partial, steps, { timeout: 0.5 })).rejects.toThrow('timed out');
    const incomplete = JSON.parse(readFileSync(resolve(partial, 'flow.json'), 'utf8'));
    expect(incomplete.complete).toBe(false);
    expect(incomplete.steps.map((step: { complete: boolean }) => step.complete)).toEqual([true, false]);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test('flow validates names and actions before creating output or browser', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-flow-validation-'));
  try {
    const steps = resolve(root, 'steps.json'), target = resolve(root, 'capture');
    for (const invalid of [[{ name: '../escape' }], [{ name: 'one' }, { name: 'ONE' }], [{ name: 'one', eval: 'doSomething()' }], [{ name: 'one', click: '#a', hover: '#b' }], [{ name: 'one', expect: 'A menu is visible' }]]) {
      writeFileSync(steps, JSON.stringify(invalid));
      await expect(captureFlow('https://example.com', target, steps)).rejects.toThrow();
      expect(existsSync(target)).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('semantic flow chooses a live element, verifies the result, and records evidence', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-semantic-flow-'));
  const originalFetch = globalThis.fetch;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(`<html><body>
    <button onclick="document.querySelector('#products').hidden=false">Products</button>
    <button>Account</button><div id="products" hidden>Widgets and Gadgets</div>
  </body></html>`, { headers: { 'content-type': 'text/html' } }) });
  try {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account';
    process.env.CLOUDFLARE_API_TOKEN = 'test';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(_input).startsWith('https://api.cloudflare.com/')) return originalFetch(_input, init);
      const body = JSON.parse(String(init?.body));
      return Response.json(body.input.questions.target
        ? { model: 'jev-test', answers: { target: { type: 'choice', choice: 'e1', confidence: 0.97, probabilities: { e1: 0.97, e2: 0.02, none: 0.01 } } }, usage: { input_tokens: 100, output_tokens: 3 } }
        : { model: 'jev-test', answers: { satisfied: { type: 'noul', noul: 0.95 } }, usage: { input_tokens: 30, output_tokens: 1 } });
    }) as unknown as typeof fetch;
    const steps = resolve(root, 'steps.json');
    writeFileSync(steps, JSON.stringify([{ name: 'products', clickIntent: 'Open the products menu', expect: 'Widgets and Gadgets are visible' }]));
    const target = resolve(root, 'capture');
    await captureFlow(server.url.href, target, steps, { timeout: 10 });
    const index = JSON.parse(readFileSync(resolve(target, 'flow.json'), 'utf8'));
    expect(index.complete).toBe(true);
    expect(index.steps[0]).toMatchObject({ complete: true, decision: { choice: 'e1', model: 'jev-test' }, verification: { probability: 0.95 } });
    expect(readFileSync(resolve(target, 'states/products/input/page-source/cdp.rendered.html'), 'utf8')).not.toContain('id="products" hidden');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
    if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = originalToken;
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('flow leaves an existing profile and its original tabs intact', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-flow-profile-'));
  const name = `flow-test-${crypto.randomUUID()}`;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html><body><h1 id="ready">Ready</h1></body></html>', { headers: { 'content-type': 'text/html' } }) });
  try {
    const browser = await ensureBrowser(name, true);
    const before = await pageTargets(browser.endpoint);
    const steps = resolve(root, 'steps.json');
    writeFileSync(steps, JSON.stringify([{ name: 'initial', waitFor: '#ready' }]));
    await captureFlow(server.url.href, resolve(root, 'capture'), steps, { profile: name, timeout: 10 });
    expect((await browserStatus(name))?.websocketUrl).toBe(browser.websocketUrl);
    const after = await pageTargets(browser.endpoint);
    for (const page of before) expect(after.find(current => current.id === page.id)?.url).toBe(page.url);
    expect(after.length).toBe(before.length + 1);
  } finally {
    await closeBrowser(name);
    rmSync(profileDirectory(name), { recursive: true, force: true });
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('flow CLI cancellation preserves completed states and cleans only temporary profiles', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-flow-cancel-'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html><body><h1 id="ready">Ready</h1></body></html>', { headers: { 'content-type': 'text/html' } }) });
  const steps = resolve(root, 'steps.json');
  writeFileSync(steps, JSON.stringify([{ name: 'first', waitFor: '#ready' }, { name: 'waiting', waitFor: '#never' }]));
  const name = `flow-cancel-${crypto.randomUUID()}`;
  try {
    // A prestarted headless profile exercises named-profile behavior without showing a browser.
    const persistent = await ensureBrowser(name, true);
    for (const named of [false, true]) {
      const target = resolve(root, named ? 'persistent' : 'temporary');
      const profiles = resolve(root, 'profiles');
      const child = Bun.spawn(['bun', resolve(import.meta.dir, '../src/cli.ts'), 'flow', server.url.href, '--out', target, '--steps', steps, '--timeout', '30', ...(named ? ['--profile', name] : [])], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...(named ? {} : { WEB_SLURP_PROFILE_ROOT: profiles }) },
      });
      const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
      try {
        const indexPath = resolve(target, 'flow.json');
        const deadline = Date.now() + 15_000;
        let completed = false;
        while (Date.now() < deadline && child.exitCode === null) {
          if (existsSync(indexPath)) {
            try { completed = JSON.parse(readFileSync(indexPath, 'utf8')).steps[0].complete; } catch {}
          }
          if (completed) break;
          await Bun.sleep(50);
        }
        expect(completed).toBe(true);
        child.kill(named ? 'SIGTERM' : 'SIGINT');
        expect(await child.exited).toBe(named ? 143 : 130);
        const index = JSON.parse(readFileSync(indexPath, 'utf8'));
        expect(index.complete).toBe(false);
        expect(index.steps.map((step: { complete: boolean }) => step.complete)).toEqual([true, false]);
        expect(existsSync(resolve(target, 'states/first/input/page-source/page.png'))).toBe(true);
        if (named) expect((await browserStatus(name))?.websocketUrl).toBe(persistent.websocketUrl);
        else expect(readdirSync(profiles)).toEqual([]);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
        await Promise.all([stdout, stderr]);
      }
    }
  } finally {
    await closeBrowser(name);
    rmSync(profileDirectory(name), { recursive: true, force: true });
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
