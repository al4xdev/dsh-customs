import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const OPERATIONS = ['help', 'list', 'inspect', 'read', 'send', 'resume'];
export const DEFAULT_BYTES = 8192;
export const MAX_BYTES = 32768;
export const MAX_TEXT = 16384;
const keys = {
  help: [], list: ['project', 'state', 'cursor', 'limit', 'maxBytes'],
  inspect: ['sessionId', 'limit', 'maxBytes'],
  read: ['sessionId', 'cursor', 'revision', 'limit', 'maxBytes'],
  send: ['sessionId', 'text'], resume: ['sessionId', 'text'],
};
export function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}
export function parseRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !OPERATIONS.includes(input.operation)) throw new Error('invalid operation');
  const { operation } = input;
  for (const key of Object.keys(input)) if (key !== 'operation' && !keys[operation].includes(key)) throw new Error(`unexpected argument: ${key}`);
  if (['inspect', 'read', 'send', 'resume'].includes(operation) && !validId(input.sessionId)) throw new Error('invalid sessionId');
  if (['send', 'resume'].includes(operation) && (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > MAX_TEXT)) throw new Error('text must be nonempty and at most 16 KiB');
  for (const key of ['project', 'cursor', 'revision']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 2048)) throw new Error(`invalid ${key}`);
  if (input.state !== undefined && !['alive', 'ended', 'waiting', 'unknown'].includes(input.state)) throw new Error('invalid state');
  const limit = input.limit ?? (operation === 'inspect' ? 12 : 32);
  const maxBytes = input.maxBytes ?? DEFAULT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1..100');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_BYTES) throw new Error('maxBytes must be 1024..32768');
  return { ...input, limit, maxBytes };
}
export function cursorCodec() {
  const secret = randomBytes(32);
  const mac = body => createHmac('sha256', secret).update(body).digest('base64url');
  return {
    revision: value => mac(JSON.stringify(value)),
    encode: data => { const body = Buffer.from(JSON.stringify(data)).toString('base64url'); return `${body}.${mac(body)}`; },
    decode: (token, id) => {
      if (typeof token !== 'string' || token.length > 2048) throw new Error('invalid cursor');
      const [body, signature, extra] = token.split('.');
      const expected = Buffer.from(mac(body ?? ''));
      const actual = Buffer.from(signature ?? '');
      if (extra || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('invalid or expired cursor');
      const data = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (data.id !== id || !Number.isSafeInteger(data.offset) || data.offset < 0) throw new Error('cursor target mismatch');
      return data;
    },
  };
}
export function boundedPage(base, rows, field, maxBytes, makeCursor) {
  const value = { ...base, [field]: [], truncated: false, nextCursor: null };
  for (let index = 0; index < rows.length; index++) {
    value[field].push(rows[index]);
    value.nextCursor = makeCursor(index + 1);
    value.truncated = index + 1 < rows.length || Boolean(base.hasMore);
    if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) {
      value[field].pop();
      if (index === 0) {
        // A large row must not produce a forever-repeating empty cursor. Keep
        // its identity, explicitly omit its preview, and advance one event.
        const row = rows[index];
        const compact = field === 'events'
          ? { seq: row.seq, time: row.time, type: row.type, contentTruncated: true, omitted: 'preview exceeds byte budget' }
          : { header: { id: row.header.id }, state: row.state, source: row.source, contentTruncated: true, omitted: 'metadata exceeds byte budget' };
        value[field].push(compact);
        value.nextCursor = makeCursor(1);
        if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) break;
        value[field].pop();
        throw new Error('response metadata exceeds byte budget; request a larger maxBytes');
      }
      value.nextCursor = makeCursor(index);
      value.truncated = true;
      break;
    }
  }
  if (!rows.length) value.nextCursor = makeCursor(0);
  delete value.hasMore;
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new Error('response metadata exceeds byte budget');
  return value;
}
// Only text previews are exposed: no tool arguments/results, request headers,
// reasoning streams, attachment bodies or credential files cross this face.
export function previewEvent(event) {
  const out = { seq: event.seq, time: event.time, type: event.type };
  const data = event.data ?? {};
  if (event.type === 'user/message' || event.type === 'assistant/message') {
    const message = event.type === 'user/message' ? data : data.message;
    const text = (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    out.text = redact(text).slice(0, 512);
    out.contentTruncated = text.length > 512;
  }
  if (event.type === 'turn/end') {
    out.reason = data.reason?.kind;
    const code = data.reason?.error?.code;
    if (typeof code === 'string' && /^[A-Za-z0-9_/-]{1,80}$/.test(code)) out.errorCode = redact(code);
  }
  if (event.type === 'tool/call') out.toolName = String(data.name ?? '').slice(0, 80);
  if (event.type === 'tool/result') out.isError = data.message?.isError === true;
  if (event.type === 'approval/asked' || event.type === 'approval/decided') {
    out.requestId = String(data.id ?? '').slice(0, 128);
    if (event.type === 'approval/decided') out.outcome = data.outcome;
  }
  return out;
}
export function redact(text) {
  return String(text).replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}
export function publicHeader(header) {
  return Object.fromEntries(['id', 'version', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'agentPreset'].filter(key => ['string', 'number', 'boolean'].includes(typeof header[key])).map(key => [key, typeof header[key] === 'string' ? redact(header[key]).slice(0, 512) : header[key]]));
}
