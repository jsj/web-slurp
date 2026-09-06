import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { cdpCall } from './cdp';

export type CapturedAsset = {
  url: string;
  path: string;
  mimeType: string;
  type: string;
  status: 'saved' | 'failed';
  error?: string;
};
export type AssetManifest = { version: 1; assets: CapturedAsset[] };
type ResourceTree = {
  frame: { id: string };
  resources: { url: string; mimeType: string; type: string; failed?: boolean; canceled?: boolean }[];
  childFrames?: ResourceTree[];
};

/** Save static resources observed by Chrome. CDP may reload evicted content through the browser. */
export async function collectAssets(websocketUrl: string, target: string, signal?: AbortSignal): Promise<AssetManifest> {
  signal?.throwIfAborted();
  const { frameTree } = await cdpCall<{ frameTree: ResourceTree }>(websocketUrl, 'Page.getResourceTree');
  const manifest: AssetManifest = { version: 1, assets: [] };
  const seen = new Set<string>();
  const directory = resolve(target, 'input/assets');
  await mkdir(directory, { recursive: true });
  async function visit(tree: ResourceTree): Promise<void> {
    for (const resource of tree.resources) {
      signal?.throwIfAborted();
      if (!['Script', 'Stylesheet', 'Image', 'Font'].includes(resource.type)) continue;
      const url = new URL(resource.url);
      url.hash = '';
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const extension = extname(url.pathname);
      const filename = createHash('sha256').update(url.href).digest('hex') + (/^\.[a-zA-Z0-9]{1,10}$/.test(extension) ? extension : '');
      const asset: CapturedAsset = { url: url.href, path: `input/assets/${filename}`, mimeType: resource.mimeType, type: resource.type, status: 'failed' };
      manifest.assets.push(asset);
      try {
        if (resource.failed || resource.canceled) throw new Error('Chrome reported the resource failed or was canceled');
        const result = await cdpCall<{ content: string; base64Encoded: boolean }>(websocketUrl, 'Page.getResourceContent', { frameId: tree.frame.id, url: resource.url }, ['Page']);
        signal?.throwIfAborted();
        await writeFile(resolve(directory, filename), Buffer.from(result.content, result.base64Encoded ? 'base64' : 'utf8'));
        asset.status = 'saved';
      } catch (error) { asset.error = error instanceof Error ? error.message : String(error); }
    }
    for (const child of tree.childFrames ?? []) await visit(child);
  }
  await visit(frameTree);
  signal?.throwIfAborted();
  await writeFile(resolve(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
