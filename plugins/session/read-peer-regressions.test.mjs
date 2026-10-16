import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadSide } from './read-side.mjs';
import { canonicalSessionDirectory } from './source-locator.mjs';
const exec = { signal: new AbortController().signal };
function fixture(rows, root = '/authored/peer', options = {}) {
  const calls = { reads: 0 };
  const ctx = { sessionPersistence: { name: 'session-persistence-jsonl', identity: Symbol(), config: { root, compression: 'none' }, list: async () => [...rows.values()].map(row => ({ header: row.header, revision: row.revision, sizeBytes: 1 })), stat: async id => { const row = rows.get(id); return row && { header: row.header, revision: row.revision, sizeBytes: 1 }; }, open: async (id, access) => {
    assert.equal(access, 'read'); const row = rows.get(id);
    return { header: row.header, read: async (offset, length) => { calls.reads++; return { events: row.events.slice(offset, offset + length) }; }, close: async () => {} };
  } }, sessionQuery: { config: { path: ':memory:', openAt: 'never' } }, sessions: { get: () => undefined, list: () => [] } };
  const api = createReadSide(ctx, options);
  return { api, ctx, calls, run: args => api.execute({ sourceId: api.locator.source().sourceId, ...args }, exec) };
}
const row = (id, text = 'needle', cwd = '/project') => ({ header: { id, version: 4, createdAt: 1, cwd, isSeeded: false }, revision: 'r', events: [{ seq: 0, time: 1, type: 'user/message', data: { content: [{ type: 'text', text }] } }] });

test('peerP1: 20 long native IDs skipped over three pages never create a self-rejected cursor', async () => {
  const rows = new Map(Array.from({ length: 20 }, (_, i) => { const id = `id-${String(i).padStart(3, '0')}-${'x'.repeat(100)}`; return [id, row(id, 'x'.repeat(2000))]; }));
  const f = fixture(rows); let cursor, pages = 0, lastCount = 0, last;
  do {
    last = await f.run({ operation: 'search', query: 'needle', candidateBudget: 8, scanBytes: 1024, maxBytes: 8192, ...(cursor ? { cursor } : {}) });
    assert.equal(last.hits.length, 0); assert.equal(last.coverage.state, 'partial');
    assert.ok(last.coverage.skippedCount >= lastCount); lastCount = last.coverage.skippedCount;
    cursor = last.nextCursor; if (cursor) assert.ok(Buffer.byteLength(cursor) <= 2048);
    assert.ok(++pages <= 3);
  } while (cursor);
  assert.equal(pages, 3); assert.equal(last.coverage.skippedCount, 20); assert.equal(last.coverage.skippedCounts.scan_budget, 20);
});

test('provider cursors remain private bounded metadata; large native cursor is not nested in a tool cursor', async () => {
  const rows = new Map([['s', row('s')]]); rows.get('s').events.push({ ...rows.get('s').events[0], seq: 1 });
  const f = fixture(rows, undefined, { allowManagedIndex: true }); const providerCursor = 'p'.repeat(10000);
  f.ctx.sessionQuery.config.openAt = 'first-search';
  f.ctx.sessionQuery.searchEvents = async request => ({ session: rows.get('s').header, items: [{ sessionId: 's', seq: request.cursor ? 1 : 0, get snippet() { throw Error('raw snippet forbidden'); } }], ...(request.cursor ? (assert.equal(request.cursor, providerCursor), {}) : { nextCursor: providerCursor }) });
  const first = await f.run({ operation: 'search', query: 'needle', limit: 1 }); assert.ok(first.nextCursor.length < 400); assert.ok(!first.nextCursor.includes(providerCursor));
  const last = await f.run({ operation: 'search', query: 'needle', limit: 1, cursor: first.nextCursor }); assert.equal(last.hits[0].seq, 1); assert.equal(last.nextCursor, null);
});

test('peerP2: absent surface classification stays unavailable before and after warming a cut', async () => {
  const f = fixture(new Map([['s', row('s')]]));
  const cold = await f.run({ operation: 'search', query: 'needle', surface: 'current' });
  assert.equal(cold.coverage.state, 'partial'); assert.equal(cold.coverage.skippedCounts.surface_unavailable, 1);
  await f.run({ operation: 'read', sessionId: 's' });
  const warm = await f.run({ operation: 'search', query: 'needle', surface: 'current' });
  assert.equal(warm.coverage.state, 'partial'); assert.equal(warm.coverage.skippedCounts.surface_unavailable, 1); assert.equal(warm.hits.length, 0);
});

