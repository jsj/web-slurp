// Metadata only: never retain console text, request bodies, headers, query strings,
// or URL fragments. Paths can still contain private data, like other captures.
export type FlowEvent = { step: number; kind: string; url?: string; method?: string; status?: number; level?: string; resourceType?: string };
export type EventLog = { version: 1; coverage: 'complete' | 'partial'; dropped: number; limitations: string[]; events: FlowEvent[] };

export function eventUrl(value: string): string | undefined {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.origin + url.pathname : undefined; } catch { return undefined; }
}

export async function observeFlow(socketUrl: string) {
  const log: EventLog = { version: 1, coverage: 'partial', dropped: 0, limitations: ['Only the selected page CDP target is observed; child targets and activity after capture are excluded. Step attribution records arrival, not causality.'], events: [] };
  let step = 0;
  let stopped = false;
  const socket = new WebSocket(socketUrl);
  const commands = ['Network.enable', 'Runtime.enable', 'Page.enable'];
  const pending = new Set([1, 2, 3]);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Flow event setup timed out.')); }, 15_000);
    const fail = (message: string) => { clearTimeout(timer); log.coverage = 'partial'; log.limitations.push(message); reject(new Error(message)); socket.close(); };
    socket.addEventListener('open', () => commands.forEach((method, i) => socket.send(JSON.stringify({ id: i + 1, method, params: {} }))));
    socket.addEventListener('error', () => fail('Flow event connection failed.'));
    socket.addEventListener('close', () => { if (!stopped) fail('Flow event connection closed unexpectedly.'); });
    socket.addEventListener('message', message => {
      try {
        const data = JSON.parse(String(message.data));
        if (pending.has(data.id)) {
          if (data.error) { fail(`Flow event setup failed: ${commands[data.id - 1]}`); return; }
          pending.delete(data.id);
          if (!pending.size) { clearTimeout(timer); log.coverage = 'complete'; resolve(); }
          return;
        }
        const p = data.params;
        let event: FlowEvent | undefined;
        switch (data.method) {
          case 'Network.requestWillBeSent': event = { step, kind: 'request', url: eventUrl(p.request.url), method: p.request.method, resourceType: p.type }; break;
          case 'Network.responseReceived': event = { step, kind: 'response', url: eventUrl(p.response.url), status: p.response.status, resourceType: p.type }; break;
          case 'Network.loadingFailed': event = { step, kind: 'request-failed', resourceType: p.type }; break;
          case 'Runtime.consoleAPICalled': event = { step, kind: 'console', level: p.type }; break;
          case 'Runtime.exceptionThrown': event = { step, kind: 'page-error' }; break;
          case 'Page.frameNavigated': if (!p.frame.parentId) event = { step, kind: 'navigation', url: eventUrl(p.frame.url) }; break;
        }
        if (event) {
          if (log.events.length < 10000) log.events.push(event);
          else { log.dropped++; log.coverage = 'partial'; }
        }
      } catch { fail('Malformed flow event message.'); }
    });
  });
  return { log, setStep(index: number) { step = index; }, stop() { stopped = true; socket.close(); } };
}
