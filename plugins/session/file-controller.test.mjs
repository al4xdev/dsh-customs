import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { createFileController } from './file-controller.mjs';
import { parseFileRequest } from './file-contracts.mjs';

const event = (seq, type, data) => ({ seq, time: 1000 + seq, type, data });
const user = (seq, text) => event(seq, 'user/message', { content: [{ type: 'text', text }] });
const ids = result => result.sessions.map(row => row.header.id);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-controller-'));
  const controller = createFileController({ root });
  t.after(async () => { controller.clear(); await rm(root, { recursive: true, force: true }); });
  async function log(id, events = [], { version = 4, encoding = 'jsonl', mtime = 100, ...metadata } = {}) {
    assert.match(id, /^[a-zA-Z0-9_-]+$/, 'fixture IDs use the canonical unescaped layout');
    const path = join(root, '--test--', id, `session.v${version}.jsonl${encoding === 'zstd' ? '.zstd' : ''}`);
    await mkdir(dirname(path), { recursive: true });
    const header = { type: 'session', id, version, cwd: '/test', createdAt: 1, isSeeded: false, delegationDepth: 0, ...metadata };
    const content = [header, ...events].map(row => JSON.stringify(row) + '\n').join('');
    await writeFile(path, encoding === 'zstd' ? zstdCompressSync(Buffer.from(content)) : content);
    await utimes(path, mtime, mtime);
    return path;
  }
  return { root, log, api: controller, execute: (args, exec) => controller.execute(args, exec) };
}

test('empty setup-only sessions do not occupy conversation slots', async t => {
  const f=await fixture(t);
  await f.log('empty', [event(0,'permission/preset',{preset:'read-only'})], {mtime:100});
  await f.log('conversation', [user(0,'actual conversation')], {mtime:90});
  const result=await f.execute({operation:'list',limit:1});
  assert.deepEqual(ids(result),['conversation']); assert.equal(result.skipped.empty,1);
});

test('read bounds oversized title metadata and redacts plural cookies', async t => {
  const f=await fixture(t);
  await f.log('large-title',[event(0,'session/title',{title:'x'.repeat(50000),source:{kind:'user'}}),event(1,'tool/call',{name:'http',arguments:{cookies:'private-cookie-value',access_token:'private-token-value',ok:'visible'}})]);
  const result=await f.execute({operation:'read',sessionId:'large-title',seq:1,format:'json',section:'event',maxBytes:4096});
  assert.equal(result.title.length,512); assert.ok(Buffer.byteLength(JSON.stringify(result))<=4096);
  assert.ok(!JSON.stringify(result).includes('private-cookie-value')); assert.ok(!JSON.stringify(result).includes('private-token-value')); assert.match(result.events[0].text,/visible/);
});

test('failed search files consume budget and current-file pagination pins its snapshot', async t => {
  const f=await fixture(t);
  const broken=await f.log('broken',[],{mtime:300}); await appendFile(broken,'not JSON\n');
  const good=await f.log('good',[user(0,'needle one'),user(1,'needle two')],{mtime:200});
  const first=await f.execute({operation:'find',query:'needle',candidateBudget:1,limit:1});
  assert.equal(first.filesRead,1);assert.equal(first.hits.length,0);assert.ok(first.nextCursor);
  const second=await f.execute({operation:'find',query:'needle',candidateBudget:1,limit:1,cursor:first.nextCursor});
  assert.equal(second.hits[0].seq,0);assert.ok(second.nextCursor);
  await appendFile(good,JSON.stringify(user(2,'needle added later'))+'\n');
  const third=await f.execute({operation:'find',query:'needle',candidateBudget:1,limit:1,cursor:second.nextCursor});
  assert.equal(third.hits[0].seq,1);assert.equal(third.nextCursor,null);
});

