import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cdpCall, evaluate, pageTargets, holdViewport } from '../cdp';
import { viewport } from '../visual';
import { closeBrowser, ensureBrowser, profileDirectory } from './browser';
import { captureTab } from './capture';

type Step = { name: string; click?: string; hover?: string; scroll?: string; waitFor?: string };

function readSteps(file: string): Step[] {
  const steps: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 50) throw new Error('Flow requires 1–50 steps.');
  const names = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)
      || Object.keys(step).some(key => !['name', 'click', 'hover', 'scroll', 'waitFor'].includes(key))) throw new Error('Flow steps support only name, click, hover, scroll, and waitFor.');
    if (typeof step.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(step.name) || names.has(step.name.toLowerCase())) throw new Error('Flow names must be unique and use 1–64 letters, digits, hyphens, or underscores.');
    names.add(step.name.toLowerCase());
    if (['click', 'hover', 'scroll'].filter(key => key in step).length > 1) throw new Error('Each flow step supports at most one action.');
    for (const key of ['click', 'hover', 'scroll', 'waitFor']) {
      if (key in step && (typeof step[key] !== 'string' || !step[key].trim() || step[key].length > 2000)) throw new Error(`${key} must be a nonempty CSS selector of at most 2000 characters.`);
    }
  }
  return steps as Step[];
}

async function ready(socket: string, selector: string | undefined, seconds: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      if (await evaluate<boolean>(socket, `(() => {
        if (document.readyState !== 'complete' || !/^https?:$/.test(location.protocol)) return false;
        const element = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.documentElement'};
        return Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
      })()`)) return;
    } catch (error) {
      if (!(error instanceof Error) || !/Execution context was destroyed|Cannot find (?:default execution )?context|Inspected target navigated/i.test(error.message)) throw error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Flow readiness timed out waiting for ${selector ?? 'page load'}. Completed states were preserved.`);
}

async function paint(socket: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await evaluate(socket, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
}

export async function captureFlow(url: string, targetInput: string, stepsFile: string, options: { profile?: string; viewport?: string; timeout?: number } = {}): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Flow URL must use HTTP or HTTPS.');
  const steps = readSteps(stepsFile);
  const size = viewport(options.viewport);
  const seconds = options.timeout ?? 30;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) throw new Error('Flow timeout must be between 0 and 600 seconds.');
  const name = options.profile ?? `flow-${crypto.randomUUID()}`;
  const profile = profileDirectory(name);
  const target = resolve(targetInput);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`Flow evidence already exists: ${target}. Choose a new --out directory.`);
  mkdirSync(target, { recursive: true });
  // Exclusive creation reserves the output before any browser action.
  const indexPath = resolve(target, 'flow.json');
  const index = { url: parsed.href, viewport: size, complete: false, steps: steps.map(step => ({ ...step, path: `states/${step.name}`, complete: false })) };
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', { flag: 'wx' });
  const save = () => writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  const controller = new AbortController();
  const signal = controller.signal;
  const interrupt = () => { process.exitCode = 130; controller.abort(new Error('Flow interrupted. Completed states were preserved.')); };
  const terminate = () => { process.exitCode = 143; controller.abort(new Error('Flow terminated. Completed states were preserved.')); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  let browserStarted = false;
  let releaseViewport: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const browser = await ensureBrowser(name, !options.profile);
    browserStarted = true;
    signal.throwIfAborted();
    const { targetId } = await cdpCall<{ targetId: string }>(browser.websocketUrl, 'Target.createTarget', { url: 'about:blank' });
    const page = (await pageTargets(browser.endpoint)).find(page => page.id === targetId);
    if (!page?.webSocketDebuggerUrl) throw new Error('Cannot find the new flow tab.');
    const socket = page.webSocketDebuggerUrl;
    signal.throwIfAborted();
    releaseViewport = await holdViewport(socket, size.width, size.height, 1);
    signal.throwIfAborted();
    await cdpCall(socket, 'Page.navigate', { url: parsed.href });
    if (options.profile) console.log(`Using profile ${name}. Sign in if prompted; waiting up to ${seconds}s for each state.`);
    for (const [i, step] of steps.entries()) {
      await ready(socket, step.click ?? step.hover ?? step.scroll, seconds, signal);
      const selector = step.click ?? step.hover ?? step.scroll;
      if (selector) {
        signal.throwIfAborted();
        await evaluate(socket, `(() => { document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'center',behavior:'instant'}); return true; })()`);
        await paint(socket, signal);
        if (!step.scroll) {
          const point = await evaluate<{ x: number; y: number }>(socket, `(() => {
            const element = document.querySelector(${JSON.stringify(selector)}), r = element.getBoundingClientRect();
            const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
            const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
            if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Flow action target is covered by another element');
            return {x,y};
          })()`);
          signal.throwIfAborted();
          await cdpCall(socket, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
          if (step.click) {
            signal.throwIfAborted();
            await cdpCall(socket, 'Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
            signal.throwIfAborted();
            await cdpCall(socket, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
          }
        }
      }
      await ready(socket, step.waitFor, seconds, signal);
      await paint(socket, signal);
      signal.throwIfAborted();
      await captureTab(resolve(target, 'states', step.name), socket, parsed.href, signal);
      index.steps[i]!.complete = true;
      save();
    }
    index.complete = true;
    save();
  } finally {
    releaseViewport?.();
    try {
      if (!options.profile && browserStarted) {
        // closeBrowser verifies shutdown before deleting only this invocation's UUID profile.
        await closeBrowser(name);
        rmSync(profile, { recursive: true, force: true });
      } else if (!options.profile && existsSync(profile)) {
        console.error(`Browser startup was not verified; profile preserved at ${profile}. Inspect Chrome before removing it.`);
      }
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  }
}
