import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadSide, matchesText } from './read-side.mjs';
import { parseRequest, cursorCodec } from './contracts.mjs';
import { createSourceLocator, componentPrefix, generationCandidate, segmentCandidate } from './source-locator.mjs';

const exec = () => ({ signal: new AbortController().signal });
function event(seq, text, type = 'user/message') {
  return { seq, time: seq, type, data: type === 'assistant/message' ? { message: { content: [{ type: 'text', text }] } } : { content: [{ type: 'text', text }] } };
}
function fixture(count = 1, length = 30, options = {}) {
  const rows = new Map();
  for (let index = 0; index < count; index++) rows.set(`s-${index}`, { header: { id: `s-${index}`, version: 4, createdAt: index, cwd: '/project', isSeeded: false }, revision: `r${index}`, events: Array.from({ length }, (_, seq) => event(seq, `original-${index} message-${seq} needle`)) });
  const live = new Map(), calls = { opens: 0, reads: 0, closes: 0, native: 0, disposed: 0 };
  const ctx = { sessionPersistence: {
    name: 'session-persistence-jsonl', identity: Symbol(), config: { root: options.root ?? '/authored-fixture', compression: 'none' },
    list: async () => [...rows.values()].map(({ header, revision, events }) => ({ header, revision, sizeBytes: events.length * 10 })),
    stat: async id => { const row = rows.get(id); return row ? { header: row.header, revision: row.revision, sizeBytes: row.events.length * 10 } : undefined; },
    open: async (id, access) => {
      assert.equal(access, 'read'); calls.opens++;
      const row = rows.get(id);
      if (!row) throw Object.assign(new Error('not found'), { name: 'SessionPersistenceNotFoundError' });
      return { header: row.header, read: async (offset, size) => { calls.reads++; return { events: row.events.slice(offset, offset + size) }; }, close: async () => calls.closes++ };
    },
  }, sessions: { list: () => [...live.values()], get: id => live.get(id) }, sessionQuery: { config: { path: ':memory:', openAt: 'never' }, observeSession: async id => {
    const row = live.get(id); assert.ok(row);
    return { header: row.header, source: 'live', cursor: row.seq - 1, events: row.events, inheritedEventCount: 0, [Symbol.dispose]: () => calls.disposed++ };
  }, searchEvents: async () => { throw new Error('disabled provider must never be called'); } } };
  const api = createReadSide(ctx, options);
  const sourceId = api.locator.source().sourceId;
  const run = args => api.execute({ sourceId, ...args }, exec());
  return { api, ctx, sourceId, run, rows, live, calls };
}
async function pages(run, args, field) {
  let cursor, out = [], iterations = 0, last;
  do {
    last = await run({ ...args, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(last)) <= (args.maxBytes ?? 8192));
    out.push(...last[field]); cursor = last.nextCursor;
    assert.ok(++iterations < 5000, 'continuation must make progress');
  } while (cursor);
  return { rows: out, last, iterations };
}

