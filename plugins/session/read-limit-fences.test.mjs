import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadSide } from './read-side.mjs';
const exec = { signal: new AbortController().signal };
const event = (seq, text) => ({ seq, time: 1, type: 'user/message', data: { content: [{ type: 'text', text }] } });
function fixture(count = 4, options = {}) {
  const rows = new Map(Array.from({ length: count }, (_, i) => { const id = `s-${i}`; return [id, { header: { id, version: 4, cwd: '/project', createdAt: 1, isSeeded: false }, revision: 'r', events: [event(0, `needle ${'x'.repeat(500)}`)] }]; }));
  let reads = 0;
  const ctx = { sessionPersistence: { name: 'session-persistence-jsonl', identity: Symbol(), config: { root: '/authored/limit-fences', compression: 'none' }, list: async () => [...rows.values()].map(row => ({ header: row.header, revision: row.revision, sizeBytes: 1 })), stat: async id => { const row = rows.get(id); return row && { header: row.header, revision: row.revision, sizeBytes: 1 }; }, open: async (id, mode) => { assert.equal(mode, 'read'); const row = rows.get(id); return { header: row.header, read: async (offset, length) => { reads++; return { events: row.events.slice(offset, offset + length) }; }, close: async () => {} }; } }, sessionQuery: { config: { path: ':memory:', openAt: 'never' } }, sessions: { list: () => [], get: () => undefined } };
  const api = createReadSide(ctx, options);
  return { api, ctx, rows, reads: () => reads, run: args => api.execute({ sourceId: api.locator.source().sourceId, ...args }, exec) };
}

test('matching event/byte budgets are cumulative across cached candidates and make forward progress', async () => {
  const f = fixture(); let cursor, seen = [], iterations = 0;
  do {
    const result = await f.run({ operation: 'search', query: 'needle', scanEvents: 2, scanBytes: 1024, candidateBudget: 8, ...(cursor ? { cursor } : {}) });
    assert.ok((result.counters.scanEvents ?? 0) <= 2); assert.ok((result.counters.scanBytes ?? 0) <= 1024);
    seen.push(...result.hits.map(hit => hit.sessionId)); cursor = result.nextCursor; assert.ok(++iterations <= 4);
  } while (cursor);
  assert.deepEqual(seen, ['s-0', 's-1', 's-2', 's-3']); assert.equal(f.reads(), 4);
});

test('native no-hit pages avoid an extra canonical decode, with hidden provider work explicitly unbounded', async () => {
  const f = fixture(1, { allowManagedIndex: true }); f.ctx.sessionQuery.config.openAt = 'first-search';
  f.ctx.sessionQuery.searchEvents = async () => ({ session: f.rows.get('s-0').header, items: [] });
  const result = await f.run({ operation: 'search', query: 'absent' });
  assert.equal(result.hits.length, 0); assert.equal(result.coverage.state, 'complete'); assert.equal(f.reads(), 0);
  assert.equal(result.counters.nativeQueries, 1); assert.equal(result.backendWorkBounded, false); assert.equal(result.effect, 'derived-cache-may-write');
});

test('replacing the public query instance invalidates source ids even when configuration matches', async () => {
  const f = fixture(1), sourceId = f.api.locator.source().sourceId;
  f.ctx.sessionQuery = { ...f.ctx.sessionQuery };
  await assert.rejects(f.api.execute({ operation: 'list', sourceId }, exec), { code: 'source_changed' });
});

test('polling rejects recreated live objects with the same header and unchanged visible prefix', async () => {
  const f = fixture(0);
  let live = { id: 'live', header: { id: 'live', version: 4, createdAt: 1, cwd: '/project', isSeeded: false }, seq: 1, events: [event(0, 'original')] };
  f.ctx.sessions = { list: () => [live], get: id => id === 'live' ? live : undefined };
  f.ctx.sessionQuery.observeSession = async () => ({ source: 'live', header: live.header, events: live.events, inheritedEventCount: 0, [Symbol.dispose]() {} });
  const first = await f.run({ operation: 'read', sessionId: 'live' });
  live = { ...live, seq: 2, events: [...live.events, event(1, 'new instance')] };
  await assert.rejects(f.run({ operation: 'read', sessionId: 'live', pollingCursor: first.pollingCursor }), { code: 'cursor_stale' });
});

test('redaction expansion beyond matching budget skips explicitly instead of issuing an infinite cursor', async () => {
  const f = fixture(1);
  f.rows.get('s-0').events = [event(0, 'token=x '.repeat(90) + 'needle')];
  const result = await f.run({ operation: 'search', query: 'needle', scanBytes: 1024 });
  assert.equal(result.hits.length, 0); assert.equal(result.nextCursor, null); assert.equal(result.coverage.state, 'partial');
  assert.equal(result.coverage.skippedCounts.scan_budget, 1); assert.equal(f.reads(), 1);
});
