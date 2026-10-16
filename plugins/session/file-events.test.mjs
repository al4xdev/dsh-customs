import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, stat, symlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { createFileEventReader, presentEvent, searchEvents, redactFileValue } from './file-events.mjs';

const event = (seq, type, data) => ({ seq, type, time: seq + 100, data });
const user = (seq, text) => event(seq, 'user/message', { content: [{ type: 'text', text }] });
async function fixture(t, events = [], { encoding = 'jsonl', version = 4, suffix = '', bytes } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-events-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, '--test--', 'session-id'); await mkdir(dir, { recursive: true });
  const path = join(dir, `session.v${version}.jsonl${encoding === 'zstd' ? '.zstd' : ''}`);
  const header = { type: 'session', id: 'session-id', cwd: '/test', version, createdAt: 1, isSeeded: false, delegationDepth: 0 };
  const source = [header, ...events].map(row => JSON.stringify(row) + '\n').join('') + suffix;
  await writeFile(path, bytes ?? (encoding === 'zstd' ? zstdCompressSync(Buffer.from(source)) : source));
  async function candidate() { const s = await stat(path, { bigint: true }); return { path, encoding, version, size: Number(s.size), signature: Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs'].map(key => [key, String(s[key])])) }; }
  return { root, path, dir, header, source, candidate, reader: createFileEventReader({ root }) };
}

test('physical v3/v4 JSONL and concatenated zstd frames return only public data', async t => {
  for (const version of [3, 4]) for (const encoding of ['jsonl', 'zstd']) {
    const f = await fixture(t, [user(0, 'first'), event(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'answer' }, { type: 'reasoning', text: 'NEVER' }] }, stream: ['NEVER'] }), event(2, 'assistant/message', { content: [{ type: 'text', text: 'alternate' }] }), event(3, 'unknown/private', { text: 'NEVER', token: 'NEVER' })], { version, encoding });
    if (encoding === 'zstd') await writeFile(f.path, Buffer.concat(f.source.trimEnd().split('\n').map(row => zstdCompressSync(Buffer.from(row + '\n')))));
    const loaded = await f.reader.load(await f.candidate());
    assert.equal(loaded.events.length, 4); assert.equal(loaded.partial, false);
    assert.equal(presentEvent(loaded.events[1]).text, 'answer');
    assert.equal(presentEvent(loaded.events[2]).text, 'alternate');
    assert.equal(loaded.events[3].data, undefined);
    assert.ok(!JSON.stringify(loaded).includes('NEVER'));
    assert.equal(Object.isFrozen(loaded.events), true);
  }
});

test('huge arguments and serialized event JSON remain fully pageable', async t => {
  const payload = 'α'.repeat(120_000) + 'END';
  const f = await fixture(t, [event(0, 'tool/call', { name: 'write', callId: 'c1', arguments: JSON.stringify({ content: payload }) })]);
  const loaded = await f.reader.load(await f.candidate());
  for (const section of ['arguments', 'event']) {
    let offset = 0, full = '';
    do { const row = presentEvent(loaded.events[0], { section, format: 'json', textOffset: offset, textLimit: 9000, maxBytes: 4096 }); full += row.text; offset = row.nextTextOffset; assert.ok(Buffer.byteLength(JSON.stringify(row)) <= 4096); } while (offset !== null);
    const value = JSON.parse(full);
    assert.equal(JSON.parse(section === 'event' ? value.data.arguments : value).content, payload);
  }
});

test('recursive and quoted JSON credentials redact before excerpt boundaries', () => {
  const raw = { password: 'P SECRET', apiKey: 'API SECRET', nested: { authorization: 'AUTH SECRET', client_secret: 'CLIENT SECRET', privateKey: 'KEY SECRET', cookies: 'not-a-sensitive-key' }, arguments: JSON.stringify({ token: 'TOKEN SECRET', nested: JSON.stringify({ password: 'DEEP SECRET' }) }) };
  const serialized = JSON.stringify(redactFileValue(raw));
  for (const secret of ['P SECRET', 'API SECRET', 'AUTH SECRET', 'CLIENT SECRET', 'KEY SECRET', 'TOKEN SECRET', 'DEEP SECRET']) assert.ok(!serialized.includes(secret));
  const text = 'prefix "password": "a long secret with spaces" suffix sk-abcdefghijklmnop Bearer abcdefghijkl';
  const row = user(0, text);
  let joined = '';
  for (let offset = 0; ; ) { const page = presentEvent(row, { textOffset: offset, textLimit: 3 }); joined += page.text; if (page.nextTextOffset === null) break; offset = page.nextTextOffset; }
  assert.ok(!joined.includes('a long secret')); assert.ok(!joined.includes('abcdefghijkl'));
  assert.ok(joined.includes('[redacted]'));
  const wrapped = JSON.stringify(JSON.stringify({ password: 'WRAPPED SECRET', nested: { apiKey: 'WRAPPED KEY' } }));
  assert.ok(!redactFileValue(wrapped).includes('WRAPPED'));
});

