import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHost } from '../common.mjs';
import { createMessageHeads } from './message-heads.mjs';
import { parseMessageHeadsRequest, parseMessageHeadsOutput } from './message-heads-contracts.mjs';
const { createAssistantMessage, createUserMessage } = await import(resolveHost('@deepseek-ai/dsh-llm'));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const header = (id = 'chat', extra = {}) => ({ id, version: 4, createdAt: 7, isSeeded: false, agentPreset: 'companion', cwd: '/synthetic', ...extra });
const text = value => ({ type: 'text', text: value });
function event(seq, type, data, extra = {}) { return { seq, time: seq + 10, type, data, ...extra }; }
function assistant(seq, content = [text('private synthetic reply')], extra = {}) {
  return event(seq, 'assistant/message', { turn: 1, step: 1,
    message: createAssistantMessage({ content, source: { provider: 'synthetic', model: 'synthetic' } }), stream: [], ...extra }, { surfaceOp: 'append' });
}
function user(seq, source = { kind: 'user' }, extra = {}) {
  return event(seq, 'user/message', createUserMessage({ content: [text('private synthetic input')], source }), { surfaceOp: 'append', ...extra });
}
function fixture(events = [assistant(0)], options = {}) {
  let snapshots = new Map([['chat', { header: header(), revision: 'v1', sizeBytes: 0 }]]);
  let query, sessions = new Map();
  const counts = { stat: 0, observe: 0, events: 0, dispose: 0 };
  const persistence = { name: 'session-persistence-jsonl', config: { compression: 'none' },
    identity: Symbol('synthetic-persistence'), async stat(id) { counts.stat++; return snapshots.get(id); } };
  query = { async observeSession(id, args) {
    counts.observe++; assert.equal(args.projectionMode, 'none'); assert.ok(args.signal instanceof AbortSignal);
    return observation(id);
  } };
  function observation(id = 'chat', overrides = {}) {
    return { source: 'prepared', header: snapshots.get(id)?.header ?? header(id), inheritedEventCount: 0,
      cursor: events.length - 1, revision: snapshots.get(id)?.revision,
      get events() { counts.events++; return events; }, [Symbol.dispose]() { counts.dispose++; }, ...overrides };
  }
  let registry = { get: id => sessions.get(id) };
  const ctx = { sessionPersistence: persistence, get: key => key === 'sessionQuery' ? query : key === 'sessions' ? registry : undefined };
  for (const key of ['agents', 'goals', 'llm', 'sessionController', 'tools']) Object.defineProperty(ctx, key, { get: () => assert.fail('Forbidden metadata capability') });
  for (const key of ['open', 'create', 'flush']) Object.defineProperty(persistence, key, { get: () => assert.fail('Forbidden direct persistence body/mutation capability') });
  const api = createMessageHeads(ctx, options);
  return { api, counts, persistence, observation, registry, sessions,
    setEvents: value => { events = value; }, setSnapshots: value => { snapshots = new Map(value.map(snapshot => [snapshot.header.id, { sizeBytes: 0, ...snapshot }])); },
    setQuery: value => { query = value; }, query: () => query,
    setRegistry: value => { registry = value; },
    read: (ids = ['chat'], signal) => api.read({ sessionIds: ids }, signal) };
}
const code = expected => error => error.code === `companion/${expected}`;
const row = (value, index = 0) => value.heads[index];

