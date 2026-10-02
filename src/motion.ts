import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluate } from './cdp';

export async function captureMotion(target: string, websocketUrl: string): Promise<void> {
  const directory = resolve(target, 'input/motion');
  mkdirSync(resolve(target, 'input'), { recursive: true });
  mkdirSync(directory); // Refuse to replace even a partial motion capture.
  const path = resolve(directory, 'runtime.json');
  try {
    const evidence = await evaluate<Record<string, unknown>>(websocketUrl, readFileSync(resolve(import.meta.dir, 'motion-probe.js'), 'utf8'));
    writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    console.log(`Motion evidence: ${path}`);
  } catch (error) {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, status: 'error', error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n', { flag: 'wx' });
    throw error;
  }
}
