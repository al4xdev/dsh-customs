export interface MotionRect { x: number; y: number; width: number; height: number }
export interface MotionRow { key: string; kind: string; turn?: number; text: string; echo?: boolean; hidden?: boolean }
export interface MessageMotionOptions {
  enabled?: boolean;
  isReady?: () => boolean;
  isFollowingTail?: () => boolean;
  isLive?: () => boolean;
  getSessionKey?: () => string | undefined;
  intentTimeoutMs?: number;
}
export interface MessageMotionIntent { text: string; rect?: MotionRect }
export interface MessageMotionController {
  captureIntent(input: MessageMotionIntent): void;
  cancelPending(): void;
  dispose(): void;
}
interface FlightSnapshot {
  text: string;
  box: MotionRect;
  anchor: { node: HTMLElement; y: number } | undefined;
  oldRows: HTMLElement[];
}
interface FlightTransform { x: number; y: number; scaleX: number; scaleY: number }

const ROW = '[data-chat-flow-key][data-chat-node-key]';
const INPUT = '[data-composer-seat] [data-composer-input][role="textbox"], [data-composer-seat] textarea';
const ECHO = '[data-submission-echo],[data-pending-steering]';
const USER = new Set(['user', 'steering']);
const INCOMING = new Set(['assistant', 'assistant-step']);
const SEND_LABELS = new Set(['Send message', 'Queue message', 'Steer message', '发送消息', '排队发送', '插话发送']);
export const MESSAGE_MOTION = Object.freeze({ flight: 440, arrival: 260, rise: 360, intentTimeout: 20000, easing: 'cubic-bezier(.22,.78,.22,1)' });

export const normalizeMessageText = (text: string): string => text.replace(/\r\n?/g, '\n').trim();
export function flightTransform(from: MotionRect, to: MotionRect): FlightTransform {
  // Composer and transcript wrap text differently. Independent axis scaling
  // squashes glyphs; translate between their centers with a subtle uniform lift.
  const scale = .98;
  return {
    x: from.x + from.width / 2 - (to.x + to.width / 2),
    y: from.y + from.height / 2 - (to.y + to.height / 2),
    scaleX: scale,
    scaleY: scale,
  };
}

/** Admission gate is independent from DOM timing. Echoes never count as admission. */
export class MessageMotionGate {
  private readonly seen = new Set<string>();
  private pending: { text: string; expires: number } | undefined;
  private latestTurn = -1;
  private readonly admittedTurns = new Set<number>();

  prime(rows: MotionRow[]): void {
    for (const row of rows) {
      // A local echo can be promoted in-place to the durable host row.
      if (row.echo === true) continue;
      this.remember(row.key);
      this.latestTurn = Math.max(this.latestTurn, row.turn ?? -1);
    }
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > 4096) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  intent(text: string, now: number, timeout: number = MESSAGE_MOTION.intentTimeout): void {
    const clean = normalizeMessageText(text);
    this.pending = clean.length > 0 && clean.length <= 16384 && !clean.startsWith('/') && Number.isFinite(timeout) && timeout > 0
      ? { text: clean, expires: now + timeout } : undefined;
  }

  cancel(): void { this.pending = undefined; }
  known(key: string): boolean { return this.seen.has(key); }
  reset(): void { this.seen.clear(); this.pending = undefined; this.latestTurn = -1; this.admittedTurns.clear(); }

  observe(row: MotionRow, now: number, following: boolean, live = false): 'user' | 'incoming' | undefined {
    if (this.pending !== undefined && now >= this.pending.expires) this.cancel();
    if (row.key.length === 0 || row.echo === true || row.hidden === true || this.seen.has(row.key)) return undefined;
    // A streaming seat may be inserted before its first visible token.
    if (row.text.trim().length === 0) return undefined;
    this.remember(row.key);
    if (USER.has(row.kind) && this.pending !== undefined && (row.turn === undefined || row.turn >= this.latestTurn) && normalizeMessageText(row.text) === this.pending.text) {
      this.cancel();
      if (row.turn !== undefined) {
        this.admittedTurns.add(row.turn);
        if (this.admittedTurns.size > 32) {
          const oldest = this.admittedTurns.values().next().value;
          if (oldest !== undefined) this.admittedTurns.delete(oldest);
        }
      }
      this.latestTurn = Math.max(this.latestTurn, row.turn ?? -1);
      return following ? 'user' : undefined;
    }
    if (INCOMING.has(row.kind) && following && row.turn !== undefined && row.turn >= this.latestTurn &&
      (this.admittedTurns.has(row.turn) || (live && row.turn > this.latestTurn))) {
      this.latestTurn = Math.max(this.latestTurn, row.turn);
      return 'incoming';
    }
    // A durable remote/mismatched user row still advances the history watermark.
    if (USER.has(row.kind) && row.turn !== undefined) this.latestTurn = Math.max(this.latestTurn, row.turn);
    return undefined;
  }
}