test('tools preserve real argument/result/error shapes and summaries', async t => {
  const f = await fixture(t, [event(0, 'tool/call', { name: 'bash', callId: 'call', arguments: '{"command":"echo okay","token":"NEVER"}' }), event(1, 'tool/result', { message: { toolCallId: 'call', isError: true, content: [{ type: 'text', text: 'result body' }, { type: 'image', data: 'NEVER' }] }, error: { code: 'FAILED', reason: 'failure', password: 'NEVER' }, meta: { raw: 'NEVER' } }), event(2, 'turn/end', { reason: { kind: 'error', error: { code: 'FAIL', token: 'NEVER' } } })]);
  const loaded = await f.reader.load(await f.candidate());
  const call = presentEvent(loaded.events[0]); assert.equal(call.toolName, 'bash'); assert.equal(call.callId, 'call'); assert.match(call.text, /command/);
  const result = presentEvent(loaded.events[1], { section: 'result' }); assert.equal(result.isError, true); assert.match(result.text, /result body/); assert.match(result.text, /FAILED/);
  assert.equal(result.toolName, 'bash'); assert.equal(result.callId, 'call');
  assert.ok(!JSON.stringify(loaded).includes('NEVER'));
});

test('latest title includes user rename and last message previews', async t => {
  const f = await fixture(t, [event(0, 'session/title', { title: 'generated', source: 'model' }), user(1, 'question'), event(2, 'session/title', { title: 'renamed', source: { kind: 'user' } }), event(3, 'assistant/message', { message: { content: 'answer' } })]);
  const summary = await f.reader.summarize(await f.candidate());
  assert.deepEqual(summary.title, { title: 'renamed', source: 'user', seq: 2 }); assert.equal(summary.lastUser.text, 'question'); assert.equal(summary.lastAssistant.text, 'answer'); assert.equal(summary.titleComplete, true);
});

test('active incomplete JSONL and zstd tails are explicitly partial', async t => {
  const f = await fixture(t, [user(0, 'complete')], { suffix: '{"seq":1' });
  const snapshot = await f.reader.load(await f.candidate()); assert.equal(snapshot.partial, true); assert.equal(snapshot.events.length, 1); assert.equal(snapshot.titleComplete, false); assert.equal(snapshot.tailComplete, false);
  const z = await fixture(t, [], { encoding: 'zstd' });
  const header = zstdCompressSync(Buffer.from(JSON.stringify(z.header) + '\n'));
  const tail = zstdCompressSync(Buffer.from(JSON.stringify(user(0, 'long content'.repeat(100))) + '\n'));
  await writeFile(z.path, Buffer.concat([header, tail.subarray(0, tail.length - 3)]));
  const partial = await z.reader.load(await z.candidate()); assert.equal(partial.partial, true); assert.ok(partial.warnings.includes('incomplete zstd tail'));
});

test('corrupt complete lines, zstd frames, unsupported headers and unordered seq fail', async t => {
  for (const suffix of ['not-json\n', '{"seq":0,"type":"user/message","time":1}\n']) {
    const f = await fixture(t, [user(0, 'okay')], { suffix }); await assert.rejects(f.reader.load(await f.candidate()), /corrupt|unordered/);
  }
  const z = await fixture(t, [], { encoding: 'zstd', bytes: Buffer.from('not zstd') }); await assert.rejects(z.reader.load(await z.candidate()));
  const h = await fixture(t); await writeFile(h.path, JSON.stringify({ ...h.header, version: 99 }) + '\n'); await assert.rejects(h.reader.load(await h.candidate()), /header/);
});

test('decode and line bounds preserve prefix but flag incomplete latest/title/tail', async t => {
  const f = await fixture(t, [user(0, 'okay'), user(1, 'x'.repeat(10000)), event(2, 'session/title', { title: 'unseen' })]);
  for (const options of [{ maxDecodedBytes: 1000 }, { maxLineBytes: 500 }]) {
    const reader = createFileEventReader({ root: f.root, ...options }); const loaded = await reader.load(await f.candidate());
    assert.equal(loaded.events.length, 1); assert.equal(loaded.partial, true); assert.equal(loaded.title, null); assert.equal(loaded.tailComplete, false);
  }
});

