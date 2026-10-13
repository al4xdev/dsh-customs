export type NavigationDirection = 'back' | 'forward';
export type GestureAxis = 'pending' | 'horizontal' | 'vertical';
export const EDGE_WIDTH = 32;

export function lockAxis(dx: number, dy: number, deadzone = 9): GestureAxis {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < deadzone) return 'pending';
  if (Math.abs(dx) > Math.abs(dy) * 1.25) return 'horizontal';
  if (Math.abs(dy) > Math.abs(dx) * 1.1) return 'vertical';
  return 'pending';
}

export function edgeDirection(x: number, width: number, selected: boolean, canForward: boolean): NavigationDirection | undefined {
  if (!Number.isFinite(width) || width <= 0) return undefined;
  if (selected && x >= 0 && x <= EDGE_WIDTH) return 'back';
  if (!selected && canForward && x <= width && x >= width - EDGE_WIDTH) return 'forward';
  return undefined;
}

export function directedDistance(dx: number, direction: NavigationDirection): number {
  return Math.max(0, direction === 'back' ? dx : -dx);
}

/** A resisted card follows the hand, but never drags beyond its own width. */
export function resistedDistance(distance: number, width: number): number {
  if (!Number.isFinite(distance) || !Number.isFinite(width) || width <= 0) return 0;
  const travel = Math.max(0, distance);
  const linear = width * .8;
  return Math.min(width, travel <= linear ? travel : linear + (travel - linear) * .22);
}

export function shouldCommit(distance: number, velocity: number, width: number): boolean {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(distance) || !Number.isFinite(velocity)) return false;
  // The short flick minimum avoids accidental navigation from a tiny edge tap.
  return distance >= Math.max(64, width * .28) || (distance >= 32 && velocity >= .55);
}

export function settleDuration(distance: number, velocity: number, width: number): number {
  const remaining = Math.max(0, width - distance);
  return Math.round(Math.max(160, Math.min(300, remaining / Math.max(.9, Math.abs(velocity)))));
}
