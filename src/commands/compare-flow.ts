import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareImages } from '../visual';
import type { FlowTarget } from '../flow-target';
import type { EventLog } from '../flow-events';

type Status = 'changed' | 'unchanged' | 'unknown';
type Step = { name: string; path: string; complete: boolean; click?: FlowTarget; hover?: FlowTarget; scroll?: FlowTarget; waitFor?: FlowTarget };
type Flow = { url: string; viewport: { width: number; height: number }; complete: boolean; steps: Step[] };
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const aggregate = (statuses: Status[]): Status => statuses.includes('changed') ? 'changed' : statuses.includes('unknown') ? 'unknown' : 'unchanged';
const action = (step: Step) => JSON.stringify([step.click ?? null, step.hover ?? null, step.scroll ?? null, step.waitFor ?? null]);
function statePath(root: string, step: Step, file: string) {
  // Use the canonical path, never a path supplied by a capture manifest.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(step.name) || step.path !== `states/${step.name}`) throw new Error('Invalid flow state path.');
  return resolve(root, 'states', step.name, 'input/page-source', file);
}
function events(root: string): EventLog | undefined {
  const path = resolve(root, 'events.json');
  if (!existsSync(path)) return;
  const value = read(path) as EventLog;
  if (value.version !== 1 || !Array.isArray(value.events) || !['complete', 'partial'].includes(value.coverage)) throw new Error('Unsupported flow event log.');
  return value;
}
function eventSignature(log: EventLog, step: number, base: string) {
  const origin = new URL(base).origin;
  // Different asynchronous arrival orders are not behavioral differences.
  return JSON.stringify(log.events.filter(event => event.step === step).map(event => {
    const { step: _, ...value } = event;
    if (value.url && new URL(value.url).origin === origin) value.url = '$TARGET' + new URL(value.url).pathname;
    return JSON.stringify(value);
  }).sort());
}
export function compareFlows(referenceInput: string, actualInput: string, outputInput: string) {
  const reference = resolve(referenceInput), actual = resolve(actualInput), out = resolve(outputInput);
  const a = read(resolve(reference, 'flow.json')) as Flow, b = read(resolve(actual, 'flow.json')) as Flow;
  for (const flow of [a, b]) {
    if (!Array.isArray(flow.steps) || !flow.steps.length || !flow.viewport || new Set(flow.steps.map(s => s.name)).size !== flow.steps.length) throw new Error('Invalid flow manifest.');
    for (const step of flow.steps) statePath(reference, step, 'page.png');
  }
  if (existsSync(out) && readdirSync(out).length) throw new Error('Comparison output already exists. Choose a new --out directory.');
  const ae = events(reference), be = events(actual);
  mkdirSync(out, { recursive: true });
  const steps = Array.from({ length: Math.max(a.steps.length, b.steps.length) }, (_, i) => {
    const left = a.steps[i], right = b.steps[i];
    if (!left || !right || left.name !== right.name || action(left) !== action(right)) return { index: i, name: left?.name ?? right?.name, status: 'unknown' as Status, reason: 'Step names, order, or actions do not align.' };
    if (!left.complete || !right.complete) return { index: i, name: left.name, status: 'unknown' as Status, reason: 'State capture is incomplete.' };
    let screenshot: Status = 'unknown';
    const lp = statePath(reference, left, 'page.png'), rp = statePath(actual, right, 'page.png');
    if (a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height && existsSync(lp) && existsSync(rp)) {
      const diff = compareImages(lp, rp, resolve(out, left.name));
      screenshot = diff.changedPixels || diff.reference.width !== diff.actual.width || diff.reference.height !== diff.actual.height ? 'changed' : 'unchanged';
    }
    let dom: Status = 'unknown';
    const lh = statePath(reference, left, 'cdp.rendered.html'), rh = statePath(actual, right, 'cdp.rendered.html');
    if (existsSync(lh) && existsSync(rh)) dom = readFileSync(lh).equals(readFileSync(rh)) ? 'unchanged' : 'changed';
    let eventStatus: Status = 'unknown';
    if (ae && be) {
      const equal = eventSignature(ae, i, a.url) === eventSignature(be, i, b.url);
      eventStatus = ae.coverage !== 'complete' || be.coverage !== 'complete' || ae.dropped || be.dropped ? 'unknown' : equal ? 'unchanged' : 'changed';
    }
    return { index: i, name: left.name, status: aggregate([screenshot, dom, eventStatus]), screenshot, dom, events: eventStatus };
  });
  const report = { status: aggregate([...steps.map(s => s.status), ...(!a.complete || !b.complete ? ['unknown' as Status] : [])]), firstDivergentStep: steps.find(s => s.status === 'changed')?.name ?? null, steps,
    policy: 'DOM bytes are compared exactly. Event metadata is compared as a multiset per step, replacing only each target origin with $TARGET. Query strings and fragments are excluded at capture. Screenshots use pixelmatch threshold 0.1.',
    limitations: ['Unchanged means selected evidence matches, not behavioral equivalence.', 'Events record arrival during each step, not causality; child targets and later activity are excluded.', 'No network bodies, console text, accessibility, storage, or backend semantics are compared.'] };
  writeFileSync(resolve(out, 'comparison.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Flow evidence: ${report.status}. Report: ${resolve(out, 'comparison.json')}`);
  return report;
}
