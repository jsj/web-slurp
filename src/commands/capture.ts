import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { collectAssets } from "../assets";
import { screenshot, viewport as parseViewport, compareImages } from "../visual";
import { resolve } from "node:path";
import { agentBrowserCli, agentBrowserEnv } from "../agent-browser";
import { cdpCall, evaluate, pageTargets, holdViewport } from "../cdp";
import { ensureBrowser, sessionForProfile } from "./browser";
import { initTarget } from "./target";
import { absolute, harnessScript, requireFile, run } from "../harness";

function agentBrowser(args: string[], input?: string): string {
  const result = spawnSync("bun", [agentBrowserCli, ...args], {
    encoding: "utf8",
    env: agentBrowserEnv(),
    input,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `agent-browser failed with exit code ${result.status ?? "unknown"}`);
  }
  return result.stdout;
}

// Resource Timing includes fetched imports that have no <script> element.
const captureExpression = `(() => {
  const resources = performance.getEntriesByType('resource');
  const urls = (values) => [...new Set(values)].filter(url => /^https?:/.test(url));
  return {
    capturedAt: new Date().toISOString(),
    baseUrl: document.baseURI,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
    html: (document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\\n' : '') + document.documentElement.outerHTML,
    scripts: urls([
      ...[...document.scripts].map(node => node.src),
      ...[...document.querySelectorAll('link[rel="modulepreload"]')].map(node => node.href),
      ...resources.filter(entry => entry.initiatorType === 'script' || /\\.(m?js)([?#]|$)/i.test(entry.name)).map(entry => entry.name)
    ]),
    stylesheets: urls([
      ...[...document.querySelectorAll('link[rel="stylesheet"]')].map(node => node.href),
      ...resources.filter(entry => /\\.css([?#]|$)/i.test(entry.name)).map(entry => entry.name)
    ]),
    title: document.title,
    url: location.href
  };
})()`;

function beginCapture(target: string, manageSignals = true): () => void {
  mkdirSync(target, { recursive: true });
  const lock = resolve(target, '.capture-lock');
  try { mkdirSync(lock); } catch {
    throw new Error(`Capture is already running, or a stale .capture-lock exists: ${target}`);
  }
  try {
    const pageSource = resolve(target, 'input/page-source');
    const bundles = resolve(target, 'input/bundles');
    const assets = resolve(target, 'input/assets');
    if ((existsSync(pageSource) && readdirSync(pageSource).length > 0)
      || (existsSync(assets) && readdirSync(assets).length > 0)
      || ['script-urls.txt', 'stylesheet-urls.txt'].some(name => existsSync(resolve(bundles, name)))) {
      throw new Error(`Capture evidence already exists: ${target}. Choose a new --out directory.`);
    }
    initTarget(target, true);
  } catch (error) { rmSync(lock, { recursive: true }); throw error; }
  const release = () => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    rmSync(lock, { recursive: true, force: true });
  };
  const interrupt = () => { release(); process.exit(130); };
  const terminate = () => { release(); process.exit(143); };
  if (manageSignals) { process.once('SIGINT', interrupt); process.once('SIGTERM', terminate); }
  return release;
}

async function saveCapture(target: string, data: CdpCapture, source: string, requestedUrl: string | undefined, websocketUrl: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const pageSource = resolve(target, 'input/page-source');
  const bundles = resolve(target, 'input/bundles');
  const htmlPath = resolve(pageSource, source === 'chrome-cdp' ? 'cdp.rendered.html' : 'codex.rendered.html');
  writeFileSync(htmlPath, data.html, { flag: 'wx' });
  writeFileSync(resolve(bundles, 'script-urls.txt'), data.scripts.join('\n') + '\n', { flag: 'wx' });
  writeFileSync(resolve(bundles, 'stylesheet-urls.txt'), data.stylesheets.join('\n') + '\n', { flag: 'wx' });
  await screenshot(websocketUrl, target);
  signal?.throwIfAborted();
  const assets = await collectAssets(websocketUrl, target, signal);
  console.log(`Assets: ${assets.assets.filter(asset => asset.status === 'saved').length} saved, ${assets.assets.filter(asset => asset.status === 'failed').length} unavailable`);
  // Metadata is written last: its presence marks a completed capture.
  writeFileSync(resolve(pageSource, 'capture-metadata.json'), JSON.stringify({
    capturedAt: data.capturedAt, scriptCount: data.scripts.length,
    stylesheetCount: data.stylesheets.length, title: data.title, url: data.url,
    requestedUrl: requestedUrl ?? data.url, source, viewport: data.viewport, baseUrl: data.baseUrl,
    screenshot: "input/page-source/page.png", assets: "input/assets/manifest.json",
  }, null, 2) + '\n', { flag: 'wx' });
  console.log(`Captured: ${data.url}\nHTML: ${htmlPath}\nScripts: ${data.scripts.length}\nStylesheets: ${data.stylesheets.length}`);
}

