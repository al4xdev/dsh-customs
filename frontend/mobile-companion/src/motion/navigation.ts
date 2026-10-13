import { directedDistance, edgeDirection, lockAxis, resistedDistance, settleDuration, shouldCommit, type GestureAxis, type NavigationDirection } from './physics';

/** Actions may be synchronous or asynchronous; motion never interprets their result. */
export type NavigationAction = () => unknown;
export interface NavigationMotionOptions {
  root: HTMLElement;
  getSelectedId(): string | undefined;
  back: NavigationAction;
  forward: NavigationAction;
  /** Must represent a known in-app history entry, not browser.history.length. */
  canForward?(): boolean;
  getSurface?(): HTMLElement | null;
  onError?(error: unknown): void;
}
export interface NavigationMotionController {
  navigate(direction: NavigationDirection, action: NavigationAction): Promise<boolean>;
  /** Call only after the new list/reference is actually ready to render. */
  enter(direction: NavigationDirection): void;
  dispose(): void;
}
interface Gesture {
  id: number;
  direction: NavigationDirection;
  x: number;
  y: number;
  width: number;
  lastX: number;
  lastTime: number;
  velocity: number;
  distance: number;
  travel: number;
  axis: GestureAxis;
  surface: HTMLElement;
}

const EXCLUDED = 'button, a, input, textarea, select, label, summary, details, pre, code, table, [contenteditable], [role="button"], [role="dialog"], [role="alertdialog"], [role="slider"], [role="checkbox"], [data-composer-input], [data-composer-seat], [data-approval], [data-user-question], [data-slot*="approval"], [data-slot*="question"], [data-motion-gesture="exclude"]';

export function isGestureExcluded(target: EventTarget | null, root: HTMLElement, hasSelection = false): boolean {
  const view = root.ownerDocument.defaultView;
  // Event targets may be Window, text nodes or objects from another document.
  // Use this surface's own realm rather than asserting an HTMLElement shape.
  if (hasSelection || view === null || !(target instanceof view.Element)) return true;
  if (target.closest(EXCLUDED) !== null) return true;
  // A horizontal code/table/media scroller keeps its entire touch sequence.
  for (let current: Element | null = target; current !== null && current !== root; current = current.parentElement) {
    if (current.scrollWidth > current.clientWidth + 2 && current.clientWidth > 0) return true;
  }
  return !root.contains(target);
}

