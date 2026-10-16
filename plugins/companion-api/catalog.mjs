import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { resolveHost } from '../common.mjs';
import { MAX_BYTES, MIN_BYTES, MAX_SNAPSHOTS, SESSION_ID, validCursor, refusal, companionMetadata, parseListRequest, parseDetailRequest, parseListOutput, parseDetailOutput } from './contracts.mjs';
const { SessionId } = await import(resolveHost('@deepseek-ai/dsh-session/types'));

/** Current Host persistence only. No independent Context, root, backend or lease. */
export function createCatalog(persistence, options = {}) {
  if (Object.keys(options).some(key => key !== 'maxBytes')) throw new TypeError('Unsupported catalog constructor option');
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_BYTES || maxBytes > MAX_BYTES) throw new RangeError('Invalid catalog byte budget');
  const key = randomBytes(32);
  const sign = text => createHmac('sha256', key).update(text).digest();
  function encode(offset, limit, revision) {
    const payload = Buffer.from(JSON.stringify({ v: 1, offset, limit, revision })).toString('base64url');
    return `${payload}.${sign(payload).toString('base64url')}`;
  }
  function decode(cursor, limit) {
    if (!validCursor(cursor)) throw refusal('invalid-cursor');
    const [payload, signature] = cursor.split('.');
    const bytes = Buffer.from(signature, 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== signature || !timingSafeEqual(bytes, sign(payload))) throw refusal('invalid-cursor');
    let value;
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch { throw refusal('invalid-cursor'); }
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 || value.v !== 1 || !Number.isSafeInteger(value.offset) || value.offset < 1 || value.offset > MAX_SNAPSHOTS || value.limit !== limit || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) throw refusal('invalid-cursor');
    return value;
  }
  async function listChats(raw, signal) {
    signal?.throwIfAborted();
    const request = parseListRequest(raw);
    const cursor = request.cursor === undefined ? undefined : decode(request.cursor, request.limit);
    let snapshots;
    try { snapshots = await persistence.list({ signal }); }
    catch { signal?.throwIfAborted(); throw refusal('metadata-unavailable'); }
    signal?.throwIfAborted();
    if (!Array.isArray(snapshots)) throw refusal('metadata-unavailable');
    if (snapshots.length > MAX_SNAPSHOTS) throw refusal('catalog-limit');
    const counts = new Map();
    const rows = [];
    for (const snapshot of snapshots) {
      signal?.throwIfAborted();
      const id = snapshot?.header?.id;
      if (typeof id === 'string' && SESSION_ID.test(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
      const row = companionMetadata(snapshot);
      if (row !== null) rows.push(row);
    }
    if (rows.some(row => counts.get(row.id) !== 1)) throw refusal('catalog-ambiguous');
    rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Cursor membership is creation order, not volatile title/activity/projections.
    const revision = createHash('sha256').update(JSON.stringify(rows.map(row => [row.id, row.createdAt ?? 0]))).digest('hex');
    if (cursor !== undefined && cursor.revision !== revision) throw refusal('cursor-stale');
    const offset = cursor?.offset ?? 0;
    if (offset > rows.length) throw refusal('invalid-cursor');
    const chats = [];
    let nextCursor = null;
    for (let index = offset; index < rows.length && chats.length < request.limit; index++) {
      signal?.throwIfAborted();
      const next = index + 1 < rows.length ? encode(index + 1, request.limit, revision) : null;
      const candidate = { profile: 'companion', chats: [...chats, rows[index]], nextCursor: next };
      if (Buffer.byteLength(JSON.stringify(candidate)) > maxBytes) break;
      chats.push(rows[index]); nextCursor = next;
    }
    // The smallest allowed budget fits any header-only row plus its cursor.
    // If display enrichment is added later, it must preserve this progress rule.
    if (offset < rows.length && chats.length === 0) throw refusal('catalog-limit');
    const value = parseListOutput({ profile: 'companion', chats, nextCursor });
    if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw refusal('invalid-output');
    signal?.throwIfAborted();
    return value;
  }
  async function detail(raw, signal) {
    signal?.throwIfAborted();
    const { id } = parseDetailRequest(raw);
    let snapshot;
    try { snapshot = await persistence.stat(SessionId(id), { signal }); }
    catch { signal?.throwIfAborted(); throw refusal('metadata-unavailable'); }
    signal?.throwIfAborted();
    if (snapshot?.header?.id !== id) throw refusal('foreign-session');
    const chat = companionMetadata(snapshot);
    if (chat === null) throw refusal('foreign-session');
    const value = parseDetailOutput({ profile: 'companion', chat });
    if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw refusal('invalid-output');
    return value;
  }
  return Object.freeze({ listChats, detail });
}