test('list defaults to ten main sessions after fifty newer subagents; seeded parent and user rename survive', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 50; i++) await f.log(`sub-${i}`, [user(0, 'excluded')], { origin: 'subagent', delegationDepth: 1, mtime: 300 + i });
  await f.log('companion', [user(0, 'excluded')], { agentPreset: 'companion', mtime: 500 });
  await f.log('legacy', [], { delegationDepth: undefined, mtime: 499 });
  for (let i = 0; i < 11; i++) await f.log(`main-${i}`, [user(0, `question ${i}`)], { mtime: 100 + i });
  await f.log('main-11', [event(0, 'session/title', { title: 'old generation' })], { version: 3, mtime: 999 });
  await f.log('main-11', [event(0, 'session/title', { title: 'generated', source: 'model' }), user(1, 'continued question'), event(2, 'session/title', { title: 'User renamed title', source: { kind: 'user' } }), event(3, 'assistant/message', { message: { content: [{ type: 'text', text: 'continued answer' }] } })], { encoding: 'zstd', mtime: 111, isSeeded: true, parentSession: 'main-10' });
  const page = await f.execute({ operation: 'list' });
  assert.equal(page.sessions.length, 10);
  assert.deepEqual(ids(page), Array.from({ length: 10 }, (_, n) => `main-${11 - n}`));
  assert.equal(page.skipped.subagent, 50); assert.equal(page.skipped.companion, 1); assert.equal(page.skipped.unknown, 1);
  const first = page.sessions[0];
  assert.equal(first.title, 'User renamed title'); assert.equal(first.titleSource, 'user');
  assert.equal(first.header.isSeeded, true); assert.equal(first.header.parentSession, 'main-10');
  assert.equal(first.preview.user, 'continued question'); assert.equal(first.preview.assistant, 'continued answer');
  assert.ok(page.nextCursor); assert.equal(page.totalCandidates, 64);
  const next = await f.execute({ operation: 'list', cursor: page.nextCursor });
  assert.deepEqual(ids(next), ['main-1', 'main-0']); assert.equal(next.nextCursor, null);
  assert.equal(JSON.stringify(page).includes(f.root), false, 'physical paths are not model-facing');
});

test('list cursor fixes membership and order while another file appends and a new session arrives', async t => {
  const f = await fixture(t);
  const old = await f.log('a', [user(0, 'old a')], { mtime: 10 });
  await f.log('b', [user(0, 'b')], { mtime: 20 }); await f.log('c', [user(0, 'c')], { mtime: 30 });
  const first = await f.execute({ operation: 'list', limit: 1 });
  assert.deepEqual(ids(first), ['c']);
  await appendFile(old, JSON.stringify(user(1, 'appended a')) + '\n');
  await f.log('new', [user(0, 'new')], { mtime: 1000 });
  const second = await f.execute({ operation: 'list', limit: 1, cursor: first.nextCursor });
  const third = await f.execute({ operation: 'list', limit: 1, cursor: second.nextCursor });
  assert.deepEqual(ids(second), ['b']); assert.deepEqual(ids(third), ['a']);
  assert.equal(third.sessions[0].preview.user, 'appended a'); assert.equal(third.nextCursor, null);
  assert.equal(first.selectionAt, third.selectionAt);
  await assert.rejects(f.execute({ operation: 'list', limit: 1, project: '/test', cursor: first.nextCursor }), { code: 'cursor_invalid' });
});

test('exact companion read, inspect, context and find are denied', async t => {
  const f = await fixture(t);
  await f.log('companion', [user(0, 'private companion message')], { agentPreset: 'companion' });
  for (const operation of ['read', 'inspect', 'context', 'find']) {
    await assert.rejects(f.execute({ operation, sessionId: 'companion', ...(operation === 'find' ? { query: 'private' } : {}) }), { code: 'session_excluded' });
  }
});

