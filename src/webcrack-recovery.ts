import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { moduleIndex, sha256 } from './module-index';
import type { RecoveryOptions } from './commands/recover';
import { absolute } from './harness';

export function recoverWebcrack(inputs: Array<{ original: string; file?: string; url?: string }>, options: RecoveryOptions, warnings: string[]): void {
  if (!['auto', 'file'].includes(options.mode) || options.level !== 'standard' || options.sourceMap) {
    throw new Error('webcrack supports --mode auto or file with --level standard. Strict/inspect modes, rewrite levels, and source-map extraction use Wakaru.');
  }
  const command = process.env.WEB_SLURP_WEBCRACK ? absolute(process.env.WEB_SLURP_WEBCRACK) : 'webcrack';
  const run = (args: string[]) => {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300_000 });
    if (result.error) throw new Error(`webcrack is unavailable: ${result.error.message}. Install webcrack with Node 22/24 or set WEB_SLURP_WEBCRACK to its CLI.`);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
  };
  const version = run(['--version']);
  if (version.exitCode) throw new Error(`webcrack version check failed: ${version.stderr}`);
  const out = absolute(options.out);
  if (existsSync(out)) throw new Error(`Recovery output already exists: ${out}. Choose a fresh directory.`);
  let root = dirname(inputs[0]!.original);
  while (inputs.some(input => relative(root, input.original).startsWith('..') || isAbsolute(relative(root, input.original)))) root = dirname(root);
  mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
  const report = { version: 1, engine: `webcrack ${version.stdout.trim()}`, mode: options.mode, raw: !!options.raw, status: 'partial', warnings,
    inputs: [] as Array<{ original: string; file: string; url?: string; sha256: string }>, runs: [] as any[], error: undefined as string | undefined };
  const save = () => writeFileSync(resolve(out, 'recovery.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  try {
    for (const input of inputs) {
      const file = resolve(out, 'inputs', input.file ?? relative(root, input.original));
      mkdirSync(dirname(file), { recursive: true }); copyFileSync(input.original, file, constants.COPYFILE_EXCL);
      report.inputs.push({ original: input.original, file: relative(out, file), url: input.url, sha256: sha256(readFileSync(file)) });
    }
    save();
    const modules = resolve(out, 'modules'); mkdirSync(modules);
    for (const [index, input] of report.inputs.entries()) {
      const output = resolve(modules, String(index + 1));
      const args = [resolve(out, input.file), '-o', output];
      if (options.mode === 'file') args.push('--no-unpack');
      if (options.raw) args.push('--no-deobfuscate', '--no-unminify', '--no-jsx');
      const result = run(args);
      report.runs.push({ input: input.file, output: relative(out, output), ...result }); save();
      if (result.exitCode) throw new Error(`webcrack recovery failed for ${input.original}.`);
    }
    const index = moduleIndex(modules);
    writeFileSync(resolve(out, 'module-index.json'), JSON.stringify(index, null, 2) + '\n');
    if (!index.modules.length || index.modules.some(module => module.parseError)) throw new Error('webcrack produced no readable modules or an output parse error.');
    report.warnings.push('webcrack outputs are grouped per input; cross-chunk URL linking and original source-map extraction use Wakaru.');
    report.status = 'complete'; save();
    console.log(`Recovered with webcrack: ${out}\nModule index: ${resolve(out, 'module-index.json')}\nReport: ${resolve(out, 'recovery.json')}`);
  } catch (error) { report.error = `${String(error)} Partial evidence preserved at ${out}.`; save(); throw new Error(report.error); }
}
