import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecentCatalog } from './recent-catalog.mjs';
import { createTitleHints, confirmedTitle } from './title-hints.mjs';
import * as contracts from './contracts.mjs';

const owned = (id, createdAt = 1) => ({ header: { id, agentPreset: 'companion', createdAt } });
const persistenceOf = snapshots => ({ list: async () => snapshots });
const activityOf = () => ({ current: () => true, hint: () => undefined });
const base = { detail: async () => { throw new Error('detail is not used by these fixtures'); } };
const catalog = (titles, snapshots, options = {}) => createRecentCatalog(persistenceOf(snapshots), activityOf(), base, contracts,
  { titles, ...options });

function provider(overrides = {}) {
  const calls = [];
  const query = {
    readTitleSnapshots: async (ids, signal) => {
      calls.push([...ids]);
      if (overrides.pending === true) {
        return await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      }
      return ids.map(id => ({
        sessionId: id,
        status: 'fulfilled',
        value: { session: { ...owned(id, overrides.createdAt ?? 1).header }, ...(overrides.noTitle === true ? {} : { title: { title: overrides.title ?? 'Synthetic title', eventSeq: 1, updatedAt: 5 } }) },
      }));
    },
  };
  return { calls, query };
}

function fakeCtx(query) {
  const listeners = new Map();
  return {
    ctx: { on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); }, get: key => key === 'sessionQuery' ? query : undefined },
    emit: (name, ...args) => listeners.get(name)?.(...args),
    listenerCount: () => listeners.size,
  };
}

test('a page carries an admitted title when the resolver knows one', async () => {
  const titles = { read: async () => new Map([['chat-a', 'Notas da semana']]) };
  const page = await catalog(titles, [owned('chat-a', 7)]).listChats({});
  assert.deepEqual(page.chats, [{ id: 'chat-a', createdAt: 7, title: 'Notas da semana' }]);
});

test('a missing title leaves the page byte-identical to today', async () => {
  const plain = await catalog(undefined, [owned('chat-a', 7), owned('chat-b', 6)]).listChats({});
  const empty = await catalog({ read: async () => new Map() }, [owned('chat-a', 7), owned('chat-b', 6)]).listChats({});
  assert.deepEqual(empty, plain);
});

test('a failing resolver never fails or delays the catalog page', async () => {
  const plain = await catalog(undefined, [owned('chat-a', 7)]).listChats({});
  const failing = await catalog({ read: async () => { throw new Error('provider down'); } }, [owned('chat-a', 7)]).listChats({});
  assert.deepEqual(failing, plain);
});

test('an unprintable title is dropped instead of invalidating the page', async () => {
  const title = 'a\nb';
  const page = await catalog({ read: async () => new Map([['chat-a', title]]) }, [owned('chat-a', 7)]).listChats({});
  assert.deepEqual(page.chats, [{ id: 'chat-a', createdAt: 7 }]);
});

test('a cursor page carries titles without changing membership or progress', async () => {
  const titles = { read: async entries => new Map(entries.map(entry => [entry.id, `T ${entry.id}`])) };
  // Cursors are signed per instance, so both pages must come from the same catalog.
  const instance = catalog(titles, [owned('chat-a', 7), owned('chat-b', 6)]);
  const fresh = await instance.listChats({ limit: 1 });
  assert.equal(fresh.chats.length, 1);
  assert.equal(fresh.chats[0].title, `T ${fresh.chats[0].id}`);
  assert.notEqual(fresh.nextCursor, null);
  const next = await instance.listChats({ limit: 1, cursor: fresh.nextCursor });
  assert.equal(next.chats.length, 1);
  assert.equal(next.chats[0].title, `T ${next.chats[0].id}`);
  assert.equal(next.chats[0].id === fresh.chats[0].id, false);
});

test('titles never change cursor revision, order or duplicates', async () => {
  const titles = { read: async () => new Map([['chat-b', 'B']]) };
  const first = await catalog(titles, [owned('chat-a', 7), owned('chat-b', 6)]).listChats({});
  assert.deepEqual(first.chats.map(row => row.id), ['chat-a', 'chat-b']);
  assert.equal(first.chats[1].title, 'B');
  assert.equal(new Set(first.chats.map(row => row.id)).size, first.chats.length);
});