test('cache is identity-bound, immutable, invalidated on append and inode replacement', async t => {
  const f = await fixture(t, [user(0, 'first')]); const c = await f.candidate();
  const first = await f.reader.load(c); assert.equal(await f.reader.load(c), first);
  await appendFile(f.path, JSON.stringify(user(1, 'second')) + '\n'); await assert.rejects(f.reader.load(c), /stale/);
  const second = await f.reader.load(await f.candidate()); assert.equal(second.events.length, 2); assert.notEqual(second, first);
  const c2 = await f.candidate(); const replacement = join(f.dir, 'replacement'); await writeFile(replacement, f.source); await rename(replacement, f.path);
  await assert.rejects(f.reader.load(c2), /stale/); assert.equal((await f.reader.load(await f.candidate())).events.length, 1);
  const uncached = createFileEventReader({ root: f.root, cacheBytes: 0 }); assert.notEqual(await uncached.load(await f.candidate()), await uncached.load(await f.candidate()));
});

test('reject symlink files, directories, roots, escaped paths and mismatched header layout', async t => {
  const f = await fixture(t, [user(0, 'okay')]); const c = await f.candidate();
  const original = join(f.root, 'original'); await rename(f.path, original); await symlink(original, f.path);
  await assert.rejects(f.reader.load(c), /symlink/);
  const alias = f.root + '-alias'; await symlink(f.root, alias); t.after(() => rm(alias));
  await assert.rejects(createFileEventReader({ root: alias }).load({ ...c, path: c.path.replace(f.root, alias) }), /symlink/);
  await assert.rejects(f.reader.load({ ...c, path: '/etc/passwd' }), /layout/);
  const g = await fixture(t); await writeFile(g.path, JSON.stringify({ ...g.header, id: 'wrong' }) + '\n'); await assert.rejects(g.reader.load(await g.candidate()), /identity/);
  const k = await fixture(t); const moved = join(k.root, 'moved'); await rename(k.dir, moved); await symlink(moved, k.dir); await assert.rejects(k.reader.load(await k.candidate()), /symlink/);
});

test('literal search, case flags, scopes and match offsets are not a 50-item sample', async t => {
  const f = await fixture(t, [...Array.from({ length: 60 }, (_, n) => user(n, n === 59 ? 'Last NEEDLE [a-z] a.*' : 'needle')), event(60, 'tool/call', { name: 'needle', arguments: '{}' }), event(61, 'unknown/internal', { text: 'needle hidden' })]);
  const snapshot = await f.reader.load(await f.candidate());
  assert.equal(searchEvents(snapshot, { query: 'needle', scope: 'messages' }).total, 60);
  const page = searchEvents(snapshot, { query: 'needle', offset: 50, limit: 5 }); assert.equal(page.matches[0].seq, 50); assert.equal(page.nextOffset, 55); assert.equal(page.nextSeq, 55);
  assert.equal(searchEvents(snapshot, { query: 'NEEDLE', caseSensitive: true }).total, 1);
  assert.equal(searchEvents(snapshot, { query: '[a-z]' }).matches[0].seq, 59);
  assert.equal(searchEvents(snapshot, { query: 'a.*' }).total, 1);
  assert.equal(searchEvents(snapshot, { query: 'needle', scope: 'tools' }).total, 1);
  assert.equal(searchEvents(snapshot, { query: 'hidden' }).total, 0);
  const tail = await f.reader.read(await f.candidate(), { view: 'tail', limit: 2, before: 61 }); assert.deepEqual(tail.events.map(row => row.seq), [60, 59]); assert.equal(tail.nextSeq, 58);
});

test('nested SDK event namespaces preserve seq lookup without revealing internal payloads', async t => {
  const f = await fixture(t, [user(0, 'before'), event(1, 'agent/inbox/spliced', { text: 'PRIVATE INBOX', messages: [{ token: 'PRIVATE TOKEN' }] }), event(2, 'agent/child/lifecycle/ended', { payload: 'PRIVATE CHILD' }), user(3, 'after')], { encoding: 'zstd' });
  const snapshot = await f.reader.load(await f.candidate());
  assert.deepEqual(snapshot.events.map(row => row.seq), [0, 1, 2, 3]);
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.events[1].type, 'agent/inbox/spliced');
  assert.equal(snapshot.events[1].data, undefined);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE'));
  assert.equal(searchEvents(snapshot, { query: 'PRIVATE' }).total, 0);
});

test('aborted reads and searches fail without cache bypass', async t => {
  const f = await fixture(t, [user(0, 'okay')]); const c = await f.candidate(); const snapshot = await f.reader.load(c);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.reader.load(c, { signal: controller.signal }), { name: 'AbortError' });
  assert.throws(() => searchEvents(snapshot, { query: 'okay', signal: controller.signal }), { name: 'AbortError' });
});
