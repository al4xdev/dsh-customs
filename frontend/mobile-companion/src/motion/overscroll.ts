import { lockAxis, type GestureAxis } from './physics';
import { isGestureExcluded } from './navigation';

export interface OverscrollMotionOptions {
  enabled?: boolean;
  /** Gate replay/opening/admission without exposing private renderer state. */
  isReady?(): boolean;
}
export interface OverscrollMotionController { dispose(): void; }
export type ScrollEdge = 'top' | 'bottom';
const LIMIT = 32;
const PROPERTY = '--motion-edge-y';

/** An asymptotic 32px cap keeps even a long pull quiet and bounded. */
export function elasticDistance(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  return LIMIT * (distance / (distance + 96));
}
export function scrollEdge(top: number, height: number, viewport: number, delta: number): ScrollEdge | undefined {
  if (![top, height, viewport, delta].every(Number.isFinite) || viewport <= 0 || height < viewport - 1) return undefined;
  if (delta > 0 && top <= 1) return 'top';
  if (delta < 0 && top >= Math.max(0, height - viewport) - 1) return 'bottom';
  return undefined;
}
export function hasNativeElasticity(view: Window & typeof globalThis): boolean {
  // All iOS WebKit browsers already supply rubber banding, including iPad's
  // desktop UA. Disable the fallback there rather than stacking two effects.
  return view.CSS.supports('-webkit-touch-callout', 'none')
    || /iPhone|iPad|iPod/.test(view.navigator.userAgent)
    || (view.navigator.userAgent.includes('Macintosh') && view.navigator.maxTouchPoints > 1);
}
interface Surface {
  port: HTMLElement;
  layer: HTMLElement;
  body: Element | null;
  session: string | null;
  portWidth: number;
  portHeight: number;
  layerHeight: number;
}
interface Pull extends Surface {
  id: number;
  x: number;
  y: number;
  axis: GestureAxis;
  edge: ScrollEdge | undefined;
  offset: number;
}
interface StyleSnapshot {
  value: string;
  priority: string;
  hadClass: boolean;
}

