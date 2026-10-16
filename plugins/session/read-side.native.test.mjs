import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadSide } from './read-side.mjs';
import { createController } from './controller.mjs';

const require = createRequire('/home/alex/.local/share/dsh-cli/package.json');
const load = id => import(require.resolve(`@deepseek-ai/${id}`));
const exec = { signal: new AbortController().signal };
async function authoredRoot() {
  await mkdir('.dumps/session-tests', { recursive: true });
  return mkdtemp(join(process.cwd(), '.dumps/session-tests/reader-native-'));
}
async function hashes(root) {
  const out = {};
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out[path] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await walk(root); return out;
}
function user(seq, text) {
  return { seq, time: seq + 1, type: 'user/message', surfaceOp: 'append', data: { id: `message-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } };
}
async function setup(t, openAt = 'never') {
  const [{ Context }, session, persistence, query, sqlite] = await Promise.all([load('cordis'), load('dsh-session'), load('dsh-session-persistence-jsonl'), load('dsh-session-query'), load('dsh-session-query-sqlite')]);
  const root = await authoredRoot();
  const ctx = new Context();
  t.after(async () => ctx.fiber.dispose());
  await ctx.plugin(session.default);
  await ctx.plugin(persistence.default, { root: join(root, 'logs'), compression: 'zstd' });
  await ctx.plugin(sqlite.default, { path: join(root, 'derived-index.sqlite'), openAt, journalMode: 'wal' });
  const header = { id: session.SessionId('authored-native/α'), version: session.SESSION_FORMAT_VERSION, createdAt: 100, cwd: '/authored/project', isSeeded: false };
  const writer = await ctx.sessionPersistence.create(header);
  await writer.append([user(0, 'original request café needle'), user(1, 'recent request secret=synthetic-credential')]);
  await writer.flush(); await writer.close();
  return { root, ctx, session, query, sqlite, header, api: createReadSide(ctx, { allowManagedIndex: openAt !== 'never', eventRecords: query.buildSessionEventRecords }) };
}

test('installed SDK: zstd canonical context/path discovery and disabled SQLite perform no source writes', async t => {
  const f = await setup(t);
  const before = await hashes(join(f.root, 'logs'));
  const sources = await f.api.execute({ operation: 'sources' }, exec);
  assert.equal(sources.sources[0].index.reason, 'search_disabled');
  assert.equal((await readdir(f.root)).includes('derived-index.sqlite'), false);
  const context = await f.api.execute({ operation: 'context', sessionId: f.header.id, textLimit: 4096 }, exec);
  assert.equal(context.source, 'durable'); assert.equal(context.synthetic, false);
  assert.equal(context.events[0].text, 'original request café needle');
  assert.ok(!JSON.stringify(context).includes('synthetic-credential'));
  const paths = await f.api.execute({ operation: 'paths', sessionId: f.header.id }, exec);
  assert.equal(paths.paths.length, 1); assert.equal(paths.paths[0].physicalFormatVersion, 4); assert.equal(paths.paths[0].compression, 'zstd'); assert.equal(paths.paths[0].readable, true);
  const referenced = await f.api.execute({ operation: 'read', pathRef: paths.paths[0].pathRef }, exec);
  assert.equal(referenced.events.length, 2); assert.equal(referenced.nextCursor, null); assert.ok(referenced.pollingCursor);
  const search = await f.api.execute({ operation: 'search', query: 'cafe needle' }, exec);
  assert.equal(search.hits.length, 1); assert.equal(search.managedIndexWrites, false);
  assert.deepEqual(await hashes(join(f.root, 'logs')), before);
  assert.equal((await readdir(f.root)).includes('derived-index.sqlite'), false);
});

test('installed SDK: public managed SQLite V8 candidates confirmed canonically; only authored derived index writes', async t => {
  const f = await setup(t, 'first-search');
  assert.equal(f.sqlite.SESSION_QUERY_SQLITE_SCHEMA_VERSION, 8);
  assert.equal(f.sqlite.SESSION_QUERY_SQLITE_APPLICATION_ID, 1146308689);
  const before = await hashes(join(f.root, 'logs'));
  const search = await f.api.execute({ operation: 'search', query: 'cafe needle', mode: 'phrase' }, exec);
  assert.equal(search.engine, 'native-sqlite-candidates+canonical-confirmation');
  assert.equal(search.hits.length, 1); assert.equal(search.hits[0].seq, 0); assert.equal(search.hits[0].text, 'original request café needle');
  assert.equal(search.managedIndexWrites, true); assert.equal(search.counters.nativeQueries, 1);
  assert.equal((await readdir(f.root)).includes('derived-index.sqlite'), true);
  assert.deepEqual(await hashes(join(f.root, 'logs')), before);
  // Inspect only the authored fixture; never reuse the native mutating loader as
  // a reader. This checks the public schema constants against the real fixture.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(f.root, 'derived-index.sqlite'), { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA query_only=ON');
    assert.equal(db.prepare('PRAGMA application_id').get().application_id, 1146308689);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='persisted_sessions'").get().name, 'persisted_sessions');
    assert.equal(db.prepare("SELECT name FROM sqlite_temp_master WHERE name='live_docs'").get(), undefined);
    assert.throws(() => db.exec('CREATE TABLE forbidden_fixture_mutation(id)'));
  } finally { db.close(); }
});

test('installed SDK: future highest generation is surfaced but never read through an older fallback', async t => {
  const f = await setup(t);
  const paths = await f.api.execute({ operation: 'paths', sessionId: f.header.id }, exec);
  const directory = paths.location.path;
  const future = { ...f.header, version: 99 };
  // Authored raw generation in the configured zstd root must fail as an encoding
  // mismatch, not silently select the current lower generation.
  await writeFile(join(directory, 'session.v99.jsonl'), JSON.stringify(future) + '\n');
  const generations = await f.api.execute({ operation: 'paths', directory }, exec);
  assert.ok(generations.paths.some(row => row.physicalFormatVersion === 99 && row.selected && !row.readable));
  await assert.rejects(f.api.execute({ operation: 'read', sourceId: f.api.locator.source().sourceId, sessionId: f.header.id }, exec));
});

test('installed SDK: legacy inspect uses one cached canonical cut, not logarithmic repeated full decodes', async t => {
  const f = await setup(t);
  let readCalls = 0;
  const p = f.ctx.sessionPersistence;
  const wrapper = { name: p.name, identity: p.identity, config: p.config, list: (...args) => p.list(...args), stat: (...args) => p.stat(...args), open: async (...args) => {
    const handle = await p.open(...args);
    return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, read: (...readArgs) => { readCalls++; return handle.read(...readArgs); }, close: () => handle.close() };
  } };
  const controller = createController({ sessionPersistence: wrapper, sessionQuery: f.ctx.sessionQuery, agents: { list: () => [], get: () => undefined } }, { ledgerPath: join(f.root, 'absent-ledger'), bridge: { discoverBridges: async () => ({ bridges: [] }) }, eventRecords: f.query.buildSessionEventRecords });
  const first = await controller.execute({ operation: 'inspect', sessionId: f.header.id, view: 'tail', limit: 1 }, exec);
  const second = await controller.execute({ operation: 'inspect', sessionId: f.header.id, view: 'tail', limit: 1 }, exec);
  assert.equal(first.events[0].seq, 1); assert.equal(second.events[0].seq, 1);
  assert.equal(first.events[0].text, 'recent request secret=[redacted]');
  assert.equal(readCalls, 1);
});

test('installed SDK: live-only unflushed history is visible, surface-aware, and creates no canonical writer or index', async t => {
  const f = await setup(t);
  const before = await hashes(join(f.root, 'logs'));
  const id = f.session.SessionId('authored-live/α');
  const live = f.ctx.sessions.create(id, { meta: { cwd: '/authored/live' } });
  live.append('user/message', user(0, 'original live needle').data, { surfaceOp: 'append' });
  live.append('user/message', user(1, 'unflushed live tail needle').data, { surfaceOp: 'append' });
  assert.equal(await f.ctx.sessionPersistence.stat(id), undefined);
  const context = await f.api.execute({ operation: 'context', sessionId: id }, exec);
  assert.equal(context.source, 'live'); assert.equal(context.durableThroughSeq, null); assert.equal(context.originalRequestConfirmed, true);
  assert.ok(context.events.some(event => event.text.includes('unflushed')));
  const read = await f.api.execute({ operation: 'read', sourceId: f.api.locator.source().sourceId, sessionId: id }, exec);
  live.append('user/message', user(2, 'replacement current needle').data, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] });
  const poll = await f.api.execute({ operation: 'read', sourceId: f.api.locator.source().sourceId, sessionId: id, pollingCursor: read.pollingCursor }, exec);
  assert.deepEqual(poll.events.map(event => event.seq), [2]);
  const current = await f.api.execute({ operation: 'search', sessionId: id, query: 'needle', surface: 'current' }, exec);
  assert.deepEqual(current.hits.map(event => event.seq), [1, 2]);
  const shadowed = await f.api.execute({ operation: 'search', sessionId: id, query: 'needle', surface: 'shadowed' }, exec);
  assert.deepEqual(shadowed.hits.map(event => event.seq), [0]);
  assert.deepEqual(await hashes(join(f.root, 'logs')), before);
  assert.equal((await readdir(f.root)).includes('derived-index.sqlite'), false);
});