test('read contracts are per-operation, bounded, native-id capable; send rules unchanged', () => {
  for (const id of ['α/会話', '.', '../native-id', 'with space']) assert.equal(parseRequest({ operation: 'read', sourceId: 'source', sessionId: id }).sessionId, id);
  assert.throws(() => parseRequest({ operation: 'send', sessionId: '../native-id', text: 'x' }));
  for (const args of [{ operation: 'sources', directory: '/' }, { operation: 'search', query: 'x', confirmed: true }, { operation: 'search', query: 'a'.repeat(513) }, { operation: 'context', sessionId: 'x', seq: 0 }, { operation: 'context', sessionId: 'x', before: 51 }, { operation: 'read', sourceId: 'x', sessionId: 's', offset: 0, cursor: 'x' }, { operation: 'search', query: 'x', types: ['tool/result'] }, { operation: 'list', sourceId: 'x', projectPrefix: 'relative' }]) assert.throws(() => parseRequest(args));
  assert.equal(parseRequest({ operation: 'search', query: '😀'.repeat(512) }).query.length, 1024);
});
test('sources report disabled managed SQLite and never open/create it; replacement stales source ids', async () => {
  const f = fixture();
  const result = await f.api.execute({ operation: 'sources' }, exec());
  assert.equal(result.sources[0].index.enabled, false); assert.equal(result.sources[0].index.reason, 'search_disabled');
  assert.equal(result.externalSqlite.startsWith('unavailable'), true); assert.equal(f.calls.opens, 0);
  f.ctx.sessionPersistence = { ...f.ctx.sessionPersistence, identity: Symbol() };
  await assert.rejects(f.run({ operation: 'list' }), { code: 'source_changed' });
});
test('describe returns exact operation parameters, no model confirmation or SQL escape hatch', async () => {
  const f = fixture();
  const result = await f.api.execute({ operation: 'describe', targetOperation: 'search' }, exec());
  assert.ok(result.parameters.query); assert.ok(result.parameters.directory); assert.equal(result.parameters.text, undefined);
  assert.equal(result.parameters.sql, undefined); assert.equal(result.readonly.canonical, true);
});
test('complete paginated discovery exceeds 1000 sessions without missing rows; prefix is component aware', async () => {
  const f = fixture(1100, 0);
  f.rows.get('s-0').header.cwd = '/project-other';
  const result = await pages(f.run, { operation: 'list', limit: 100, maxBytes: 2048, projectPrefix: '/project' }, 'sessions');
  assert.equal(result.rows.length, 1099); assert.equal(new Set(result.rows.map(row => row.sessionId)).size, 1099);
  assert.equal(result.last.nextCursor, null); assert.equal(result.last.total, 1099);
  assert.ok(result.iterations > 11);
  assert.equal(componentPrefix('/project/child', '/project'), true); assert.equal(componentPrefix('/project-other', '/project'), false);
});
test('list cursor tolerates append but rejects membership, filters and runtime tampering', async () => {
  const f = fixture(3, 1);
  const first = await f.run({ operation: 'list', limit: 1 });
  f.rows.get('s-0').revision = 'new-append';
  const next = await f.run({ operation: 'list', cursor: first.nextCursor, limit: 1 }); assert.equal(next.sessions.length, 1);
  await assert.rejects(f.run({ operation: 'list', cursor: first.nextCursor + 'x' }), { code: 'cursor_invalid' });
  await assert.rejects(f.run({ operation: 'list', cursor: first.nextCursor, project: '/project' }), { code: 'cursor_invalid' });
  f.rows.delete('s-0'); await assert.rejects(f.run({ operation: 'list', cursor: first.nextCursor }), { code: 'cursor_stale' });
});
test('context returns original head and recent tail separately, message-aligned, without structural payloads', async () => {
  const f = fixture(1, 40);
  f.rows.get('s-0').events[1] = { seq: 1, time: 1, type: 'request/header', data: { secret: 'fixture-hidden-envelope' } };
  const result = await pages(f.run, { operation: 'context', sessionId: 's-0', before: 2, after: 2, limit: 2 }, 'events');
  assert.equal(result.rows[0].seq, 0); assert.equal(result.rows[0].window, 'head');
  assert.equal(result.rows.at(-1).seq, 39); assert.equal(result.rows.at(-1).window, 'tail');
  assert.ok(!result.rows.some(row => row.seq === 1)); assert.ok(!JSON.stringify(result).includes('fixture-hidden-envelope'));
  assert.equal(f.calls.opens, 1); assert.equal(f.calls.reads, 1); assert.equal(f.calls.closes, 1);
  const seq = await f.run({ operation: 'context', sessionId: 's-0', anchor: 'seq', seq: 1, before: 0, after: 0 });
  assert.ok(seq.events.some(row => row.seq === 1)); assert.equal(seq.events.find(row => row.seq === 1).data, undefined);
});
test('redaction precedes excerpts; reasoning, mixed assistant tool calls and tool results never cross read/search', async () => {
  const f = fixture(1, 4);
  const secret = 'syntheticSensitiveCredential';
  f.rows.get('s-0').events = [event(0, `token=${secret} ${'á'.repeat(6000)}`), { ...event(1, 'public response', 'assistant/message'), data: { message: { content: [{ type: 'text', text: 'public response' }, { type: 'tool-call', name: 'hidden', arguments: 'needle fixture-tool-secret' }, { type: 'reasoning', text: 'fixture-reasoning-secret' }] } } }, { seq: 2, time: 2, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'fixture-tool-result-secret needle' }] } } }, event(3, 'final')];
  const read = await f.run({ operation: 'read', sessionId: 's-0', offset: 0, limit: 1, textOffset: 8, textLimit: 4096, maxBytes: 32768 });
  assert.ok(!JSON.stringify(read).includes(secret)); assert.ok(read.events[0].nextTextOffset);
  const all = await pages(f.run, { operation: 'read', sessionId: 's-0', limit: 1 }, 'events');
  assert.ok(!JSON.stringify(all).includes('fixture-tool')); assert.ok(!JSON.stringify(all).includes('fixture-reasoning'));
  const search = await pages(f.run, { operation: 'search', query: 'needle', mode: 'substring' }, 'hits');
  assert.equal(search.rows.length, 0); assert.equal(search.last.coverage.state, 'complete');
});
test('precise reads cache a revision-bound cut, nextCursor ends and polling is separate append-safe', async () => {
  const f = fixture(1, 3);
  const first = await f.run({ operation: 'read', sessionId: 's-0', limit: 1 });
  const rest = await pages(f.run, { operation: 'read', sessionId: 's-0', cursor: first.nextCursor, limit: 1 }, 'events');
  assert.deepEqual(rest.rows.map(row => row.seq), [1, 2]); assert.equal(rest.last.nextCursor, null); assert.ok(rest.last.pollingCursor);
  assert.equal(f.calls.reads, 1);
  f.rows.get('s-0').events.push(event(3, 'appended')); f.rows.get('s-0').revision = 'r-new';
  const poll = await f.run({ operation: 'read', sessionId: 's-0', pollingCursor: rest.last.pollingCursor });
  assert.deepEqual(poll.events.map(row => row.seq), [3]);
  await assert.rejects(f.run({ operation: 'read', sessionId: 's-0', cursor: first.nextCursor }), { code: 'cursor_stale' });
  f.rows.get('s-0').events[0] = event(0, 'rewritten'); f.rows.get('s-0').revision = 'r-rewrite';
  await assert.rejects(f.run({ operation: 'read', sessionId: 's-0', pollingCursor: poll.pollingCursor }), { code: 'cursor_stale' });
});
test('incarnation/shrink changes and service swaps never silently reuse old cuts', async () => {
  const f = fixture(1, 3);
  const result = await f.run({ operation: 'read', sessionId: 's-0', limit: 1 });
  f.rows.get('s-0').header.createdAt = 999; f.rows.get('s-0').revision = 'new-life';
  await assert.rejects(f.run({ operation: 'read', sessionId: 's-0', pollingCursor: result.pollingCursor }), { code: 'cursor_stale' });
  const fresh = await f.run({ operation: 'read', sessionId: 's-0', limit: 1 });
  f.rows.get('s-0').events.length = 0; f.rows.get('s-0').revision = 'shrink';
  await assert.rejects(f.run({ operation: 'read', sessionId: 's-0', pollingCursor: fresh.pollingCursor }), { code: 'cursor_stale' });
});
test('bounded scans continue with no matches, report skipped sources, and do not claim physical completeness', async () => {
  const f = fixture(5, 3);
  const found = await pages(f.run, { operation: 'search', query: 'absent', candidateBudget: 1 }, 'hits');
  assert.equal(found.iterations, 5); assert.equal(found.rows.length, 0); assert.equal(found.last.coverage.physicalArtifacts, 'not-asserted');
  f.rows.get('s-0').events[0].data.content[0].text = 'x'.repeat(2000);
  const skipped = await pages(f.run, { operation: 'search', query: 'needle', scanBytes: 1024, candidateBudget: 1 }, 'hits');
  assert.equal(skipped.last.coverage.state, 'partial'); assert.ok(skipped.last.coverage.skippedCounts.scan_budget > 0);
});
test('phrase and substring are explicit literal modes including accents, whitespace, emoji and syntax-looking text', () => {
  assert.equal(matchesText('BRAID', 'AI', 'phrase'), false); assert.equal(matchesText('BRAID', 'AI', 'substring'), true);
  assert.equal(matchesText('café\twork', 'cafe work', 'phrase'), true);
  assert.equal(matchesText('literal OR * emoji 😀', 'OR *', 'substring'), true);
  assert.equal(matchesText('emoji\n😀', 'emoji 😀', 'substring'), true);
  assert.equal(matchesText('nothing', '" OR NEAR(*)', 'phrase'), false);
});
test('live-only history uses the public live observation, never requires flush or loses the live tail', async () => {
  const f = fixture(0);
  f.live.set('live/α', { id: 'live/α', header: { id: 'live/α', createdAt: 10, cwd: '/project', version: 4, isSeeded: false }, seq: 2, events: [event(0, 'original live'), event(1, 'recent unflushed needle')] });
  const list = await f.run({ operation: 'list' }); assert.equal(list.sessions[0].availability, 'live');
  const context = await f.run({ operation: 'context', sessionId: 'live/α' });
  assert.equal(context.source, 'live'); assert.equal(context.durableThroughSeq, null); assert.ok(context.events.some(row => row.text.includes('unflushed')));
  const search = await f.run({ operation: 'search', query: 'needle' }); assert.equal(search.hits.length, 1);
  assert.equal(f.calls.opens, 0); assert.equal(f.calls.disposed, 1);
});
test('managed provider only supplies addresses: even a poisoned snippet getter is never accessed', async () => {
  const f = fixture(1, 3, { allowManagedIndex: true });
  f.ctx.sessionQuery.config.openAt = 'first-search';
  const sourceId = f.api.locator.source().sourceId;
  f.ctx.sessionQuery.searchEvents = async request => {
    f.calls.native++; assert.deepEqual(request.filters[0].values, ['user/message', 'assistant/message']);
    return { session: f.rows.get('s-0').header, items: [0, 1, 2].map(seq => ({ sessionId: 's-0', seq, get snippet() { throw new Error('raw snippet crossed boundary'); } })) };
  };
  const result = await f.api.execute({ operation: 'search', query: 'needle', sourceId }, exec());
  assert.equal(result.engine, 'native-sqlite-candidates+canonical-confirmation'); assert.equal(result.managedIndexWrites, true); assert.equal(result.hits.length, 3); assert.equal(f.calls.native, 1);
});
test('configured provider is not called without explicit host cache-write authorization', async () => {
  const f = fixture(); f.ctx.sessionQuery.config.openAt = 'startup';
  const result = await f.api.execute({ operation: 'search', query: 'needle' }, exec());
  assert.equal(result.fallback, 'managed_index_not_authorized'); assert.equal(result.managedIndexWrites, false);
});
test('expired bounded cuts fail explicitly and cancellation closes already-open read handles', async () => {
  let now = 100; const f = fixture(1, 3, { now: () => now });
  const first = await f.run({ operation: 'read', sessionId: 's-0', limit: 1 }); now += 61000;
  await assert.rejects(f.run({ operation: 'read', sessionId: 's-0', cursor: first.nextCursor }), { code: 'cursor_expired' });
  const signal = new AbortController();
  const original = f.ctx.sessionPersistence.open;
  f.ctx.sessionPersistence.open = async (...args) => { const handle = await original(...args); return { ...handle, read: async () => { signal.abort(); signal.signal.throwIfAborted(); } }; };
  await assert.rejects(f.api.execute({ operation: 'read', sourceId: f.sourceId, sessionId: 's-0' }, { signal: signal.signal }), { name: 'AbortError' });
  assert.equal(f.calls.opens, f.calls.closes);
});

