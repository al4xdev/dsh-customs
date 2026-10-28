import { MAX_TITLE } from './contracts.mjs';

/** Display-only budgets. A catalog page must never wait on a title fold for long. */
export const TITLE_HINTS_LIMITS = Object.freeze({ wallMs: 1200, cacheEntries: 128, batch: 100 });

const TITLE_EVENT = 'session/title';
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;

/** Same authority the wire validator applies: never invent, pad or echo a non-title. */
export function confirmedTitle(value) {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/\p{Cc}/gu, ' ').trim().slice(0, MAX_TITLE);
  return title.length > 0 ? title : undefined;
}

/**
 * Titles are display hints, never membership: the row already exists because its header was
 * admitted. So this source is bounded, cancellable and fail-open. A missing title, a timeout or
 * a provider error must leave the page exactly as it is today.
 *
 * Cache identity is `id + createdAt`, because a reused id is not the same incarnation. A
 * `session/title` event is the only thing that can change a folded title, so it is the only
 * invalidation signal; there is no clock and no polling.
 */
export function createTitleHints(ctx, options = {}) {
  if (Object.keys(options).some(key => !Object.hasOwn(TITLE_HINTS_LIMITS, key))) throw new TypeError('Unsupported title hint option');
  const limits = { ...TITLE_HINTS_LIMITS, ...options };
  for (const key of Object.keys(limits)) {
    if (!integer(limits[key], 1) || limits[key] > TITLE_HINTS_LIMITS[key]) throw new RangeError('Invalid title hint budget');
  }
  const cache = new Map();
  let closed = false;
  const keyOf = (id, createdAt) => `${id}\u0000${createdAt ?? ''}`;
  function remember(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > limits.cacheEntries) cache.delete(cache.keys().next().value);
  }
  // A rename arrives as an event, never as a poll: drop every incarnation of that id.
  const disposeEvent = typeof ctx?.on === 'function'
    ? ctx.on('session/event', (session, event) => {
      if (closed || event?.type !== TITLE_EVENT || typeof session?.id !== 'string') return;
      const prefix = `${session.id}\u0000`;
      for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
    })
    : undefined;

  /**
   * @param entries - admitted rows as `{ id, createdAt }`; only these ids are ever folded.
   * @param signal - caller cancellation, shared with the bounded fold.
   * @returns admitted titles by id; absent keys mean "no title", not an error.
   */
  async function read(entries, signal) {
    const resolved = new Map();
    if (closed || !Array.isArray(entries) || signal?.aborted) return resolved;
    const unique = [];
    const seen = new Set();
    for (const entry of entries) {
      if (typeof entry?.id !== 'string' || entry.id.length === 0 || seen.has(entry.id)) continue;
      seen.add(entry.id);
      unique.push({ id: entry.id, ...(integer(entry.createdAt) ? { createdAt: entry.createdAt } : {}) });
      if (unique.length >= limits.batch) break;
    }
    if (unique.length === 0) return resolved;
    const missing = [];
    for (const entry of unique) {
      const cached = cache.get(keyOf(entry.id, entry.createdAt));
      if (cached === undefined) missing.push(entry);
      else if (cached.title !== undefined) resolved.set(entry.id, cached.title);
    }
    if (missing.length === 0) return resolved;
    const query = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined;
    if (typeof query?.readTitleSnapshots !== 'function') return resolved;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('title hint deadline')), limits.wallMs);
    const foldSignal = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);
    let results;
    try {
      results = await query.readTitleSnapshots(missing.map(entry => entry.id), foldSignal);
    } catch {
      // Fail open: the page keeps its admitted rows and loses only the optional names.
      return resolved;
    } finally {
      clearTimeout(timer);
    }
    if (closed || !Array.isArray(results)) return resolved;
    const byId = new Map(missing.map(entry => [entry.id, entry]));
    for (const result of results) {
      const entry = byId.get(result?.sessionId);
      if (entry === undefined || result.status !== 'fulfilled') continue;
      const observation = result.value;
      // The fold must describe the same incarnation the page admitted.
      if (observation?.session?.id !== entry.id) continue;
      if (entry.createdAt !== undefined && integer(observation.session.createdAt) && observation.session.createdAt !== entry.createdAt) continue;
      const title = confirmedTitle(observation?.title?.title);
      remember(keyOf(entry.id, entry.createdAt), { title, eventSeq: observation?.title?.eventSeq });
      if (title !== undefined) resolved.set(entry.id, title);
    }
    // A result the provider omitted is not cached: the next page may observe it correctly.
    return resolved;
  }

  function close() {
    if (closed) return;
    closed = true;
    cache.clear();
    disposeEvent?.();
  }

  return Object.freeze({ read, close });
}

export default { createTitleHints, confirmedTitle, TITLE_HINTS_LIMITS };
