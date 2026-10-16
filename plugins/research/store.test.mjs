import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openStore } from './store.mjs';

const exec = promisify(execFile);
async function fixture(t, ignored = true) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'research-store-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await exec('git', ['init', '--quiet'], { cwd });
  if (ignored) await fs.writeFile(path.join(cwd, '.gitignore'), '.dumps/\n');
  return cwd;
}

test('requires Git ignore without changing project files', async t => {
  const cwd = await fixture(t, false);
  await assert.rejects(openStore(cwd, 'session'), /git check-ignore/);
  await assert.rejects(fs.stat(path.join(cwd, '.dumps')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(cwd, '.gitignore')), { code: 'ENOENT' });
});

test('config snapshots, manifest identity and session isolation', async t => {
  const cwd = await fixture(t);
  const store = await openStore(cwd, 'alice');
  const config = { sources: ['web'], budget: 4 };
  const id = await store.saveConfig(config);
  config.budget = 99;
  assert.equal((await store.loadConfig(id)).budget, 4);
  const manifest = await store.createRun('Olá ../ Research!', { budget: 4 });
  assert.match(manifest.id, /^r-1-ola-research-[0-9a-f]{12}$/);
  assert.equal(manifest.path, `.dumps/research/runs/${manifest.id}`);
  assert.deepEqual(await store.readRun(manifest.id), manifest);
  for (const [key, value] of Object.entries({ id: 'other', owner: 'bob', config: {}, path: '../', created_at: 'now' })) {
    await assert.rejects(store.writeRun(manifest.id, { ...manifest, [key]: value }), /Immutable/);
  }
  const updated = await store.writeRun(manifest.id, { ...manifest, status: 'done' });
  assert.equal(updated.status, 'done');
  assert.match(await fs.readFile(path.join(cwd, manifest.path, 'index.md'), 'utf8'), /Run: r-1-/);
  const other = await openStore(cwd, 'bob');
  await assert.rejects(other.loadConfig(id), /owner/);
  await assert.rejects(other.readRun(manifest.id), /owner/);
  await assert.rejects(other.saveEvidence(manifest.id, { content: 'no' }), /owner/);
  await assert.rejects(other.event(manifest.id, {}), /owner/);
});

test('concurrent stores allocate unique monotonic reservations without locks', async t => {
  const cwd = await fixture(t);
  const stores = await Promise.all(Array.from({ length: 4 }, () => openStore(cwd, 'alice')));
  const manifests = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 4].createRun('Parallel', {})));
  const counters = manifests.map(item => Number(item.id.split('-')[1])).sort((a, b) => a - b);
  assert.deepEqual(counters, Array.from({ length: 20 }, (_, i) => i + 1));
  // A crashed creator may leave a reservation, but never a stale blocking lock.
  await fs.mkdir(path.join(cwd, '.dumps/research/allocations/21'));
  assert.match((await stores[0].createRun('after crash', {})).id, /^r-22-/);
});

test('evidence is recoverable independently, bounded, searchable and private', async t => {
  const cwd = await fixture(t);
  const store = await openStore(cwd, 'alice');
  const run = await store.createRun('evidence', {});
  const saved = await store.saveEvidence(run.id, { url: 'https://example.test', title: 'Evidence', source: 'web', kind: 'page', content: 'Hello Needle!'.padEnd(100010, 'x'), comments: Array.from({ length: 205 }, (_, i) => ({ text: `comment ${i}` })) });
  assert.deepEqual(saved.metadata.truncation, { content: true, comments: true });
  assert.equal(saved.metadata.comments, undefined);
  assert.equal(saved.metadata.stored_comments_count, 200);
  const commentsPage = await store.inspect(run.id, { ref: saved.ref, section: 'comments' });
  assert.equal(JSON.parse(commentsPage.content).length, 200);
  assert.equal(commentsPage.truncated, true);
  assert.deepEqual((await store.readRun(run.id)).evidence, []);
  const inspected = await store.inspect(run.id, { ref: saved.ref, query: 'needle', limit: 6 });
  assert.equal(inspected.content, 'Needle');
  assert.equal(inspected.offset, 6);
  assert.equal(inspected.total, 100000);
  assert.equal(inspected.truncated, true);
  assert.equal((await store.inspect(run.id, { ref: saved.ref, query: 'missing' })).matched, false);
  assert.equal((await store.inspect(run.id)).items[0].ref, saved.ref);
  assert.equal((await store.inspect(run.id, { query: 'missing' })).total, 0);
  assert.equal((await store.inspect(run.id, { ref: saved.ref })).content.length, 6000);
  await store.event(run.id, { status: 'done' });
  assert.equal((await fs.readdir(path.join(cwd, run.path, 'events'))).length, 1);
  assert.equal((await fs.stat(path.join(cwd, run.path))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(cwd, run.path, 'evidence', `${saved.ref}.json`))).mode & 0o777, 0o600);
});

