// Query cuts may include synthetic interrupted-turn closers or live events
// not yet durable. They are upper-bound hints, never persisted cursor authority.
// Confirm the physical prefix boundary through the public read-only handle.
export async function persistedEventCount(handle, hint, signal) {
  let probes = 0;
  async function exists(offset) {
    signal?.throwIfAborted();
    if (++probes > 108) throw new Error('persisted tail discovery probe budget exceeded');
    return (await handle.read(offset, 1, { signal })).events.length > 0;
  }
  if (!await exists(0)) return 0;
  let low = 0;
  let high = Number.isSafeInteger(hint) && hint > 0 ? hint : 1;
  while (await exists(high)) {
    low = high;
    if (high > Number.MAX_SAFE_INTEGER / 2) throw new Error('persisted tail exceeds supported cursor range');
    high *= 2;
  }
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (await exists(middle)) low = middle;
    else high = middle;
  }
  return high;
}
