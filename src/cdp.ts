export type CdpTarget = { id: string; type: string; url: string; webSocketDebuggerUrl?: string };

export async function cdpCall<T>(websocketUrl: string, method: string, params: Record<string, unknown> = {}, enableDomains: string[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl);
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve(result as T);
    };
    const timer = setTimeout(() => finish(new Error(`CDP timed out: ${method}`)), 15_000);
    const commands = [...enableDomains.map(domain => ({ method: `${domain}.enable`, params: {} })), { method, params }];
    let index = 0;
    const send = () => socket.send(JSON.stringify({ id: index + 1, ...commands[index] }));
    socket.addEventListener('open', send);
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id !== index + 1) return;
        if (message.error) { finish(new Error(`CDP ${commands[index]!.method}: ${message.error.message}`)); return; }
        if (++index < commands.length) send();
        else finish(undefined, message.result);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.addEventListener('error', () => finish(new Error(`CDP connection failed: ${method}`)));
    socket.addEventListener('close', () => finish(new Error(`CDP connection closed: ${method}`)));
  });
}

export async function evaluate<T>(websocketUrl: string, expression: string): Promise<T> {
  const result = await cdpCall<{ exceptionDetails?: { text?: string; exception?: { description?: string } }; result?: { value?: T } }>(websocketUrl, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(`Chrome evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  if (result.result?.value === undefined) throw new Error('Chrome returned no evaluation result.');
  return result.result.value;
}

export async function pageTargets(endpoint: string): Promise<CdpTarget[]> {
  const response = await fetch(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`CDP target discovery failed: HTTP ${response.status}`);
  return (await response.json() as CdpTarget[]).filter(page => page.type === 'page' && page.webSocketDebuggerUrl);
}

// Emulation overrides belong to a CDP connection. Keep it attached until the
// capture finishes; detaching restores the browser's native pixel density.
export async function holdViewport(websocketUrl: string, width: number, height: number, deviceScaleFactor: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl);
    const timer = setTimeout(() => fail(new Error('Viewport setup timed out.')), 15_000);
    const fail = (error: Error) => { clearTimeout(timer); socket.close(); reject(error); };
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Emulation.setDeviceMetricsOverride', params: { width, height, deviceScaleFactor, mobile: false } })));
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        if (message.error) { fail(new Error(message.error.message)); return; }
        clearTimeout(timer);
        resolve(() => socket.close());
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.addEventListener('error', () => fail(new Error('Viewport connection failed.')));
    socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Viewport connection closed.')); });
  });
}

// DOM node IDs and CSS stylesheet IDs belong to one DevTools session.
// Keep that connection open while collecting matched rules and source URLs.
export async function withCdpSession<T>(url: string, use: (call: <R>(method: string, params?: Record<string, unknown>) => Promise<R>) => Promise<T>, onEvent?: (method: string, params: any) => void): Promise<T> {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (message: string) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
    pending.clear();
  };
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method) onEvent?.(message.method, message.params);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`CDP: ${message.error.message}`));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => fail('CDP session closed.'));
  socket.addEventListener('error', () => fail('CDP session failed.'));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP session connection timed out.')), 15_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP session connection failed.')); }, { once: true });
    });
    return await use(<R>(method: string, params: Record<string, unknown> = {}) => new Promise<R>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    }));
  } finally { fail('CDP session finished.'); socket.close(); }
}
