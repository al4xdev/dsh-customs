import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
export function rootHeader(header) {
  return header?.version === 4 && validId(header.id) && integer(header.createdAt) && header.agentPreset === 'companion' &&
    header.isSeeded === false && header.parentSession === undefined && header.origin === undefined && (header.delegationDepth ?? 0) === 0;
}

/** Recency is not unread or acknowledgement. Only canonical user-visible message/audit activity contributes here. */
export function activityTime(event) {
  if (!integer(event?.time) || !integer(event?.seq)) return null;
  if (event.type === 'user/message' && event.data?.source?.kind === 'user') return event.time;
  if (event.type === 'approval/asked') return event.time;
  if (event.type !== 'assistant/message') return null;
  const message = event.data?.message;
  if (message?.role !== 'assistant' || message.source?.kind !== 'model' || !Array.isArray(message.content)) return null;
  // A bounded prefix avoids walking arbitrarily large whitespace payloads on the append callback.
  const text = message.content.slice(0, 128).some(block => block?.type === 'text' && typeof block.text === 'string' && /\S/u.test(block.text.slice(0, 65536)));
  return text ? event.time : null;
}

export function createRecencyLedger({ maxEntries = 4096 } = {}) {
  if (!integer(maxEntries) || maxEntries < 1 || maxEntries > 4096) throw new RangeError('Invalid recency entry budget');
  const rows = new Map();
  function observe(header, event) {
    if (!rootHeader(header)) return false;
    const time = activityTime(event);
    if (time === null || time < header.createdAt) return false;
    const previous = rows.get(header.id);
    if (previous?.createdAt === header.createdAt && previous.updatedAt >= time) return false;
    rows.delete(header.id);
    rows.set(header.id, Object.freeze({ id: header.id, createdAt: header.createdAt, updatedAt: time }));
    while (rows.size > maxEntries) rows.delete(rows.keys().next().value);
    return true;
  }
  function hint(header) {
    if (!rootHeader(header)) return undefined;
    const row = rows.get(header.id);
    return row?.createdAt === header.createdAt ? row.updatedAt : undefined;
  }
  return Object.freeze({ observe, hint, clear() { rows.clear(); }, exportMetadata() { return [...rows.values()].map(row => ({ ...row })); } });
}

export function newestFirst(rows) {
  return [...rows].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0) ||
    (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A cursor pins immutable metadata, not a volatile sort revision. New messages cannot skip/duplicate a page. */
export function createRecencyPager({ now = () => performance.now(), ttlMs = 300000, maxSnapshots = 8, maxBytes = 32768,
  fail = code => Object.assign(new Error('Recent conversation page unavailable.'), { code: `companion/${code}` }) } = {}) {
  if (![ttlMs, maxSnapshots, maxBytes].every(integer) || ttlMs < 1 || ttlMs > 300000 || maxSnapshots < 1 || maxSnapshots > 8 || maxBytes < 1024 || maxBytes > 32768) throw new RangeError('Invalid recency page budget');
  let key = randomBytes(32);
  const snapshots = new Map();
  const sign = payload => createHmac('sha256', key).update(payload).digest();
  function prune() { const time = now(); for (const [id, snapshot] of snapshots) if (time >= snapshot.expires) snapshots.delete(id); }
  function encode(id, offset, limit) {
    const payload = Buffer.from(JSON.stringify({ v: 1, snapshot: id, offset, limit })).toString('base64url');
    return `${payload}.${sign(payload).toString('base64url')}`;
  }
  function decode(cursor, limit) {
    if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw fail('invalid-cursor');
    const [payload, rawSignature] = cursor.split('.');
    const signature = Buffer.from(rawSignature, 'base64url');
    if (signature.length !== 32 || signature.toString('base64url') !== rawSignature || !timingSafeEqual(signature, sign(payload))) throw fail('invalid-cursor');
    let value;
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw fail('invalid-cursor'); }
    if (!value || typeof value !== 'object' || Object.keys(value).length !== 4 || value.v !== 1 || typeof value.snapshot !== 'string' || !/^[a-f0-9]{32}$/.test(value.snapshot) || !integer(value.offset) || value.offset < 1 || value.offset > 4096 || value.limit !== limit) throw fail('invalid-cursor');
    return value;
  }
  function page(id, offset, limit) {
    const snapshot = snapshots.get(id);
    if (!snapshot) throw fail('cursor-stale');
    if (offset > snapshot.rows.length) throw fail('invalid-cursor');
    const chats = [];
    let nextCursor = null;
    for (let index = offset; index < snapshot.rows.length && chats.length < limit; index++) {
      const next = index + 1 < snapshot.rows.length ? encode(id, index + 1, limit) : null;
      const row = { ...snapshot.rows[index] };
      const bytes = () => Buffer.byteLength(JSON.stringify({ profile: 'companion', chats: [...chats, row], nextCursor: next }));
      // Optional display enrichment must not prevent progress at the smallest byte budget.
      if (chats.length === 0 && bytes() > maxBytes) delete row.title;
      if (bytes() > maxBytes) break;
      chats.push(row); nextCursor = next;
    }
    if (offset < snapshot.rows.length && chats.length === 0) throw fail('catalog-limit');
    return { profile: 'companion', chats, nextCursor };
  }
  function list(rows, request) {
    if (!integer(request?.limit) || request.limit < 1 || request.limit > 100) throw fail('invalid-request');
    prune();
    if (request.cursor !== undefined) { const cursor = decode(request.cursor, request.limit); return page(cursor.snapshot, cursor.offset, request.limit); }
    if (!Array.isArray(rows) || rows.length > 4096 || new Set(rows.map(row => row.id)).size !== rows.length) throw fail('catalog-limit');
    // Only the existing public metadata vocabulary is captured; never preserve a header/body by spreading it.
    const captured = rows.map(row => {
      if (!validId(row.id) || (row.createdAt !== undefined && !integer(row.createdAt)) || (row.updatedAt !== undefined && !integer(row.updatedAt))) throw fail('invalid-output');
      if (row.title !== undefined && (typeof row.title !== 'string' || row.title.length < 1 || row.title.length > 240 || /\p{Cc}/u.test(row.title))) throw fail('invalid-output');
      return Object.freeze({ id: row.id, ...(row.title === undefined ? {} : { title: row.title }), ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }), ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }) });
    });
    const id = randomBytes(16).toString('hex');
    snapshots.set(id, { expires: now() + ttlMs, rows: Object.freeze(newestFirst(captured)) });
    while (snapshots.size > maxSnapshots) snapshots.delete(snapshots.keys().next().value);
    return page(id, 0, request.limit);
  }
  return Object.freeze({ list, clear() { snapshots.clear(); key = randomBytes(32); } });
}