/** One existing surface moves; no snapshot clone or additional SessionProvider is mounted. */
export function attachNavigationMotion(options: NavigationMotionOptions): NavigationMotionController {
  const { root } = options;
  const browserView = root.ownerDocument.defaultView;
  // Detached documents have no browser animation/event environment to own.
  if (browserView === null) return {
    navigate: () => Promise.resolve(false),
    enter: () => { /* No surface can animate in a detached document. */ },
    dispose: () => { /* No document listeners or frames were registered. */ },
  };
  const view = browserView;
  const preference = view.matchMedia('(prefers-reduced-motion: reduce)');
  const surface = (): HTMLElement | null => {
    const supplied = options.getSurface?.();
    if (supplied !== undefined && supplied !== null) return supplied;
    const element = root.querySelector('.mobile-chat, .mobile-list');
    return element instanceof view.HTMLElement ? element : null;
  };
  const selectionActive = (): boolean => {
    const selected = root.ownerDocument.getSelection();
    return selected !== null && selected.toString().length > 0;
  };
  const animations = new Set<Animation>();
  let disposed = false;
  let busy = false;
  let frame = 0;
  let gesture: Gesture | undefined;
  const savedX = new Map<HTMLElement, string>();
  root.classList.add('mobile-motion-root');

  // Disposal may happen while awaiting WAAPI or a guarded navigation action.
  const isDisposed = (): boolean => disposed;
  function decorate(element: HTMLElement): void { element.classList.add('mobile-motion-surface'); }
  function reset(element: HTMLElement): void {
    element.classList.remove('is-nav-gesturing');
    element.removeAttribute('data-nav-direction');
    const previous = savedX.get(element);
    if (previous !== undefined) {
      if (previous.length > 0) element.style.setProperty('--motion-nav-x', previous);
      else element.style.removeProperty('--motion-nav-x');
      savedX.delete(element);
    }
  }
  function cancelFrame(): void { if (frame !== 0) view.cancelAnimationFrame(frame); frame = 0; }
  function cancelAnimations(): void { for (const animation of animations) animation.cancel(); animations.clear(); }
  function cancelGesture(): void {
    cancelFrame();
    if (gesture !== undefined) reset(gesture.surface);
    gesture = undefined;
  }
  async function animate(element: HTMLElement, frames: Keyframe[], duration: number): Promise<void> {
    if (isDisposed() || preference.matches || typeof element.animate !== 'function') return;
    const animation = element.animate(frames, { duration, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'none' });
    animations.add(animation);
    try { await animation.finished; } catch { /* Cancellation is a lifecycle event, not a navigation error. */ }
    finally { animations.delete(animation); animation.cancel(); }
  }
  function paint(): void {
    frame = 0;
    if (gesture === undefined || isDisposed() || preference.matches) return;
    const signed = gesture.direction === 'back' ? gesture.travel : -gesture.travel;
    gesture.surface.style.setProperty('--motion-nav-x', `${signed.toFixed(2)}px`);
  }
  function touchStart(event: TouchEvent): void {
    if (isDisposed() || busy || event.touches.length !== 1 || isGestureExcluded(event.target, root, selectionActive())) return;
    const element = surface();
    if (element === null || !(event.target instanceof view.Node) || !element.contains(event.target)) return;
    const touch = event.touches.item(0);
    if (touch === null) return;
    const bounds = element.getBoundingClientRect();
    const selected = options.getSelectedId();
    const direction = edgeDirection(touch.clientX - bounds.left, bounds.width, selected !== undefined && selected.length > 0, options.canForward?.() === true);
    if (direction === undefined) return;
    decorate(element);
    gesture = { id: touch.identifier, direction, x: touch.clientX, y: touch.clientY, width: bounds.width, lastX: touch.clientX, lastTime: event.timeStamp, velocity: 0, distance: 0, travel: 0, axis: 'pending', surface: element };
  }
  function touchMove(event: TouchEvent): void {
    const current = gesture;
    if (current === undefined) return;
    if (event.touches.length !== 1 || selectionActive()) { cancelGesture(); return; }
    const touch = Array.from(event.touches).find(value => value.identifier === current.id);
    if (touch === undefined) { cancelGesture(); return; }
    const dx = touch.clientX - current.x;
    const dy = touch.clientY - current.y;
    if (current.axis === 'pending') current.axis = lockAxis(dx, dy);
    if (current.axis === 'vertical') { cancelGesture(); return; }
    if (current.axis !== 'horizontal') return;
    if (directedDistance(dx, current.direction) === 0) { cancelGesture(); return; }
    // Prevent only this admitted horizontal edge drag, never native vertical or
    // nested code scrolling. No touch-action restriction exists on an ancestor.
    if (!event.cancelable) { cancelGesture(); return; }
    event.preventDefault();
    current.surface.classList.add('is-nav-gesturing');
    current.surface.setAttribute('data-nav-direction', current.direction);
    if (!savedX.has(current.surface)) savedX.set(current.surface, current.surface.style.getPropertyValue('--motion-nav-x'));
    const elapsed = Math.max(1, event.timeStamp - current.lastTime);
    const velocity = (touch.clientX - current.lastX) / elapsed * (current.direction === 'back' ? 1 : -1);
    current.velocity = current.velocity * .35 + velocity * .65;
    current.lastX = touch.clientX; current.lastTime = event.timeStamp;
    current.distance = directedDistance(dx, current.direction);
    current.travel = resistedDistance(current.distance, current.width);
    if (frame === 0 && !preference.matches) frame = view.requestAnimationFrame(paint);
  }
  async function settle(current: Gesture, commit: boolean): Promise<void> {
    busy = true;
    const signed = current.direction === 'back' ? 1 : -1;
    try {
      const start = String(signed * current.travel);
      const end = String(commit ? signed * (current.width + 16) : 0);
      await animate(current.surface, [{ transform: `translate3d(${start}px,0,0)`, opacity: 1 }, { transform: `translate3d(${end}px,0,0)`, opacity: commit ? .88 : 1 }], commit ? settleDuration(current.travel, current.velocity, current.width) : 260);
      reset(current.surface);
      if (isDisposed() || !commit) return;
      if (current.direction === 'forward' && options.canForward?.() !== true) return;
      await (current.direction === 'back' ? options.back() : options.forward());
    } catch (error) { options.onError?.(error); }
    finally { busy = false; }
  }
  function touchEnd(event: TouchEvent): void {
    const current = gesture;
    if (current === undefined || !Array.from(event.changedTouches).some(touch => touch.identifier === current.id)) return;
    cancelFrame(); gesture = undefined;
    if (current.axis !== 'horizontal') { reset(current.surface); return; }
    // A release after a pause is not a flick, even if the last move was fast.
    const velocity = event.timeStamp - current.lastTime > 100 ? 0 : current.velocity;
    void settle(current, shouldCommit(current.distance, velocity, current.width));
  }
  const onCancel = (): void => { cancelGesture(); };
  const onPreference = (): void => { cancelGesture(); cancelAnimations(); };
  root.addEventListener('touchstart', touchStart, { passive: true });
  root.addEventListener('touchmove', touchMove, { passive: false });
  root.addEventListener('touchend', touchEnd, { passive: true });
  root.addEventListener('touchcancel', onCancel, { passive: true });
  preference.addEventListener('change', onPreference);

  return {
    async navigate(direction, action): Promise<boolean> {
      if (isDisposed() || busy) return false;
      cancelGesture(); busy = true;
      const element = surface();
      try {
        if (element !== null) {
          decorate(element);
          const distance = direction === 'back' ? '28' : '-18';
          await animate(element, [{ transform: 'translate3d(0,0,0)', opacity: 1 }, { transform: `translate3d(${distance}px,0,0)`, opacity: .9 }], 160);
        }
        if (isDisposed()) return false;
        await action();
        return true;
      } catch (error) { options.onError?.(error); return false; }
      finally { busy = false; }
    },
    enter(direction): void {
      if (isDisposed()) return;
      const element = surface();
      if (element === null) return;
      decorate(element);
      const distance = direction === 'back' ? '-18' : '24';
      void animate(element, [{ transform: `translate3d(${distance}px,0,0)`, opacity: .92 }, { transform: 'translate3d(0,0,0)', opacity: 1 }], 300);
    },
    dispose(): void {
      if (isDisposed()) return;
      disposed = true; cancelGesture(); cancelAnimations();
      for (const element of savedX.keys()) reset(element);
      root.removeEventListener('touchstart', touchStart); root.removeEventListener('touchmove', touchMove);
      root.removeEventListener('touchend', touchEnd); root.removeEventListener('touchcancel', onCancel);
      preference.removeEventListener('change', onPreference);
      root.classList.remove('mobile-motion-root');
      for (const element of root.querySelectorAll('.mobile-motion-surface')) element.classList.remove('mobile-motion-surface', 'is-nav-gesturing');
    },
  };
}
