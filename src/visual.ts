import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { cdpCall, evaluate } from './cdp';

export function viewport(value = '1440x900'): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw new Error('Viewport must use WIDTHxHEIGHT, for example 1440x900.');
  const width = Number(match[1]), height = Number(match[2]);
  if (width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('Viewport dimensions must be between 1 and 8192 pixels.');
  return { width, height };
}

export async function screenshot(websocketUrl: string, target: string): Promise<void> {
  await evaluate(websocketUrl, 'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))');
  const clip = await evaluate<{ x: number; y: number; width: number; height: number; scale: number }>(websocketUrl, '({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,scale:devicePixelRatio})');
  const result = await cdpCall<{ data: string }>(websocketUrl, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
  writeFileSync(resolve(target, 'input/page-source/page.png'), Buffer.from(result.data, 'base64'), { flag: 'wx' });
}

export function compareImages(referencePath: string, actualPath: string, outdir: string) {
  const reference = PNG.sync.read(readFileSync(referencePath));
  const actual = PNG.sync.read(readFileSync(actualPath));
  const width = Math.max(reference.width, actual.width), height = Math.max(reference.height, actual.height);
  const pad = (source: PNG) => {
    const image = new PNG({ width, height });
    image.data.fill(255);
    PNG.bitblt(source, image, 0, 0, source.width, source.height, 0, 0);
    return image;
  };
  const diff = new PNG({ width, height });
  const changedPixels = pixelmatch(pad(reference).data, pad(actual).data, diff.data, width, height, { threshold: 0.1, diffMask: true });
  const tileWidth = Math.ceil(width / 4), tileHeight = Math.ceil(height / 4);
  const regions = Array.from({ length: 16 }, (_, index) => ({
    x: (index % 4) * tileWidth, y: Math.floor(index / 4) * tileHeight,
    width: Math.min(tileWidth, width - (index % 4) * tileWidth),
    height: Math.min(tileHeight, height - Math.floor(index / 4) * tileHeight), changedPixels: 0,
  }));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (diff.data[(y * width + x) * 4 + 3]) regions[Math.floor(y / tileHeight) * 4 + Math.floor(x / tileWidth)]!.changedPixels++;
  }
  const report = {
    reference: { path: referencePath, width: reference.width, height: reference.height },
    actual: { path: actualPath, width: actual.width, height: actual.height },
    changedPixels, changedPercent: changedPixels / (width * height) * 100,
    largestRegions: regions.filter(region => region.changedPixels > 0).sort((a, b) => b.changedPixels - a.changedPixels).slice(0, 5),
    note: 'Pixel differences highlight areas to inspect; they do not explain layout causes or verify behavior.',
  };
  mkdirSync(outdir, { recursive: true });
  writeFileSync(resolve(outdir, 'diff.png'), PNG.sync.write(diff), { flag: 'wx' });
  writeFileSync(resolve(outdir, 'comparison.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}