test('message-head codecs accept only exact bounded metadata and preserve unknown versus absence', () => {
  assert.deepEqual(parseMessageHeadsRequest({ sessionIds: [] }), { sessionIds: [] });
  for (const input of [null, [], {}, { sessionIds: new Array(1) }, { sessionIds: 'chat' }, { sessionIds: ['chat', 'chat'] }, { sessionIds: ['../foreign'] },
    { sessionIds: Array.from({ length: 21 }, (_, i) => `chat${i}`) }, { sessionIds: [], body: 'private synthetic' }]) {
    assert.throws(() => parseMessageHeadsRequest(input), code('invalid-request'));
  }
  const valid = { version: 1, profile: 'companion', heads: [{ sessionId: 'chat', createdAt: null, knowledge: 'unknown', asOfSeq: null, lastVisibleAssistant: null }] };
  assert.deepEqual(parseMessageHeadsOutput(valid), valid);
  for (const mutate of [v => { v.heads[0].body = 'private synthetic'; }, v => { v.cookie = 'private synthetic'; },
    v => { v.heads[0].knowledge = 'current'; }, v => { v.heads[0].asOfSeq = -1; }, v => { v.heads.push({ ...v.heads[0] }); },
    v => { v.profile = 'other'; }]) {
    const invalid = structuredClone(valid); mutate(invalid); assert.throws(() => parseMessageHeadsOutput(invalid), code('invalid-output'));
  }
  const current = { version: 1, profile: 'companion', heads: [{ sessionId: 'chat', createdAt: 7, knowledge: 'current', asOfSeq: 3,
    lastVisibleAssistant: { seq: 2, messageId: 'opaque:synthetic/id', time: 10, interrupted: true } }] };
  assert.deepEqual(parseMessageHeadsOutput(current), current);
  for (const mutate of [v => { v.heads[0].lastVisibleAssistant.seq = 4; }, v => { v.heads[0].lastVisibleAssistant.messageId = 'x'.repeat(257); },
    v => { v.heads[0].lastVisibleAssistant.text = 'private synthetic'; }, v => { v.heads[0].lastVisibleAssistant.interrupted = null; },
    v => { v.heads[0].createdAt = null; }, v => { v.heads[0].asOfSeq = -2; }, v => { v.heads[0].lastVisibleAssistant.time = -1; }]) {
    const invalid = structuredClone(current); mutate(invalid); assert.throws(() => parseMessageHeadsOutput(invalid), code('invalid-output'));
  }
  let getter = false;
  assert.throws(() => parseMessageHeadsRequest(Object.defineProperty({}, 'sessionIds', { get() { getter = true; return []; } })), code('invalid-request'));
  assert.equal(getter, false);
});

test('current visible model text produces only its settled identity, not content or raw provider data', async () => {
  const events = [user(0), assistant(1)];
  const f = fixture(events);
  const output = await f.read();
  assert.deepEqual(row(output), { sessionId: 'chat', createdAt: 7, knowledge: 'current', asOfSeq: 1,
    lastVisibleAssistant: { seq: 1, messageId: events[1].data.message.id, time: 11, interrupted: false } });
  assert.equal(JSON.stringify(output).includes('private synthetic'), false);
  assert.equal(JSON.stringify(output).includes('provider'), false);
  assert.equal(f.counts.dispose, 1);
});

test('tool-only, reasoning-only, blank, attempt, internal goal input and context never invent a visible reply', async () => {
  const events = [user(0, { kind: 'goal', goalId: 'synthetic-goal', revision: 1, round: 1 }),
    assistant(1, [{ type: 'tool-call', id: 'synthetic-call', name: 'synthetic-tool', arguments: '{}' }]),
    assistant(2, [{ type: 'reasoning', text: 'private synthetic reasoning' }]), assistant(3, [text(' \n\t ')]),
    event(4, 'assistant/attempt', { turn: 1, step: 2, stream: [] }), event(5, 'goal/change', { private: 'synthetic objective' })];
  const f = fixture(events);
  const output = await f.read();
  assert.equal(row(output).knowledge, 'current'); assert.equal(row(output).lastVisibleAssistant, null);
  assert.equal(row(output).asOfSeq, 5); assert.equal(f.counts.dispose, 1);
});

test('real model text during an automatic goal round counts and interrupted visible prefixes count', async () => {
  const events = [user(0, { kind: 'goal', goalId: 'synthetic-goal', revision: 1, round: 2 }), assistant(1, [text('synthetic partial')], { interrupted: true })];
  const f = fixture(events);
  assert.deepEqual(row(await f.read()).lastVisibleAssistant, { seq: 1, messageId: events[1].data.message.id, time: 11, interrupted: true });
});

test('first-party current surface excludes replaced replies and recognizes a later model text', async () => {
  const events = [assistant(0), user(1, { kind: 'synthetic-compaction' },
    { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] })];
  const f = fixture(events);
  assert.equal(row(await f.read()).lastVisibleAssistant, null);
  const next = assistant(2); f.setEvents([...events, next]);
  f.setSnapshots([{ header: header(), revision: 'v2' }]);
  assert.equal(row(await f.read()).lastVisibleAssistant.messageId, next.data.message.id);
});