test('physical discovery navigates root/project/session/generations, confirms headers without reading bodies', async () => {
  await mkdir('.dumps/session-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.dumps/session-tests/paths-'));
  const directory = join(root, '--actual-cwd--', 'native~002F~03B1');
  await mkdir(directory, { recursive: true });
  for (const filename of ['session.jsonl', 'session.v4.jsonl', 'session.v03.jsonl', 'session.v0.jsonl', 'writer.lock']) await writeFile(join(directory, filename), 'fixture-header-body-never-read');
  const f = fixture(0, 0, { root }); f.rows.set('native/α', { header: { id: 'native/α', version: 4, createdAt: 1, cwd: '/actual/cwd', isSeeded: false }, revision: 'r', events: [] });
  const rootResult = await f.run({ operation: 'paths' }); assert.equal(rootResult.location.role, 'persistenceRoot'); assert.equal(rootResult.paths[0].role, 'projectDir');
  const projects = await f.run({ operation: 'paths', pathRef: rootResult.paths[0].pathRef }); assert.equal(projects.paths[0].sessionId, 'native/α'); assert.equal(projects.paths[0].project, '/actual/cwd');
  await writeFile(join(directory, 'session.v9.jsonl'), 'authored future marker');
  const logs = await f.run({ operation: 'paths', pathRef: projects.paths[0].pathRef });
  assert.equal(logs.paths.length, 3); assert.equal(logs.paths.filter(row => row.selected)[0].physicalFormatVersion, 9);
  assert.equal(f.calls.opens, 0); assert.equal(f.calls.reads, 0);
  await assert.rejects(f.run({ operation: 'context', pathRef: projects.paths[0].pathRef }), { code: 'path_role_mismatch' });
  await rename(join(directory, 'session.v9.jsonl'), join(directory, 'authored-future-marker.txt'));
  const refreshed = await f.run({ operation: 'paths', directory: join(root, '--actual-cwd--') });
  const context = await f.run({ operation: 'context', pathRef: refreshed.paths[0].pathRef }); assert.equal(context.sessionId, 'native/α');
  assert.equal(generationCandidate('session.v0.jsonl'), undefined); assert.equal(generationCandidate('session.v04.jsonl'), undefined); assert.equal(segmentCandidate('native~002F~03B1'), 'native/α');
  const before = await readdir(root); await f.api.execute({ operation: 'sources' }, exec()); assert.deepEqual(await readdir(root), before);
});
test('path references reject symlink escapes, inode replacement, external dirs and duplicate candidates', async () => {
  await mkdir('.dumps/session-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.dumps/session-tests/unsafe-'));
  const other = await mkdtemp(join(process.cwd(), '.dumps/session-tests/other-'));
  const project = join(root, '--project--'); await mkdir(join(project, 's-0'), { recursive: true });
  await symlink(other, join(root, '--escape--'));
  const f = fixture(1, 0, { root });
  await assert.rejects(f.run({ operation: 'paths', directory: join(root, '--escape--') }), { code: 'path_unsafe' });
  await assert.rejects(f.run({ operation: 'paths', directory: other }), { code: 'path_outside_source' });
  const ref = (await f.run({ operation: 'paths', directory: project })).paths[0].pathRef;
  await rename(join(project, 's-0'), join(project, 'old')); await mkdir(join(project, 's-0'));
  await assert.rejects(f.run({ operation: 'context', pathRef: ref }), { code: 'path_changed' });
  await mkdir(join(root, '--other--', 's-0'), { recursive: true });
  await assert.rejects(f.run({ operation: 'paths', sessionId: 's-0' }), { code: 'path_ambiguous' });
});
