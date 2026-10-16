import { createHash } from 'node:crypto';
import { createSourceLocator, componentPrefix } from './source-locator.mjs';
import { READ_LIMITS, READ_SCHEMAS, parseReadRequest, readError } from './read-contracts.mjs';
import { cursorCodec, publicHeader, previewEvent, redact } from './contracts.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Public SDK root headers may omit depth; JSONL persists that exact default as 0.
// Only undefined is defaulted: malformed or genuinely different depths still fence reads.
const delegationDepth = header => header.delegationDepth === undefined ? 0 : header.delegationDepth;
const lifecycle = header => [header.id, header.createdAt, header.cwd, header.parentSession, header.isSeeded, delegationDepth(header), header.incarnation];
function compatible(left, right) { return hash(lifecycle(left)) === hash(lifecycle(right)); }
function authorizedText(event) {
  const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data?.message : undefined;
  return (message?.content ?? []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
}
function safeEvent(event) {
  const out = previewEvent(event);
  if (['user/message', 'assistant/message'].includes(event.type)) {
    out.text = redact(authorizedText(event));
    const kind = (event.type === 'user/message' ? event.data : event.data?.message)?.source?.kind;
    if (typeof kind === 'string' && /^[a-zA-Z0-9_.:/-]{1,64}$/.test(kind)) out.messageSource = redact(kind);
    delete out.contentTruncated; delete out.nextTextOffset; delete out.textLength; delete out.textOffset;
  }
  for (const key of ['toolName', 'requestId', 'outcome']) if (typeof out[key] === 'string') out[key] = redact(out[key]).slice(0, 128);
  return out;
}
export function previewCutEvent(event, args) {
  const out = { ...event };
  if (typeof out.text === 'string') {
    const text = out.text;
    const offset = args.textOffset ?? 0, length = args.textLimit ?? 512;
    out.text = text.slice(offset, offset + length);
    out.textOffset = offset; out.textLength = text.length;
    out.nextTextOffset = offset + out.text.length < text.length ? offset + out.text.length : null;
    out.contentTruncated = offset > 0 || out.nextTextOffset !== null;
  }
  return out;
}
// Literal normalization is bounded by the request contract. Neither mode accepts
// executable FTS/regex syntax. Scan phrase tokens are deliberately labelled a
// Unicode-word fallback, not falsely advertised as the SQLite unicode61 engine.
const words = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [];
export function matchesText(text, query, mode) {
  if (mode === 'substring') return text.toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').includes(query.trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' '));
  const hay = words(text), needle = words(query);
  return needle.length > 0 && hay.some((_, start) => needle.every((word, index) => hay[start + index] === word));
}
function shortFailure(error) {
  if (error?.sessionReadError) return error.code;
  const codes = { SessionFormatUnsupportedError: 'unsupported_format', SessionPersistenceCorruptionError: 'corrupt_log', SessionPersistenceNotFoundError: 'not_found' };
  return codes[error?.name] ?? 'backend_unavailable';
}
function fingerprint(args) {
  const skip = new Set(['cursor', 'pollingCursor', 'revision', 'limit', 'maxBytes', 'textLimit', 'textOffset', 'candidateBudget', 'scanBytes', 'scanEvents', 'durationMs']);
  return Object.fromEntries(Object.keys(args).sort().filter(key => !skip.has(key)).map(key => [key, args[key]]));
}
function compact(row) {
  return Object.fromEntries(['sessionId', 'seq', 'time', 'type', 'window', 'role', 'pathRef', 'selected', 'physicalFormatVersion', 'code', 'state', 'writerOwnership'].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
}
function outputPage(base, rows, field, args, cursorAt) {
  const result = { ...base, [field]: [], nextCursor: null, truncated: false };
  if (result.counters) result.counters = Object.fromEntries(Object.entries(result.counters).filter(([, count]) => count !== 0));
  // Long display metadata is optional; source/revision/coverage identities are not.
  if (Buffer.byteLength(JSON.stringify(result)) > args.maxBytes && result.header) result.header = { id: result.header.id };
  if (Buffer.byteLength(JSON.stringify(result)) > args.maxBytes && result.location) result.location = { role: result.location.role, pathRef: result.location.pathRef };
  let used = 0;
  for (const row of rows.slice(0, args.limit)) {
    result[field].push(row); used++;
    result.nextCursor = cursorAt(used); result.truncated = result.nextCursor !== null;
    if (Buffer.byteLength(JSON.stringify(result)) > args.maxBytes) {
      result[field].pop(); used--;
      if (!used) {
        result[field].push({ ...compact(row), contentTruncated: true, omitted: 'row exceeds byte budget' }); used = 1;
        result.nextCursor = cursorAt(used); result.truncated = result.nextCursor !== null;
      } else { result.nextCursor = cursorAt(used); result.truncated = true; }
      break;
    }
  }
  if (!rows.length) { result.nextCursor = cursorAt(0); result.truncated = result.nextCursor !== null; }
  if (Buffer.byteLength(JSON.stringify(result)) > args.maxBytes) {
    // At 1KiB the authenticated continuation/polling tokens can consume most
    // of the envelope. Preserve source/revision/watermarks and row progress.
    delete result.header;
    delete result.cut;
    if (result.inheritedEventCount === null) delete result.inheritedEventCount;
    result.metadataTruncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > args.maxBytes) {
    delete result.freshness;
    delete result.synthetic;
    if (result.effect === 'none') delete result.effect;
  }
  // The target is already authenticated by the caller's explicit id/pathRef.
  // A huge display id must not prevent an otherwise bounded event page.
  if (Buffer.byteLength(JSON.stringify(result)) > args.maxBytes && ['read', 'context'].includes(args.operation)) delete result.sessionId;
  if (Buffer.byteLength(JSON.stringify(result)) > args.maxBytes) throw readError('metadata_budget', 'Increase maxBytes for source/cut metadata.');
  return result;
}

/** Read-side owner. Uses only public services; never creates an Agent, opens a
 * writer, mounts a persistence backend, or opens an external SQLite connection. */
export function createReadSide(ctx, options = {}) {
  const codec = cursorCodec();
  const locator = createSourceLocator(ctx, codec, options);
  const cuts = new Map();
  const searchStates = new Map();
  const liveInstances = new WeakMap();
  const now = options.now ?? Date.now;
  let nextInstance = 0, cacheBytes = 0, searchStateBytes = 0;
  function counters() { return { lists: 0, stats: 0, opens: 0, observations: 0, cacheHits: 0, nativeQueries: 0, entries: 0, candidates: 0, events: 0, bytes: 0, scanEvents: 0, scanBytes: 0 }; }
  function instance(live) { if (!liveInstances.has(live)) liveInstances.set(live, ++nextInstance); return liveInstances.get(live); }
  function evict() {
    for (const [key, cut] of cuts) if (cut.expires < now()) { cuts.delete(key); cacheBytes -= cut.bytes; }
    while (cuts.size > READ_LIMITS.cuts || cacheBytes > READ_LIMITS.cutBytes) { const key = cuts.keys().next().value; cacheBytes -= cuts.get(key).bytes; cuts.delete(key); }
    for (const [key, entry] of searchStates) if (entry.expires < now()) { searchStates.delete(key); searchStateBytes -= entry.bytes; }
    while (searchStates.size > READ_LIMITS.searchStates || searchStateBytes > READ_LIMITS.searchStateBytes) { const key = searchStates.keys().next().value; searchStateBytes -= searchStates.get(key).bytes; searchStates.delete(key); }
  }
  function remember(cut) {
    const old = cuts.get(cut.id);
    if (old) cacheBytes -= old.bytes;
    cuts.delete(cut.id); cuts.set(cut.id, cut); cacheBytes += cut.bytes; evict();
    return cut;
  }
  async function snapshot(value, id, signal, stats) {
    signal?.throwIfAborted(); stats.stats++;
    return value.persistence.stat(id, { signal });
  }
  async function loadCut(value, id, args, signal, stats, durableOnly = false) {
    const before = await snapshot(value, id, signal, stats);
    const live = durableOnly ? undefined : ctx.sessions?.get?.(id);
    if (!before && !live) throw readError('not_found');
    const header = live?.header ?? before.header;
    if (header.id !== id || before && !compatible(header, before.header)) throw readError('source_conflict');
    const stamp = live ? ['live', instance(live), live.seq] : ['durable', before.revision];
    const idKey = codec.revision([value.sourceId, lifecycle(header), stamp]);
    // Surface availability is a capability, not a property of cache warmth.
    if (args.surface !== undefined && typeof options.eventRecords !== 'function') throw readError('surface_unavailable');
    evict();
    const cached = cuts.get(idKey);
    if (cached) {
      if (cached.events.length > args.scanEvents || cached.rawBytes > args.scanBytes) throw readError('scan_budget');
      cuts.delete(idKey); cuts.set(idKey, cached); stats.cacheHits++;
      return cached;
    }
    if (!live && before.sizeBytes > args.scanBytes) throw readError('scan_budget', 'Physical artifact exceeds read admission budget.');
    let raw, observation, inheritedEventCount;
    try {
      if (live) {
        if (typeof ctx.sessionQuery?.observeSession !== 'function') throw readError('live_reader_unavailable');
        observation = await ctx.sessionQuery.observeSession(id, { signal, projectionMode: 'none' }); stats.observations++;
        if (observation.source !== 'live' || !compatible(observation.header, header)) throw readError('source_changed');
        raw = observation.events;
        inheritedEventCount = observation.inheritedEventCount;
      } else {
        const handle = await value.persistence.open(id, 'read', { signal }); stats.opens++;
        try {
          if (handle.header && !compatible(handle.header, header)) throw readError('source_conflict');
          raw = (await handle.read(0, args.scanEvents + 1, { signal })).events;
          inheritedEventCount = handle.inheritedEventCount;
        } finally { await handle.close(); }
      }
      signal?.throwIfAborted();
      if (!Array.isArray(raw) || raw.length > args.scanEvents) throw readError('scan_budget');
      const after = await snapshot(value, id, signal, stats);
      if (!live && (!after || before.revision !== after.revision || !compatible(before.header, after.header))) throw readError('source_changed');
      if (live && (ctx.sessions.get(id) !== live || !compatible(header, live.header))) throw readError('source_changed');
      let rawBytes = 0, prior = '', prefixes = [], events = [];
      for (let index = 0; index < raw.length; index++) {
        signal?.throwIfAborted();
        const event = raw[index];
        if (event.seq !== index) throw readError('corrupt_log');
        const serialized = JSON.stringify(event); rawBytes += Buffer.byteLength(serialized);
        if (rawBytes > args.scanBytes) throw readError('scan_budget');
        prior = hash([prior, serialized]); prefixes.push(prior);
        events.push(safeEvent(event));
      }
      if (args.surface !== undefined && typeof options.eventRecords !== 'function') throw readError('surface_unavailable');
      if (typeof options.eventRecords === 'function') {
        const records = options.eventRecords(id, raw);
        for (const record of records) if (events[record.seq]) events[record.seq].surface = record.surface;
      }
      stats.events += raw.length; stats.bytes += rawBytes;
      const bytes = Buffer.byteLength(JSON.stringify(events)) + prefixes.length * 64;
      if (bytes > READ_LIMITS.cutBytes) throw readError('scan_budget');
      const durableEvidence = value.public.physicalPaths && before?.sizeBytes !== undefined;
      return remember({ id: idKey, sourceId: value.sourceId, sessionId: id, header: publicHeader(header), projectCwd: header.cwd, lifecycle: hash(lifecycle(header)), revision: codec.revision([value.sourceId, stamp, lifecycle(header)]), sourceRevision: before?.revision, live: live ? new WeakRef(live) : undefined, liveInstance: live ? instance(live) : undefined, source: live ? 'live' : durableEvidence ? 'durable' : 'persistence-visible', synthetic: live ? 'not-inferred; observed-live-log' : false, durableThroughSeq: live ? before?.eventCount === undefined ? null : before.eventCount - 1 : durableEvidence ? raw.length - 1 : null, inheritedEventCount: inheritedEventCount ?? null, events, prefixes, rawBytes, bytes, expires: now() + READ_LIMITS.ttlMs });
    } finally { observation?.[Symbol.dispose](); }
  }
  async function currentCut(value, token, args, signal, stats) {
    evict();
    const cut = cuts.get(token);
    if (!cut) throw readError('cursor_expired', 'Restart the read; the bounded cut expired.');
    if (cut.sourceId !== value.sourceId) throw readError('source_changed');
    if (cut.events.length > args.scanEvents || cut.rawBytes > args.scanBytes) throw readError('scan_budget');
    const fresh = await snapshot(value, cut.sessionId, signal, stats);
    const live = ctx.sessions?.get?.(cut.sessionId);
    if (cut.source === 'live') {
      if (live !== cut.live?.deref() || live.seq < cut.events.length || hash(lifecycle(live.header)) !== cut.lifecycle) throw readError('cursor_stale');
    } else if (!fresh || fresh.revision !== cut.sourceRevision || hash(lifecycle(fresh.header)) !== cut.lifecycle) throw readError('cursor_stale');
    stats.cacheHits++;
    return cut;
  }
  async function target(value, args, signal, stats) {
    if (!args.pathRef) return args.sessionId;
    const ref = await locator.resolveRef(value, args.pathRef);
    if (!ref.sessionId || !['sessionDir', 'logGeneration'].includes(ref.role)) throw readError('path_role_mismatch', 'Use a confirmed sessionDir/logGeneration pathRef.');
    await locator.confirmRef(value, ref, signal, stats);
    return ref.sessionId;
  }
  async function catalog(value, args, signal, stats) {
    signal?.throwIfAborted(); stats.lists++;
    const stored = await value.persistence.list({ signal });
    const map = new Map();
    for (const row of stored) {
      if (map.has(row.header.id)) throw readError('source_conflict');
      map.set(row.header.id, { header: row.header, revision: row.revision, availability: 'durable' });
    }
    for (const live of ctx.sessions?.list?.() ?? []) {
      const durable = map.get(live.id);
      if (durable && !compatible(durable.header, live.header)) throw readError('source_conflict');
      map.set(live.id, { ...durable, header: live.header, availability: durable ? 'live+durable' : 'live', live: true, liveStamp: [instance(live), live.seq] });
    }
    let rows = [...map.values()];
    if (args.pathRef) {
      const ref = await locator.resolveRef(value, args.pathRef);
      if (ref.sessionId) { await locator.confirmRef(value, ref, signal, stats); rows = rows.filter(row => row.header.id === ref.sessionId); }
      else if (ref.role === 'projectDir') {
        const located = await locator.navigate(value, { directory: ref.path }, signal, stats);
        const ids = new Set(located.rows.filter(row => row.sessionId).map(row => row.sessionId));
        rows = rows.filter(row => ids.has(row.header.id));
      } else if (ref.role !== 'persistenceRoot') throw readError('path_role_mismatch');
    }
    if (args.directory) {
      const located = await locator.navigate(value, { directory: args.directory }, signal, stats);
      if (located.location.role !== 'persistenceRoot') {
        const ids = new Set(located.rows.filter(row => row.sessionId).map(row => row.sessionId));
        rows = rows.filter(row => ids.has(row.header.id));
      }
    }
    rows = rows.filter(row => (!args.sessionId || row.header.id === args.sessionId) && (!args.project || row.header.cwd === args.project) && (!args.projectPrefix || componentPrefix(row.header.cwd, args.projectPrefix)));
    rows.sort((a, b) => (Number(b.header.createdAt) || 0) - (Number(a.header.createdAt) || 0) || (a.header.id < b.header.id ? -1 : a.header.id > b.header.id ? 1 : 0));
    return rows;
  }
  function base(args, value, stats, extra = {}) {
    return { operation: args.operation, sourceId: value.sourceId, observedAt: new Date(now()).toISOString(), untrustedData: true, effect: 'none', counters: stats, ...extra };
  }
  function cutInfo(cut) {
    return { cut: cut.id, revision: cut.revision, source: cut.source, asOfSeq: cut.events.length - 1, durableThroughSeq: cut.durableThroughSeq, inheritedEventCount: cut.inheritedEventCount, synthetic: cut.synthetic, freshness: 'checked', backendWorkBounded: false };
  }
  function decode(args, key) {
    try { return args.cursor ? codec.decode(args.cursor, key) : { offset: 0 }; }
    catch { throw readError('cursor_invalid'); }
  }
  async function execute(raw, exec = {}) {
    const args = parseReadRequest(raw), signal = exec.signal, stats = counters();
    signal?.throwIfAborted();
    if (args.operation === 'describe') return { operation: 'describe', targetOperation: args.targetOperation, parameters: READ_SCHEMAS[args.targetOperation], required: args.targetOperation === 'search' ? ['query'] : [], limits: READ_LIMITS, readonly: { canonical: true, managedIndexRequiresExplicitHostConfiguration: true }, untrustedData: true };
    const value = locator.checkSource(args);
    if (args.operation === 'sources') {
      const result = base(args, value, stats, { sources: [value.public], nextCursor: null, truncated: false, limits: READ_LIMITS, externalSqlite: 'unavailable; no source-bound sidecar-safe public adapter', cache: { cuts: READ_LIMITS.cuts, bytes: READ_LIMITS.cutBytes, ttlMs: READ_LIMITS.ttlMs } });
      if (Buffer.byteLength(JSON.stringify(result)) > args.maxBytes) throw readError('metadata_budget');
      return result;
    }
    if (args.operation === 'paths') {
      const found = await locator.navigate(value, args, signal, stats);
      const key = codec.revision(['paths', value.sourceId, fingerprint(args)]);
      const state = decode(args, key), generation = codec.revision(found.rows);
      if (state.generation && state.generation !== generation) throw readError('cursor_stale');
      return outputPage(base(args, value, stats, { location: found.location, coverage: { state: 'complete', scope: 'this-directory-metadata-only' } }), found.rows.slice(state.offset), 'paths', args, used => state.offset + used < found.rows.length ? codec.encode({ id: key, offset: state.offset + used, generation }) : null);
    }
    if (args.operation === 'list') {
      let rows = await catalog(value, args, signal, stats);
      const evidence = options.evidence ? await options.evidence(rows, signal) : new Map();
      rows = rows.map(row => ({ ...row, evidence: evidence.get(row.header.id) ?? { state: 'unknown', writerOwnership: { state: 'unknown' } } })).filter(row => (!args.state || row.evidence.state === args.state) && (!args.writer || row.evidence.writerOwnership?.state === args.writer));
      const key = codec.revision(['list', value.sourceId, fingerprint(args)]), state = decode(args, key), generation = codec.revision(rows.map(row => lifecycle(row.header)));
      if (state.generation && state.generation !== generation) throw readError('cursor_stale');
      const shown = rows.slice(state.offset).map(row => ({ sessionId: row.header.id, header: publicHeader(row.header), availability: row.availability, ...row.evidence }));
      return outputPage(base(args, value, stats, { total: rows.length, coverage: { state: 'complete', scope: 'public-visible-sessions', physicalArtifacts: 'not-asserted' }, ordering: 'createdAt-desc,id-asc' }), shown, 'sessions', args, used => state.offset + used < rows.length ? codec.encode({ id: key, offset: state.offset + used, generation }) : null);
    }
    if (args.operation === 'search') return search(value, args, signal, stats);
    const id = await target(value, args, signal, stats);
    if (args.directory && !(await catalog(value, { directory: args.directory, sessionId: id }, signal, stats)).length) throw readError('not_found', 'Session is not in this physical directory.');
    const key = codec.revision([args.operation, value.sourceId, id, fingerprint(args)]);
    const state = decode(args, key);
    let cut;
    if (args.pollingCursor) {
      let poll;
      try { poll = codec.decode(args.pollingCursor, codec.revision(['poll', value.sourceId, id])); } catch { throw readError('cursor_invalid'); }
      const old = cuts.get(poll.cut);
      if (!old || old.expires < now()) throw readError('cursor_expired');
      cut = await loadCut(value, id, args, signal, stats);
      if (cut.lifecycle !== old.lifecycle || cut.liveInstance !== old.liveInstance || cut.events.length < poll.offset || (poll.offset > 0 && cut.prefixes[poll.offset - 1] !== old.prefixes[poll.offset - 1])) throw readError('cursor_stale');
      state.offset = poll.offset;
    } else cut = state.cut ? await currentCut(value, state.cut, args, signal, stats) : await loadCut(value, id, args, signal, stats);
    if (args.project && cut.projectCwd !== args.project || args.projectPrefix && !componentPrefix(cut.projectCwd, args.projectPrefix)) throw readError('not_found', 'Session does not match the project filter.');
    const pollingCursor = codec.encode({ id: codec.revision(['poll', value.sourceId, id]), offset: cut.events.length, cut: cut.id });
    const info = base(args, value, stats, { sessionId: id, header: cut.header, ...cutInfo(cut), ...(args.operation === 'read' ? { pollingCursor } : {}), coverage: { state: 'complete', scope: 'observed-log-cut' } });
    if (args.operation === 'read') {
      if (!args.cursor && !args.pollingCursor && args.revision === cut.revision) return outputPage({ ...info, unchanged: true }, [], 'events', args, () => null);
      const offset = args.offset ?? state.offset;
      const rows = cut.events.slice(offset).map(event => previewCutEvent(event, args));
      return outputPage(info, rows, 'events', args, used => offset + used < cut.events.length ? codec.encode({ id: key, offset: offset + used, cut: cut.id }) : null);
    }
    const messages = cut.events.filter(event => typeof event.text === 'string');
    const originalIndex = messages.findIndex(event => event.type === 'user/message' && event.messageSource === 'user');
    const headMessages = originalIndex < 0 ? messages : messages.slice(originalIndex);
    const windowSize = Math.max(1, (args.before ?? 6) + (args.after ?? 6));
    let selected;
    const anchor = args.anchor ?? 'both';
    if (anchor === 'both') selected = [...headMessages.slice(0, windowSize).map(event => ({ ...event, window: 'head' })), ...messages.slice(-windowSize).map(event => ({ ...event, window: 'tail' }))];
    else if (anchor === 'head' || anchor === 'tail') selected = (anchor === 'head' ? headMessages.slice(0, windowSize) : messages.slice(-windowSize)).map(event => ({ ...event, window: anchor }));
    else {
      if (args.seq >= cut.events.length) throw readError('not_found', 'Event anchor is outside the cut.');
      let index = messages.findIndex(event => event.seq >= args.seq);
      if (index < 0) index = messages.length;
      selected = messages.slice(Math.max(0, index - (args.before ?? 6)), index + (args.after ?? 6) + 1).map(event => ({ ...event, window: 'anchor' }));
      if (!selected.some(event => event.seq === args.seq)) selected.push({ ...cut.events[args.seq], window: 'anchor' });
      selected.sort((a, b) => a.seq - b.seq);
    }
    return outputPage({ ...info, anchor, originalRequestConfirmed: originalIndex >= 0, windows: anchor === 'both' ? ['head', 'tail'] : [anchor], contextComplete: false }, selected.slice(state.offset).map(event => previewCutEvent(event, args)), 'events', args, used => state.offset + used < selected.length ? codec.encode({ id: key, offset: state.offset + used, cut: cut.id }) : null);
  }
  async function search(value, args, signal, stats) {
    const records = await catalog(value, args, signal, stats);
    const key = codec.revision(['search', value.sourceId, fingerprint(args)]);
    const generation = codec.revision(records.map(row => [lifecycle(row.header), row.revision, row.liveStamp]));
    const decoded = decode(args, key);
    evict();
    const saved = decoded.stateRef ? searchStates.get(decoded.stateRef) : undefined;
    if (decoded.stateRef && (!saved || saved.key !== key)) throw readError('cursor_expired', 'Restart this bounded search.');
    const state = saved?.state ?? decoded;
    if (state.generation && state.generation !== generation) throw readError('cursor_stale');
    let sessionOffset = state.sessionOffset ?? 0, eventOffset = state.eventOffset ?? 0, providerCursor = state.providerCursor;
    const mode = args.mode ?? 'phrase';
    const native = mode === 'phrase' && value.nativeSearch;
    const deadline = now() + args.durationMs;
    const rows = [], continuations = [], skipped = [];
    const skippedCounts = { ...(state.skippedCounts ?? {}) };
    let skippedCount = state.skippedCount ?? 0;
    let visited = 0;
    let budgetEnded = false;
    while (sessionOffset < records.length && visited < args.candidateBudget && rows.length < args.limit && !budgetEnded && (visited === 0 || now() <= deadline)) {
      signal?.throwIfAborted();
      const record = records[sessionOffset]; stats.candidates++; visited++;
      let cut, candidates, next;
      try {
        if (args.surface !== undefined && typeof options.eventRecords !== 'function') throw readError('surface_unavailable');
        if (native) {
          const filters = [{ kind: 'type', values: args.types ?? ['user/message', 'assistant/message'] }];
          if (args.surface) filters.push({ kind: 'surface', values: [args.surface] });
          if (args.fromTime !== undefined || args.toTime !== undefined) filters.push({ kind: 'time', ...(args.fromTime === undefined ? {} : { from: args.fromTime }), ...(args.toTime === undefined ? {} : { to: args.toTime }) });
          stats.nativeQueries++;
          const page = await value.query.searchEvents({ sessionId: record.header.id, query: args.query, filters, limit: Math.min(100, value.query.config.maxLimit ?? 100), ...(providerCursor ? { cursor: providerCursor } : {}) }, { signal });
          signal?.throwIfAborted();
          if (!page || !compatible(page.session, record.header) || !Array.isArray(page.items) || page.items.length > 100) throw readError('source_conflict');
          const after = await snapshot(value, record.header.id, signal, stats);
          if (record.revision !== after?.revision || record.live && ctx.sessions.get(record.header.id)?.seq !== record.liveStamp[1]) throw readError('source_changed');
          // Only addresses cross this adapter. Native snippets may contain tool
          // payloads even inside assistant/message and are intentionally unread.
          // A no-hit index page does not need another canonical full decode.
          if (page.items.length) {
            cut = await loadCut(value, record.header.id, args, signal, stats);
            if (cut.lifecycle !== hash(lifecycle(record.header)) || cut.sourceRevision !== record.revision || record.live && cut.events.length !== record.liveStamp[1]) throw readError('source_changed');
          }
          candidates = page.items.map(hit => {
            if (hit.sessionId !== record.header.id || !Number.isSafeInteger(hit.seq) || hit.seq < 0 || !cut.events[hit.seq]) throw readError('source_conflict');
            return cut.events[hit.seq];
          });
          next = page.nextCursor;
        } else {
          cut = await loadCut(value, record.header.id, args, signal, stats);
          if (cut.lifecycle !== hash(lifecycle(record.header))) throw readError('source_conflict');
          candidates = cut.events;
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.code === 'SESSION_QUERY_STALE_CURSOR' || ['source_changed', 'source_conflict'].includes(error?.code)) throw readError('cursor_stale');
        if (error?.code === 'SESSION_QUERY_INVALID_CURSOR') throw readError('cursor_invalid');
        if (error?.code === 'SESSION_QUERY_SEARCH_DISABLED') throw readError('search_disabled', 'Restart using mode:substring.');
        const code = shortFailure(error);
        skippedCount++; skippedCounts[code] = (skippedCounts[code] ?? 0) + 1;
        if (skipped.length < 2) skipped.push({ sessionId: redact(record.header.id).slice(0, 128), code });
        sessionOffset++; eventOffset = 0; providerCursor = undefined;
        continue;
      }
      for (; eventOffset < candidates.length && rows.length < args.limit; eventOffset++) {
        signal?.throwIfAborted();
        const event = candidates[eventOffset];
        const size = Buffer.byteLength(JSON.stringify(event));
        // Redaction may expand many short secrets. A single admitted event can
        // then exceed the entire matching budget: never reissue its same slot.
        if (size > args.scanBytes) {
          skippedCount++; skippedCounts.scan_budget = (skippedCounts.scan_budget ?? 0) + 1;
          if (skipped.length < 2) skipped.push({ sessionId: redact(record.header.id).slice(0, 128), code: 'scan_budget' });
          sessionOffset++; eventOffset = 0; providerCursor = undefined;
          budgetEnded = true; break;
        }
        if (stats.scanEvents >= args.scanEvents || stats.scanBytes + size > args.scanBytes || stats.scanEvents > 0 && now() > deadline) { budgetEnded = true; break; }
        stats.scanEvents++; stats.scanBytes += size;
        if (typeof event.text !== 'string' || !(args.types ?? ['user/message', 'assistant/message']).includes(event.type) || args.surface && event.surface !== args.surface || args.fromTime !== undefined && event.time < args.fromTime || args.toTime !== undefined && event.time > args.toTime || !matchesText(event.text, args.query, mode)) continue;
        rows.push({ sessionId: record.header.id, ...previewCutEvent(event, { ...args, textOffset: 0 }), source: cut.source, revision: cut.revision, asOfSeq: cut.events.length - 1, freshness: 'canonical-confirmed' });
        continuations.push({ sessionOffset, eventOffset: eventOffset + 1, providerCursor });
      }
      if (eventOffset >= candidates.length) {
        eventOffset = 0;
        if (native && next) { if (next === providerCursor) throw readError('cursor_invalid'); providerCursor = next; }
        else { sessionOffset++; providerCursor = undefined; }
      }
    }
    const hasMore = sessionOffset < records.length;
    const finish = { sessionOffset, eventOffset, providerCursor };
    const encode = progress => {
      const state = { ...progress, generation, skippedCount, skippedCounts };
      const bytes = Buffer.byteLength(JSON.stringify(state));
      if (bytes > READ_LIMITS.searchStateMaxBytes) throw readError('provider_cursor_budget');
      const ref = codec.revision([key, state]);
      if (searchStates.has(ref)) searchStateBytes -= searchStates.get(ref).bytes;
      searchStates.delete(ref); searchStates.set(ref, { key, state, bytes, expires: now() + READ_LIMITS.ttlMs }); searchStateBytes += bytes; evict();
      return codec.encode({ id: key, offset: 0, stateRef: ref });
    };
    const info = base(args, value, stats, { effect: native ? 'derived-cache-may-write' : 'none', engine: native ? 'native-sqlite-candidates+canonical-confirmation' : mode === 'substring' ? 'bounded-literal-substring-scan' : 'bounded-unicode-word-phrase-scan', fallback: native ? null : value.public.index.reason ?? (mode === 'substring' ? 'substring-requires-scan' : 'index_unavailable'), managedIndexWrites: native, coverage: { state: hasMore || skippedCount ? 'partial' : 'complete', scope: 'public-visible-authorized-message-text', physicalArtifacts: 'not-asserted', skippedCount, skippedCounts, skipped }, freshness: 'canonical-confirmed-per-hit', backendWorkBounded: false });
    const result = outputPage(info, rows, 'hits', args, used => {
      if (used < rows.length) return encode(used ? continuations[used - 1] : { sessionOffset: state.sessionOffset ?? 0, eventOffset: state.eventOffset ?? 0, providerCursor: state.providerCursor });
      return hasMore ? encode(finish) : null;
    });
    if (result.nextCursor) result.coverage.state = 'partial';
    return result;
  }
  async function executeSafe(raw, exec = {}) {
    try {
      const result = await execute(raw, exec);
      exec.signal?.throwIfAborted();
      if (result.sourceId && result.sourceId !== locator.source().sourceId) throw readError('source_changed');
      return result;
    } catch (error) { exec.signal?.throwIfAborted(); if (error?.sessionReadError) throw error; throw readError(shortFailure(error)); }
  }
  return { execute: executeSafe, loadCut, locator, durableCut: (id, signal) => loadCut(locator.source(), id, parseReadRequest({ operation: 'read', sessionId: id }), signal, counters(), true), clear: () => { cuts.clear(); cacheBytes = 0; searchStates.clear(); searchStateBytes = 0; locator.clear(); }, limits: READ_LIMITS };
}