export async function capture(url: string, targetInput: string, options: { waitFor?: string; waitUntil?: string; profile?: string; readyUrl?: string; authTimeout?: number; viewport?: string; deviceScaleFactor?: number } = {}): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Capture URL must use HTTP or HTTPS.");
  if (options.profile) return captureWithProfile(parsed.href, targetInput, options as { profile: string; waitFor?: string; readyUrl?: string; authTimeout?: number; viewport?: string; deviceScaleFactor?: number });
  const size = parseViewport(options.viewport);
  const scale = options.deviceScaleFactor ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error("Device scale factor must be between 0 and 4.");
  const target = absolute(targetInput);
  const release = beginCapture(target);
  const session = `web-slurp-${process.pid}-${Date.now()}`;
  let profile: string | undefined;
  let releaseViewport: (() => void) | undefined;
  try {
    profile = mkdtempSync(resolve(tmpdir(), "web-slurp-capture-"));
    agentBrowser(["--session", session, "--profile", profile, "--headed", "false", "--pin-tab", "open", parsed.toString()]);
    agentBrowser(["--session", session, "set", "viewport", String(size.width), String(size.height), String(scale)]);
    agentBrowser(["--session", session, "wait", "--load", options.waitUntil ?? 'networkidle']);
    if (options.waitFor) agentBrowser(["--session", session, "wait", options.waitFor]);
    const browser = await sessionForProfile(profile);
    if (!browser) throw new Error('Cannot locate the capture browser endpoint.');
    const tabs = JSON.parse(agentBrowser(['--session', session, 'tab', 'list', '--json'])) as { data?: { tabs?: Array<{ active: boolean; targetId: string }> } };
    const activeId = tabs.data?.tabs?.find(tab => tab.active)?.targetId;
    const page = (await pageTargets(browser.endpoint)).find(candidate => candidate.id === activeId);
    if (!page?.webSocketDebuggerUrl) throw new Error('Cannot locate the pinned capture tab.');
    // Agent-browser commands can restore their own device metrics. Apply the
    // requested density after its last command and finish capture through CDP.
    releaseViewport = await holdViewport(page.webSocketDebuggerUrl, size.width, size.height, scale);
    await evaluate(page.webSocketDebuggerUrl, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    const data = await evaluate<CdpCapture>(page.webSocketDebuggerUrl, captureExpression);
    await saveCapture(target, data, 'agent-browser', parsed.toString(), page.webSocketDebuggerUrl);
  } finally {
    releaseViewport?.();
    try {
      agentBrowser(["--session", session, "close"]);
      if (profile) rmSync(profile, { recursive: true, force: true });
    } catch (error) { console.error(`Browser cleanup: ${error instanceof Error ? error.message : error}. Temporary profile preserved at ${profile ?? 'unavailable'}`); }
    finally { release(); }
  }
}

export function download(urlListInput: string, outdirInput: string, referer: string, cdp: string): void {
  const urls = absolute(urlListInput);
  const outdir = absolute(outdirInput);
  requireFile(urls);
  run("python3", [
    harnessScript("cdp_download_urls.py"),
    urls,
    outdir,
    "--referer",
    new URL(referer).toString(),
    "--cdp",
    cdp,
  ]);
}

type CdpCapture = {
  baseUrl: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  capturedAt: string;
  html: string;
  scripts: string[];
  stylesheets: string[];
  title: string;
  url: string;
};

export async function captureTab(targetInput: string, websocketUrl: string, requestedUrl?: string, signal?: AbortSignal): Promise<void> {
  const target = absolute(targetInput);
  signal?.throwIfAborted();
  const release = beginCapture(target, !signal);
  try {
    const data = await evaluate<CdpCapture>(websocketUrl, captureExpression);
    await saveCapture(target, data, 'chrome-cdp', requestedUrl, websocketUrl, signal);
  } finally { release(); }
}

export async function captureCdp(targetInput: string, pageUrl: string | undefined, cdp: string): Promise<void> {
  const target = absolute(targetInput);
  const release = beginCapture(target);
  try {
    const pages = await pageTargets(cdp);
    const exact = pageUrl ? pages.filter(candidate => candidate.url === pageUrl) : [];
    const matches = exact.length ? exact : pageUrl ? pages.filter(candidate => candidate.url.startsWith(pageUrl)) : pages;
    if (matches.length !== 1) throw new Error(`Expected one matching Chrome page; found ${matches.length}. Use --page-url with an exact URL. Available: ${pages.map(page => page.url).join(', ')}`);
    const page = matches[0]!;
    const data = await evaluate<CdpCapture>(page.webSocketDebuggerUrl!, captureExpression);
    await saveCapture(target, data, 'chrome-cdp', pageUrl, page.webSocketDebuggerUrl!);
  } finally { release(); }
}