test('find selects main files after filtering, defaults to 100, and uses literal scoped cursor-bound search', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 50; i++) await f.log(`sub-${i}`, [user(0, 'literal a.*')], { origin: 'subagent', delegationDepth: 1, mtime: 200 + i });
  await f.log('companion', [user(0, 'literal a.*')], { agentPreset: 'companion', mtime: 300 });
  for (let i = 0; i < 3; i++) await f.log(`main-${i}`, [user(0, 'literal a.*'), user(1, 'literal aZZ'), event(2, 'tool/call', { name: 'bash', callId: `c${i}`, arguments: '{"command":"literal a.*"}' }), event(3, 'request/header', { text: 'hidden private needle' })], { mtime: 10 + i });
  assert.equal(parseFileRequest({ operation: 'find', query: 'x' }).maxFiles, 100);
  const args = { operation: 'find', query: 'a.*', scope: 'messages', maxFiles: 2, limit: 1 };
  const first = await f.execute(args);
  assert.equal(first.selectedFiles, 2); assert.equal(first.skipped.subagent, 50); assert.equal(first.skipped.companion, 1);
  assert.deepEqual(first.hits.map(hit => [hit.sessionId, hit.seq]), [['main-2', 0]]);
  const second = await f.execute({ ...args, cursor: first.nextCursor });
  assert.deepEqual(second.hits.map(hit => [hit.sessionId, hit.seq]), [['main-1', 0]]); assert.equal(second.nextCursor, null);
  await assert.rejects(f.execute({ ...args, query: 'aZZ', cursor: first.nextCursor }), { code: 'cursor_invalid' });
  await assert.rejects(f.execute({ ...args, scope: 'tools', cursor: first.nextCursor }), { code: 'cursor_invalid' });
  await assert.rejects(f.execute({ ...args, maxFiles: 3, cursor: first.nextCursor }), { code: 'cursor_invalid' });
  const tools = await f.execute({ ...args, scope: 'tools', limit: 10 });
  assert.deepEqual(tools.hits.map(hit => hit.seq), [2, 2]);
  const hidden = await f.execute({ operation: 'find', query: 'hidden private needle' });
  assert.equal(hidden.hits.length, 0); assert.equal(hidden.maxFiles, 100); assert.equal(hidden.selectedFiles, 3);
  const alias = await f.execute({ operation: 'search', query: 'a.*', mode: 'literal', scope: 'messages', maxFiles: 2 });
  assert.equal(alias.hits.length, 2);
});

test('JSON tool arguments/results are deep-pageable and never disclose secrets, reasoning or attachments', async t => {
  const f = await fixture(t);
  const payload = 'long argument α'.repeat(300) + 'ARG_END';
  await f.log('tools', [event(0, 'tool/call', { name: 'write', callId: 'call', arguments: JSON.stringify({ content: payload, apiKey: 'DO_NOT_EXPOSE_API' }) }), event(1, 'tool/result', { message: { toolCallId: 'call', isError: true, content: [{ type: 'text', text: 'long result '.repeat(300) + 'RESULT_END' }, { type: 'image', data: 'DO_NOT_EXPOSE_IMAGE' }] }, error: { code: 'FAILED', password: 'DO_NOT_EXPOSE_PASSWORD' } }), event(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'safe answer' }, { type: 'reasoning', text: 'DO_NOT_EXPOSE_REASONING' }] } })]);
  async function collect(seq, section) {
    let textOffset = 0, text = '', pages = 0;
    do {
      const page = await f.execute({ operation: 'inspect', sessionId: 'tools', seq, section, format: 'json', textOffset, textLimit: 300, maxBytes: 2048 });
      assert.equal(page.events.length, 1); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2048);
      assert.ok(!JSON.stringify(page).includes('DO_NOT_EXPOSE'));
      text += page.events[0].text; textOffset = page.events[0].nextTextOffset;
      assert.ok(++pages < 100, 'text pagination advances');
    } while (textOffset !== null);
    assert.ok(pages > 1);
    return text;
  }
  const args = await collect(0, 'arguments');
  assert.equal(JSON.parse(JSON.parse(args)).content, payload);
  assert.ok(args.includes('[redacted]'));
  const result = await collect(1, 'result');
  assert.ok(result.includes('RESULT_END')); assert.ok(result.includes('FAILED'));
  const whole = await f.execute({ operation: 'read', sessionId: 'tools', view: 'head', format: 'json', section: 'event', textLimit: 16384, maxBytes: 32768 });
  assert.ok(!JSON.stringify(whole).includes('DO_NOT_EXPOSE'));
  const assistant = whole.events.find(row => row.seq === 2);
  assert.ok(assistant.text.includes('safe answer'));
});

