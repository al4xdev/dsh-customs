import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHost } from '../common.mjs';
import { createCatalog } from './catalog.mjs';
import { MAX_SNAPSHOTS, companionMetadata, parseMetadata, parseListRequest, parseDetailRequest, parseListOutput, parseDetailOutput } from './contracts.mjs';
import { apply, CompanionCatalogService } from './index.mjs';
const [{ Context }, { default: Registry }, { default: Gateway }, sessionSdk, llm] = await Promise.all([
  import(resolveHost('@deepseek-ai/cordis')),
  import(resolveHost('@deepseek-ai/dsh-typert-registry')),
  import(resolveHost('@deepseek-ai/dsh-api-gateway')),
  import(resolveHost('@deepseek-ai/dsh-session')),
  import(resolveHost('@deepseek-ai/dsh-llm')),
]);
const owned = (id, createdAt = 1, extra = {}) => ({ header: { id, agentPreset: 'companion', createdAt, ...extra } });
function metadataSource(initial) {
  let snapshots = initial; const calls = [];
  const persistence = {
    list: async options => { calls.push(['list', options]); return snapshots; },
    stat: async (id, options) => { calls.push(['stat', id, options]); return snapshots.find(row => row?.header?.id === id); },
  };
  for (const method of ['open', 'create', 'flush', 'read', 'agents', 'llm', 'prompt', 'follow']) {
    Object.defineProperty(persistence, method, { get: () => assert.fail(`forbidden capability ${method}`) });
  }
  return { persistence, calls, set: value => { snapshots = value; } };
}
const code = expected => error => error.code === `companion/${expected}`;
async function host(t, profileName = 'companion', snapshots = [owned('chat')]) {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Registry); await ctx.plugin(Gateway);
  const source = metadataSource(snapshots);
  ctx.provide('sessionPersistence', source.persistence);
  if (profileName !== null) ctx.provide('profileContext', { name: profileName, dir: '/synthetic-companion' });
  await ctx.plugin(sessionSdk.default);
  return { ctx, source, invoke: (method, request, extra = {}) => ctx.typertGateway.invoke({ namespace: 'companion', method, args: { request, ...extra }, signal: new AbortController().signal }) };
}