/** Animate the verified transcript/list column, never its scroller or composer. */
export function attachOverscrollMotion(root: HTMLElement, options: OverscrollMotionOptions = {}): OverscrollMotionController {
  const browserView = root.ownerDocument.defaultView;
  if (browserView === null || options.enabled === false || hasNativeElasticity(browserView)
    || !browserView.CSS.supports('translate', '0 1px')) {
    return { dispose: () => { /* Inert: no listeners, observers or visual state were allocated. */ } };
  }
  const view = browserView;
  const document = root.ownerDocument;
  const preference = view.matchMedia('(prefers-reduced-motion: reduce)');
  const saved = new Map<HTMLElement, StyleSnapshot>();
  let disposed = false;
  let composing = false;
  let frame = 0;
  let pull: Pull | undefined;
  let spring: { surface: Surface; animation: Animation } | undefined;
  const available = (): boolean => !disposed && !composing && !preference.matches
    && document.visibilityState === 'visible' && options.isReady?.() !== false;
  const selected = (): boolean => {
    const selection = document.getSelection();
    return selection !== null && selection.toString().length > 0;
  };
  function snapshot(layer: HTMLElement): void {
    if (saved.has(layer)) return;
    saved.set(layer, {
      value: layer.style.getPropertyValue(PROPERTY),
      priority: layer.style.getPropertyPriority(PROPERTY),
      hadClass: layer.classList.contains('mobile-elastic-content'),
    });
    layer.classList.add('mobile-elastic-content');
  }
  function restore(layer: HTMLElement): void {
    const original = saved.get(layer);
    if (original === undefined) return;
    if (original.value.length > 0) layer.style.setProperty(PROPERTY, original.value, original.priority);
    else layer.style.removeProperty(PROPERTY);
    if (!original.hadClass) layer.classList.remove('mobile-elastic-content');
    saved.delete(layer);
  }
  function cancelFrame(): void {
    if (frame !== 0) view.cancelAnimationFrame(frame);
    frame = 0;
  }
  function reset(): void {
    cancelFrame();
    const previous = spring;
    spring = undefined;
    previous?.animation.cancel();
    pull = undefined;
    for (const layer of saved.keys()) restore(layer);
    resize.disconnect();
  }
  function valid(surface: Surface): boolean {
    if (!available() || selected() || !root.contains(surface.port) || !surface.port.contains(surface.layer)) return false;
    if (surface.body !== null && (surface.body.getAttribute('data-content-phase') !== 'active'
      || surface.body.getAttribute('data-conversation-session') !== surface.session)) return false;
    return surface.layer.closest('.is-nav-gesturing') === null;
  }
  function findSurface(target: Element): Surface | undefined {
    const candidate = target.closest('[data-conversation-scroll], .mobile-list');
    if (!(candidate instanceof view.HTMLElement) || !root.contains(candidate) || candidate.clientHeight <= 0) return undefined;
    const body = candidate.closest('[data-conversation-content]');
    if (body !== null && body.getAttribute('data-content-phase') !== 'active') return undefined;
    // ui-chat's outer column has this public marker; nested process ledgers also
    // mark a flow, but identify themselves with data-step-process-content.
    const layer = candidate.matches('.mobile-list')
      ? candidate.querySelector(':scope > ul')
      : candidate.querySelector('[data-chat-flow]:not([data-step-process-content])');
    if (!(layer instanceof view.HTMLElement) || !layer.contains(target)
      || layer.contains(candidate.querySelector('[data-composer-seat]'))) return undefined;
    // A nested vertical ledger, like code's horizontal scroller, owns its touch.
    for (let node: Element | null = target; node !== null && node !== candidate; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 2 && /^(auto|scroll)$/.test(view.getComputedStyle(node).overflowY)) return undefined;
    }
    return { port: candidate, layer, body, session: body?.getAttribute('data-conversation-session') ?? null,
      portWidth: candidate.clientWidth, portHeight: candidate.clientHeight, layerHeight: layer.clientHeight };
  }
  function paint(): void {
    frame = 0;
    if (pull === undefined) return;
    if (!valid(pull)) { reset(); return; }
    pull.layer.style.setProperty(PROPERTY, `${pull.offset.toFixed(2)}px`);
  }
  function start(event: TouchEvent): void {
    // A second finger cancels an existing sequence rather than leaving a layer
    // translated while the browser handles pinch zoom.
    if (!available() || event.touches.length !== 1 || isGestureExcluded(event.target, root, selected())) { reset(); return; }
    if (!(event.target instanceof view.Element)) return;
    const touch = event.touches.item(0);
    if (touch === null) return;
    reset();
    const surface = findSurface(event.target);
    if (surface === undefined || !valid(surface)) return;
    // Interior scrolling never arms a fallback, even if momentum later lands at
    // an edge. A fresh outward pull at that edge is required.
    if (surface.port.scrollTop > 1 && surface.port.scrollTop < surface.port.scrollHeight - surface.port.clientHeight - 1) return;
    pull = { ...surface, id: touch.identifier, x: touch.clientX, y: touch.clientY, axis: 'pending', edge: undefined, offset: 0 };
    resize.observe(surface.port); resize.observe(surface.layer);
  }
  function move(event: TouchEvent): void {
    const current = pull;
    if (current === undefined) return;
    if (!valid(current) || event.touches.length !== 1 || selected()) { reset(); return; }
    const touch = Array.from(event.touches).find(value => value.identifier === current.id);
    if (touch === undefined) { reset(); return; }
    const dx = touch.clientX - current.x;
    const dy = touch.clientY - current.y;
    if (current.axis === 'pending') current.axis = lockAxis(dx, dy);
    if (current.axis === 'horizontal') { reset(); return; }
    if (current.axis !== 'vertical') return;
    const edge = scrollEdge(current.port.scrollTop, current.port.scrollHeight, current.port.clientHeight, dy);
    if (edge === undefined || (current.edge !== undefined && edge !== current.edge) || !event.cancelable) { reset(); return; }
    current.edge = edge;
    // Only an admitted outward vertical edge pull is suppressed. ScrollTop is
    // never written; all interior momentum, selection and nested scrolling stay native.
    event.preventDefault();
    current.offset = (edge === 'top' ? 1 : -1) * elasticDistance(Math.abs(dy));
    snapshot(current.layer);
    if (frame === 0) frame = view.requestAnimationFrame(paint);
  }
  function finish(event: TouchEvent): void {
    const current = pull;
    if (current === undefined || !Array.from(event.changedTouches).some(touch => touch.identifier === current.id)) return;
    cancelFrame(); pull = undefined;
    if (!valid(current) || current.edge === undefined || current.offset === 0 || typeof current.layer.animate !== 'function') { reset(); return; }
    const animation = current.layer.animate([
      { translate: `0 ${current.offset.toFixed(2)}px` },
      { translate: `0 ${(-current.offset * .1).toFixed(2)}px`, offset: .68 },
      { translate: '0 0px' },
    ], { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'none' });
    const released = { surface: current, animation };
    spring = released;
    const cleanup = (): void => {
      if (spring !== released) return;
      spring = undefined;
      animation.cancel(); restore(current.layer); resize.disconnect();
    };
    void animation.finished.then(cleanup, cleanup);
  }
  function interrupted(): void { reset(); }
  function compositionStart(): void { composing = true; reset(); }
  function compositionEnd(): void { composing = false; }
  function scroll(event: Event): void {
    const current = pull ?? spring?.surface;
    if (current === undefined || event.target !== current.port) return;
    // The browser or renderer moved its real scroll position during a pull.
    // Never hold a displaced column over a changed viewport.
    reset();
  }
  const resize = new view.ResizeObserver(() => {
    const current = pull ?? spring?.surface;
    // observe() also delivers an initial record. Only a real geometry change
    // cancels; otherwise every new pull would be killed by its first record.
    if (current !== undefined && (current.port.clientWidth !== current.portWidth
      || current.port.clientHeight !== current.portHeight || current.layer.clientHeight !== current.layerHeight)) reset();
  });
  const observer = new view.MutationObserver(() => {
    const current = pull ?? spring?.surface;
    if (current !== undefined && !valid(current)) reset();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-content-phase', 'data-conversation-session'] });
  root.addEventListener('touchstart', start, { passive: true });
  root.addEventListener('touchmove', move, { passive: false });
  root.addEventListener('touchend', finish, { passive: true });
  root.addEventListener('touchcancel', interrupted, { passive: true });
  root.addEventListener('scroll', scroll, { capture: true, passive: true });
  root.addEventListener('compositionstart', compositionStart);
  root.addEventListener('compositionend', compositionEnd);
  document.addEventListener('visibilitychange', interrupted);
  document.addEventListener('selectionchange', interrupted);
  preference.addEventListener('change', interrupted);
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true; reset(); observer.disconnect();
      root.removeEventListener('touchstart', start); root.removeEventListener('touchmove', move);
      root.removeEventListener('touchend', finish); root.removeEventListener('touchcancel', interrupted);
      root.removeEventListener('scroll', scroll, true);
      root.removeEventListener('compositionstart', compositionStart); root.removeEventListener('compositionend', compositionEnd);
      document.removeEventListener('visibilitychange', interrupted); document.removeEventListener('selectionchange', interrupted);
      preference.removeEventListener('change', interrupted);
    },
  };
}
