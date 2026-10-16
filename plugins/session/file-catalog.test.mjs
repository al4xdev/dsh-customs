import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, symlink, rename, rm, utimes, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { createFileCatalog } from './file-catalog.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'file-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function log(id, header = {}, { version = 4, encoding = 'jsonl', body = '', raw, project = 'project' } = {}) {
    const path = join(root, project, id, `session.v${version}.jsonl${encoding === 'zstd' ? '.zstd' : ''}`);
    await mkdir(dirname(path), { recursive: true });
    const text = raw ?? JSON.stringify({ type: 'session', id, version, ...header }) + '\n' + body;
    await writeFile(path, encoding === 'zstd' ? zstdCompressSync(Buffer.from(text)) : text);
    return path;
  }
  return { root, log };
}
const code = value => ({ code: value });

test('metadata discovery orders 50 newer subagents before two main sessions; seeded parent remains main', async t => {
  const { root, log } = await fixture(t);
  const paths = [];
  for (let i = 0; i < 50; i++) paths.push(await log(`sub-${i}`, { origin: 'subagent', delegationDepth: 1 }));
  const main = await log('main', { delegationDepth: 0 });
  const seeded = await log('seeded', { delegationDepth: 0, isSeeded: true, parentSession: 'main' });
  await log('companion', { agentPreset: 'companion', delegationDepth: 0 });
  await log('legacy', { parentSession: 'parent' });
  await log('unproven-origin', { origin: 'tui' });
  for (const path of paths) await utimes(path, 200, 200);
  await utimes(main, 100, 100); await utimes(seeded, 100, 100);
  const catalog = createFileCatalog({ root });
  const found = await catalog.discover();
  assert.equal(found.truncated, false);
  assert.equal(found.counters.headerReads, 0); assert.equal(found.counters.headerBytes, 0);
  assert.equal(found.candidates.length, 55);
  const sub = found.candidates.filter(row => paths.includes(row.path));
  assert.deepEqual(sub.map(row => row.path), [...paths].sort());
  assert.ok(found.candidates.indexOf(sub.at(-1)) < found.candidates.findIndex(row => row.path === main));
  const rows = await Promise.all(found.candidates.map(candidate => catalog.describe(candidate)));
  assert.equal(rows.filter(row => row.classification === 'subagent').length, 50);
  assert.deepEqual(rows.filter(row => row.classification === 'main').map(row => row.header.id), ['main', 'seeded']);
  assert.equal(rows.filter(row => row.classification === 'unknown').length, 2);
  assert.equal(rows.find(row => row.header.id === 'companion').classification, 'companion');
  for (const candidate of found.candidates) {
    assert.deepEqual(Object.keys(candidate.signature), ['dev', 'ino', 'size', 'mtimeNs']);
    assert.ok(Object.values(candidate.signature).every(value => typeof value === 'string'));
  }
});

for (const version of [3, 4]) for (const encoding of ['jsonl', 'zstd']) {
  test(`reads real ${encoding} v${version} header across chunks without decoding giant body`, async t => {
    const { root, log } = await fixture(t);
    const cwd = '/á/🙂'.repeat(3000);
    await log('large', { cwd, delegationDepth: 0, ignored: 'never expose' }, { version, encoding, body: 'x'.repeat(16 * 1024 * 1024) });
    const catalog = createFileCatalog({ root });
    const { candidates } = await catalog.discover();
    const row = await catalog.describe(candidates[0]);
    assert.equal(row.header.cwd, cwd); assert.equal(row.header.version, version);
    assert.equal(row.header.ignored, undefined); assert.equal(row.classification, 'main');
    const { counters } = await catalog.discover();
    assert.equal(counters.headerReads, 1);
    assert.ok(counters.headerBytes > Buffer.byteLength(cwd));
    assert.ok(counters.headerBytes < 64 * 1024, `decoded only prefix: ${counters.headerBytes}`);
  });
}

test('highest future generation is unreadable without old fallback or any header reads', async t => {
  const { root, log } = await fixture(t);
  await log('future', { delegationDepth: 0 });
  const path = await log('future', {}, { version: 99, raw: 'not valid JSON or header' });
  const catalog = createFileCatalog({ root });
  const found = await catalog.discover();
  assert.equal(found.candidates.length, 1); assert.equal(found.candidates[0].path, path);
  assert.deepEqual(await catalog.describe(found.candidates[0]), { ...found.candidates[0], header: null, classification: 'unreadable' });
  assert.equal((await catalog.discover()).counters.headerReads, 0);
});