test('strict ids, refs, options and payload validation', async t => {
  const cwd = await fixture(t);
  const store = await openStore(cwd, 'alice');
  const run = await store.createRun('validation', {});
  for (const id of ['../x', '/tmp/x', 'r-1-a-123456789abc/../x', '', 'c-nope']) {
    await assert.rejects(store.readRun(id), /Invalid/);
    await assert.rejects(store.loadConfig(id), /Invalid/);
    await assert.rejects(store.inspect(run.id, { ref: id }), /Invalid/);
  }
  for (const options of [{ offset: -1 }, { limit: Infinity }, { limit: 100001 }, { offset: 0.5 }, { query: {} }, { section: 'unknown' }, { section: 'comments' }]) {
    await assert.rejects(store.inspect(run.id, options), /Invalid/);
  }
  await assert.rejects(store.saveEvidence(run.id, { content: 12 }), /string/);
  await assert.rejects(store.saveEvidence(run.id, { content: 'ok', comments: {} }), /array/);
  await assert.rejects(store.saveConfig({ tooBig: 'x'.repeat(2_000_001) }), /limit/);
});

test('rejects existing storage and config symlinks', async t => {
  const cwd = await fixture(t);
  await fs.mkdir(path.join(cwd, 'outside'));
  await fs.symlink(path.join(cwd, 'outside'), path.join(cwd, '.dumps'));
  await assert.rejects(openStore(cwd, 'alice'), /Unsafe/);
  await fs.unlink(path.join(cwd, '.dumps'));
  const store = await openStore(cwd, 'alice');
  const id = await store.saveConfig({ secret: 'local' });
  const configFile = path.join(cwd, '.dumps/research/configs', `${id}.json`);
  await fs.rename(configFile, path.join(cwd, 'outside/config.json'));
  await fs.symlink(path.join(cwd, 'outside/config.json'), configFile);
  await assert.rejects(store.loadConfig(id), /Unsafe/);
});

test('rejects replaced directories and symlink manifest writes after opening', async t => {
  const cwd = await fixture(t);
  const store = await openStore(cwd, 'alice');
  const run = await store.createRun('safe', {});
  const manifestPath = path.join(cwd, run.path, 'manifest.json');
  await fs.rename(manifestPath, path.join(cwd, 'original.json'));
  await fs.symlink(path.join(cwd, 'original.json'), manifestPath);
  await assert.rejects(store.writeRun(run.id, run), /Unsafe/);
  await fs.rename(path.join(cwd, '.dumps/research'), path.join(cwd, 'moved'));
  await fs.symlink(path.join(cwd, 'moved'), path.join(cwd, '.dumps/research'));
  await assert.rejects(store.saveConfig({}), /Unsafe/);
  await assert.rejects(store.readRun(run.id), /Unsafe/);
  await assert.rejects(store.createRun('escape', {}), /Unsafe/);
});

