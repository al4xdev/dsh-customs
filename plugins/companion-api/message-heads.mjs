import { performance } from 'node:perf_hooks';
import { resolveHost } from '../common.mjs';
import { companionMetadata, refusal } from './contracts.mjs';
import { parseMessageHeadsRequest, parseMessageHeadsOutput } from './message-heads-contracts.mjs';
import { activityTime } from './activity-order.mjs';
const { buildSessionEventRecords } = await import(resolveHost('@deepseek-ai/dsh-session-query'));
const { symbols: { original } } = await import(resolveHost('@deepseek-ai/cordis'));

export const MESSAGE_HEADS_LIMITS = Object.freeze({ wallMs: 1500, sessionEvents: 10000, batchEvents: 20000,
  sessionBytes: 4 * 1024 * 1024, batchBytes: 8 * 1024 * 1024, batchNodes: 100000, cacheEntries: 128 });
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const cancellation = () => new DOMException('Message metadata request cancelled.', 'AbortError');
const identity = value => value?.identity ?? value?.[original] ?? value;
const canonicalIdentity = value => value?.[original] ?? value;
const unknown = (sessionId, createdAt = null) => ({ sessionId, createdAt, knowledge: 'unknown', asOfSeq: null, lastVisibleAssistant: null });
class Unavailable extends Error {}
// Ephemeral host-only provenance: JSON lookalikes cannot import historical activity. Never contains bodies/paths.
const activityPublications = new WeakMap();
export function verifiedMessageActivityHeader(metadata, root, profile, persistence, profileDir) {
  const proof = activityPublications.get(metadata);
  return proof && proof.root === root && proof.profile === profile && proof.profileDir === profileDir && proof.persistence === canonicalIdentity(persistence) && proof.current() &&
    metadata.id === proof.header.id && metadata.createdAt === proof.header.createdAt && metadata.updatedAt === proof.time ? proof.header : undefined;
}
function rootHeader(snapshot, sessionId) {
  const header = snapshot?.header;
  if (companionMetadata(snapshot) === null || header.id !== sessionId || header.version !== 4 ||
      !integer(header.createdAt) || header.isSeeded !== false || header.parentSession !== undefined || header.origin !== undefined ||
      (header.delegationDepth !== undefined && header.delegationDepth !== 0)) throw refusal('foreign-session');
  return header;
}
function stamp(header) {
  return JSON.stringify([header.version, header.id, header.createdAt, header.cwd ?? null, header.agentPreset,
    header.isSeeded, header.parentSession ?? null, header.origin ?? null, header.delegationDepth ?? 0]);
}
function detached(row) { return { ...row, lastVisibleAssistant: row.lastVisibleAssistant === null ? null : { ...row.lastVisibleAssistant } }; }

// Conservative JSON-size upper bounds avoid serializing a giant tool result merely to discover it exceeds the budget.
function consumeJson(value, session, batch, limits, check) {
  const stack = [value], visited = new Set();
  function add(bytes) {
    session.bytes += bytes; batch.bytes += bytes;
    if (session.bytes > limits.sessionBytes || batch.bytes > limits.batchBytes) throw new Unavailable();
  }
  while (stack.length) {
    check();
    if (++batch.nodes > limits.batchNodes) throw new Unavailable();
    const item = stack.pop();
    if (item === null) { add(4); continue; }
    if (typeof item === 'string') { add(item.length * 6 + 2); continue; }
    if (typeof item === 'number' && Number.isFinite(item)) { add(32); continue; }
    if (typeof item === 'boolean') { add(5); continue; }
    if (typeof item !== 'object' || visited.has(item)) throw new Unavailable();
    visited.add(item);
    if (Array.isArray(item)) {
      if (item.length > limits.batchNodes - batch.nodes) throw new Unavailable();
      add(2 + item.length);
      for (let index = item.length - 1; index >= 0; index--) stack.push(item[index]);
    } else {
      const keys = Object.keys(item);
      if (keys.length > limits.batchNodes - batch.nodes) throw new Unavailable();
      add(2 + keys.length);
      for (const key of keys) { add(key.length * 6 + 3); stack.push(item[key]); }
    }
  }
}