export async function captureWithProfile(url: string, targetInput: string, options: { profile: string; waitFor?: string; readyUrl?: string; authTimeout?: number; viewport?: string; deviceScaleFactor?: number }): Promise<void> {
  if (!options.waitFor) throw new Error('Profile capture requires --wait-for <selector> identifying the signed-in page.');
  const expected = new URL(options.readyUrl ?? url);
  if (!['http:', 'https:'].includes(expected.protocol)) throw new Error('Ready URL must use HTTP or HTTPS.');
  const size = parseViewport(options.viewport);
  const scale = options.deviceScaleFactor ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error('Device scale factor must be between 0 and 4.');
  const seconds = options.authTimeout ?? 300;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--auth-timeout must be positive seconds.');
  const target = absolute(targetInput);
  const release = beginCapture(target);
  let releaseViewport: (() => void) | undefined;
  try {
    const browser = await ensureBrowser(options.profile);
    const { targetId } = await cdpCall<{ targetId: string }>(browser.websocketUrl, 'Target.createTarget', { url });
    console.log(`Sign in to continue if prompted in Chrome (profile: ${options.profile}).\nWaiting for ${options.waitFor} on ${expected.origin}${expected.pathname}.`);
    let viewportSet = false;
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const page = (await pageTargets(browser.endpoint)).find(page => page.id === targetId);
      if (!page?.webSocketDebuggerUrl) throw new Error('Capture tab was closed. Rerun capture to resume with the saved profile.');
      let data: CdpCapture | null = null;
      try {
        if (!viewportSet) {
          releaseViewport = await holdViewport(page.webSocketDebuggerUrl, size.width, size.height, scale);
          viewportSet = true;
        }
        // Readiness and evidence share one synchronous evaluation so a SPA state
        // change cannot race between checking the selector and cloning its DOM.
        data = await evaluate<CdpCapture | null>(page.webSocketDebuggerUrl, `(() => {
          if (location.href !== ${JSON.stringify(expected.href)}) return null;
          const element = document.querySelector(${JSON.stringify(options.waitFor)});
          if (document.readyState !== 'complete' || !element || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return null;
          return ${captureExpression};
        })()`);
      } catch (error) {
        // Document replacement during login can invalidate Runtime.evaluate.
        // Invalid selectors and other failures remain actionable errors.
        if (!(error instanceof Error) || !/Execution context was destroyed|Cannot find (?:default execution )?context|Inspected target navigated/i.test(error.message)) throw error;
      }
        if (data) {
          await saveCapture(target, data, 'chrome-cdp', url, page.webSocketDebuggerUrl);
          console.log(`Chrome remains open. Close it with: web-slurp browser close --profile ${options.profile}`);
          return;
        }
      await Bun.sleep(500);
    }
    throw new Error(`Sign-in/readiness timed out. Chrome and its login state are preserved; finish signing in, then rerun the same capture command. No capture evidence was saved.`);
  } finally { releaseViewport?.(); release(); }
}

export async function captureResponsive(url: string, target: string, options: { profile?: string; waitFor?: string; readyUrl?: string; authTimeout?: number }): Promise<void> {
  for (const [name, viewport] of [['desktop', '1440x900'], ['mobile', '390x844']]) {
    await capture(url, resolve(target, name!), { ...options, viewport });
  }
  writeFileSync(resolve(target, 'responsive.json'), JSON.stringify({
    desktop: 'desktop/input/page-source/capture-metadata.json', mobile: 'mobile/input/page-source/capture-metadata.json',
  }, null, 2) + '\n', { flag: 'wx' });
}

export async function compare(reference: string, url: string, target: string, options: { waitFor?: string; profile?: string; readyUrl?: string; authTimeout?: number }): Promise<void> {
  const metadata = JSON.parse(readFileSync(resolve(reference, 'input/page-source/capture-metadata.json'), 'utf8')) as CdpCapture;
  if (!metadata.viewport) throw new Error('Reference predates screenshot capture. Capture it again before comparing.');
  const baseline = resolve(reference, 'input/page-source/page.png');
  requireFile(baseline);
  await capture(url, resolve(target, 'actual'), { ...options, viewport: `${metadata.viewport.width}x${metadata.viewport.height}`, deviceScaleFactor: metadata.viewport.deviceScaleFactor });
  const result = compareImages(baseline, resolve(target, 'actual/input/page-source/page.png'), resolve(target, 'output'));
  console.log(`Changed pixels: ${result.changedPercent.toFixed(2)}%\nReport: ${resolve(target, 'output/comparison.json')}`);
}