test('every root is admitted before any observation and foreign or seeded roots refuse the whole batch', async () => {
  for (const extra of [{ agentPreset: 'ordinary' }, { parentSession: 'parent' }, { origin: 'subagent' }, { isSeeded: true },
    { delegationDepth: 1 }, { delegationDepth: -1 }, { createdAt: null }, { version: 99 }]) {
    const f = fixture(); f.setSnapshots([{ header: header('chat'), revision: 'v1' }, { header: header('foreign', extra), revision: 'v1' }]);
    await assert.rejects(f.read(['chat', 'foreign']), code('foreign-session')); assert.equal(f.counts.observe, 0);
  }
  const absent = fixture(); await assert.rejects(absent.read(['absent']), code('foreign-session')); assert.equal(absent.counts.observe, 0);
});

test('unavailable metadata uses null lifecycle unknown while missing query preserves verified lifecycle unknown', async () => {
  const f = fixture(); f.persistence.stat = async () => { throw new Error('private synthetic failure'); };
  assert.deepEqual(row(await f.read()), { sessionId: 'chat', createdAt: null, knowledge: 'unknown', asOfSeq: null, lastVisibleAssistant: null });
  const missing = fixture(); missing.setQuery(undefined);
  assert.deepEqual(row(await missing.read()), { sessionId: 'chat', createdAt: 7, knowledge: 'unknown', asOfSeq: null, lastVisibleAssistant: null });
});

test('cursor gaps, header drift, source revision mismatch and malformed replies are unknown with all leases disposed', async () => {
  const cases = [f => f.observation('chat', { cursor: 3 }), f => f.observation('chat', { header: header('chat', { createdAt: 8 }) }),
    f => f.observation('chat', { revision: 'other' }), f => f.observation('chat', { inheritedEventCount: 1 }),
    f => f.observation('chat', { events: [assistant(1)] }), f => f.observation('chat', { events: [{ ...assistant(0), time: -1 }] })];
  for (const make of cases) {
    const f = fixture(); f.setQuery({ observeSession: async () => make(f) });
    const output = await f.read(); assert.equal(row(output).knowledge, 'unknown'); assert.equal(row(output).lastVisibleAssistant, null);
    assert.equal(f.counts.dispose, 1);
  }
  const malformed = fixture([assistant(0, [text('synthetic')], { interrupted: false })]);
  assert.equal(row(await malformed.read()).knowledge, 'unknown'); assert.equal(malformed.counts.dispose, 1);
});

test('cold cache reuses verified revision without another SDK body read and invalidates on new text or source swap', async () => {
  const f = fixture(); const initial = await f.read();
  assert.deepEqual(await f.read(), initial); assert.equal(f.counts.observe, 1); assert.equal(f.counts.events, 1);
  const next = assistant(1); f.setEvents([assistant(0), next]); f.setSnapshots([{ header: header(), revision: 'v2' }]);
  assert.equal(row(await f.read()).lastVisibleAssistant.messageId, next.data.message.id); assert.equal(f.counts.observe, 2);
  const query = f.query(); f.setQuery({ observeSession: (...args) => query.observeSession(...args) });
  await f.read(); assert.equal(f.counts.observe, 3);
});

test('a new live overlay cannot be hidden by an unchanged cold revision or same-cursor replaced live instance', async () => {
  const f = fixture(); await f.read();
  const newer = assistant(1); f.setEvents([assistant(0), newer]);
  const live = { header: header(), seq: 2 }; f.sessions.set('chat', live);
  f.setQuery({ observeSession: async () => f.observation('chat', { source: 'live', revision: undefined }) });
  assert.equal(row(await f.read()).lastVisibleAssistant.messageId, newer.data.message.id);
  const eventReads = f.counts.events;
  await f.read(); assert.equal(f.counts.events, eventReads);
  const replacement = assistant(1); f.setEvents([assistant(0), replacement]); f.sessions.set('chat', { header: header(), seq: 2 });
  assert.equal(row(await f.read()).lastVisibleAssistant.messageId, replacement.data.message.id);
});

