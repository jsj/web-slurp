import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withCdpSession } from './cdp';

const properties = ['display', 'position', 'box-sizing', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap', 'grid-template-columns', 'grid-template-rows', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'background-color', 'border-radius', 'border-top-width', 'border-top-style', 'border-top-color', 'opacity', 'transform', 'overflow', 'z-index'];

export async function captureLayout(target: string, websocketUrl: string, selector: string | boolean): Promise<void> {
  const rootSelector = selector === true ? 'body' : String(selector);
  const directory = resolve(target, 'input/layout');
  mkdirSync(resolve(target, 'input'), { recursive: true }); mkdirSync(directory);
  const path = resolve(directory, 'layout.json');
  const report: Record<string, any> = { schemaVersion: 1, status: 'partial', rootSelector, warnings: [] };
  const save = () => writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  save();
  try {
    const stylesheetUrls = new Map<string, string>();
    await withCdpSession(websocketUrl, async call => {
      await call('DOM.enable'); await call('CSS.enable');
      const evaluated = await call<any>('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        const root = document.querySelector(${JSON.stringify(rootSelector)});
        if (!root) throw new Error('Layout selector matched no element');
        const selectorFor = el => {
          if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
          const parts = [];
          for (let node = el; node; node = node.parentElement) {
            const siblings = node.parentElement ? [...node.parentElement.children].filter(n => n.tagName === node.tagName) : [node];
            parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
          }
          return parts.join(' > ');
        };
        const visible = [root, ...root.querySelectorAll('*')].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
        return { url: location.href, capturedAt: new Date().toISOString(), viewport: {width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio}, scroll:{x:scrollX,y:scrollY}, totalVisible:visible.length,
          elements: visible.slice(0,200).map(el => {
            const r=el.getBoundingClientRect(), style=getComputedStyle(el);
            return { selector:selectorFor(el), tag:el.tagName.toLowerCase(), rect:{x:r.x,y:r.y,width:r.width,height:r.height},
              documentRect:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height},
              computed:Object.fromEntries(${JSON.stringify(properties)}.map(p=>[p,style.getPropertyValue(p)])) };
          }) };
      })()` });
      if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
      Object.assign(report, evaluated.result.value);
      if (report.totalVisible > 200) report.warnings.push('Layout measurement limited to 200 visible elements.');
      const { root } = await call<any>('DOM.getDocument', { depth: 0 });
      const style = (value: any) => {
        if (!value) return null;
        const styleSheetId = value.styleSheetId;
        return { styleSheetId: styleSheetId ?? null, range: value.range ?? null,
          properties: (value.cssProperties || []).filter((p: any) => !p.disabled && p.parsedOk !== false).map((p: any) => ({ name: p.name, value: p.value, important: !!p.important, implicit: !!p.implicit })) };
      };
      for (const [index, element] of report.elements.entries()) {
        if (index >= 20) { element.rulesStatus = 'not-sampled'; continue; }
        try {
          const { nodeId } = await call<any>('DOM.querySelector', { nodeId: root.nodeId, selector: element.selector });
          if (!nodeId) throw new Error('Element changed during capture');
          const matched = await call<any>('CSS.getMatchedStylesForNode', { nodeId });
          const rules = async (matches: any[]) => Promise.all(matches.map(async match => ({ selector: match.rule.selectorList.text, origin: match.rule.origin,
            sourceUrl: stylesheetUrls.get(match.rule.styleSheetId ?? match.rule.style?.styleSheetId) ?? match.rule.sourceURL ?? null, matchingSelectors: match.matchingSelectors,
            media: (match.rule.media || []).map((m: any) => m.text), style: await style(match.rule.style) })));
          element.rules = { inline: await style(matched.inlineStyle), matched: await rules(matched.matchedCSSRules || []),
            inherited: await Promise.all((matched.inherited || []).map(async (entry: any) => ({ inline: await style(entry.inlineStyle), matched: await rules(entry.matchedCSSRules || []) }))) };
          element.rulesStatus = 'captured';
        } catch (error) { element.rulesStatus = 'error'; element.rulesError = String(error); report.warnings.push(`Rule capture for ${element.selector}: ${String(error)}`); }
      }
    }, (method, params) => {
      if (method === 'CSS.styleSheetAdded') stylesheetUrls.set(params.header.styleSheetId, params.header.sourceURL);
    });
    report.status = 'complete';
    report.limits = ['Measured geometry is a rendered snapshot; matched rules are candidates, not a computed cascade explanation.', '200 visible elements measured; matched and inherited rules sampled for the first 20.', 'Main-document elements only; iframe and shadow-root traversal are not included.'];
    save(); console.log(`Layout evidence: ${path}`);
  } catch (error) { report.error = String(error); save(); throw error; }
}