test('the resolver folds once, caches by incarnation, and a title event invalidates it', async () => {
  const { calls, query } = provider({ title: 'Nome real' });
  const { ctx, emit } = fakeCtx(query);
  const titles = createTitleHints(ctx);
  const entries = [{ id: 'chat-a', createdAt: 1 }];
  assert.equal((await titles.read(entries)).get('chat-a'), 'Nome real');
  assert.equal((await titles.read(entries)).get('chat-a'), 'Nome real');
  assert.equal(calls.length, 1);
  emit('session/event', { id: 'chat-a' }, { type: 'session/title' });
  await titles.read(entries);
  assert.equal(calls.length, 2);
  titles.close();
});

test('a foreign incarnation never produces a title and is not cached as proof', async () => {
  const { calls, query } = provider({ createdAt: 2 });
  const { ctx } = fakeCtx(query);
  const titles = createTitleHints(ctx);
  const entries = [{ id: 'chat-a', createdAt: 1 }];
  assert.equal((await titles.read(entries)).size, 0);
  assert.equal(calls.length, 1);
  assert.equal((await titles.read(entries)).size, 0);
  // A mismatch is not a negative fact about this incarnation, so it folds again instead of caching.
  assert.equal(calls.length, 2);
  titles.close();
});

test('only a title event invalidates the cache', async () => {
  const { calls, query } = provider({ title: 'Cached name' });
  const { ctx, emit } = fakeCtx(query);
  const titles = createTitleHints(ctx);
  const entries = [{ id: 'chat-a', createdAt: 1 }];
  assert.equal((await titles.read(entries)).get('chat-a'), 'Cached name');
  emit('session/event', { id: 'chat-a' }, { type: 'assistant/message' });
  assert.equal((await titles.read(entries)).get('chat-a'), 'Cached name');
  assert.equal(calls.length, 1);
  emit('session/event', { id: 'chat-b' }, { type: 'session/title' });
  assert.equal((await titles.read(entries)).get('chat-a'), 'Cached name');
  assert.equal(calls.length, 1);
  emit('session/event', { id: 'chat-a' }, { type: 'session/title' });
  await titles.read(entries);
  assert.equal(calls.length, 2);
  titles.close();
});

test('an absent service, a rejection or a stalled fold degrades to no title', async () => {
  const absent = createTitleHints({ get: () => undefined });
  assert.equal((await absent.read([{ id: 'chat-a', createdAt: 1 }])).size, 0);
  absent.close();

  const { ctx } = fakeCtx({ readTitleSnapshots: async () => { throw new Error('metadata read failed'); } });
  assert.equal((await createTitleHints(ctx).read([{ id: 'chat-a', createdAt: 1 }])).size, 0);

  const stalled = provider({ pending: true });
  const started = Date.now();
  const titles = createTitleHints(fakeCtx(stalled.query).ctx, { wallMs: 40 });
  assert.equal((await titles.read([{ id: 'chat-a', createdAt: 1 }])).size, 0);
  assert.ok(Date.now() - started < 1000, 'the fold must respect its deadline');
  titles.close();
});

test('a title snapshot without a folded title is cached as "no title"', async () => {
  const { calls, query } = provider({ noTitle: true });
  const titles = createTitleHints(fakeCtx(query).ctx);
  const entries = [{ id: 'chat-a', createdAt: 1 }];
  assert.equal((await titles.read(entries)).size, 0);
  assert.equal((await titles.read(entries)).size, 0);
  assert.equal(calls.length, 1);
  titles.close();
});

test('confirmed title trims, strips control characters and caps length', () => {
  assert.equal(confirmedTitle('  Hello\tworld '), 'Hello world');
  assert.equal(confirmedTitle('\n\n'), undefined);
  assert.equal(confirmedTitle(42), undefined);
  assert.equal(confirmedTitle('a'.repeat(300)).length, contracts.MAX_TITLE);
});