test('continuation lock fails BUSY and releases on success or callback failure', async t => {
  const cwd = await fixture(t);
  const store = await openStore(cwd, 'alice');
  const other = await openStore(cwd, 'alice');
  const run = await store.createRun('lock', {});
  await store.withRunLock(run.id, async () => {
    await assert.rejects(other.withRunLock(run.id, async () => {}), { code: 'BUSY' });
    await store.writeRun(run.id, { ...run, state: 'checkpoint' });
  });
  await assert.rejects(store.withRunLock(run.id, async () => { throw new Error('callback failed'); }), /callback failed/);
  assert.equal(await other.withRunLock(run.id, async () => 42), 42);
  await fs.mkdir(path.join(cwd, run.path, '.continue-lock'));
  await assert.rejects(store.withRunLock(run.id, async () => {}), { code: 'BUSY' });
});

test('inspect metadata and comments have strict output budgets and pagination', async t => {
  const cwd = await fixture(t);
  const store = await openStore(cwd, 'alice');
  const run = await store.createRun('compact', {});
  const evidence = {
    content: '\u0000😀'.repeat(25000),
    title: '😀'.repeat(3000), url: 'https://example.test/' + 'x'.repeat(8000),
    source: 'web', kind: 'page', snippet: 'do not expose'.repeat(10000),
    libraryId: '/org/library', provenance: 'https://mcp.context7.com/mcp', text_format: 'markdown',
    sourceUrls: Array.from({ length: 5 }, (_, i) => `https://docs.example.test/${i}/` + 'x'.repeat(1000)),
    comment_nodes_count: 9, comments_selected_count: 9, comments_available_count: 100,
    comments_count_scope: 'returned_algolia_snapshot',
    comments: [{ text: 'comment'.repeat(10000) }],
    limitations: Array(10).fill('\u0000'.repeat(1000)), errors: Array(10).fill({ message: 'bad'.repeat(2000) }),
  };
  const saved = await store.saveEvidence(run.id, evidence);
  assert.equal(saved.metadata.comments, undefined);
  assert.equal(saved.metadata.snippet, undefined);
  assert.equal(saved.metadata.truncation.metadata, true);
  const assertIdentity = metadata => {
    assert.equal(metadata.libraryId, evidence.libraryId);
    assert.equal(metadata.provenance, evidence.provenance);
    assert.equal(metadata.text_format, 'markdown');
    assert.equal(metadata.comment_nodes_count, 9);
    assert.equal(metadata.comments_selected_count, 9);
    assert.equal(metadata.comments_available_count, 100);
    assert.equal(metadata.comments_count_scope, 'returned_algolia_snapshot');
    assert.deepEqual(metadata.sourceUrls, evidence.sourceUrls.slice(0, 3).map(url => url.slice(0, 256)));
  };
  assertIdentity(saved.metadata);
  for (const section of ['content', 'comments']) {
    const page = await store.inspect(run.id, { ref: saved.ref, section, limit: 100000 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 16000);
    assert.equal(page.metadata.comments, undefined);
    assert.equal(page.metadata.snippet, undefined);
    assertIdentity(page.metadata);
    assert.equal(page.truncated, true);
    const next = await store.inspect(run.id, { ref: saved.ref, section, offset: page.content.length, limit: 50 });
    const original = section === 'comments' ? JSON.stringify(evidence.comments) : evidence.content;
    assert.equal(next.content, original.slice(page.content.length, page.content.length + 50));
  }
  await Promise.all(Array.from({ length: 24 }, (_, i) => store.saveEvidence(run.id, { ...evidence, title: `item ${i}` })));
  const first = await store.inspect(run.id);
  assert.ok(first.items.length > 0 && first.items.length <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 16000);
  assert.equal(first.total, 25);
  assert.equal(first.truncated, true);
  first.items.forEach(item => assertIdentity(item.metadata));
  const second = await store.inspect(run.id, { offset: first.items.length });
  assert.ok(second.items.length > 0);
  assert.ok(!first.items.some(item => second.items.some(next => next.ref === item.ref)));
  assert.ok(Buffer.byteLength(JSON.stringify(second)) <= 16000);
});