function rect(element: Element): MotionRect {
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function htmlElement(element: Element | null | undefined): HTMLElement | undefined {
  if (element === null || element === undefined) return undefined;
  const view = element.ownerDocument.defaultView;
  return view !== null && element instanceof view.HTMLElement ? element : undefined;
}

function rowInfo(row: HTMLElement): MotionRow {
  const turnText = row.getAttribute('data-chat-turn');
  const turn = turnText === null || turnText.length === 0 ? undefined : Number(turnText);
  return {
    key: row.getAttribute('data-chat-node-key') ?? '', kind: row.getAttribute('data-chat-flow-kind') ?? '',
    ...(turn !== undefined && Number.isSafeInteger(turn) && turn >= 0 ? { turn } : {}),
    text: userBubble(row)?.textContent ?? row.textContent,
    echo: row.matches(ECHO) || row.querySelector(ECHO) !== null,
    hidden: row.closest('[hidden]') !== null || row.hasAttribute('data-turn-process-hidden') || row.getAttribute('data-chat-group-part') === 'reasoning',
  };
}

function userBubble(row: HTMLElement): HTMLElement | undefined {
  if (!USER.has(row.getAttribute('data-chat-flow-kind') ?? '')) return undefined;
  // rc.2 UserStyleBubble: node seat -> userRow -> userStack -> bubble.
  // The renderer exposes row identity, not a bubble marker. Fail closed on
  // structural drift instead of depending on hashed CSS or cloning interactive content.
  const seat = row.querySelector('[data-slot="conversation.chat.node"]');
  const userRow = htmlElement(seat?.firstElementChild);
  const stack = htmlElement(userRow?.firstElementChild);
  if (userRow?.tagName !== 'DIV' || stack?.tagName !== 'DIV') return undefined;
  for (const child of stack.children) {
    const element = htmlElement(child);
    if (element?.tagName === 'DIV' && !element.hasAttribute('data-message-attachments')) return element;
  }
  return undefined;
}

/** Presentation only. No input mutation, API calls, scroll commands or synthetic sends. */
export function attachMessageMotion(root: HTMLElement, options: MessageMotionOptions = {}): MessageMotionController {
  const documentView = root.ownerDocument.defaultView;
  if (documentView === null) {
    return {
      captureIntent(): void { /* A detached document has no animation lifecycle. */ },
      cancelPending(): void { /* No document view means no pending presentation. */ },
      dispose(): void { /* Nothing was attached. */ },
    };
  }
  const view = documentView;
  const gate = new MessageMotionGate();
  const reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false;
  let primed = false;
  let session = options.getSessionKey?.();
  let frame = 0;
  let warmFrame = 0;
  let expiry: number | undefined;
  let source: FlightSnapshot | undefined;
  const candidates = new Set<HTMLElement>();
  const cleanups = new Set<() => void>();
  const now = (): number => view.performance.now();
  const permitted = (): boolean => !disposed && options.enabled !== false && !reduced.matches && (options.isReady?.() ?? true);
  const scroller = (): HTMLElement | undefined => htmlElement(root.querySelector('[data-conversation-scroll]'));
  const following = (): boolean => {
    if (options.isFollowingTail !== undefined) return options.isFollowingTail();
    const flow = root.querySelector('[data-chat-flow]');
    // In the pinned native renderer the missing presence marker means false,
    // not permission to infer follow-tail from nearby geometry.
    if (flow !== null) return flow.parentElement?.parentElement?.hasAttribute('data-chat-following-tail') === true;
    const scroll = scroller();
    return scroll === undefined || scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 80;
  };
  const rows = (): HTMLElement[] => Array.from(root.querySelectorAll(ROW)).flatMap(element => {
    const row = htmlElement(element);
    return row === undefined ? [] : [row];
  });
  const clearIntent = (): void => {
    gate.cancel(); source = undefined;
    if (expiry !== undefined) view.clearTimeout(expiry);
    expiry = undefined;
  };
  const prime = (): void => { gate.prime(rows().map(rowInfo)); primed = true; };
  const clearAnimations = (): void => { for (const cleanup of [...cleanups]) cleanup(); };
  const reset = (): void => { clearIntent(); clearAnimations(); gate.reset(); candidates.clear(); primed = false; };

  function animate(element: HTMLElement, frames: Keyframe[], duration: number, done?: () => void): (() => void) | undefined {
    if (typeof element.animate !== 'function') { done?.(); return undefined; }
    let animation: Animation;
    try {
      animation = element.animate(frames, { duration, easing: MESSAGE_MOTION.easing, fill: 'none' });
    } catch {
      // WAAPI failure must never leave the real bubble transparent or a ghost orphaned.
      done?.();
      return undefined;
    }
    let finished = false;
    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      animation.onfinish = null; animation.oncancel = null;
      animation.cancel(); cleanups.delete(cleanup); done?.();
    };
    cleanups.add(cleanup);
    animation.onfinish = cleanup; animation.oncancel = cleanup;
    return cleanup;
  }

  function arrive(row: HTMLElement): void {
    if (row.querySelector('[role="dialog"],[role="alertdialog"]') !== null) return;
    animate(row, [{ opacity: .12, transform: 'translate3d(0,12px,0)' }, { opacity: 1, transform: 'translate3d(0,0,0)' }], MESSAGE_MOTION.arrival);
  }

  function fly(row: HTMLElement, snapshot: FlightSnapshot): void {
    const bubble = userBubble(row);
    if (bubble === undefined || !bubble.isConnected || normalizeMessageText(bubble.textContent) !== snapshot.text) return;
    const target = rect(bubble);
    const bounds = rect(root);
    if (target.width <= 0 || target.height <= 0 || target.y + target.height < bounds.y || target.y > bounds.y + bounds.height) return;
    const styles = view.getComputedStyle(bubble);
    const ghost = root.ownerDocument.createElement('div');
    ghost.className = 'mobile-message-flight'; ghost.setAttribute('aria-hidden', 'true');
    ghost.textContent = snapshot.text; // Text only: no links, handlers, attachments or private element attributes.
    Object.assign(ghost.style, { left: `${String(target.x)}px`, top: `${String(target.y)}px`, width: `${String(target.width)}px`, height: `${String(target.height)}px`,
      background: styles.backgroundColor, color: styles.color, font: styles.font, padding: styles.padding, borderRadius: styles.borderRadius });
    root.ownerDocument.body.appendChild(ghost);
    // Opacity preserves the native accessible transcript; visibility:hidden would not.
    const previous = bubble.style.opacity;
    bubble.style.opacity = '0';
    const cleanupGhost = (): void => {
      ghost.remove();
      if (bubble.style.opacity === '0') bubble.style.opacity = previous;
      cleanups.delete(cleanupGhost);
    };
    cleanups.add(cleanupGhost);
    const path = flightTransform(snapshot.box, target);
    animate(ghost, [
      { opacity: .84, transform: `translate3d(${String(path.x)}px,${String(path.y)}px,0) scale(${String(path.scaleX)},${String(path.scaleY)})`, borderRadius: '24px' },
      { opacity: 1, transform: 'translate3d(0,0,0) scale(1,1)', offset: .88 },
      { opacity: 1, transform: 'translate3d(0,0,0) scale(1,1)' },
    ], MESSAGE_MOTION.flight, cleanupGhost);
    // FLIP the already-laid-out visible transcript, never the scroll container.
    // Native following-tail owns the actual rise and scroll position.
    const anchor = snapshot.anchor;
    if (anchor?.node.isConnected === true) {
      const delta = anchor.y - rect(anchor.node).y;
      if (Math.abs(delta) > 1 && Math.abs(delta) < bounds.height) for (const old of snapshot.oldRows) {
        if (old.isConnected && old.querySelector('[role="dialog"],[role="alertdialog"]') === null)
          animate(old, [{ transform: `translate3d(0,${String(delta)}px,0)` }, { transform: 'translate3d(0,0,0)' }], MESSAGE_MOTION.rise);
      }
    }
  }

  function process(): void {
    frame = 0;
    if (disposed) return;
    const nextSession = options.getSessionKey?.();
    if (session !== nextSession) { session = nextSession; reset(); prime(); return; }
    if (!permitted()) { clearIntent(); clearAnimations(); prime(); candidates.clear(); return; }
    if (!primed) { prime(); candidates.clear(); return; }
    for (const candidate of candidates) {
      if (!candidate.isConnected || !root.contains(candidate) || gate.known(candidate.getAttribute('data-chat-node-key') ?? '')) continue;
      const decision = gate.observe(rowInfo(candidate), now(), following(), options.isLive?.() ?? false);
      if (decision === 'user' && source !== undefined) {
        const snapshot = source; clearIntent(); fly(candidate, snapshot);
      } else if (decision === 'incoming') arrive(candidate);
    }
    candidates.clear();
  }

  function queue(): void { if (frame === 0) frame = view.requestAnimationFrame(process); }
  function addCandidate(node: Node): void {
    const element = node instanceof view.Element ? node : node.parentElement;
    if (element === null) return;
    const ancestor = htmlElement(element.closest(ROW));
    if (ancestor?.getAttribute('data-chat-group-part') === 'reasoning') return;
    if (ancestor !== undefined && !gate.known(ancestor.getAttribute('data-chat-node-key') ?? '') && candidates.size < 128) candidates.add(ancestor);
    if (node instanceof view.Element && ancestor === undefined) for (const elementRow of element.querySelectorAll(ROW)) {
      if (candidates.size >= 128) break;
      const row = htmlElement(elementRow);
      if (row !== undefined && !gate.known(row.getAttribute('data-chat-node-key') ?? '')) candidates.add(row);
    }
  }
  const observer = new view.MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData' || record.type === 'attributes') addCandidate(record.target);
      else for (const node of record.addedNodes) addCandidate(node);
    }
    if (candidates.size > 0) queue();
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['data-chat-node-key', 'data-chat-flow-kind', 'data-chat-turn', 'data-submission-echo', 'data-pending-steering', 'hidden', 'data-turn-process-hidden'] });
  // Baseline the first native paint, including historical streaming seats.
  warmFrame = view.requestAnimationFrame(() => { warmFrame = view.requestAnimationFrame(() => { warmFrame = 0; if (!disposed) prime(); }); });

  function captureIntent(input: MessageMotionIntent): void {
    clearIntent();
    if (!permitted() || !following()) return;
    prime();
    const text = normalizeMessageText(input.text);
    const editor = htmlElement(root.querySelector(INPUT));
    const box = input.rect ?? (editor === undefined ? undefined : rect(editor));
    if (box === undefined || text.length === 0 || text.length > 16384 || text.startsWith('/')) return;
    const timeout = options.intentTimeoutMs ?? MESSAGE_MOTION.intentTimeout;
    if (!Number.isFinite(timeout) || timeout <= 0) return;
    const bounds = rect(root);
    const visible = rows().filter(row => { const r = rect(row); return r.y < bounds.y + bounds.height && r.y + r.height > bounds.y; }).slice(-16);
    const anchor = visible.at(-1);
    source = { text, box, oldRows: visible, anchor: anchor === undefined ? undefined : { node: anchor, y: rect(anchor).y } };
    gate.intent(text, now(), timeout);
    expiry = view.setTimeout(clearIntent, timeout);
  }

  function captureFromEditor(): void {
    const editor = htmlElement(root.querySelector(INPUT));
    if (editor === undefined) return;
    if (editor instanceof view.HTMLTextAreaElement || editor instanceof view.HTMLInputElement) {
      if (!editor.disabled && !editor.readOnly) captureIntent({ text: editor.value });
    } else if (editor.isContentEditable) {
      // Native Lexical input is a DIV. Rendered newlines survive multiline paragraphs.
      captureIntent({ text: editor.innerText });
    }
  }
  const onClick = (event: Event): void => {
    if (!(event.target instanceof view.Element)) return;
    const button = event.target.closest('button');
    if (!(button instanceof view.HTMLButtonElement) || button.closest('[data-composer-seat]') === null || button.disabled) return;
    // Version-pinned accessible EN/ZH labels; an explicit input-store bridge can
    // call captureIntent instead. A false intent cannot fabricate admission.
    if (SEND_LABELS.has(button.getAttribute('aria-label') ?? '')) captureFromEditor();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target instanceof view.Element && event.target.matches(INPUT)) captureFromEditor();
  };
  const onReduced = (): void => { if (reduced.matches) { clearIntent(); clearAnimations(); } };
  root.addEventListener('click', onClick, true); root.addEventListener('keydown', onKey, true); reduced.addEventListener('change', onReduced);
  return {
    captureIntent,
    cancelPending: clearIntent,
    dispose(): void {
      if (disposed) return;
      disposed = true; observer.disconnect();
      if (frame !== 0) view.cancelAnimationFrame(frame);
      if (warmFrame !== 0) view.cancelAnimationFrame(warmFrame);
      frame = 0; warmFrame = 0;
      root.removeEventListener('click', onClick, true); root.removeEventListener('keydown', onKey, true); reduced.removeEventListener('change', onReduced); reset();
    },
  };
}
