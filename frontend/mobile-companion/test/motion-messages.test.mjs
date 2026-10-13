import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageMotionGate, attachMessageMotion, flightTransform, normalizeMessageText, MESSAGE_MOTION } from '../src/motion/messages.ts';
const row = (key, kind = 'user', text = 'hello', turn = 3, extra = {}) => ({ key, kind, text, turn, ...extra });

test('intent does not animate local echo, mismatched text, duplicate or existing history', () => {
  const gate = new MessageMotionGate(); gate.prime([row('old', 'user', 'hello', 2)]); gate.intent('hello', 0);
  assert.equal(gate.observe(row('old', 'user', 'hello', 2), 1, true), undefined);
  assert.equal(gate.observe(row('echo', 'user', 'hello', 3, { echo: true }), 2, true), undefined);
  assert.equal(gate.observe(row('wrong', 'user', 'different', 3), 3, true), undefined);
  assert.equal(gate.observe(row('admitted'), 4, true), 'user');
  assert.equal(gate.observe(row('admitted'), 5, true), undefined);
});
test('failed/cancelled/expired and command intentions never produce a flight', () => {
  for (const mode of ['cancel', 'expire', 'command']) {
    const gate = new MessageMotionGate(); gate.intent(mode === 'command' ? '/model' : 'hello', 0, 10);
    if (mode === 'cancel') gate.cancel();
    assert.equal(gate.observe(row('new'), mode === 'expire' ? 11 : 1, true), undefined);
  }
});
test('new response enters once at first visible token, never on every streaming chunk', () => {
  const gate = new MessageMotionGate(); gate.prime([row('old', 'assistant-step', 'old reply', 2)]); gate.intent('hello', 0);
  assert.equal(gate.observe(row('user'), 1, true), 'user');
  assert.equal(gate.observe(row('answer', 'assistant-step', '', 3), 2, true), undefined);
  assert.equal(gate.observe(row('answer', 'assistant-step', 'first', 3), 3, true), 'incoming');
  assert.equal(gate.observe(row('answer', 'assistant-step', 'first second', 3), 4, true), undefined);
  assert.equal(gate.observe(row('answer', 'assistant', 'final message', 3), 5, true), undefined);
});
test('old paging, hidden reasoning, tool/approval rows and disconnected/reload history do not enter', () => {
  const gate = new MessageMotionGate(); gate.prime([row('latest', 'assistant-step', 'cached', 7)]); gate.intent('hello', 0);
  assert.equal(gate.observe(row('paged-user', 'user', 'hello', 2), 1, true), undefined);
  assert.equal(gate.observe(row('paged', 'assistant-step', 'older', 2), 1, true, true), undefined);
  assert.equal(gate.observe(row('reason', 'assistant-step', 'reason', 8, { hidden: true }), 1, true, true), undefined);
  assert.equal(gate.observe(row('approval', 'tool-call', 'approve', 8), 1, true, true), undefined);
  assert.equal(gate.observe(row('reload', 'assistant-step', 'cached', 7), 1, true, false), undefined);
  assert.equal(gate.observe(row('fresh', 'assistant-step', 'live', 8), 1, true, true), 'incoming');
});
test('reading above never causes flight, rise, incoming animation or scroll/focus calls', () => {
  const gate = new MessageMotionGate(); gate.intent('hello', 0);
  assert.equal(gate.observe(row('admitted'), 1, false), undefined);
  assert.equal(gate.observe(row('answer', 'assistant-step', 'new', 3), 2, false, true), undefined);
});
test('flight coordinates stay finite and native geometry is not mutated', () => {
  const from = Object.freeze({ x: 20, y: 720, width: 300, height: 70 });
  assert.deepEqual(flightTransform(from, Object.freeze({ x: 140, y: 420, width: 230, height: 54 })), { x: -85, y: 308, scaleX: .98, scaleY: .98 });
  assert.deepEqual(flightTransform(from, { x: 0, y: 0, width: 0, height: 0 }), { x: 170, y: 755, scaleX: .98, scaleY: .98 });
  const wideToTall = flightTransform(from, { x: 140, y: 420, width: 120, height: 240 });
  assert.equal(wideToTall.scaleX, wideToTall.scaleY, 'glyphs must never be stretched independently');
  assert.equal(normalizeMessageText('  a\r\nb  '), 'a\nb'); assert.equal(MESSAGE_MOTION.flight, 440);
});
test('priming a pending echo does not block its in-place durable admission', () => {
  const gate = new MessageMotionGate(); gate.prime([row('same', 'user', 'hello', 3, { echo: true })]); gate.intent('hello', 0);
  assert.equal(gate.known('same'), false);
  assert.equal(gate.observe(row('same', 'user', 'hello', 3, { echo: true }), 1, true), undefined);
  assert.equal(gate.observe(row('same'), 2, true), 'user');
});
test('same-turn live history, exact expiry boundary and invalid timeouts fail closed', () => {
  const gate = new MessageMotionGate(); gate.prime([row('baseline', 'assistant-step', 'history', 7)]);
  assert.equal(gate.observe(row('other-history', 'assistant-step', 'cached', 7), 1, true, true), undefined);
  for (const timeout of [0, -1, NaN, Infinity]) {
    const invalid = new MessageMotionGate(); invalid.intent('hello', 0, timeout);
    assert.equal(invalid.observe(row('user'), 0, true), undefined);
  }
  const expired = new MessageMotionGate(); expired.intent('hello', 0, 10);
  assert.equal(expired.observe(row('user'), 10, true), undefined);
});
test('paging an older once-admitted turn cannot restart incoming motion after newer durable users', () => {
  const gate = new MessageMotionGate(); gate.intent('hello', 0);
  assert.equal(gate.observe(row('user-three'), 1, true), 'user');
  assert.equal(gate.observe(row('remote-four', 'user', 'another message', 4), 2, true), undefined);
  assert.equal(gate.observe(row('paged-three', 'assistant-step', 'old response', 3), 3, true), undefined);
  gate.intent('hello', 4);
  assert.equal(gate.observe(row('user-five', 'user', 'hello', 5), 5, true), 'user');
  assert.equal(gate.observe(row('new-five', 'assistant-step', 'first', 5), 6, true), 'incoming');
});