test('session, aggregate and raw-byte budgets return unknown rather than partial absence', async () => {
  const tooMany = fixture([assistant(0), assistant(1)], { sessionEvents: 1 });
  assert.equal(row(await tooMany.read()).knowledge, 'unknown'); assert.equal(tooMany.counts.events, 0); assert.equal(tooMany.counts.dispose, 1);
  const preflight = fixture(); preflight.setSnapshots([{ header: header(), revision: 'v1', sizeBytes: 100 }]);
  const small = createMessageHeads({ sessionPersistence: preflight.persistence, get: key => key === 'sessionQuery' ? preflight.query() : undefined }, { sessionBytes: 99 });
  assert.equal(row(await small.read({ sessionIds: ['chat'] })).knowledge, 'unknown'); assert.equal(preflight.counts.observe, 0);
  const bytes = fixture([assistant(0)], { sessionBytes: 1 }); assert.equal(row(await bytes.read()).knowledge, 'unknown'); assert.equal(bytes.counts.dispose, 1);
  const aggregate = fixture([assistant(0)], { batchEvents: 1 });
  aggregate.setSnapshots([{ header: header('one'), revision: 'v1' }, { header: header('two'), revision: 'v1' }]);
  const result = await aggregate.read(['one', 'two']);
  assert.deepEqual(result.heads.map(head => head.knowledge).sort(), ['current', 'unknown']);
});

test('twenty roots are ordered and underlying observations never exceed concurrency two', async () => {
  const f = fixture(); const ids = Array.from({ length: 20 }, (_, index) => `chat${index}`);
  f.setSnapshots(ids.map(id => ({ header: header(id), revision: 'v1' })));
  let active = 0, peak = 0;
  f.setQuery({ async observeSession(id) { active++; peak = Math.max(peak, active); await tick(); active--; return f.observation(id); } });
  const result = await f.read(ids); assert.deepEqual(result.heads.map(head => head.sessionId), ids);
  assert.equal(result.heads.every(head => head.knowledge === 'current'), true); assert.equal(peak, 2); assert.equal(f.counts.dispose, 20);
  assert.equal(Buffer.byteLength(JSON.stringify(result)) < 32 * 1024, true);
});

test('external abort returns promptly and late non-cooperative leases are disposed without publishing or overbooking', async () => {
  const f = fixture(); const started = defer(), late = defer();
  f.setQuery({ observeSession() { f.counts.observe++; started.resolve(); return late.promise; } });
  const controller = new AbortController(); const reading = f.read(['chat'], controller.signal);
  await started.promise; controller.abort();
  await assert.rejects(reading, error => error.name === 'AbortError');
  assert.equal(row(await f.read()).knowledge, 'unknown'); assert.equal(f.counts.observe, 1);
  late.resolve(f.observation()); await tick(); assert.equal(f.counts.dispose, 1);
  f.setQuery({ observeSession: async () => f.observation() }); assert.equal(row(await f.read()).knowledge, 'current');
});

test('wall timeout and disposal never turn late observations into cached positive badges', async () => {
  const f = fixture([assistant(0)], { wallMs: 10 }); const late = defer();
  f.setQuery({ observeSession() { f.counts.observe++; return late.promise; } });
  assert.equal(row(await f.read()).knowledge, 'unknown');
  assert.equal(row(await f.read()).knowledge, 'unknown'); assert.equal(f.counts.observe, 1);
  f.api.clear(); late.resolve(f.observation()); await tick(); assert.equal(f.counts.dispose, 1);
  await assert.rejects(f.read(), code('metadata-unavailable'));
});

test('empty request is a cheap typed readiness and already-aborted requests do no work', async () => {
  const f = fixture(); assert.deepEqual(await f.read([]), { version: 1, profile: 'companion', heads: [] });
  assert.equal(f.counts.stat, 0); assert.equal(f.counts.observe, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.read(['chat'], controller.signal), error => error.name === 'AbortError'); assert.equal(f.counts.stat, 0);
});

test('nested node and oversized payload bounds fail closed without serializing raw event objects', async () => {
  const huge = assistant(0, [text('x'.repeat(10000))]);
  Object.defineProperty(huge, 'toJSON', { value() { assert.fail('Raw events must not be serialized for size admission'); } });
  const f = fixture([huge], { sessionBytes: 1024 });
  assert.equal(row(await f.read()).knowledge, 'unknown'); assert.equal(f.counts.dispose, 1);
  const nodes = fixture([assistant(0)], { batchNodes: 1 });
  assert.equal(row(await nodes.read()).knowledge, 'unknown'); assert.equal(nodes.counts.dispose, 1);
});

test('metadata codecs reject array holes, extra array fields and array accessors without invoking them', () => {
  let accessed = false;
  const getter = []; Object.defineProperty(getter, '0', { get() { accessed = true; return 'chat'; }, enumerable: true });
  const extra = ['chat']; extra.private = 'synthetic';
  for (const sessionIds of [getter, extra]) assert.throws(() => parseMessageHeadsRequest({ sessionIds }), code('invalid-request'));
  assert.equal(accessed, false);
  assert.throws(() => parseMessageHeadsOutput({ version: 1, profile: 'companion', heads: new Array(1) }), code('invalid-output'));
});

