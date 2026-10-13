import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: [new URL('../src/motion/overscroll.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { attachOverscrollMotion, elasticDistance, scrollEdge, hasNativeElasticity } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

// Small lifecycle fixture, not a fake chat runtime: only the public DOM markers,
// browser observers and immutable scroll geometry used by the controller exist.
class TrackedTarget extends EventTarget {
  listeners = new Map();
  addEventListener(type, listener, options) { super.addEventListener(type, listener, options); if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener, options) { super.removeEventListener(type, listener, options); this.listeners.get(type)?.delete(listener); }
  get listenerCount() { return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0); }
}
class Element extends TrackedTarget {
  parentElement = null; children = []; attributes = new Map();
  scrollTop = 0; clientHeight = 500; scrollHeight = 1100; clientWidth = 393; scrollWidth = 393;
  overflowY = 'visible'; tagName = 'DIV'; animations = [];
  values = new Map(); priorities = new Map(); classes = new Set();
  classList = { add: value => { this.classes.add(value); }, remove: value => { this.classes.delete(value); }, contains: value => this.classes.has(value) };
  style = { getPropertyValue: name => this.values.get(name) ?? '', getPropertyPriority: name => this.priorities.get(name) ?? '',
    setProperty: (name, value, priority = '') => { this.values.set(name, value); this.priorities.set(name, priority); }, removeProperty: name => { this.values.delete(name); this.priorities.delete(name); } };
  append(child) { this.children.push(child); child.parentElement = this; child.ownerDocument = this.ownerDocument; return child; }
  contains(node) { while (node !== null) { if (node === this) return true; node = node.parentElement; } return false; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  matches(selector) {
    if (selector === '.mobile-list') return this.classes.has('mobile-list');
    if (selector === '[data-conversation-content]') return this.attributes.has('data-conversation-content');
    if (selector === '[data-conversation-scroll], .mobile-list') return this.attributes.has('data-conversation-scroll') || this.classes.has('mobile-list');
    if (selector === '.is-nav-gesturing') return this.classes.has('is-nav-gesturing');
    if (selector === '[data-chat-flow]:not([data-step-process-content])') return this.attributes.has('data-chat-flow') && !this.attributes.has('data-step-process-content');
    if (selector === '[data-composer-seat]') return this.attributes.has('data-composer-seat');
    return this.excluded === true;
  }
  closest(selector) { let node = this; while (node !== null) { if (node.matches(selector)) return node; node = node.parentElement; } return null; }
  querySelector(selector) {
    if (selector === ':scope > ul') return this.children.find(child => child.tagName === 'UL') ?? null;
    for (const child of this.children) { if (child.matches(selector)) return child; const descendant = child.querySelector(selector); if (descendant !== null) return descendant; }
    return null;
  }
  animate(frames, options) {
    let finish;
    const animation = { frames, options, cancelled: 0, finished: new Promise(resolve => { finish = resolve; }), finish: () => { finish(); }, cancel() { this.cancelled++; finish(); } };
    this.animations.push(animation); return animation;
  }
}
function environment({ native = false, reduced = false, list = false, ready = true, enabled = true } = {}) {
  const document = new TrackedTarget(); document.visibilityState = 'visible'; let selection = '';
  document.getSelection = () => ({ toString: () => selection });
  const preference = new TrackedTarget(); preference.matches = reduced;
  const observers = []; const resizes = []; const frames = new Map(); let serial = 0;
  class Observer { targets = new Set(); constructor(callback) { this.callback = callback; observers.push(this); } observe(target) { this.targets.add(target); } disconnect() { this.targets.clear(); } trigger() { this.callback(); } }
  class Resize { targets = new Set(); constructor(callback) { this.callback = callback; resizes.push(this); } observe(target) { this.targets.add(target); } disconnect() { this.targets.clear(); } trigger() { this.callback(); } }
  const view = { Element, HTMLElement: Element, CSS: { supports: property => property === '-webkit-touch-callout' ? native : true },
    navigator: { userAgent: 'Mozilla Android Chrome', platform: 'Linux', maxTouchPoints: 1 }, matchMedia: () => preference,
    ResizeObserver: Resize, MutationObserver: Observer, getComputedStyle: node => ({ overflowY: node.overflowY }),
    requestAnimationFrame: callback => { frames.set(++serial, callback); return serial; }, cancelAnimationFrame: id => { frames.delete(id); } };
  document.defaultView = view;
  const root = new Element(); root.ownerDocument = document;
  const body = root.append(new Element()); body.setAttribute('data-conversation-content', ''); body.setAttribute('data-content-phase', 'active'); body.setAttribute('data-conversation-session', 'synthetic-owned');
  const port = (list ? root : body).append(new Element()); port.overflowY = 'auto';
  if (list) port.classes.add('mobile-list'); else port.setAttribute('data-conversation-scroll', '');
  const layer = port.append(new Element()); layer.clientHeight = 1100; layer.scrollHeight = 1100;
  if (list) layer.tagName = 'UL'; else layer.setAttribute('data-chat-flow', '');
  const target = layer.append(new Element()); target.clientHeight = 100; target.scrollHeight = 100;
  const composer = port.append(new Element()); composer.setAttribute('data-composer-seat', '');
  const controller = attachOverscrollMotion(root, { enabled, isReady: () => ready });
  function touch(type, x, y, { targetNode = target, multiple = false, cancelable = true } = {}) {
    const item = { identifier: 7, clientX: x, clientY: y };
    const touches = type === 'touchend' ? [] : multiple ? [item, { ...item, identifier: 8 }] : [item];
    Object.assign(touches, { item: index => touches[index] ?? null });
    const event = new Event(type, { cancelable }); Object.defineProperty(event, 'target', { value: targetNode });
    Object.assign(event, { touches, changedTouches: [item] }); root.dispatchEvent(event); return event;
  }
  function flush() { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => { callback(); }); }
  return { root, body, port, layer, target, composer, controller, document, view, preference, observers, resizes, frames, touch, flush,
    set ready(value) { ready = value; }, set selection(value) { selection = value; } };
}
const settled = () => new Promise(resolve => { setImmediate(resolve); });
const property = '--motion-edge-y';
function outward(env, end = 180) { env.touch('touchstart', 170, 100); return env.touch('touchmove', 172, end); }

test('resistance is monotonic, finite and bounded below 32px', () => {
  assert.equal(elasticDistance(0), 0); assert.equal(elasticDistance(-1), 0); assert.equal(elasticDistance(NaN), 0); assert.equal(elasticDistance(Infinity), 0);
  assert.ok(elasticDistance(100) > elasticDistance(50)); assert.ok(elasticDistance(10000) < 32); assert.ok(elasticDistance(Number.MAX_VALUE) <= 32);
});
test('only outward movement at physical top or bottom is eligible', () => {
  assert.equal(scrollEdge(0, 1100, 500, 30), 'top'); assert.equal(scrollEdge(600, 1100, 500, -30), 'bottom');
  assert.equal(scrollEdge(200, 1100, 500, 30), undefined); assert.equal(scrollEdge(0, 1100, 500, -30), undefined);
  assert.equal(scrollEdge(600, 1100, 500, 30), undefined); assert.equal(scrollEdge(0, 100, 0, 30), undefined); assert.equal(scrollEdge(NaN, 1100, 500, 30), undefined);
});
test('native iOS capability and iPad desktop identity disable fallback entirely', () => {
  const env = environment({ native: true }); assert.equal(env.root.listenerCount, 0); assert.equal(env.observers.length, 0);
  assert.equal(outward(env).defaultPrevented, false); env.controller.dispose();
  env.view.CSS.supports = () => false; env.view.navigator.userAgent = 'iPhone'; assert.equal(hasNativeElasticity(env.view), true);
  env.view.navigator.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit'; env.view.navigator.maxTouchPoints = 5; assert.equal(hasNativeElasticity(env.view), true);
});
test('top pull translates only the verified transcript, never scroller or composer', async () => {
  const env = environment(); const top = env.port.scrollTop;
  assert.equal(outward(env).defaultPrevented, true); assert.equal(env.frames.size, 1); env.flush();
  assert.ok(parseFloat(env.layer.values.get(property)) > 0); assert.equal(env.port.values.has(property), false); assert.equal(env.composer.values.has(property), false);
  assert.equal(env.port.scrollTop, top); env.touch('touchend', 172, 180);
  assert.equal(env.layer.animations.length, 1); env.layer.animations[0].finish(); await settled();
  assert.equal(env.layer.classes.has('mobile-elastic-content'), false); assert.equal(env.layer.values.has(property), false); env.controller.dispose();
});
test('bottom pull uses negative bounded translation and preserves real scroll position', () => {
  const env = environment(); env.port.scrollTop = 600;
  assert.equal(outward(env, 20).defaultPrevented, true); env.flush();
  const offset = parseFloat(env.layer.values.get(property)); assert.ok(offset < 0 && offset > -32); assert.equal(env.port.scrollTop, 600); env.controller.dispose();
});
test('owned list uses its ul rather than moving the list scrollport', () => {
  const env = environment({ list: true }); assert.equal(outward(env).defaultPrevented, true); env.flush();
  assert.equal(env.layer.classes.has('mobile-elastic-content'), true); assert.equal(env.port.classes.has('mobile-elastic-content'), false); env.controller.dispose();
});
test('interior, inward, diagonal and horizontal gestures retain native scrolling', () => {
  const interior = environment(); interior.port.scrollTop = 200; assert.equal(outward(interior).defaultPrevented, false); interior.controller.dispose();
  for (const [x, y] of [[170, 30], [250, 104], [183, 113]]) {
    const env = environment(); env.touch('touchstart', 170, 100); assert.equal(env.touch('touchmove', x, y).defaultPrevented, false); assert.equal(env.frames.size, 0); env.controller.dispose();
  }
});
test('controls, composer, horizontal scrollers, nested vertical ledgers and selection are excluded', () => {
  for (const kind of ['control', 'composer', 'horizontal', 'nested', 'selection']) {
    const env = environment(); let target = env.target;
    if (kind === 'control') target.excluded = true;
    if (kind === 'composer') target = env.composer;
    if (kind === 'horizontal') { target.scrollWidth = 700; }
    if (kind === 'nested') { target.scrollHeight = 700; target.clientHeight = 100; target.overflowY = 'auto'; }
    if (kind === 'selection') env.selection = 'reading';
    env.touch('touchstart', 170, 100, { targetNode: target }); assert.equal(env.touch('touchmove', 172, 180, { targetNode: target }).defaultPrevented, false);
    assert.equal(env.frames.size, 0); env.controller.dispose();
  }
});
test('replay, admission, IME, hidden pages, navigation drag and reduced motion never animate', () => {
  for (const kind of ['replay', 'admission', 'IME', 'hidden', 'navigation', 'reduced']) {
    const env = environment();
    if (kind === 'replay') env.body.setAttribute('data-content-phase', 'settling');
    if (kind === 'admission') env.ready = false;
    if (kind === 'IME') env.root.dispatchEvent(new Event('compositionstart'));
    if (kind === 'hidden') env.document.visibilityState = 'hidden';
    if (kind === 'navigation') env.body.classes.add('is-nav-gesturing');
    if (kind === 'reduced') env.preference.matches = true;
    assert.equal(outward(env).defaultPrevented, false); assert.equal(env.frames.size, 0); env.controller.dispose();
  }
});
test('preference changes, cancellation, multitouch and native scroll reset active transforms', () => {
  for (const kind of ['preference', 'cancel', 'multiple', 'scroll', 'selection', 'hidden']) {
    const env = environment(); outward(env); env.flush();
    if (kind === 'preference') { env.preference.matches = true; env.preference.dispatchEvent(new Event('change')); }
    if (kind === 'cancel') env.touch('touchcancel', 172, 180);
    if (kind === 'multiple') env.touch('touchstart', 172, 180, { multiple: true });
    if (kind === 'scroll') { const event = new Event('scroll'); Object.defineProperty(event, 'target', { value: env.port }); env.root.dispatchEvent(event); }
    if (kind === 'selection') env.document.dispatchEvent(new Event('selectionchange'));
    if (kind === 'hidden') env.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(env.layer.values.has(property), false); assert.equal(env.frames.size, 0); env.controller.dispose();
  }
});
test('route removal and session identity changes cancel without mutating renderer state', () => {
  for (const kind of ['removed', 'identity']) {
    const env = environment(); outward(env); env.flush();
    if (kind === 'removed') env.port.parentElement = null;
    else env.body.setAttribute('data-conversation-session', 'different-owned');
    env.observers[0].trigger(); assert.equal(env.layer.values.has(property), false); env.controller.dispose();
  }
});
test('initial ResizeObserver delivery does not cancel; actual geometry changes do', () => {
  const env = environment(); outward(env); env.resizes[0].trigger(); assert.equal(env.frames.size, 1); env.flush();
  env.port.clientHeight = 420; env.resizes[0].trigger(); assert.equal(env.layer.values.has(property), false); env.controller.dispose();
});
test('inline state is restored and disposal cleans queued frames, spring and all listeners', async () => {
  const env = environment(); env.layer.style.setProperty(property, '2px', 'important');
  outward(env); env.flush(); env.touch('touchend', 172, 180); const animation = env.layer.animations[0];
  env.controller.dispose(); await settled();
  assert.equal(env.layer.values.get(property), '2px'); assert.equal(env.layer.priorities.get(property), 'important'); assert.ok(animation.cancelled > 0);
  assert.equal(env.root.listenerCount, 0); assert.equal(env.document.listenerCount, 0); assert.equal(env.preference.listenerCount, 0);
  assert.ok(env.observers.every(observer => observer.targets.size === 0)); assert.ok(env.resizes.every(observer => observer.targets.size === 0));
  assert.equal(outward(env).defaultPrevented, false); env.controller.dispose();
  const queued = environment(); outward(queued); assert.equal(queued.frames.size, 1); queued.controller.dispose(); assert.equal(queued.frames.size, 0);
});
test('missing safe visual column, detached documents and disabled mode stay inert', () => {
  const missing = environment(); missing.layer.attributes.delete('data-chat-flow'); assert.equal(outward(missing).defaultPrevented, false); missing.controller.dispose();
  const disabled = environment({ enabled: false }); assert.equal(disabled.root.listenerCount, 0); disabled.controller.dispose();
  const root = new Element(); root.ownerDocument = { defaultView: null }; attachOverscrollMotion(root).dispose(); assert.equal(root.listenerCount, 0);
});