/** Pure metadata owner. Public reads may load cold bodies server-side; no Agent is resolved or followed. */
export function createMessageHeads(ctx, options = {}, trusted = {}) {
  if (Object.keys(trusted).some(key => key !== 'onActivity') || trusted.onActivity !== undefined && typeof trusted.onActivity !== 'function') throw new TypeError('Invalid trusted metadata callback');
  const onActivity = trusted.onActivity;
  const owner = onActivity ? ctx.fiber : undefined, root = onActivity ? ctx.root : undefined;
  const rootFiber = root?.fiber, ownerUid = owner?.uid, rootUid = rootFiber?.uid;
  const profile = onActivity ? ctx.get('profileContext') : undefined, profileDir = profile?.dir;
  const bridgeCurrent = () => !closed && integer(ownerUid) && integer(rootUid) && owner.uid === ownerUid && rootFiber.uid === rootUid &&
    ctx.fiber === owner && ctx.root === root && root.fiber === rootFiber && ctx.get('profileContext') === profile && root.get('profileContext') === profile &&
    profile?.name === 'companion' && typeof profileDir === 'string' && profileDir.length > 0 && profile.dir === profileDir;
  if (Object.keys(options).some(key => !Object.hasOwn(MESSAGE_HEADS_LIMITS, key))) throw new TypeError('Unsupported message metadata option');
  const limits = { ...MESSAGE_HEADS_LIMITS, ...options };
  for (const key of Object.keys(limits)) if (!integer(limits[key], 1) || limits[key] > MESSAGE_HEADS_LIMITS[key]) throw new RangeError('Invalid message metadata budget');
  const cache = new Map();
  let busy = false, closed = false, activeController;
  function remember(sessionId, entry) {
    cache.delete(sessionId); cache.set(sessionId, entry);
    while (cache.size > limits.cacheEntries) cache.delete(cache.keys().next().value);
  }
  function clear() { closed = true; activeController?.abort(); cache.clear(); }
  async function read(raw, signal) {
    const { sessionIds } = parseMessageHeadsRequest(raw);
    if (signal?.aborted) throw cancellation();
    if (closed) throw refusal('metadata-unavailable');
    if (sessionIds.length === 0) return parseMessageHeadsOutput({ version: 1, profile: 'companion', heads: [] });
    // Refuse overlapping work rather than queue unbounded foreground retries. Late SDK work still owns this slot.
    if (busy) return parseMessageHeadsOutput({ version: 1, profile: 'companion', heads: sessionIds.map(id => unknown(id)) });
    busy = true;
    const controller = new AbortController(); activeController = controller;
    const started = performance.now();
    const pending = new Set();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, limits.wallMs);
    const budget = { events: 0, bytes: 0, nodes: 0 };
    const activityCandidates = [];
    const candidate = (header, time) => { if (onActivity && integer(time) && time >= header.createdAt) activityCandidates.push({ header, time }); };
    const check = () => {
      if (signal?.aborted) throw cancellation();
      if (controller.signal.aborted || performance.now() - started >= limits.wallMs) throw new Unavailable();
    };
    // Cancellation returns promptly even for a non-cooperative provider; a late observation is disposed, never published.
    async function wait(operation, late) {
      check();
      const task = Promise.resolve().then(operation);
      pending.add(task);
      task.then(() => pending.delete(task), () => pending.delete(task));
      return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => { if (!settled) { settled = true; reject(new Unavailable()); } };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        task.then(value => {
          controller.signal.removeEventListener('abort', onAbort);
          if (settled) { try { late?.(value); } catch {} return; }
          settled = true; resolve(value);
        }, () => {
          controller.signal.removeEventListener('abort', onAbort);
          if (!settled) { settled = true; reject(new Unavailable()); }
        });
        if (controller.signal.aborted) onAbort();
      });
    }
    async function mapTwo(items, operation) {
      const output = new Array(items.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
        for (;;) { const index = next++; if (index >= items.length) return; output[index] = await operation(items[index]); }
      }));
      return output;
    }
    try {
      const persistence = ctx.sessionPersistence;
      const query = ctx.get('sessionQuery');
      const sessions = ctx.get('sessions');
      const binding = [identity(persistence), identity(query), identity(sessions)];
      const receiptBinding = onActivity ? [persistence, query, sessions].map(canonicalIdentity) : undefined;
      const receiptRoot = onActivity ? persistence?.config?.root : undefined, receiptCompression = onActivity ? persistence?.config?.compression : undefined;
      const receiptCurrent = () => bridgeCurrent() && [ctx.sessionPersistence, ctx.get('sessionQuery'), ctx.get('sessions')].every((value, index) => canonicalIdentity(value) === receiptBinding[index]) &&
        canonicalIdentity(root.get('sessionPersistence')) === receiptBinding[0] && persistence?.config?.root === receiptRoot && persistence?.config?.compression === receiptCompression;
      const sourceCurrent = () => identity(ctx.sessionPersistence) === binding[0] && identity(ctx.get('sessionQuery')) === binding[1] &&
        identity(ctx.get('sessions')) === binding[2];
      async function validatePublication(admission, source, live, cursor) {
        const latest = await wait(() => persistence.stat(admission.sessionId, { signal: controller.signal }));
        check();
        if (!sourceCurrent() || latest?.revision === undefined || latest.revision !== admission.snapshot.revision ||
            stamp(rootHeader(latest, admission.sessionId)) !== admission.headerStamp) throw new Unavailable();
        if (typeof sessions?.get === 'function') {
          const attached = sessions.get(admission.sessionId);
          if (source === 'prepared' ? attached !== undefined : attached !== live || attached?.seq !== cursor + 1) throw new Unavailable();
        }
      }
      // Admit the complete batch first: a foreign root never causes any requested event log to be inspected.
      const admitted = await mapTwo(sessionIds, async sessionId => {
        let snapshot;
        try { snapshot = await wait(() => persistence.stat(sessionId, { signal: controller.signal })); check(); }
        catch { if (signal?.aborted) throw cancellation(); return { sessionId }; }
        const header = rootHeader(snapshot, sessionId);
        return { sessionId, snapshot, header, headerStamp: stamp(header) };
      });
      const heads = await mapTwo(admitted, async admission => {
        const { sessionId, snapshot, header, headerStamp } = admission;
        const fallback = unknown(sessionId, header?.createdAt ?? null);
        if (!header || typeof query?.observeSession !== 'function') return fallback;
        let observation;
        try {
          check();
          if (integer(snapshot.eventCount) && snapshot.eventCount > limits.sessionEvents ||
              integer(snapshot.sizeBytes) && snapshot.sizeBytes > limits.sessionBytes) return fallback;
          const cached = cache.get(sessionId);
          const sameSource = cached && cached.binding[0] === binding[0] && cached.binding[1] === binding[1] &&
            cached.binding[2] === binding[2] && cached.headerStamp === headerStamp;
          // A metadata-only cold cache hit is safe only when the current public registry proves no unflushed live overlay exists.
          if (sameSource && cached.source === 'prepared' && snapshot.revision !== undefined && cached.revision === snapshot.revision &&
              typeof sessions?.get === 'function' && sessions.get(sessionId) === undefined) {
            await validatePublication(admission, 'prepared', undefined, cached.cursor);
            remember(sessionId, cached); candidate(header, cached.activityAt); return detached(cached.row);
          }
          const beforeLive = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
          if (beforeLive !== undefined) {
            if (!integer(beforeLive.seq) || beforeLive.seq > limits.sessionEvents || stamp(beforeLive.header) !== headerStamp) throw new Unavailable();
          } else {
            // This bounds known uncompressed input at admission, NOT SDK decode under a concurrent append race.
            // The public observer has no max-decode option; compressed/unknown-size cold inputs stay unknown.
            if (persistence.name !== 'session-persistence-jsonl' || persistence.config?.compression !== 'none' ||
                !integer(snapshot.sizeBytes) || snapshot.sizeBytes > limits.sessionBytes) throw new Unavailable();
          }
          observation = await wait(() => query.observeSession(sessionId, { signal: controller.signal, projectionMode: 'none' }),
            value => value?.[Symbol.dispose]?.());
          check();
          if (!observation || typeof observation[Symbol.dispose] !== 'function' ||
              !['live', 'prepared'].includes(observation.source) || !integer(observation.cursor, -1) || observation.inheritedEventCount !== 0) throw new Unavailable();
          const observedHeader = rootHeader(observation, sessionId);
          if (stamp(observedHeader) !== headerStamp) throw new Unavailable();
          if (observation.source === 'prepared' && (snapshot.revision === undefined || observation.revision !== snapshot.revision)) throw new Unavailable();
          const live = observation.source === 'live' && typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
          if (observation.source === 'live' && live !== undefined &&
              (live.seq !== observation.cursor + 1 || stamp(live.header) !== headerStamp)) throw new Unavailable();
          if (sameSource && cached.source === observation.source && cached.cursor === observation.cursor &&
              (observation.source === 'live' ? live !== undefined && cached.live?.deref() === live : cached.revision === observation.revision)) {
            await validatePublication(admission, observation.source, live, observation.cursor);
            remember(sessionId, cached); candidate(header, cached.activityAt); return detached(cached.row);
          }
          if (observation.cursor + 1 > limits.sessionEvents || budget.events + observation.cursor + 1 > limits.batchEvents) throw new Unavailable();
          const events = observation.events;
          if (!Array.isArray(events) || events.length !== observation.cursor + 1) throw new Unavailable();
          const sessionBudget = { bytes: 0 };
          for (let index = 0; index < events.length; index++) {
            check();
            const event = events[index];
            if (!event || event.seq !== index || !integer(event.time) || typeof event.type !== 'string') throw new Unavailable();
            budget.events++;
            consumeJson(event, sessionBudget, budget, limits, check);
          }
          const records = buildSessionEventRecords(sessionId, events);
          check();
          let head = null, activityAt = null;
          for (const record of records) {
            if (record.surface !== 'current') continue;
            const event = events[record.seq];
            if (record.type === 'user/message') {
              if (onActivity) {
                const time = activityTime(event);
                if (time !== null && time >= header.createdAt) activityAt = Math.max(activityAt ?? time, time);
              }
              continue;
            }
            if (record.type !== 'assistant/message') continue;
            const data = event.data, message = data?.message;
            if (message?.role !== 'assistant' || message.source?.kind !== 'model' || !Array.isArray(message.content)) throw new Unavailable();
            if (data.interrupted !== undefined && data.interrupted !== true) throw new Unavailable();
            if (!message.content.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)) continue;
            // The existing fold already proved visible model text; do not walk its content a second time.
            if (onActivity && event.time >= header.createdAt) activityAt = Math.max(activityAt ?? event.time, event.time);
            head = { seq: record.seq, messageId: message.id, time: record.time, interrupted: data.interrupted === true };
          }
          check();
          const row = { sessionId, createdAt: header.createdAt, knowledge: 'current', asOfSeq: observation.cursor, lastVisibleAssistant: head };
          // Validate before caching; malformed provider metadata must never become a positive badge.
          parseMessageHeadsOutput({ version: 1, profile: 'companion', heads: [row] });
          await validatePublication(admission, observation.source, live, observation.cursor);
          remember(sessionId, { binding, headerStamp, source: observation.source, revision: observation.revision, cursor: observation.cursor,
            live: live === undefined ? undefined : new WeakRef(live), row: detached(row), activityAt });
          candidate(header, activityAt);
          return row;
        } catch { if (signal?.aborted) throw cancellation(); return fallback; }
        finally { try { observation?.[Symbol.dispose]?.(); } catch {} }
      });
      if (signal?.aborted) throw cancellation();
      if (!sourceCurrent()) return parseMessageHeadsOutput({ version: 1, profile: 'companion', heads: sessionIds.map(id => unknown(id)) });
      const output = parseMessageHeadsOutput({ version: 1, profile: 'companion', heads });
      // Publish only a fully validated batch, outside all body folds. One failure/timeout means no partial hints.
      if (onActivity && heads.every(row => row.knowledge === 'current')) {
        try { check(); } catch { return output; }
        for (const { header, time } of activityCandidates) {
          if (!receiptCurrent() || !sourceCurrent()) break;
          const metadata = Object.freeze({ id: header.id, createdAt: header.createdAt, updatedAt: time });
          const safeHeader = Object.freeze({ version: header.version, id: header.id, createdAt: header.createdAt, agentPreset: header.agentPreset,
            isSeeded: header.isSeeded, parentSession: header.parentSession, origin: header.origin, delegationDepth: header.delegationDepth });
          activityPublications.set(metadata, { root, profile, profileDir, persistence: receiptBinding[0], header: safeHeader, time, current: () => receiptCurrent() && sourceCurrent() });
          try { Promise.resolve(onActivity(metadata)).catch(() => {}); } catch { /* Trusted enrichment cannot break or expose metadata. */ }
          finally { activityPublications.delete(metadata); }
        }
      }
      return output;
    } finally {
      controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (activeController === controller) activeController = undefined;
      // An ignored abort cannot create unlimited concurrent reads on subsequent requests.
      if (pending.size > 0) Promise.allSettled([...pending]).then(() => { busy = false; });
      else busy = false;
    }
  }
  return Object.freeze({ read, clear });
}