test('compressed, unknown-size or unsupported cold sources are unknown before SDK capture', async () => {
  for (const mutate of [f => { f.persistence.config.compression = 'zstd'; }, f => { f.persistence.name = 'other'; },
    f => f.setSnapshots([{ header: header(), revision: 'v1', sizeBytes: undefined }]),
    f => f.setSnapshots([{ header: header(), revision: 'v1', sizeBytes: -1 }])]) {
    const f = fixture(); mutate(f);
    assert.equal(row(await f.read()).knowledge, 'unknown'); assert.equal(f.counts.observe, 0); assert.equal(f.counts.events, 0);
  }
});

test('a concurrently appended cold revision is rejected after public capture and never cached positive', async () => {
  const f = fixture(); const initial = f.observation();
  f.setQuery({ async observeSession() { f.counts.observe++; f.setSnapshots([{ header: header(), revision: 'v2' }]); return initial; } });
  const output = await f.read(); assert.equal(row(output).knowledge, 'unknown'); assert.equal(row(output).lastVisibleAssistant, null);
  assert.equal(f.counts.stat, 2); assert.equal(f.counts.dispose, 1);
  f.setQuery({ observeSession: async () => f.observation() }); assert.equal(row(await f.read()).knowledge, 'current');
});

test('source replacement during capture cannot publish or reuse a positive row', async () => {
  const f = fixture();
  f.setQuery({ async observeSession() { f.setQuery(undefined); return f.observation(); } });
  const output = await f.read(); assert.equal(row(output).knowledge, 'unknown'); assert.equal(row(output).createdAt, null);
  assert.equal(f.counts.dispose, 1);
});

test('bounded metadata cache evicts least-recently-used roots without retaining event bodies', async () => {
  const f = fixture([assistant(0)], { cacheEntries: 1 });
  f.setSnapshots([{ header: header('one'), revision: 'v1' }, { header: header('two'), revision: 'v1' }]);
  await f.read(['one']); await f.read(['two']); await f.read(['one']);
  assert.equal(f.counts.observe, 3); assert.equal(f.counts.dispose, 3);
});

test('registry replacement mid-observation invalidates publication even when query identity stays the same', async () => {
  const f = fixture(); let replace = true;
  const query = { async observeSession() {
    f.counts.observe++;
    if (replace) { replace = false; f.setRegistry({ get: () => undefined }); }
    return f.observation();
  } };
  f.setQuery(query);
  const stale = row(await f.read());
  assert.equal(stale.knowledge, 'unknown'); assert.equal(stale.createdAt, null); assert.equal(stale.lastVisibleAssistant, null);
  assert.equal(f.counts.dispose, 1);
  assert.equal(row(await f.read()).knowledge, 'current'); assert.equal(f.counts.observe, 2); assert.equal(f.counts.dispose, 2);
  assert.equal(f.query(), query);
});

test('registry replacement during cached-row post-stat cannot publish the old positive or seed the next batch', async () => {
  const f = fixture(); await f.read();
  assert.equal(f.counts.observe, 1); assert.equal(f.counts.stat, 2);
  const query = f.query(), stat = f.persistence.stat;
  f.persistence.stat = async (...args) => {
    const result = await stat(...args);
    if (f.counts.stat === 4) f.setRegistry({ get: () => undefined });
    return result;
  };
  const stale = row(await f.read());
  assert.equal(stale.knowledge, 'unknown'); assert.equal(stale.lastVisibleAssistant, null); assert.equal(f.counts.observe, 1);
  assert.equal(row(await f.read()).knowledge, 'current'); assert.equal(f.counts.observe, 2); assert.equal(f.query(), query);
});

test('a replacement public registry invalidates cross-batch cache reuse without replacing persistence or query', async () => {
  const f = fixture(); await f.read(); const query = f.query();
  assert.equal(f.counts.observe, 1); assert.equal(f.counts.events, 1);
  f.setRegistry({ get: () => undefined });
  assert.equal(row(await f.read()).knowledge, 'current'); assert.equal(f.counts.observe, 2); assert.equal(f.counts.events, 2);
  await f.read(); assert.equal(f.counts.observe, 2); assert.equal(f.query(), query);
});