test('peerP2: empty/corrupt/future aliases never bind global stat(A) to physical directory B', async () => {
  await mkdir('.dumps/session-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.dumps/session-tests/alias-proof-'));
  const a = join(root, '--A--', 'same'), b = join(root, '--B--', 'same');
  await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
  await writeFile(join(a, 'session.v4.jsonl'), 'authored canonical marker');
  const rows = new Map([['same', row('same', 'needle canonical A', '/A')]]), f = fixture(rows, root);
  for (const marker of [null, 'session.v99.jsonl', 'session.v4.jsonl']) {
    if (marker) await writeFile(join(b, marker), 'authored corrupt/future marker');
    const paths = await f.run({ operation: 'paths', directory: join(root, '--B--') });
    assert.equal(paths.paths[0].sessionId, undefined); assert.equal(paths.paths[0].identityConfirmed, false);
    await assert.rejects(f.run({ operation: 'context', pathRef: paths.paths[0].pathRef }), { code: 'path_role_mismatch' });
    await assert.rejects(f.run({ operation: 'read', sessionId: 'same', directory: join(root, '--B--') }), { code: 'not_found' });
    const search = await f.run({ operation: 'search', query: 'needle', directory: join(root, '--B--') }); assert.equal(search.hits.length, 0);
    const list = await f.run({ operation: 'list', directory: join(root, '--B--') }); assert.equal(list.sessions.length, 0);
    const generations = await f.run({ operation: 'paths', directory: b });
    for (const generation of generations.paths) { assert.equal(generation.sessionId, undefined); assert.equal(generation.readable, false); await assert.rejects(f.run({ operation: 'read', pathRef: generation.pathRef }), { code: 'path_role_mismatch' }); }
  }
  const good = await f.run({ operation: 'paths', directory: join(root, '--A--') });
  const context = await f.run({ operation: 'context', pathRef: good.paths[0].pathRef }); assert.equal(context.sessionId, 'same'); assert.ok(context.events[0].text.endsWith('canonical A'));
  assert.equal(f.calls.reads, 1, 'unproven B never causes a canonical A body read');
});

test('previously proven session directory refs are revalidated after the logical session moves elsewhere', async () => {
  await mkdir('.dumps/session-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.dumps/session-tests/moved-proof-'));
  const a = join(root, '--A--', 'same'), b = join(root, '--B--', 'same');
  await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
  await writeFile(join(a, 'session.v4.jsonl'), 'authored canonical marker');
  const rows = new Map([['same', row('same', 'needle A', '/A')]]), f = fixture(rows, root);
  const ref = (await f.run({ operation: 'paths', directory: join(root, '--A--') })).paths[0].pathRef;
  await rename(join(a, 'session.v4.jsonl'), join(b, 'session.v4.jsonl'));
  rows.get('same').header.cwd = '/B'; rows.get('same').revision = 'moved';
  await assert.rejects(f.run({ operation: 'context', pathRef: ref }), { code: 'canonical_location_changed' });
  await assert.rejects(f.run({ operation: 'search', query: 'needle', pathRef: ref }), { code: 'canonical_location_changed' });
});

test('forward layout is version fenced, handles dots/Unicode/space IDs, and never reverse-infers cwd', () => {
  assert.equal(canonicalSessionDirectory('/root', { id: '.', version: 4, cwd: '/a.b/space here' }), '/root/--a.b-space~0020here--/~002E');
  assert.equal(canonicalSessionDirectory('/root', { id: 'native/α', version: 4, cwd: '/actual/cwd' }), '/root/--actual-cwd--/native~002F~03B1');
  assert.equal(canonicalSessionDirectory('/root', { id: 's', version: 99, cwd: '/project' }), undefined);
  assert.equal(canonicalSessionDirectory('/root', { id: 's', version: 4, cwd: '/a/b' }), canonicalSessionDirectory('/root', { id: 's', version: 4, cwd: '/a-b' }));
});
