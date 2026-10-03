import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { captureFlow } from '../src/commands/flow';
import { recover } from '../src/commands/recover';

test('semantic fallback, CSS provenance and rrweb retain evidence across navigation', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'slurp-evidence-'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/style.css') return new Response('body { color: rgb(12, 34, 56) } #panel { padding: 20px; width: 160px }', { headers: { 'content-type': 'text/css' } });
    return new Response(path === '/next' ? '<html><body><h1 id="next">Next document</h1></body></html>' : `<html><head><link rel="stylesheet" href="/style.css"></head><body>
      <input value="private-input-value"><button aria-label="Open menu" onclick="document.querySelector('#panel').hidden=false">Icon</button>
      <section id="panel" hidden>Opened<a href="/next">Continue</a></section></body></html>`, { headers: { 'content-type': 'text/html' } });
  } });
  try {
    const steps = resolve(root, 'steps.json'), target = resolve(root, 'capture');
    writeFileSync(steps, JSON.stringify([{ name: 'initial' }, { name: 'opened', click: { css: '#obsolete', role: 'button', name: 'Open menu' }, waitFor: '#panel' }, { name: 'next', click: { role: 'link', name: 'Continue' }, waitFor: '#next' }]));
    await captureFlow(server.url.href, target, steps, { record: true, layout: true, timeout: 10 });
    const json = (path: string) => JSON.parse(readFileSync(resolve(target, path), 'utf8'));
    expect(json('flow.json').steps[1].resolvedTarget.resolvedBy).toBe('role-name');
    const layout = json('states/opened/input/layout/layout.json');
    expect(layout.status).toBe('complete');
    const panel = layout.elements.find((element: any) => element.selector === '#panel');
    expect(panel.computed['padding-top']).toBe('20px');
    expect(panel.computed.color).toBe('rgb(12, 34, 56)');
    expect(panel.rect.width).toBe(200);
    expect(panel.rules.matched.some((rule: any) => rule.sourceUrl === new URL('style.css', server.url).href)).toBe(true);
    expect(panel.rules.inherited.length).toBeGreaterThan(0);
    const recording = json('input/recording/events.json');
    expect(recording.status).toBe('complete');
    expect(recording.events.filter((event: any) => event.type === 2).length).toBeGreaterThanOrEqual(2);
    expect(recording.events.some((event: any) => event.type === 3 && event.data.source === 0)).toBe(true);
    expect(recording.documents.some((document: any) => document.url.endsWith('/next'))).toBe(true);
    expect(JSON.stringify(recording.events)).not.toContain('private-input-value');
    // A failed second action retains the first state's snapshot and the recorder buffer.
    writeFileSync(steps, JSON.stringify([{ name: 'first' }, { name: 'missing', waitFor: '#missing' }]));
    await expect(captureFlow(server.url.href, resolve(root, 'partial'), steps, { record: true, timeout: 0.3 })).rejects.toThrow('timed out');
    const partial = JSON.parse(readFileSync(resolve(root, 'partial/input/recording/events.json'), 'utf8'));
    expect(partial.status).toBe('partial');
    expect(partial.events.some((event: any) => event.type === 2)).toBe(true);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test('semantic locators refuse ambiguous controls before clicking', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'slurp-ambiguous-'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html><body><button>Same</button><button>Same</button></body></html>', { headers: { 'content-type': 'text/html' } }) });
  try {
    const steps = resolve(root, 'steps.json');
    writeFileSync(steps, JSON.stringify([{ name: 'click', click: { role: 'button', name: 'Same' } }]));
    await expect(captureFlow(server.url.href, resolve(root, 'capture'), steps, { timeout: 10 })).rejects.toThrow('ambiguous');
    const index = JSON.parse(readFileSync(resolve(root, 'capture/flow.json'), 'utf8'));
    expect(index.steps[0].complete).toBe(false);
    expect(index.steps[0].resolvedTarget).toBeUndefined();
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test.skipIf(!process.env.WEB_SLURP_WEBCRACK)('optional webcrack recovers JSX and preserves input bytes', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'slurp-webcrack-'));
  try {
    const input = resolve(root, 'input.js'), out = resolve(root, 'recovery');
    const source = 'var x = React.createElement("h1", null, "Hello");';
    writeFileSync(input, source);
    recover([input], { engine: 'webcrack', out, mode: 'file', level: 'standard' });
    expect(readFileSync(resolve(out, 'inputs/input.js'), 'utf8')).toBe(source);
    expect(readFileSync(resolve(out, 'modules/1/deobfuscated.js'), 'utf8')).toContain('<h1>Hello</h1>');
    expect(JSON.parse(readFileSync(resolve(out, 'recovery.json'), 'utf8')).status).toBe('complete');
    expect(() => recover([input], { engine: 'webcrack', out, mode: 'file', level: 'standard' })).toThrow('already exists');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
