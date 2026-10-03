import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withCdpSession } from './cdp';

export async function recordFlow(socket: string, target: string, run: (checkpoint: () => void) => Promise<void>): Promise<void> {
  const directory = resolve(target, 'input/recording');
  mkdirSync(resolve(target, 'input'), { recursive: true }); mkdirSync(directory);
  const report = { schemaVersion: 1, engine: 'rrweb', version: JSON.parse(readFileSync(resolve(import.meta.dir, '../node_modules/rrweb/package.json'), 'utf8')).version,
    status: 'partial', maskAllInputs: true, events: [] as any[], documents: [] as { url: string; firstEvent: number }[], warnings: [] as string[], error: undefined as string | undefined };
  const save = () => writeFileSync(resolve(directory, 'events.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  const key = `__slurpRecord${crypto.randomUUID().replaceAll('-', '')}`;
  const binding = key + 'Emit';
  let bytes = 0;
  const bundle = readFileSync(resolve(import.meta.dir, '../node_modules/rrweb/dist/rrweb.umd.min.cjs'), 'utf8');
  try {
    await withCdpSession(socket, async call => {
      await call('Page.enable');
      await call('Runtime.enable');
      await call('Runtime.addBinding', { name: binding });
      // Load rrweb into a local CommonJS wrapper so target AMD/exports globals
      // cannot redirect the bundle or replace the site's own rrweb instance.
      // CDP injects into every frame. rrweb creates an iframe to obtain clean
      // DOM methods, so initializing inside those frames would recurse.
      const source = `(function(){if(window!==window.top)return;const module={exports:{}};const exports=module.exports;\n${bundle}\n;window[${JSON.stringify(key)}]=module.exports.record({maskAllInputs:true,recordCanvas:false,collectFonts:false,emit(event){window[${JSON.stringify(binding)}](JSON.stringify({url:location.href,event}));}});})()`;
      const { identifier } = await call<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', { source });
      try {
        await run(save);
        if (!report.events.some(event => event.type === 2)) throw new Error('rrweb did not produce a full DOM snapshot.');
        report.status = 'complete';
      } finally {
        try { await call('Runtime.evaluate', { expression: `(() => {window[${JSON.stringify(key)}]?.();delete window[${JSON.stringify(key)}];return true})()` }); } catch {}
        try { await call('Page.removeScriptToEvaluateOnNewDocument', { identifier }); } catch {}
        try { await call('Runtime.removeBinding', { name: binding }); } catch {}
      }
    }, (method, params) => {
      if (method !== 'Runtime.bindingCalled' || params.name !== binding) return;
      const size = Buffer.byteLength(params.payload, 'utf8');
      if (report.events.length >= 10_000 || bytes + size > 8 * 1024 * 1024) {
        if (!report.warnings.includes('Recording truncated at 10,000 events or 8 MiB.')) report.warnings.push('Recording truncated at 10,000 events or 8 MiB.');
        return;
      }
      try {
        const { url, event } = JSON.parse(params.payload);
        if (!event || !Number.isInteger(event.type) || typeof event.timestamp !== 'number' || typeof url !== 'string') throw new Error('Invalid recorder event');
        if (report.documents.at(-1)?.url !== url || event.type === 2) report.documents.push({ url, firstEvent: report.events.length });
        bytes += size; report.events.push(event);
      } catch { if (!report.warnings.includes('Invalid recorder events were ignored.')) report.warnings.push('Invalid recorder events were ignored.'); }
    });
    console.log(`Interaction recording: ${resolve(directory, 'events.json')}`);
  } catch (error) { report.error = String(error); throw error; }
  finally { save(); }
}
