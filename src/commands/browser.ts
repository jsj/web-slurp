import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { cdpCall } from '../cdp';

export function profileDirectory(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('Profile names must use 1–64 letters, digits, hyphens, or underscores.');
  return resolve(process.env.WEB_SLURP_PROFILE_ROOT ?? resolve(homedir(), '.local/share/web-slurp/profiles'), name);
}
export type BrowserSession = { endpoint: string; websocketUrl: string; profile: string };

export async function browserStatus(name: string): Promise<BrowserSession | null> {
  return sessionForProfile(profileDirectory(name));
}

export async function sessionForProfile(profile: string): Promise<BrowserSession | null> {
  const file = resolve(profile, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  const [port, browserPath] = readFileSync(file, 'utf8').trim().split('\n');
  if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535
    || !browserPath || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath)) return null;
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1_000), redirect: 'error' });
    if (!response.ok) return null;
    const version = await response.json() as { webSocketDebuggerUrl?: string };
    if (!version.webSocketDebuggerUrl) return null;
    const actual = new URL(version.webSocketDebuggerUrl);
    // The random browser ID comes from this profile, not a shared fixed port.
    if (actual.pathname !== browserPath || actual.port !== port || !['127.0.0.1', 'localhost'].includes(actual.hostname)) return null;
    return { endpoint, websocketUrl: `ws://127.0.0.1:${port}${browserPath}`, profile };
  } catch { return null; }
}

function chromeExecutable(): string {
  const candidates = [
    process.env.WEB_SLURP_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    Bun.which('google-chrome'), Bun.which('chromium'), Bun.which('chromium-browser'),
    process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  ];
  const executable = candidates.find(path => path && existsSync(path));
  if (!executable) throw new Error('Chrome was not found. Set WEB_SLURP_CHROME to its executable path.');
  return executable;
}

export async function ensureBrowser(name: string, headless = false): Promise<BrowserSession> {
  const profile = profileDirectory(name);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(profile, 0o700);
  const unlock = lockProfile(profile);
  try {
    const current = await browserStatus(name);
    if (current) return current;
    if (profileLocked(profile)) throw new Error(`Chrome profile ${name} is locked but its endpoint is unavailable. Check Chrome and retry; profile files were preserved.`);
    // Stale IDs must never be used to attach to a different browser reusing a port.
    rmSync(resolve(profile, 'DevToolsActivePort'), { force: true });
    const child = spawn(chromeExecutable(), [
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', ...(headless ? ['--headless=new'] : []), 'about:blank',
    ], { detached: true, stdio: 'ignore' });
    let launchError: Error | undefined;
    child.on('error', error => { launchError = error; });
    child.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw launchError;
      const session = await browserStatus(name);
      if (session) return session;
      if (child.exitCode !== null) throw new Error(`Chrome exited with code ${child.exitCode}. Check whether this profile is open in another browser.`);
      await Bun.sleep(100);
    }
    throw new Error(`Chrome did not become ready for profile ${name}. Check Chrome before retrying.`);
  } finally { unlock(); }
}

export async function openBrowser(name: string, url: string): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:', 'about:'].includes(parsed.protocol) || (parsed.protocol === 'about:' && parsed.href !== 'about:blank')) throw new Error('Browser URL must use HTTP or HTTPS.');
  const session = await ensureBrowser(name);
  await cdpCall(session.websocketUrl, 'Target.createTarget', { url: parsed.href });
  console.log(`Profile: ${name}\nCDP: ${session.endpoint}\nSign in in Chrome. This profile keeps its session between launches.`);
}

function lockProfile(profile: string): () => void {
  const lock = resolve(profile, '.launch-lock');
  try { mkdirSync(lock); } catch { throw new Error(`Profile launch or shutdown is already in progress. If interrupted, check Chrome before removing ${lock}.`); }
  return () => rmSync(lock, { recursive: true, force: true });
}

function profileLocked(profile: string): boolean {
  try { lstatSync(resolve(profile, 'SingletonLock')); return true; } catch { return false; }
}

export async function closeBrowser(name: string): Promise<void> {
  const profile = profileDirectory(name);
  if (!existsSync(profile)) { console.log(`Profile ${name} is not running.`); return; }
  const unlock = lockProfile(profile);
  try {
    const session = await browserStatus(name);
    if (!session) {
      if (profileLocked(profile)) throw new Error(`Chrome profile ${name} is locked but its endpoint cannot be verified. Its files have been preserved.`);
      console.log(`Profile ${name} is not running with a verified CDP endpoint.`); return;
    }
    try { await cdpCall(session.websocketUrl, 'Browser.close'); }
    catch (error) { if (await browserStatus(name)) throw error; }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!await browserStatus(name) && !profileLocked(session.profile)) { console.log(`Closed Chrome profile ${name}; login state preserved.`); return; }
      await Bun.sleep(100);
    }
    throw new Error(`Chrome profile ${name} did not close. Its files have been preserved.`);
  } finally { unlock(); }
}