test('tail previousCursor, logical seq offsets, before/after and context both preserve navigation', async t => {
  const f = await fixture(t);
  await f.log('history', Array.from({ length: 8 }, (_, n) => user(n * 2, `message ${n}`)));
  const tailArgs = { operation: 'read', sessionId: 'history', view: 'tail', limit: 2 };
  const tail = await f.execute(tailArgs);
  assert.deepEqual(tail.events.map(row => row.seq), [12, 14]); assert.equal(tail.nextCursor, null); assert.ok(tail.previousCursor);
  const previous = await f.execute({ ...tailArgs, cursor: tail.previousCursor });
  assert.deepEqual(previous.events.map(row => row.seq), [8, 10]);
  const back = await f.execute({ ...tailArgs, cursor: previous.nextCursor });
  assert.deepEqual(back.events.map(row => row.seq), [12, 14]);
  const offset = await f.execute({ operation: 'read', sessionId: 'history', offset: 5, limit: 2 });
  assert.deepEqual(offset.events.map(row => row.seq), [6, 8]); assert.equal(offset.nextSeq, 10);
  const neighborhood = await f.execute({ operation: 'inspect', sessionId: 'history', seq: 6, before: 2, after: 1 });
  assert.deepEqual(neighborhood.events.map(row => row.seq), [2, 4, 6, 8]);
  const both = await f.execute({ operation: 'context', sessionId: 'history', anchor: 'both', limit: 4 });
  assert.deepEqual(both.events.map(row => row.seq), [0, 2, 12, 14]);
  const unchanged = await f.execute({ operation: 'read', sessionId: 'history', revision: tail.revision });
  assert.equal(unchanged.unchanged, true); assert.deepEqual(unchanged.events, []);
});

test('byte-capped list and read pages stay under budget without dropping omitted rows', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) await f.log(`budget-${i}`, [event(0, 'session/title', { title: 'title '.repeat(60), source: 'user' }), user(1, 'preview '.repeat(100))], { mtime: 100 + i });
  const seen = []; let cursor;
  do {
    const page = await f.execute({ operation: 'list', limit: 5, maxBytes: 2048, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2048);
    assert.ok(page.sessions.length > 0); seen.push(...ids(page)); cursor = page.nextCursor;
    assert.ok(seen.length <= 5);
  } while (cursor);
  assert.deepEqual(seen, ['budget-4', 'budget-3', 'budget-2', 'budget-1', 'budget-0']);
  const read = await f.execute({ operation: 'read', sessionId: 'budget-0', seq: 1, format: 'json', section: 'event', textLimit: 16384, maxBytes: 2048 });
  assert.ok(Buffer.byteLength(JSON.stringify(read)) <= 2048); assert.ok(read.events[0].nextTextOffset > 0);
});

test('installed SDK-produced native zstd layout is readable through file controller', async t => {
  const { createRequire } = await import('node:module');
  const require = createRequire('/home/alex/.local/share/dsh-cli/package.json');
  const load = id => import(require.resolve(`@deepseek-ai/${id}`));
  const [{ Context }, session, persistence] = await Promise.all([load('cordis'), load('dsh-session'), load('dsh-session-persistence-jsonl')]);
  const f = await fixture(t), ctx = new Context();
  try {
    await ctx.plugin(session.default); await ctx.plugin(persistence.default, { root: f.root, compression: 'zstd' });
    const writer = await ctx.sessionPersistence.create({ id: session.SessionId('native-main'), version: session.SESSION_FORMAT_VERSION, createdAt: 1, cwd: '/test', isSeeded: false });
    await writer.append([user(0, 'native SDK question')]); await writer.flush(); await writer.close();
    const list = await f.execute({ operation: 'list' });
    assert.deepEqual(ids(list), ['native-main']); assert.equal(list.sessions[0].preview.user, 'native SDK question');
    const read = await f.execute({ operation: 'read', sessionId: 'native-main' });
    assert.equal(read.events[0].text, 'native SDK question');
  } finally { await ctx.fiber.dispose(); }
});