test('highest supported version wins regardless of older generation mtime', async t => {
  const { root, log } = await fixture(t);
  const older = await log('mixed', {}, { version: 3 });
  const newest = await log('mixed', {}, { version: 4, encoding: 'zstd' });
  await utimes(older, 999, 999); await utimes(newest, 10, 10);
  const catalog = createFileCatalog({ root });
  const { candidates } = await catalog.discover();
  assert.equal(candidates[0].path, newest);
  assert.equal((await catalog.describe(candidates[0])).header.version, 4);
});

test('invalid, mismatched, partial, oversized, and corrupt headers have FILE errors', async t => {
  const { root, log } = await fixture(t);
  const cases = [
    ['bad-json', '{broken}\n', 'FILE_HEADER_INVALID'],
    ['bad-id', '{"type":"session","id":1,"version":4}\n', 'FILE_HEADER_INVALID'],
    ['bad-type', '{"type":"event","id":"bad","version":4}\n', 'FILE_HEADER_INVALID'],
    ['bad-version', '{"type":"session","id":"bad","version":3}\n', 'FILE_HEADER_INVALID'],
    ['partial', '{"type":"session","id":"bad","version":4}', 'FILE_HEADER_INCOMPLETE'],
    ['too-large', 'x'.repeat(128 * 1024 + 1) + '\n', 'FILE_HEADER_LIMIT'],
  ];
  for (const [id, raw] of cases) await log(id, {}, { raw });
  const corrupt = await log('corrupt', {}, { encoding: 'zstd' });
  await writeFile(corrupt, 'not zstd');
  const catalog = createFileCatalog({ root });
  const { candidates } = await catalog.discover();
  for (const [id, , expected] of cases) await assert.rejects(catalog.describe(candidates.find(row => row.sessionDir.endsWith(`/${id}`))), code(expected));
  await assert.rejects(catalog.describe(candidates.find(row => row.path === corrupt)), code('FILE_HEADER_DECODE'));
});

test('root, ancestor, project, session and file symlinks are never followed; forged candidates fail', async t => {
  const { root, log } = await fixture(t);
  const path = await log('safe', { delegationDepth: 0 });
  const catalog = createFileCatalog({ root });
  const { candidates: [candidate] } = await catalog.discover();
  await assert.rejects(catalog.describe({ ...candidate, path: '/etc/passwd' }), code('FILE_CANDIDATE'));
  await assert.rejects(catalog.describe({ ...candidate, version: 3 }), code('FILE_CANDIDATE'));
  await assert.rejects(createFileCatalog({ root }).describe(candidate), code('FILE_CANDIDATE'));
  await symlink(join(root, 'project'), join(root, 'linked-project'));
  await symlink(dirname(path), join(root, 'project', 'linked-session'));
  await mkdir(join(root, 'project', 'linked-file'));
  await symlink(path, join(root, 'project', 'linked-file', 'session.v4.jsonl'));
  await log('linked-file', {}, { version: 3 });
  assert.equal((await catalog.discover()).candidates.length, 1);
  const alias = join(root, 'alias');
  await symlink(join(root, 'project'), alias);
  await assert.rejects(createFileCatalog({ root: alias }).discover(), code('FILE_UNSAFE_PATH'));
  await assert.rejects(createFileCatalog({ root: join(alias, 'safe') }).discover(), code('FILE_UNSAFE_PATH'));
  await rename(path, path + '.saved'); await symlink(path + '.saved', path);
  await assert.rejects(catalog.describe(candidate), code('FILE_UNSAFE_PATH'));
});

test('entry cap marks truncation and never emits a partially scanned generation directory', async t => {
  const { root, log } = await fixture(t);
  await log('session', {}, { version: 3 }); await log('session', {}, { version: 99 });
  const limited = await createFileCatalog({ root, maxEntries: 3 }).discover();
  assert.equal(limited.truncated, true); assert.equal(limited.counters.entries, 3); assert.deepEqual(limited.candidates, []);
  const complete = await createFileCatalog({ root, maxEntries: 4 }).discover();
  assert.equal(complete.truncated, false); assert.equal(complete.candidates[0].version, 99);
});