// These structural fixtures model the inspected rc.2 public DOM seam, not a browser.
// Geometry, observer delivery and WAAPI completion remain deterministic and explicit.
function environment(reduced = false) {
  const frames = new Map(), timers = new Map(), mediaEvents = new Map(), animations = [];
  let id = 0, disconnected = false, observerCallback, failAnimation = false;
  const document = { defaultView: null };
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.attributes = new Map(); this.children = [];
      this.parentElement = null; this.style = { opacity: '', visibility: '' }; this.listeners = new Map(); this.text = '';
      this.isContentEditable = false; this.measures = 0; this.box = { x: 0, y: 400, width: 230, height: 54 };
      this.scrollHeight = 1000; this.clientHeight = 600; this.scrollTop = 400;
    }
    get firstElementChild() { return this.children[0] ?? null; }
    get isConnected() { return this === document.body || this.parentElement?.isConnected === true; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.text = value; this.children = []; }
    get innerText() { return this.textContent; }
    set innerText(value) { this.textContent = value; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    remove() {
      if (this.parentElement !== null) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    contains(child) { return child === this || this.children.some(node => node.contains(child)); }
    matches(selector) {
      return selector.split(',').some(choice => {
        const parts = choice.trim().split(/\s+/);
        const simple = (element, part) => {
          const tag = /^[a-z-]+/i.exec(part)?.[0];
          if (tag !== undefined && element.tagName !== tag.toUpperCase()) return false;
          const attributes = [...part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
          return (tag !== undefined || attributes.length > 0) && attributes.every(([, name, value]) =>
            value === undefined ? element.hasAttribute(name) : element.getAttribute(name) === value);
        };
        if (!simple(this, parts.pop())) return false;
        let ancestor = this.parentElement;
        while (parts.length > 0) {
          const part = parts.pop();
          while (ancestor !== null && !simple(ancestor, part)) ancestor = ancestor.parentElement;
          if (ancestor === null) return false;
          ancestor = ancestor.parentElement;
        }
        return true;
      });
    }
    closest(selector) {
      for (let element = this; element !== null; element = element.parentElement) if (element.matches(selector)) return element;
      return null;
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    getBoundingClientRect() { this.measures++; return this.box; }
    animate(keyframes, options) {
      if (failAnimation) throw new Error('WAAPI unavailable');
      const animation = {
        element: this, keyframes, options, cancelled: false, onfinish: null, oncancel: null,
        cancel() { this.cancelled = true; this.oncancel?.(); },
      };
      animations.push(animation); return animation;
    }
  }
  class Input extends Element { constructor() { super('input'); this.value = ''; this.disabled = false; this.readOnly = false; } }
  class Textarea extends Input { constructor() { super(); this.tagName = 'TEXTAREA'; } }
  class Button extends Element { constructor() { super('button'); this.disabled = false; } }
  const media = {
    matches: reduced,
    addEventListener(name, callback) { mediaEvents.set(name, callback); },
    removeEventListener(name, callback) { if (mediaEvents.get(name) === callback) mediaEvents.delete(name); },
  };
  const view = {
    Element, HTMLElement: Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, HTMLButtonElement: Button,
    performance: { now: () => 0 }, matchMedia: () => media,
    requestAnimationFrame(callback) { frames.set(++id, callback); return id; },
    cancelAnimationFrame(frame) { frames.delete(frame); },
    setTimeout(callback) { timers.set(++id, callback); return id; },
    clearTimeout(timer) { timers.delete(timer); },
    getComputedStyle: () => ({ backgroundColor: 'blue', color: 'white', font: '14px sans-serif', padding: '12px', borderRadius: '24px' }),
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() { /* Delivery is explicitly driven by mutate(). */ }
      disconnect() { disconnected = true; }
    },
  };
  document.defaultView = view; document.createElement = tag => new Element(tag); document.body = new Element('body');
  const root = document.body.appendChild(new Element()); root.box = { x: 0, y: 0, width: 393, height: 852 };
  const chatRoot = root.appendChild(new Element()); chatRoot.setAttribute('data-chat-following-tail', '');
  const scroll = chatRoot.appendChild(new Element()); scroll.setAttribute('data-conversation-scroll', '');
  const flow = scroll.appendChild(new Element()); flow.setAttribute('data-chat-flow', '');
  const composer = root.appendChild(new Element()); composer.setAttribute('data-composer-seat', '');
  const editor = composer.appendChild(new Element()); editor.setAttribute('data-composer-input', 'true'); editor.setAttribute('role', 'textbox');
  editor.isContentEditable = true; editor.box = { x: 0, y: 700, width: 300, height: 70 };
  const send = composer.appendChild(new Button()); send.setAttribute('aria-label', 'Send message');
  return {
    root, editor, send, composer, chatRoot, flow, frames, timers, events: root.listeners, media, mediaEvents, animations, document,
    get disconnected() { return disconnected; }, get reads() { return editor.measures; },
    failAnimations() { failAnimation = true; },
    flush() {
      while (frames.size > 0) {
        const next = [...frames]; frames.clear();
        for (const [, callback] of next) callback();
      }
    },
    mutate(target) { observerCallback([{ type: 'attributes', target }]); },
    click(target = send) { root.listeners.get('click')({ target }); },
    key(extra = {}) { root.listeners.get('keydown')({ key: 'Enter', shiftKey: false, isComposing: false, target: editor, ...extra }); },
    addRow(key, text = 'hello', kind = 'user', turn = 3, { echo = false, attachment = false } = {}) {
      const row = flow.appendChild(new Element());
      row.setAttribute('data-chat-flow-key', key); row.setAttribute('data-chat-node-key', key);
      row.setAttribute('data-chat-flow-kind', kind); row.setAttribute('data-chat-turn', String(turn));
      const seat = row.appendChild(new Element()); seat.setAttribute('data-slot', 'conversation.chat.node');
      const user = seat.appendChild(new Element()); if (echo) user.setAttribute('data-submission-echo', '');
      const stack = user.appendChild(new Element());
      if (attachment) { const files = stack.appendChild(new Element()); files.setAttribute('data-message-attachments', 'true'); files.textContent = 'attachment.pdf'; }
      const bubble = stack.appendChild(new Element()); bubble.textContent = text;
      return { row, bubble, user, stack };
    },
    ghosts() { return document.body.children.filter(child => child.className === 'mobile-message-flight'); },
  };
}

test('reduced motion suppresses even measuring intent and disposes every observer/listener/frame', () => {
  const env = environment(true); const controller = attachMessageMotion(env.root, { isFollowingTail: () => true });
  controller.captureIntent({ text: 'hello' }); assert.equal(env.reads, 0); assert.equal(env.events.size, 2);
  controller.dispose(); controller.dispose();
  assert.equal(env.disconnected, true); assert.equal(env.events.size, 0); assert.equal(env.mediaEvents.size, 0); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
});
test('runtime reduced-motion change cancels pending intent, timeout and frames', () => {
  const env = environment(); const controller = attachMessageMotion(env.root, { isFollowingTail: () => true });
  controller.captureIntent({ text: 'hello' }); assert.equal(env.reads, 1); assert.equal(env.timers.size, 1);
  env.media.matches = true; env.mediaEvents.get('change')(); controller.dispose();
  assert.equal(env.disconnected, true); assert.equal(env.events.size, 0); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
});
test('native contenteditable capture admits only durable text bubble, not echo or attachments', () => {
  const env = environment(); const controller = attachMessageMotion(env.root); env.flush();
  env.editor.innerText = 'hello'; env.click();
  const sent = env.addRow('user', 'hello', 'user', 3, { echo: true, attachment: true });
  env.mutate(sent.row); env.flush(); assert.equal(env.ghosts().length, 0);
  sent.user.removeAttribute('data-submission-echo'); env.mutate(sent.user); env.flush();
  assert.equal(env.ghosts().length, 1); assert.equal(env.ghosts()[0].textContent, 'hello');
  assert.equal(env.ghosts()[0].getAttribute('aria-hidden'), 'true'); assert.equal(sent.bubble.style.opacity, '0'); assert.equal(sent.bubble.style.visibility, '');
  const reply = env.addRow('answer', '', 'assistant-step'); env.mutate(reply.row); env.flush(); assert.equal(env.animations.length, 1);
  reply.bubble.textContent = 'first'; env.mutate(reply.bubble); env.flush(); assert.equal(env.animations.length, 2);
  reply.bubble.textContent = 'first second'; env.mutate(reply.bubble); env.flush(); assert.equal(env.animations.length, 2);
  controller.dispose(); assert.equal(sent.bubble.style.opacity, ''); assert.equal(env.ghosts().length, 0); assert.ok(env.animations.every(animation => animation.cancelled));
});
test('native not-following marker absence overrides near-tail geometric fallback', () => {
  const env = environment(); env.chatRoot.removeAttribute('data-chat-following-tail');
  const controller = attachMessageMotion(env.root); env.flush(); env.editor.innerText = 'hello'; env.click();
  assert.equal(env.reads, 0); const sent = env.addRow('user'); env.mutate(sent.row); env.flush(); assert.equal(env.animations.length, 0); controller.dispose();
});
test('active flight restores prior opacity on reduced-motion, completion, cancellation and disposal', () => {
  for (const mode of ['reduce', 'finish', 'cancel', 'dispose']) {
    const env = environment(); const controller = attachMessageMotion(env.root); env.flush(); controller.captureIntent({ text: 'hello' });
    const sent = env.addRow('user'); sent.bubble.style.opacity = '.6'; env.mutate(sent.row); env.flush(); assert.equal(sent.bubble.style.opacity, '0');
    if (mode === 'reduce') { env.media.matches = true; env.mediaEvents.get('change')(); }
    if (mode === 'finish') env.animations[0].onfinish();
    if (mode === 'cancel') env.animations[0].cancel();
    if (mode === 'dispose') controller.dispose();
    assert.equal(sent.bubble.style.opacity, '.6'); assert.equal(env.ghosts().length, 0); controller.dispose(); assert.equal(env.timers.size, 0);
  }
});
test('WAAPI failure and absence never strand a transparent native bubble or ghost', () => {
  for (const mode of ['throw', 'missing']) {
    const env = environment(); const controller = attachMessageMotion(env.root); env.flush(); controller.captureIntent({ text: 'hello' });
    if (mode === 'throw') env.failAnimations();
    else env.document.createElement = tag => { const element = new env.document.defaultView.HTMLElement(tag); element.animate = undefined; return element; };
    const sent = env.addRow('user'); env.mutate(sent.row); env.flush();
    assert.equal(sent.bubble.style.opacity, ''); assert.equal(env.ghosts().length, 0); controller.dispose();
  }
});
test('IME, Shift+Enter, disabled sends and non-element targets cannot capture a flight', () => {
  for (const mode of ['ime', 'shift', 'disabled', 'target']) {
    const env = environment(); const controller = attachMessageMotion(env.root); env.flush(); env.editor.innerText = 'hello';
    if (mode === 'ime') env.key({ isComposing: true });
    if (mode === 'shift') env.key({ shiftKey: true });
    if (mode === 'disabled') { env.send.disabled = true; env.click(); }
    if (mode === 'target') env.click({});
    const sent = env.addRow('user'); env.mutate(sent.row); env.flush(); assert.equal(env.animations.length, 0); controller.dispose();
  }
});
test('multiline Lexical DIV text is captured without input-only value assertions', () => {
  const env = environment(); const controller = attachMessageMotion(env.root); env.flush(); env.editor.innerText = 'first\nsecond'; env.key();
  const sent = env.addRow('user', 'first\nsecond'); env.mutate(sent.row); env.flush();
  assert.equal(env.ghosts()[0].textContent, 'first\nsecond'); controller.dispose();
});
test('session replacement cancels active flight and does not animate replacement history', () => {
  const env = environment(); let session = 'one'; const controller = attachMessageMotion(env.root, { getSessionKey: () => session }); env.flush();
  controller.captureIntent({ text: 'hello' }); const sent = env.addRow('user'); env.mutate(sent.row); env.flush(); assert.equal(sent.bubble.style.opacity, '0');
  session = 'two'; const history = env.addRow('history', 'cached', 'assistant-step', 10); env.mutate(history.row); env.flush();
  assert.equal(sent.bubble.style.opacity, ''); assert.equal(env.ghosts().length, 0); assert.equal(env.animations.length, 1); controller.dispose();
});
test('detached document view safely exposes an inert presentation controller', () => {
  const controller = attachMessageMotion({ ownerDocument: { defaultView: null } });
  controller.captureIntent({ text: 'hello' }); controller.cancelPending(); controller.dispose();
});
test('all inspected native EN/ZH submit labels capture, while Stop never does', () => {
  for (const label of ['Send message', 'Queue message', 'Steer message', '发送消息', '排队发送', '插话发送', 'Stop']) {
    const env = environment(); const controller = attachMessageMotion(env.root); env.flush(); env.editor.innerText = 'hello';
    env.send.setAttribute('aria-label', label); env.click();
    const sent = env.addRow('user'); env.mutate(sent.row); env.flush();
    assert.equal(env.ghosts().length, label === 'Stop' ? 0 : 1, label); controller.dispose();
  }
});
