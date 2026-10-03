import { withCdpSession } from './cdp';

export type FlowTarget = string | { css?: string; role: string; name: string };
export function validFlowTarget(value: unknown): value is FlowTarget {
  const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 2000;
  if (text(value)) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return Object.keys(target).every(key => ['css', 'role', 'name'].includes(key)) && text(target.role) && text(target.name) && (target.css === undefined || text(target.css));
}

export async function flowTarget(socket: string, target: FlowTarget, act: false | "pointer" | "scroll" = false): Promise<{ x: number; y: number; resolvedBy: string; role?: string; name?: string } | null> {
  return withCdpSession(socket, async call => {
    await call('DOM.enable');
    let nodeId: number | undefined, backendNodeId: number | undefined;
    const css = typeof target === 'string' ? target : target.css;
    let resolvedBy = 'css';
    if (css) {
      const { root } = await call<any>('DOM.getDocument', { depth: 0 });
      const { nodeIds } = await call<any>('DOM.querySelectorAll', { nodeId: root.nodeId, selector: css });
      // Ambiguous primary selectors never fall through to a guessed target.
      if (nodeIds.length > 1) throw new Error(`Flow selector is ambiguous: ${css}`);
      nodeId = nodeIds[0];
    }
    if (!nodeId && typeof target !== 'string') {
      const { frameTree } = await call<any>('Page.getFrameTree');
      const { nodes } = await call<any>('Accessibility.getFullAXTree', { frameId: frameTree.frame.id });
      const matches = nodes.filter((node: any) => !node.ignored && node.backendDOMNodeId && node.role?.value === target.role && String(node.name?.value ?? '').trim().replace(/\s+/g, ' ') === target.name.trim().replace(/\s+/g, ' '));
      if (matches.length > 1) throw new Error(`Flow role/name is ambiguous: ${target.role} ${target.name}`);
      backendNodeId = matches[0]?.backendDOMNodeId; resolvedBy = 'role-name';
    }
    if (!nodeId && !backendNodeId) return null;
    const { object } = await call<any>('DOM.resolveNode', nodeId ? { nodeId } : { backendNodeId });
    const result = await call<any>('Runtime.callFunctionOn', {
      objectId: object.objectId, returnByValue: true, awaitPromise: true, arguments: [{ value: act }],
      functionDeclaration: `async function(act) {
        if (!this.isConnected || !this.getClientRects().length || getComputedStyle(this).visibility==='hidden') return null;
        if (act) {this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}
        const box=this.getBoundingClientRect();
        const x=(Math.max(0,box.left)+Math.min(innerWidth,box.right))/2,y=(Math.max(0,box.top)+Math.min(innerHeight,box.bottom))/2;
        if (act === 'pointer' && !this.contains(document.elementFromPoint(x,y))) throw new Error('Flow action target is covered by another element');
        return {x,y};
      }`,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    if (!result.result.value) return null;
    return { ...result.result.value, resolvedBy, ...(typeof target === 'string' ? {} : { role: target.role, name: target.name }) };
  });
}
