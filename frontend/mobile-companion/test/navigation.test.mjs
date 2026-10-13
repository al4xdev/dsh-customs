import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Compile the actual TypeScript in memory. Only the observable store transport
// is replaced; no generated files, native runtime, browser or backend is used.
const sourceUrls = new Map();
async function sourceModule(entry) {
  const result = await build({
    entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname],
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'isolated-store', setup(builder) {
      // Preserve API class identity across both compiled entry points so typed
      // MobileApiError guards behave exactly like the production module graph.
      builder.onResolve({ filter: /^\.\/api$/ }, () => ({ path: sourceUrls.get('api.ts'), external: true }));
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-store$/ }, () => ({ path: 'store', namespace: 'test-store' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-store' }, () => ({ contents: `
        export function createSnapshotStore(value) {
          const listeners = new Set();
          return { getSnapshot: () => value,
            subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
            set: next => { value = next; for (const listener of listeners) listener(); } };
        }` }));
    } }],
  });
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  sourceUrls.set(entry, url);
  return import(url);
}
const { CompanionApi, MobileApiError } = await sourceModule('api.ts');
const { MobileCompanion } = await sourceModule('workspace.ts');
const settle = () => new Promise(resolve => { setImmediate(resolve); });
const row = id => ({ id, title: 'Conversa' });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fakeBrowser(url = 'http://local/') {
  const entries = [{ url, state: null }], listeners = new Set();
  let index = 0;
  const browser = {
    get location() { return { href: entries[index].url }; },
    addEventListener(type, listener) { assert.equal(type, 'popstate'); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, 'popstate'); listeners.delete(listener); },
  };
  browser.history = {
    get state() { return entries[index].state; },
    replaceState(state, title, next) { assert.equal(title, ''); entries[index] = { state, url: String(next) }; },
    pushState(state, title, next) { assert.equal(title, ''); entries.splice(index + 1); entries.push({ state, url: String(next) }); ++index; },
    go(distance) {
      assert.ok(index + distance >= 0 && index + distance < entries.length, 'navigation must not leave the owned app history');
      index += distance;
      // Real popstate is dispatched after history navigation, not inside go().
      queueMicrotask(() => { for (const listener of listeners) listener(); });
    },
  };
  return browser;
}
const chatQuery = browser => new URL(browser.location.href).searchParams.get('chat');
function fakeApi() {
  const calls = [], allowed = new Set(['a', 'b', 'older']);
  return { calls, allowed,
    list: async () => [row('a'), row('b')],
    assertAllowed: async id => { calls.push(id); if (!allowed.has(id)) throw new MobileApiError('foreign', 403); return row(id); },
    create: async () => 'b',
  };
}

test('selection pushes a meaningful URL only after admission; Back and Forward revalidate', async () => {
  const api = fakeApi(), browser = fakeBrowser(), mobile = new MobileCompanion(api);
  const detach = mobile.attachNavigation(browser);
  await mobile.select('a');
  assert.equal(chatQuery(browser), 'a');
  browser.history.go(-1); await settle();
  assert.equal(mobile.state.getSnapshot().selectedId, undefined);
  assert.equal(chatQuery(browser), null);
  browser.history.go(1); await settle();
  assert.equal(mobile.state.getSnapshot().selectedId, 'a');
  assert.equal(api.calls.filter(id => id === 'a').length, 2);
  await mobile.select('b'); mobile.back(); await settle();
  assert.equal(chatQuery(browser), null);
  assert.equal(mobile.state.getSnapshot().selectedId, undefined);
  detach(); mobile.dispose();
});

test('reload restores only a freshly validated companion address and preserves owned Back', async () => {
  const browser = fakeBrowser(), first = new MobileCompanion(fakeApi());
  const detach = first.attachNavigation(browser);
  await first.select('a'); detach(); first.dispose();
  const api = fakeApi(), reloaded = new MobileCompanion(api);
  reloaded.attachNavigation(browser); await settle();
  assert.equal(reloaded.state.getSnapshot().selectedId, 'a');
  assert.deepEqual(api.calls, ['a']);
  reloaded.back(); await settle(); assert.equal(chatQuery(browser), null);
});

test('initial older deep link has a safe explicit Back without an outside-app ancestor', async () => {
  const browser = fakeBrowser('http://local/?chat=older&keep=1'), mobile = new MobileCompanion(fakeApi());
  mobile.attachNavigation(browser); await settle();
  assert.equal(mobile.state.getSnapshot().selectedId, 'older');
  mobile.back();
  assert.equal(chatQuery(browser), null);
  assert.equal(new URL(browser.location.href).searchParams.get('keep'), '1');
  await mobile.select('b'); mobile.back(); await settle(); assert.equal(chatQuery(browser), null);
});

test('foreign deep links are sanitized; foreign click does not replace a valid route', async () => {
  const invalid = fakeBrowser('http://local/?chat=foreign'), denied = new MobileCompanion(fakeApi());
  denied.attachNavigation(invalid); await settle();
  assert.equal(denied.state.getSnapshot().selectedId, undefined);
  assert.equal(chatQuery(invalid), null); assert.equal(denied.state.getSnapshot().error, 'foreign');
  const valid = fakeBrowser(), mobile = new MobileCompanion(fakeApi());
  mobile.attachNavigation(valid); await mobile.select('a'); await mobile.select('foreign');
  assert.equal(mobile.state.getSnapshot().selectedId, 'a'); assert.equal(chatQuery(valid), 'a');
});

test('late selection result cannot overwrite newer navigation or Back', async () => {
  const pending = deferred(), api = fakeApi();
  api.assertAllowed = id => id === 'a' ? pending.promise : Promise.resolve(row(id));
  const browser = fakeBrowser(), mobile = new MobileCompanion(api);
  mobile.attachNavigation(browser);
  const opening = mobile.select('a');
  assert.equal(chatQuery(browser), null, 'unresolved proof must not enter history');
  assert.equal(mobile.state.getSnapshot().selectedId, undefined);
  await mobile.select('b');
  pending.resolve(row('a')); await opening;
  assert.equal(mobile.state.getSnapshot().selectedId, 'b'); assert.equal(chatQuery(browser), 'b');
  const next = deferred(); api.assertAllowed = () => next.promise;
  const retry = mobile.select('a'); mobile.back(); await settle(); next.resolve(row('a')); await retry;
  assert.equal(mobile.state.getSnapshot().selectedId, undefined); assert.equal(chatQuery(browser), null);
});

test('Forward rechecks a revoked historical address instead of trusting its saved marker', async () => {
  const api = fakeApi(), browser = fakeBrowser(), mobile = new MobileCompanion(api);
  mobile.attachNavigation(browser); await mobile.select('a');
  browser.history.go(-1); await settle(); api.allowed.delete('a');
  browser.history.go(1); await settle();
  assert.equal(mobile.state.getSnapshot().selectedId, undefined); assert.equal(chatQuery(browser), null);
  assert.equal(api.calls.filter(id => id === 'a').length, 2);
});

test('admitted create completion cannot steal the route after Back', async () => {
  const admission = deferred(), api = fakeApi(); api.create = () => admission.promise;
  const browser = fakeBrowser(), mobile = new MobileCompanion(api);
  mobile.attachNavigation(browser); await mobile.select('a');
  const creation = mobile.create(); mobile.back(); await settle(); admission.resolve('b');
  assert.equal(await creation, 'b'); assert.equal(mobile.state.getSnapshot().selectedId, undefined);
  assert.equal(chatQuery(browser), null); assert.equal(mobile.state.getSnapshot().creating, false);
});

test('stale opening rejection cannot clear newer selection; current rejection sanitizes', async () => {
  const browser = fakeBrowser(), mobile = new MobileCompanion(fakeApi());
  mobile.attachNavigation(browser); await mobile.select('a'); const old = mobile.state.getSnapshot().revision;
  await mobile.select('b'); mobile.rejectSelection('a', old, 'stale');
  assert.equal(chatQuery(browser), 'b');
  mobile.rejectSelection('b', mobile.state.getSnapshot().revision, 'revoked');
  assert.equal(chatQuery(browser), null); assert.equal(mobile.state.getSnapshot().selectedId, undefined);
});

test('refresh keeps an older proven chat but drops it when the header guard is revoked', async () => {
  const api = fakeApi(), browser = fakeBrowser(), mobile = new MobileCompanion(api);
  mobile.attachNavigation(browser); await mobile.select('older'); await mobile.refresh();
  assert.ok(mobile.state.getSnapshot().chats.some(chat => chat.id === 'older'));
  api.allowed.delete('older'); await mobile.refresh();
  assert.equal(mobile.state.getSnapshot().selectedId, undefined); assert.equal(chatQuery(browser), null);
});

function response(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function httpApi(list, detail, status = 200) {
  const requests = [];
  const api = new CompanionApi(async (path, init) => {
    requests.push({ path, init });
    return path.includes('?') ? response(list) : response(detail, status);
  });
  return { api, requests };
}

test('API requests the bounded100 list and accepts optional header display metadata', async () => {
  const { api, requests } = httpApi({ profile: 'companion', chats: [{ id: 'a' }] });
  assert.deepEqual(await api.list(), [{ id: 'a', title: 'Conversa' }]);
  assert.equal(requests[0].path, '/mobile-api/chats?limit=100');
  assert.equal(requests[0].init.credentials, 'same-origin'); assert.equal(requests[0].init.cache, 'no-store');
});

test('older API address requires exact authenticated detail id/profile proof', async () => {
  const { api, requests } = httpApi({ profile: 'companion', chats: [row('a')] }, { profile: 'companion', chat: { id: 'older' } });
  assert.equal((await api.assertAllowed('older')).id, 'older');
  assert.deepEqual(requests.map(request => request.path), ['/mobile-api/chats?limit=100', '/mobile-api/chats/older']);
  for (const detail of [{ chat: { id: 'older' } }, { profile: 'standard', chat: { id: 'older' } }, { profile: 'companion', chat: { id: 'different' } }]) {
    await assert.rejects(httpApi({ profile: 'companion', chats: [] }, detail).api.assertAllowed('older'));
  }
  await assert.rejects(httpApi({ profile: 'companion', chats: [] }, {}, 403).api.assertAllowed('foreign'), error => error.status === 403);
});

test('list validation rejects wrong profile, duplicate ids and malformed ids', async () => {
  for (const list of [{ profile: 'standard', chats: [] }, { profile: 'companion', chats: [row('a'), row('a')] }, { profile: 'companion', chats: [{ id: '../foreign' }] }]) {
    await assert.rejects(httpApi(list).api.list());
  }
});

test('header detail omission preserves meaningful list title and timestamp', async () => {
  const { api } = httpApi({ profile: 'companion', chats: [{ id: 'a', title: 'Resumo do trabalho', createdAt: 123 }] }, { profile: 'companion', chat: { id: 'a' } });
  assert.deepEqual(await api.assertAllowed('a'), { id: 'a', title: 'Resumo do trabalho', createdAt: 123, updatedAt: 123 });
});
