import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { captureMotion } from '../src/motion';

const html = (scrollable: boolean) => `<!doctype html><html><head><title>Motion control</title><style>
body{margin:0;height:${scrollable ? '4000' : '300'}px}div{position:fixed;width:80px;height:80px;top:100px}
#scrub{left:20px}#timer{left:120px}#pulse{left:220px}#finite{left:320px}
button{transition:transform .24s ease}button:hover{transform:scale(1.1)}
@media(min-width:600px){.card:hover{opacity:.5}}
@keyframes breathe{from{opacity:.2}to{opacity:1}}
</style></head><body><button>Hover control</button><div id="scrub"></div><div id="timer"></div><div id="pulse"></div><div id="finite"></div><script>
const scrub=document.querySelector('#scrub'),timer=document.querySelector('#timer');
function update(){scrub.style.transform='translateY('+scrollY/10+'px)';timer.style.opacity=String(scrollY/4000)}
update();addEventListener('scroll',update);
let tick=0;setInterval(()=>{timer.style.transform='translateX('+(++tick%100)+'px)'},30);
document.querySelector('#pulse').animate([{opacity:.2},{opacity:1}],{duration:1200,easing:'ease-in-out',iterations:Infinity});
document.querySelector('#finite').animate([{opacity:0},{opacity:1}],{duration:100000,iterations:3});
window.gsap={version:'fixture'};window.ScrollTrigger={getAll:()=>[{trigger:scrub,start:50,end:300,vars:{scrub:1},pin:false,animation:{duration:()=>1.2,vars:{ease:'power2.out'},targets:()=>[scrub]}}]};
</script></body></html>`;

for (const scrollable of [true, false]) test(`motion capture separates timers and scroll evidence (${scrollable ? 'scrollable' : 'short'} page)`, async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-motion-'));
  const target = resolve(root, 'capture');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(html(scrollable), { headers: { 'content-type': 'text/html' } }) });
  try {
    const child = Bun.spawn(['bun', resolve(import.meta.dir, '../src/cli.ts'), 'capture', server.url.href, '--out', target, '--motion'], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(stderr).toBe(''); expect(stdout).toContain('Motion evidence:');
    const evidence = JSON.parse(readFileSync(resolve(target, 'input/motion/runtime.json'), 'utf8'));
    expect(evidence.status).toBe('complete');
    const pulse = evidence.animations.find((a: any) => a.target === '#pulse');
    expect(pulse.duration).toBe(1200); expect(pulse.easing).toBe('ease-in-out');
    expect(pulse.iterations).toBeNull(); expect(pulse.infiniteIterations).toBe(true);
    expect(pulse.keyframes).toHaveLength(2);
    const finite = evidence.animations.find((a: any) => a.target === '#finite');
    expect(finite.iterations).toBe(3); expect(finite.infiniteIterations).toBe(false);
    expect(evidence.cssRules.find((r: any) => r.selector === 'button:hover').declarations.transform).toBe('scale(1.1)');
    expect(evidence.cssRules.find((r: any) => r.selector === '.card:hover').context).toContain('(min-width: 600px)');
    expect(evidence.keyframes[0].name).toBe('breathe');
    expect(evidence.scrollTriggers[0]).toMatchObject({ target: '#scrub', start: 50, end: 300, scrub: 1, duration: 1.2, ease: 'power2.out' });
    const timer = evidence.inlineMotion.find((row: any) => row.target === '#timer' && row.property === 'transform');
    expect(timer.classification).toBe('unverified');
    expect(timer.reason).toBe('changes-at-stationary-scroll');
    if (scrollable) {
      const scrub = evidence.inlineMotion.find((row: any) => row.target === '#scrub' && row.property === 'transform');
      expect(scrub.classification).toBe('scroll-candidate');
      expect(scrub.samples.at(-1).value).toBe(`translateY(${evidence.maxScroll / 10}px)`);
      expect(evidence.inlineMotion.find((row: any) => row.target === '#timer' && row.property === 'opacity').classification).toBe('scroll-candidate');
    } else {
      expect(evidence.maxScroll).toBe(0);
      expect(evidence.inlineMotion.every((row: any) => row.classification === 'unverified')).toBe(true);
    }
    const original = readFileSync(resolve(target, 'input/page-source/codex.rendered.html'), 'utf8');
    const repeated = Bun.spawn(['bun', resolve(import.meta.dir, '../src/cli.ts'), 'capture', server.url.href, '--out', target, '--motion'], { stdout: 'ignore', stderr: 'pipe' });
    expect(await repeated.exited).toBe(1);
    expect(readFileSync(resolve(target, 'input/page-source/codex.rendered.html'), 'utf8')).toBe(original);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test('motion failures retain evidence and refuse to overwrite it', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'web-slurp-motion-'));
  try {
    await expect(captureMotion(root, 'ws://127.0.0.1:1')).rejects.toThrow();
    const path = resolve(root, 'input/motion/runtime.json');
    const before = readFileSync(path, 'utf8');
    expect(JSON.parse(before).status).toBe('error');
    await expect(captureMotion(root, 'ws://127.0.0.1:1')).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
