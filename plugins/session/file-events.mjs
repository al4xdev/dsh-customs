import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';

export const FILE_EVENT_DEFAULTS = Object.freeze({ maxDecodedBytes: 64 * 1024 * 1024, maxLineBytes: 8 * 1024 * 1024, cacheBytes: 32 * 1024 * 1024 });
const SECRET = /(?:password|passwd|token|apikey|authorization|cookies?|clientsecret|privatekey|secret)$/i;
const PRIVATE = /^(?:reasoning|reasoningcontent|requestheaders?|headers|attachments?|blob|blobs|stream|meta)$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyName = key => key.replace(/[^a-z0-9]/gi, '');
const abort = signal => signal?.throwIfAborted();
function integer(value, fallback, name, minimum = 0) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`invalid ${name}`);
  return value;
}

// Strings may themselves contain serialized arguments. Sanitize those before
// excerpting, including quoted values with spaces and escaped quotes.
export function redactFileValue(value, depth = 0) {
  if (depth > 64) return '[omitted: nesting limit]';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[\[{"]/.test(trimmed)) {
      try { return JSON.stringify(redactFileValue(JSON.parse(trimmed), depth + 1)); } catch { /* Not a complete JSON document. */ }
    }
    return value
      .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]')
      .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[redacted]')
      .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
      .replace(/("(?:[^"\\]|\\.)*"|[A-Za-z_][\w-]*)\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, (match, key) => SECRET.test(keyName(key)) ? `${key}:"[redacted]"` : match)
      .replace(/\b([\w-]*(?:password|passwd|token|api[_-]?key|authorization|cookie|client[_-]?secret|private[_-]?key|secret))\s*[:=]\s*[^\s,;"']+/gi, '$1=[redacted]');
  }
  if (Array.isArray(value)) return value.map(item => redactFileValue(item, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE.test(keyName(key))).map(([key, item]) => [key, SECRET.test(keyName(key)) ? '[redacted]' : redactFileValue(item, depth + 1)]));
  return value;
}
function pick(value, keys) {
  return Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
}
function content(message) {
  const value = message?.content;
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
}
function safeEvent(event) {
  const result = pick(event, ['seq', 'type', 'time']);
  const data = object(event.data) ? event.data : {};
  switch (event.type) {
    case 'user/message': case 'assistant/message':
      result.data = { text: content(data.message ?? data) }; break;
    case 'tool/call':
      result.data = pick(data, ['name', 'callId', 'arguments', 'input']); break;
    case 'tool/result':
      result.data = { ...pick(data.message ?? data, ['name', 'callId', 'toolCallId', 'isError']), text: content(data.message ?? data), ...pick(data, ['error']) }; break;
    case 'session/title':
      result.data = pick(data, ['title', 'name', 'source']); break;
    case 'turn/end':
      result.data = pick(data, ['reason']); break;
    default:
      result.omitted = 'event payload is not public';
  }
  return redactFileValue(result);
}
function eventValue(event, section) {
  const data = event.data ?? {};
  if (section === 'event') return event;
  if (section === 'arguments') return event.type === 'tool/call' ? (data.arguments ?? data.input ?? '') : '';
  if (section === 'result') return event.type === 'tool/result' ? data : '';
  if (event.type === 'tool/call') return data;
  if (event.type === 'tool/result') return data;
  if (event.type === 'session/title') return data.title ?? data.name ?? '';
  if (event.type === 'turn/end') return data.reason ?? '';
  return data.text ?? '';
}

/** Input may be raw: public presentation always applies the allowlist again. */
export function presentEvent(event, { section = 'summary', format = 'text', textOffset = 0, textLimit = 2048, maxBytes = 32768 } = {}) {
  if (!['summary', 'arguments', 'result', 'event'].includes(section) || !['text', 'json'].includes(format)) throw new Error('invalid presentation');
  textOffset = integer(textOffset, 0, 'textOffset'); textLimit = integer(textLimit, 2048, 'textLimit', 1); maxBytes = integer(maxBytes, 32768, 'maxBytes', 256);
  // Loaded events use normalized text, unlike the physical SDK messages.
  const safe = safeEvent(event);
  if (['user/message', 'assistant/message', 'tool/result'].includes(event.type) && typeof event.data?.text === 'string') safe.data.text = redactFileValue(event.data.text);
  const value = eventValue(safe, section);
  const text = format === 'json' ? JSON.stringify(value) : typeof value === 'string' ? value : JSON.stringify(value);
  const end = Math.min(text.length, textOffset + textLimit);
  const result = { ...pick(safe, ['seq', 'type', 'time', 'omitted']), section, format, text: text.slice(textOffset, end), textOffset, textLength: text.length, nextTextOffset: end < text.length ? end : null, cutoff: textOffset > 0 || end < text.length };
  if (safe.type.startsWith('tool/')) Object.assign(result, { toolName: safe.data?.name ?? null, callId: safe.data?.callId ?? safe.data?.toolCallId ?? null, isError: safe.data?.isError === true });
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes && result.text.length) {
    result.text = result.text.slice(0, Math.floor(result.text.length / 2));
    result.nextTextOffset = textOffset + result.text.length < text.length ? textOffset + result.text.length : null;
    result.cutoff = true;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes || (!result.text.length && textOffset < text.length)) throw new Error('presentation metadata exceeds maxBytes');
  return result;
}

/** One literal match reference per event, offset indexes matching events, not characters. */
export function searchEvents(snapshot, { query, signal, caseSensitive = false, scope = 'all', offset = 0, limit = 20, ...presentation } = {}) {
  if (typeof query !== 'string' || !query.length || !['messages', 'tools', 'all'].includes(scope) || typeof caseSensitive !== 'boolean') throw new Error('invalid search');
  offset = integer(offset, 0, 'offset'); limit = integer(limit, 20, 'limit', 1);
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches = [];
  for (const event of snapshot.events) {
    abort(signal);
    const message = ['user/message', 'assistant/message'].includes(event.type), tool = ['tool/call', 'tool/result'].includes(event.type);
    if (scope === 'messages' && !message || scope === 'tools' && !tool) continue;
    const safeText = presentEvent(event, { section: presentation.section ?? 'summary', textLimit: 1 }).textLength;
    // Search the full sanitized value, never only a preview or a sampled child set.
    const safe = safeEvent(event);
    if (['user/message', 'assistant/message', 'tool/result'].includes(event.type) && typeof event.data?.text === 'string') safe.data.text = redactFileValue(event.data.text);
    const value = eventValue(safe, presentation.section ?? 'summary');
    const text = redactFileValue(typeof value === 'string' ? value : JSON.stringify(value));
    const matchOffset = (caseSensitive ? text : text.toLowerCase()).indexOf(needle);
    if (matchOffset >= 0) matches.push({ seq: event.seq, type: event.type, time: event.time, matchOffset, textLength: safeText });
  }
  const selected = matches.slice(offset, offset + limit);
  return { matches: selected, total: matches.length, offset, nextOffset: offset + selected.length < matches.length ? offset + selected.length : null, nextSeq: matches[offset + selected.length]?.seq ?? null, partial: snapshot.partial, cutoff: snapshot.partial || offset + selected.length < matches.length, warnings: snapshot.warnings };
}
function encodeSegment(raw) {
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  return raw.split('').map(ch => /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join('');
}
function projectKey(cwd) {
  if (cwd === undefined) return '_no-cwd';
  const readable = cwd.replace(/[\\/:]+/g, '\0').split('').map(ch => ch === '\0' ? '-' : /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join('');
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs) });
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs'].every(key => String(a[key]) === String(b[key]));
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

export function createFileEventReader({ root, maxDecodedBytes = FILE_EVENT_DEFAULTS.maxDecodedBytes, maxLineBytes = FILE_EVENT_DEFAULTS.maxLineBytes, cacheBytes = FILE_EVENT_DEFAULTS.cacheBytes } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('root must be absolute');
  root = resolve(root);
  maxDecodedBytes = integer(maxDecodedBytes, undefined, 'maxDecodedBytes', 1); maxLineBytes = integer(maxLineBytes, undefined, 'maxLineBytes', 1); cacheBytes = integer(cacheBytes, undefined, 'cacheBytes');
  const cache = new Map(); let cachedBytes = 0;
  async function load(candidate, { signal } = {}) {
    abort(signal);
    if (!candidate || ![3, 4].includes(candidate.version) || !['jsonl', 'zstd'].includes(candidate.encoding) || typeof candidate.path !== 'string' || !isAbsolute(candidate.path)) throw new Error('unsupported candidate');
    const path = resolve(candidate.path), parts = relative(root, path).split(sep);
    if (parts.length !== 3 || parts.some(part => !part || part === '..') || parts[2] !== `session.v${candidate.version}.jsonl${candidate.encoding === 'zstd' ? '.zstd' : ''}`) throw new Error('invalid session layout');
    if (await realpath(root) !== root || await realpath(path) !== path) throw new Error('symlink session path refused');
    const before = await lstat(path, { bigint: true });
    if (!before.isFile()) throw new Error('not a regular session file');
    const sig = identity(before);
    if (object(candidate.signature) && !same(candidate.signature, sig) || candidate.size !== undefined && String(candidate.size) !== sig.size || candidate.mtimeMs !== undefined && Math.abs(Number(before.mtimeNs) / 1e6 - candidate.mtimeMs) > 0.01) throw new Error('stale candidate identity');
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const initial = await fd.stat({ bigint: true });
      if (!initial.isFile() || !same(sig, identity(initial)) || await realpath(path) !== path) throw new Error('session identity changed');
      abort(signal);
      const cacheKey = JSON.stringify([path, sig]);
      if (cache.has(cacheKey)) { const hit = cache.get(cacheKey); cache.delete(cacheKey); cache.set(cacheKey, hit); return hit.snapshot; }
      const snapshot = { header: null, events: [], title: null, partial: false, warnings: [], counters: { encodedBytes: 0, decodedBytes: 0, lines: 0, events: 0 }, signature: sig };
      const warn = reason => { snapshot.partial = true; if (!snapshot.warnings.includes(reason)) snapshot.warnings.push(reason); };
      const toolNames = new Map();
      let previousSeq = -1, pending = Buffer.alloc(0), stopped = false;
      function line(bytes) {
        snapshot.counters.lines++;
        let row;
        try { row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('corrupt JSONL record'); }
        if (!snapshot.header) {
          if (!object(row) || row.type !== 'session' || row.version !== candidate.version || typeof row.id !== 'string' || !row.id || typeof row.isSeeded !== 'boolean' || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || row.cwd !== undefined && (typeof row.cwd !== 'string' || !isAbsolute(row.cwd))) throw new Error('invalid or unsupported session header');
          if (parts[0] !== projectKey(row.cwd) || parts[1] !== encodeSegment(row.id) || candidate.header?.id !== undefined && candidate.header.id !== row.id) throw new Error('session header identity/layout mismatch');
          snapshot.header = redactFileValue(pick(row, ['id', 'version', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'agentPreset', 'delegationDepth']));
          return;
        }
        if (!object(row) || !Number.isSafeInteger(row.seq) || row.seq < 0 || row.seq <= previousSeq || typeof row.type !== 'string' || !/^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)+$/.test(row.type) || !Number.isSafeInteger(row.time) || row.time < 0) throw new Error('invalid or unordered session event');
        previousSeq = row.seq;
        const event = safeEvent(row);
        if (event.type === 'tool/call' && typeof event.data.callId === 'string' && typeof event.data.name === 'string') toolNames.set(event.data.callId, event.data.name);
        if (event.type === 'tool/result' && !event.data.name) {
          const name = toolNames.get(event.data.toolCallId ?? event.data.callId);
          if (name) event.data.name = name;
        }
        snapshot.events.push(event); snapshot.counters.events++;
        if (event.type === 'session/title') {
          const title = event.data.title ?? event.data.name;
          if (typeof title === 'string') snapshot.title = { title, source: typeof event.data.source === 'string' ? event.data.source : typeof event.data.source?.kind === 'string' ? event.data.source.kind : 'unknown', seq: event.seq };
        }
      }
      async function* encoded() {
        const size = Number(initial.size);
        if (!Number.isSafeInteger(size)) throw new Error('session file too large');
        for (let position = 0; position < size;) {
          abort(signal);
          const buffer = Buffer.allocUnsafe(Math.min(65536, size - position));
          const { bytesRead } = await fd.read(buffer, 0, buffer.length, position);
          if (!bytesRead) throw new Error('session truncated during read');
          position += bytesRead; snapshot.counters.encodedBytes += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
      }
      const input = Readable.from(encoded());
      const stream = candidate.encoding === 'zstd' ? input.pipe(createZstdDecompress()) : input;
      const onError = error => stream.destroy(error);
      if (stream !== input) input.on('error', onError);
      const onAbort = () => { input.destroy(signal.reason); stream.destroy(signal.reason); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        outer: for await (const chunk of stream) {
          abort(signal);
          const available = maxDecodedBytes - snapshot.counters.decodedBytes;
          const bytes = chunk.subarray(0, available);
          snapshot.counters.decodedBytes += bytes.length;
          pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
          let start = 0, end;
          while ((end = pending.indexOf(10, start)) >= 0) {
            if (end - start > maxLineBytes) { warn('maxLineBytes'); stopped = true; break outer; }
            line(pending.subarray(start, end)); start = end + 1;
          }
          pending = pending.subarray(start);
          if (pending.length > maxLineBytes) { warn('maxLineBytes'); stopped = true; break; }
          if (bytes.length < chunk.length) { warn('maxDecodedBytes'); stopped = true; break; }
        }
      } catch (error) {
        abort(signal);
        // Only an incomplete final frame is recoverable. Malformed frames and
        // checksums are corruption, not successful partial reads.
        if (candidate.encoding === 'zstd' && error.code === 'Z_BUF_ERROR' && /unexpected end/i.test(error.message)) warn('incomplete zstd tail');
        else throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        input.destroy(); stream.destroy();
      }
      if (!snapshot.header) throw new Error('missing complete session header');
      if (pending.length && !stopped) warn('incomplete JSONL tail');
      const final = await fd.stat({ bigint: true });
      if (final.dev !== initial.dev || final.ino !== initial.ino || final.size < initial.size) throw new Error('session changed during read');
      const changed = !same(identity(final), sig);
      if (changed) warn('session changed after initial snapshot');
      snapshot.cutoff = snapshot.partial;
      snapshot.titleComplete = !snapshot.partial;
      snapshot.tailComplete = !snapshot.partial;
      freeze(snapshot);
      const bytes = Buffer.byteLength(JSON.stringify(snapshot));
      if (!changed && bytes <= cacheBytes) {
        // Remove old revisions as well as LRU overflow; entry count bounds tiny files.
        for (const [key, entry] of cache) if (entry.path === path) { cache.delete(key); cachedBytes -= entry.bytes; }
        cache.set(cacheKey, { path, snapshot, bytes }); cachedBytes += bytes;
        while (cachedBytes > cacheBytes || cache.size > 32) { const key = cache.keys().next().value; cachedBytes -= cache.get(key).bytes; cache.delete(key); }
      }
      return snapshot;
    } finally { await fd.close(); }
  }
  async function read(candidate, options = {}) {
    const snapshot = await load(candidate, options);
    const { seq, before, after, view = 'head' } = options;
    if (!['head', 'tail'].includes(view)) throw new Error('invalid view');
    for (const [name, value] of Object.entries({ seq, before, after })) if (value !== undefined) integer(value, undefined, name);
    const offset = integer(options.offset, 0, 'offset'), limit = integer(options.limit, 20, 'limit', 1);
    let events = snapshot.events.filter(event => (seq === undefined || event.seq === seq) && (before === undefined || event.seq < before) && (after === undefined || event.seq > after));
    if (view === 'tail') events = [...events].reverse();
    const selected = events.slice(offset, offset + limit).map(event => presentEvent(event, options));
    return { events: selected, total: events.length, offset, nextOffset: offset + selected.length < events.length ? offset + selected.length : null, nextSeq: events[offset + selected.length]?.seq ?? null, partial: snapshot.partial, warnings: snapshot.warnings, cutoff: snapshot.partial || offset + selected.length < events.length || selected.some(event => event.cutoff) };
  }
  async function summarize(candidate, options = {}) {
    const snapshot = await load(candidate, options);
    let lastUser = null, lastAssistant = null;
    for (const event of snapshot.events) {
      if (event.type === 'user/message') lastUser = presentEvent(event, { textLimit: 512 });
      if (event.type === 'assistant/message') lastAssistant = presentEvent(event, { textLimit: 512 });
    }
    return { header: snapshot.header, title: snapshot.title, lastUser, lastAssistant, partial: snapshot.partial, titleComplete: snapshot.titleComplete, tailComplete: snapshot.tailComplete, warnings: snapshot.warnings, counters: snapshot.counters, signature: snapshot.signature };
  }
  return { load, read, summarize, find: async (candidate, options) => searchEvents(await load(candidate, options), options), clearCache() { cache.clear(); cachedBytes = 0; } };
}