test('headers alone grant membership and scalar metadata never exposes private fields', () => {
  const snapshot = owned('chat', 12, { cwd: '/private', title: 'not a public header title' });
  snapshot.metadata = { agentPreset: 'companion', credentials: 'fixture-only', title: 'not a trusted hint' };
  assert.deepEqual(companionMetadata(snapshot), { id: 'chat', createdAt: 12 });
  assert.deepEqual(companionMetadata(snapshot, { title: '\n Hello\tworld ', updatedAt: 25, cwd: '/private' }), { id: 'chat', createdAt: 12, title: 'Hello world', updatedAt: 25 });
  assert.equal(companionMetadata(owned('foreign', 1, { agentPreset: 'standard' }), { agentPreset: 'companion', title: 'companion' }), null);
  assert.deepEqual(companionMetadata(owned('odd', NaN), { title: {}, updatedAt: Infinity }), { id: 'odd' });
});
test('strict request contracts reject extras, invalid native ids, coercion and unbounded cursors', () => {
  assert.deepEqual(parseListRequest({}), { limit: 50 });
  for (const raw of [null, [], { root: '/wrong' }, { limit: '1' }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: undefined }, { cursor: 'a'.repeat(2049) }, { cursor: 'x' }]) assert.throws(() => parseListRequest(raw), code('invalid-request'));
  for (const raw of [{ id: '../private' }, { id: '' }, { id: 'x'.repeat(161) }, { id: 'chat', backend: 'jsonl' }, {}, null]) assert.throws(() => parseDetailRequest(raw), code('invalid-request'));
  assert.deepEqual(parseDetailRequest({ id: 'native_id-123' }), { id: 'native_id-123' });
});
test('explicit output validators reject leaks, duplicates, invalid optional values and oversized results', () => {
  for (const value of [{ id: 'chat', cwd: '/private' }, { id: 'chat', title: 1 }, { id: 'chat', createdAt: '12' }, { id: 'chat', updatedAt: -1 }, { id: 'chat', title: 'a\nb' }, { id: 'chat', title: 'a'.repeat(241) }]) assert.throws(() => parseMetadata(value), code('invalid-output'));
  assert.throws(() => parseListOutput({ profile: 'companion', chats: [{ id: 'a' }, { id: 'a' }], nextCursor: null }), code('invalid-output'));
  assert.throws(() => parseDetailOutput({ profile: 'standard', chat: { id: 'chat' } }), code('invalid-output'));
  assert.throws(() => parseListOutput({ profile: 'companion', chats: Array.from({ length: 100 }, (...[, i]) => ({ id: `id${i}`, title: '😀'.repeat(120) })), nextCursor: null }), code('invalid-output'));
});
test('catalog reads only current persistence metadata and handles unmaterialized native sessions', async () => {
  const source = metadataSource([owned('unmaterialized', 9), owned('foreign', 8, { agentPreset: 'standard' }), { header: { id: 'missing-preset' } }]);
  const catalog = createCatalog(source.persistence);
  assert.deepEqual(await catalog.listChats({}), { profile: 'companion', chats: [{ id: 'unmaterialized', createdAt: 9 }], nextCursor: null });
  assert.deepEqual(await catalog.detail({ id: 'unmaterialized' }), { profile: 'companion', chat: { id: 'unmaterialized', createdAt: 9 } });
  assert.deepEqual(source.calls.map(call => call[0]), ['list', 'stat']); assert.equal(source.calls[1][1], 'unmaterialized');
  await assert.rejects(catalog.detail({ id: 'foreign' }), code('foreign-session'));
  await assert.rejects(catalog.detail({ id: 'absent' }), code('foreign-session'));
});
test('detail rejects a mismatched stat header identity and metadata failures are sanitized', async () => {
  const wrong = createCatalog({ list: async () => [], stat: async () => owned('other') });
  await assert.rejects(wrong.detail({ id: 'requested' }), code('foreign-session'));
  const failed = createCatalog({ list: async () => { throw new Error('fixture private path'); }, stat: async () => { throw new Error('fixture credential'); } });
  for (const operation of [failed.listChats({}), failed.detail({ id: 'chat' })]) await assert.rejects(operation, error => error.code === 'companion/metadata-unavailable' && !error.message.includes('fixture'));
});
test('ordering is stable creation descending with deterministic id ties', async () => {
  const source = metadataSource([owned('b', 1), owned('z', 4), owned('a', 1), owned('bad-time', -1)]);
  assert.deepEqual((await createCatalog(source.persistence).listChats({})).chats.map(row => row.id), ['z', 'a', 'b', 'bad-time']);
});
test('signed pagination enumerates every chat with no duplicates or missing rows', async () => {
  const snapshots = Array.from({ length: 181 }, (...[, i]) => owned(`chat${i}`, i));
  const catalog = createCatalog(metadataSource(snapshots).persistence);
  const ids = []; let cursor; let pages = 0;
  do {
    const result = await catalog.listChats({ limit: 7, ...(cursor === undefined ? {} : { cursor }) });
    ids.push(...result.chats.map(row => row.id)); pages++; cursor = result.nextCursor;
  } while (cursor !== null);
  assert.equal(pages, 26); assert.equal(ids.length, 181); assert.equal(new Set(ids).size, 181); assert.deepEqual(ids, [...snapshots].reverse().map(snapshot => snapshot.header.id));
});
test('a trusted 1 KiB byte cap makes progress and bounds every full page', async () => {
  const snapshots = Array.from({ length: 60 }, (...[, i]) => owned(`${'x'.repeat(150)}${i}`, i));
  const catalog = createCatalog(metadataSource(snapshots).persistence, { maxBytes: 1024 });
  const ids = []; let cursor; let pages = 0;
  do {
    const result = await catalog.listChats({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024); assert.ok(result.chats.length > 0);
    ids.push(...result.chats.map(row => row.id)); pages++; cursor = result.nextCursor;
  } while (cursor !== null);
  assert.ok(pages > 1); assert.equal(ids.length, 60); assert.equal(new Set(ids).size, 60);
  for (const options of [{ maxBytes: 1023 }, { maxBytes: 32769 }, { root: '/private' }, { backend: 'jsonl' }]) assert.throws(() => createCatalog(metadataSource([]).persistence, options));
});
test('cursor tampering, limit mismatch and cross-instance replay fail before persistence', async () => {
  const source = metadataSource([owned('one'), owned('two')]); const first = createCatalog(source.persistence);
  const cursor = (await first.listChats({ limit: 1 })).nextCursor;
  const calls = source.calls.length;
  const tampered = `${cursor[0] === 'A' ? 'B' : 'A'}${cursor.slice(1)}`;
  await assert.rejects(first.listChats({ limit: 1, cursor: tampered }), code('invalid-cursor'));
  await assert.rejects(first.listChats({ limit: 2, cursor }), code('invalid-cursor'));
  await assert.rejects(createCatalog(source.persistence).listChats({ limit: 1, cursor }), code('invalid-cursor'));
  assert.equal(source.calls.length, calls);
});
test('title/activity changes do not stale cursors; member or creation changes do', async () => {
  const source = metadataSource([owned('one', 2), owned('two', 1)]); const catalog = createCatalog(source.persistence);
  const cursor = (await catalog.listChats({ limit: 1 })).nextCursor;
  source.set([owned('one', 2), { ...owned('two', 1), metadata: { title: 'changed', updatedAt: 999 } }]);
  assert.equal((await catalog.listChats({ limit: 1, cursor })).chats[0].id, 'two');
  source.set([owned('one', 2), owned('two', 1), owned('three', 0)]);
  await assert.rejects(catalog.listChats({ limit: 1, cursor }), code('cursor-stale'));
  source.set([owned('one', 2), owned('two', 3)]);
  await assert.rejects(catalog.listChats({ limit: 1, cursor }), code('cursor-stale'));
});
test('ambiguous companion ids, foreign duplicate claims, invalid snapshots and metadata caps fail closed', async () => {
  for (const snapshots of [[owned('duplicate'), owned('duplicate')], [owned('duplicate'), owned('duplicate', 1, { agentPreset: 'standard' })]]) await assert.rejects(createCatalog(metadataSource(snapshots).persistence).listChats({}), code('catalog-ambiguous'));
  await assert.rejects(createCatalog(metadataSource({}).persistence).listChats({}), code('metadata-unavailable'));
  await assert.rejects(createCatalog(metadataSource(Array.from({ length: MAX_SNAPSHOTS + 1 }, (...[, i]) => owned(`chat${i}`))).persistence).listChats({}), code('catalog-limit'));
});
test('abort is propagated before metadata and after an awaited metadata cut', async () => {
  const source = metadataSource([owned('chat')]); const catalog = createCatalog(source.persistence); const controller = new AbortController(); controller.abort();
  await assert.rejects(catalog.listChats({}, controller.signal), error => error.name === 'AbortError');
  await assert.rejects(catalog.detail({ id: 'chat' }, controller.signal), error => error.name === 'AbortError'); assert.equal(source.calls.length, 0);
  const later = new AbortController();
  const aborting = createCatalog({ list: async () => { later.abort(); return [owned('chat')]; }, stat: async () => { later.abort(); return owned('chat'); } });
  await assert.rejects(aborting.listChats({}, later.signal), error => error.name === 'AbortError');
  const detailAbort = new AbortController();
  const abortingDetail = createCatalog({ stat: async () => { detailAbort.abort(); return owned('chat'); } });
  await assert.rejects(abortingDetail.detail({ id: 'chat' }, detailAbort.signal), error => error.name === 'AbortError');
});
test('public Gateway keeps strict catalog reads independent of optional model and deletion capabilities', async t => {
  const fixture = await host(t); await apply(fixture.ctx);
  assert.deepEqual(fixture.ctx.typert.local.list().map(row => `${row.namespace}/${row.method}`), ['companion/listChats', 'companion/detail', 'companion/deleteChat', 'companion/modelCatalog', 'companion/selectDefaultModel', 'companion/messageHeads', 'companion/selectAppModel', 'companion/applyAppModel', 'companion/catalogState', 'companion/interactionHeads']);
  assert.equal(fixture.ctx.get('tools'), undefined); assert.equal(fixture.ctx.get('systemPrompt'), undefined); assert.equal(fixture.ctx.get('agents'), undefined);
  assert.deepEqual((await fixture.invoke('listChats', {})).chats, [{ id: 'chat', createdAt: 1 }]);
  assert.equal((await fixture.invoke('detail', { id: 'chat' })).chat.id, 'chat');
  await assert.rejects(fixture.invoke('listChats', { limit: '1' }), error => error.code === 'gateway/input-invalid');
  await assert.rejects(fixture.invoke('listChats', {}, { root: '/private' }), error => error.code === 'gateway/arguments-invalid');
  await assert.rejects(fixture.invoke('detail', { id: 'chat', agentPreset: 'companion' }), error => error.code === 'gateway/input-invalid');
});
test('missing or wrong actual launcher profile refuses before any service/endpoint registration', async t => {
  for (const profile of ['web', 'dsh-tui', 'companion-other', null]) {
    const fixture = await host(t, profile);
    await assert.rejects(apply(fixture.ctx, { profile: 'companion' }), code('profile-mismatch'));
    assert.throws(() => new CompanionCatalogService(fixture.ctx), code('profile-mismatch'));
    assert.equal(fixture.ctx.get('companionCatalog'), undefined); assert.equal(fixture.ctx.typert.local.get('companion/listChats'), undefined); assert.equal(fixture.source.calls.length, 0);
  }
});
test('profile is rechecked on every call, not trusted from constructor config', async t => {
  const fixture = await host(t); await apply(fixture.ctx); fixture.ctx.get('profileContext').name = 'web';
  await assert.rejects(fixture.invoke('detail', { id: 'chat' }), code('profile-mismatch')); assert.equal(fixture.source.calls.length, 0);
});
test('owned fiber disposal withdraws definitions and forbids SRC fallback', async t => {
  const fixture = await host(t); let owner;
  await fixture.ctx.plugin({ name: 'fixture-catalog-owner', apply: async ctx => { owner = ctx; await apply(ctx); } });
  await fixture.invoke('listChats', {}); await owner.fiber.dispose();
  assert.equal(fixture.ctx.typert.local.get('companion/listChats'), undefined);
  await assert.rejects(fixture.invoke('listChats', {}), error => error.code === 'gateway/definition-unavailable');
});