test('cache is signature-bound, cloned and LRU bounded; clear invalidates candidates and counters', async t => {
  const { root, log } = await fixture(t);
  await log('a', { delegationDepth: 0 }); await log('b', { delegationDepth: 0 });
  const catalog = createFileCatalog({ root, headerCacheSize: 1 });
  const { candidates } = await catalog.discover();
  const [a, b] = candidates;
  const first = await catalog.describe(a); first.header.id = 'mutated'; first.signature.ino = '0';
  assert.notEqual((await catalog.describe(structuredClone(a))).header.id, 'mutated');
  await catalog.describe(b); await catalog.describe(a);
  let stats = (await catalog.discover()).counters;
  assert.equal(stats.headerReads, 3); assert.equal(stats.cacheHits, 1);
  await appendFile(a.path, '{"type":"event"}\n');
  await assert.rejects(catalog.describe(a), code('FILE_CHANGED'));
  const refreshed = (await catalog.discover()).candidates.find(row => row.path === a.path);
  await catalog.describe(refreshed);
  stats = (await catalog.discover()).counters;
  assert.equal(stats.headerReads, 4);
  catalog.clear();
  await assert.rejects(catalog.describe(refreshed), code('FILE_CANDIDATE'));
  assert.equal((await catalog.discover()).counters.headerReads, 0);
});

test('replacement inode is refused before reading and cancellation uses FILE_ABORTED', async t => {
  const { root, log } = await fixture(t);
  const path = await log('change');
  const catalog = createFileCatalog({ root });
  const { candidates: [candidate] } = await catalog.discover();
  await rename(path, path + '.old'); await writeFile(path, '{"type":"session","id":"replacement","version":4}\n');
  await assert.rejects(catalog.describe(candidate), code('FILE_CHANGED'));
  const signal = AbortSignal.abort();
  await assert.rejects(catalog.discover({ signal }), code('FILE_ABORTED'));
  await assert.rejects(catalog.describe(candidate, { signal }), code('FILE_ABORTED'));
});

test('append while streaming is rejected by post-read signature check', async t => {
  const { root, log } = await fixture(t);
  const path = await log('racing', { cwd: 'x'.repeat(120 * 1024), delegationDepth: 0 });
  const catalog = createFileCatalog({ root });
  const { candidates: [candidate] } = await catalog.discover();
  const writer = await open(path, 'a');
  // Keep appending during the multi-chunk header read; signature validation must
  // never publish a snapshot assembled across this changing file.
  let busy = false;
  const timer = setInterval(async () => { if (!busy) { busy = true; try { await writer.write('x'); } finally { busy = false; } } }, 1);
  try { await assert.rejects(catalog.describe(candidate), code('FILE_CHANGED')); }
  finally { clearInterval(timer); await writer.close(); }
});

test('factory rejects relative roots and invalid options', () => {
  assert.throws(() => createFileCatalog({ root: '.' }), code('FILE_ROOT'));
  assert.throws(() => createFileCatalog({ root: '/tmp', maxEntries: 0 }), code('FILE_OPTIONS'));
  assert.throws(() => createFileCatalog({ root: '/tmp', headerCacheSize: -1 }), code('FILE_OPTIONS'));
});

test('installed public persistence SDK authors a real zstd session header accepted by catalog', async t => {
  const { createRequire } = await import('node:module');
  const require = createRequire('/home/alex/.local/share/dsh-cli/package.json');
  const load = id => import(require.resolve(`@deepseek-ai/${id}`));
  const [{ Context }, session, persistence] = await Promise.all([load('cordis'), load('dsh-session'), load('dsh-session-persistence-jsonl')]);
  const { root } = await fixture(t);
  const ctx = new Context();
  try {
    await ctx.plugin(session.default);
    await ctx.plugin(persistence.default, { root, compression: 'zstd' });
    const header = { id: session.SessionId('catalog-native'), version: session.SESSION_FORMAT_VERSION, createdAt: 100, cwd: '/fixture/project', isSeeded: false };
    const writer = await ctx.sessionPersistence.create(header);
    await writer.flush(); await writer.close();
    const catalog = createFileCatalog({ root });
    const { candidates } = await catalog.discover();
    assert.equal(candidates.length, 1); assert.equal(candidates[0].encoding, 'zstd');
    const described = await catalog.describe(candidates[0]);
    assert.equal(described.header.type, 'session');
    assert.equal(described.header.id, header.id);
    assert.equal(described.header.version, header.version);
    assert.equal(described.classification, 'main');
  } finally { await ctx.fiber.dispose(); }
});
