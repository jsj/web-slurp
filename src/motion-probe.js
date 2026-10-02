(async () => {
  const warnings = [];
  const selector = el => {
    if (!el?.tagName) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    const path = [];
    for (let node = el; node?.tagName; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      const siblings = node.parentElement ? [...node.parentElement.children].filter(other => other.tagName === node.tagName) : [node];
      path.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
      if (node === document.body) break;
    }
    return path.join(' > ');
  };
  const properties = ['transform', 'opacity', 'width', 'height', 'filter'];
  const cssRules = [], keyframes = [];
  const walk = (rules, context = []) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) {
        keyframes.push({ name: rule.name, css: rule.cssText, context });
        continue;
      }
      // CSSStyleRule also has cssRules in modern Chrome, even when empty.
      if (rule.selectorText && rule.style) {
        const declarations = Object.fromEntries([...rule.style].map(name => [name, rule.style.getPropertyValue(name)]));
        if (rule.selectorText.includes(':hover') || Object.keys(declarations).some(name => /^(transition|animation)(-|$)/.test(name))) {
          cssRules.push({ selector: rule.selectorText, declarations, context });
        }
      }
      if (rule.cssRules?.length) walk(rule.cssRules, [...context, rule.conditionText || rule.selectorText || rule.name || String(rule.type)]);
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules, sheet.href ? [sheet.href] : ['inline']); }
    catch { warnings.push(`CSSOM unavailable: ${sheet.href || 'inline stylesheet'}`); }
  }
  const animationIds = new WeakMap(), animations = new Map();
  let animationCounter = 0;
  const collectAnimations = () => {
    for (const animation of document.getAnimations()) {
      if (!animationIds.has(animation)) animationIds.set(animation, ++animationCounter);
      const timing = animation.effect?.getTiming();
      if (!timing) continue;
      animations.set(animationIds.get(animation), {
        sourceId: `animation-${animationIds.get(animation)}`, target: selector(animation.effect?.target),
        playState: animation.playState, duration: timing.duration, delay: timing.delay,
        easing: timing.easing, iterations: Number.isFinite(timing.iterations) ? timing.iterations : null,
        infiniteIterations: timing.iterations === Infinity,
        keyframes: animation.effect.getKeyframes?.() || [],
      });
    }
  };
  const gsap = window.gsap || window.GSAP;
  const gsapAnimations = (() => {
    try {
      const children = gsap?.globalTimeline?.getChildren?.(true, true, true) || [];
      if (children.length > 200) warnings.push('GSAP timeline inspection limited to 200 entries.');
      return children.slice(0, 200).map(child => ({
        targets: (child.targets?.() || []).map(selector).filter(Boolean),
        duration: child.duration?.() ?? null, delay: child.delay?.() ?? null,
        repeat: child.repeat?.() ?? null, infiniteRepeat: child.repeat?.() === -1,
        ease: typeof child.vars?.ease === 'string' ? child.vars.ease : null,
        easeUnresolved: child.vars?.ease != null && typeof child.vars.ease !== 'string',
      }));
    } catch (error) { warnings.push(`GSAP timeline inspection failed: ${String(error)}`); return []; }
  })();
  const ST = window.ScrollTrigger || gsap?.core?.globals?.()?.ScrollTrigger;
  const triggers = new Map();
  const collectTriggers = () => {
    try {
      for (const trigger of ST?.getAll?.() || []) {
        const animation = trigger.animation;
        triggers.set(trigger, { target: selector(trigger.trigger), start: trigger.start, end: trigger.end,
          scrub: trigger.vars?.scrub ?? null, pin: !!trigger.pin,
          duration: animation?.duration?.() ?? null,
          ease: typeof animation?.vars?.ease === 'string' ? animation.vars.ease : null,
          targets: (animation?.targets?.() || []).map(selector).filter(Boolean) });
      }
    } catch (error) { warnings.push(`ScrollTrigger inspection failed: ${String(error)}`); }
  };
  const nodeIds = new WeakMap(), nodes = new Set(), uncertain = new Map();
  let nodeCounter = 0, truncated = false;
  const snapshot = () => {
    for (const node of document.querySelectorAll('[style]')) {
      if (nodes.size >= 500 && !nodes.has(node)) { truncated = true; continue; }
      nodes.add(node);
    }
    const frame = {};
    for (const node of nodes) {
      if (!node.isConnected) continue;
      if (!nodeIds.has(node)) nodeIds.set(node, `node-${++nodeCounter}`);
      frame[nodeIds.get(node)] = { selector: selector(node), ...Object.fromEntries(properties.map(p => [p, node.style[p] || null])) };
    }
    return frame;
  };
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const originalScroll = { x: scrollX, y: scrollY };
  const maxScroll = Math.max(document.documentElement.scrollHeight - innerHeight, 0);
  const positions = maxScroll ? [0, .1, .35, .7, 1] : [0];
  const down = {}, up = {}, audit = [];
  collectAnimations(); collectTriggers();
  const sample = async (fraction, sink, direction) => {
    window.scrollTo({ top: fraction * maxScroll, left: originalScroll.x, behavior: 'instant' });
    await pause();
    let previous = snapshot(), current = previous;
    for (let attempt = 0; attempt < 3; attempt++) {
      await pause(); current = snapshot();
      if (JSON.stringify(previous) === JSON.stringify(current)) break;
      if (attempt === 2) {
        for (const [id, values] of Object.entries(current)) {
          if (!previous[id]) continue;
          for (const property of properties) {
            if (values[property] === previous[id][property]) continue;
            if (!uncertain.has(id)) uncertain.set(id, new Set());
            uncertain.get(id).add(property);
          }
        }
      }
      previous = current;
    }
    sink[fraction] = current;
    audit.push({ fraction, direction, requestedY: fraction * maxScroll, observedY: scrollY });
    collectAnimations(); collectTriggers();
  };
  try {
    for (const position of positions) await sample(position, down, 'down');
    for (const position of [...positions].reverse()) await sample(position, up, 'up');
  } finally { window.scrollTo({ top: originalScroll.y, left: originalScroll.x, behavior: 'instant' }); }
  if (truncated) warnings.push('Inline-style sampling limited to 500 nodes.');
  const motion = [];
  const keys = new Set(positions.flatMap(position => Object.keys(down[position])));
  for (const id of keys) {
    const frames = positions.filter(p => down[p][id]);
    const target = down[frames[0]][id].selector;
    for (const property of properties) {
      const values = new Set(frames.map(p => down[p][id][property]));
      if (values.size < 2 && !uncertain.get(id)?.has(property)) continue;
      const paired = frames.filter(p => up[p][id]);
      const mismatches = paired.some(p => down[p][id][property] !== up[p][id][property]);
      const latched = mismatches && paired.length === frames.length && new Set(paired.map(p => up[p][id][property])).size === 1;
      const moving = uncertain.get(id)?.has(property);
      const unverified = moving || paired.length !== frames.length || (mismatches && !latched);
      motion.push({ sourceId: id, target, property,
        classification: unverified ? 'unverified' : latched ? 'latched-candidate' : 'scroll-candidate',
        reason: moving ? 'changes-at-stationary-scroll' : unverified ? 'not-repeatable-at-scroll-offset' : 'stable-during-sampling',
        samples: frames.map(p => ({ fraction: p, value: down[p][id][property], returnValue: up[p][id]?.[property] ?? null })) });
    }
  }
  if (maxScroll && new Set(audit.map(sample => sample.observedY)).size < 3) warnings.push('Scroll sweep could not reach distinct positions; inspect the page scroll container or smooth-scroll controller.');
  return { schemaVersion: 1, status: 'complete', url: location.href, capturedAt: new Date().toISOString(),
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
    originalScroll, maxScroll, audit, animations: [...animations.values()],
    gsap: gsap ? { version: gsap.version || null } : null, gsapAnimations, scrollTriggers: [...triggers.values()],
    cssRules, keyframes, inlineMotion: motion, warnings,
    limits: ['Candidates describe sampled evidence, not proof of scroll causation.', 'Only accessible stylesheets, exposed GSAP registries, and inline-style motion are inspected.', 'This sweep does not exercise hover or click controls, or record video.'] };
})()
