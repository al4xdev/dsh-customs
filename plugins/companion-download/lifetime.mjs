import { refuse } from './registry.mjs';

/** Public Cordis uid is 0 for root, and null after disposal. Never recapture a token. */
export function pinFiber(fiber) {
  const uid = fiber?.uid;
  if (!Number.isSafeInteger(uid) || uid < 0) refuse('source-changed');
  return Object.freeze({ fiber, uid });
}
export function fiberCurrent(pin, fiber) {
  return Boolean(pin && fiber === pin.fiber && Number.isSafeInteger(pin.uid) && pin.uid >= 0 && fiber.uid === pin.uid);
}
