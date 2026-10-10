import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { compareFlows } from '../src/commands/compare-flow';
import { eventUrl } from '../src/flow-events';

test('flow comparison localizes differences and preserves missing and truncated evidence as unknown', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-compare-flow-'));
  const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
  const setup = (name: string, origin: string) => {
    const dir = resolve(root, name);
    mkdirSync(resolve(dir, 'states/start/input/page-source'), { recursive: true });
    write(resolve(dir, 'flow.json'), { url: origin, complete: true, viewport: { width: 2, height: 2 }, steps: [{ name: 'start', path: 'states/start', complete: true }] });
    const png = new PNG({ width: 2, height: 2 }); png.data.fill(255);
    writeFileSync(resolve(dir, 'states/start/input/page-source/page.png'), PNG.sync.write(png));
    writeFileSync(resolve(dir, 'states/start/input/page-source/cdp.rendered.html'), '<p>same</p>');
    write(resolve(dir, 'events.json'), { version: 1, coverage: 'complete', dropped: 0, events: [{ step: 0, kind: 'request', url: origin + '/data', method: 'GET' }] });
    return dir;
  };
  try {
    const a = setup('a', 'https://example.com'), b = setup('b', 'http://localhost:3000');
    expect(compareFlows(a, b, resolve(root, 'equal')).status).toBe('unchanged');
    writeFileSync(resolve(b, 'states/start/input/page-source/cdp.rendered.html'), '<p>changed</p>');
    const changed = compareFlows(a, b, resolve(root, 'changed'));
    expect(changed.status).toBe('changed');
    expect(changed.firstDivergentStep).toBe('start');
    expect(() => compareFlows(a, b, resolve(root, 'changed'))).toThrow('already exists');
    writeFileSync(resolve(b, 'states/start/input/page-source/cdp.rendered.html'), '<p>same</p>');
    rmSync(resolve(b, 'events.json'));
    expect(compareFlows(a, b, resolve(root, 'missing')).status).toBe('unknown');
    write(resolve(b, 'events.json'), { version: 1, coverage: 'partial', dropped: 1, events: [] });
    expect(compareFlows(a, b, resolve(root, 'partial')).status).toBe('unknown');
    write(resolve(b, 'flow.json'), { url: 'https://example.com', complete: true, viewport: { width: 2, height: 2 }, steps: [{ name: 'other', path: 'states/other', complete: true }] });
    expect(compareFlows(a, b, resolve(root, 'unaligned')).steps[0]?.status).toBe('unknown');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('event URLs exclude credentials, queries, fragments, and non-HTTP payloads', () => {
  expect(eventUrl('https://user:secret@example.com/path?token=secret#private')).toBe('https://example.com/path');
  expect(eventUrl('data:text/plain,secret')).toBeUndefined();
  expect(eventUrl('invalid')).toBeUndefined();
});
