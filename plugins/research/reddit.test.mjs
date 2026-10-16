import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedditConnector } from './reddit.mjs';
import { createScheduler } from './scheduler.mjs';

const env = { REDDIT_ACCESS_TOKEN: 'secret-token', REDDIT_USER_AGENT: 'research-tests/1.0 (offline fixture)' };
const listing = children => ({ data: { children, after: 't3_next' } });
const post = { kind: 't3', data: { id: 'abc', title: 'Title', selftext: 'Post text', subreddit: 'testing', num_comments: 3 } };
const comment = (id, parent = 't3_abc', replies) => ({ kind: 't1', data: { id, parent_id: parent, link_id: 't3_abc', author: 'reader', body: `body ${id}`, created_utc: 123, replies } });
const more = ids => ({ kind: 'more', data: { id: 'more1', parent_id: 't3_abc', link_id: 't3_abc', count: ids.length, children: ids } });
const thread = comments => [listing([post]), listing(comments)];
const expanded = comments => ({ json: { data: { things: comments }, errors: [] } });
const response = (data, init) => new Response(JSON.stringify(data), init);
function harness(fixtures = [], extra = {}) {
  const calls = [], keys = [], cooldowns = [];
  const scheduler = { async run(key, fn, opts) { keys.push({ key, limit: opts.limit }); opts.signal?.throwIfAborted(); return fn(); }, cooldown(key, ms) { cooldowns.push({ key, ms }); } };
  const connector = createRedditConnector({ env, scheduler, fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); assert.ok(fixtures.length, 'unexpected request'); const next = fixtures.shift(); return typeof next === 'function' ? next(url, init) : next instanceof Response ? next : response(next); }, ...extra });
  return { connector, calls, keys, cooldowns };
}
const item = { url: 'https://www.reddit.com/comments/abc', reddit: { postId: 'abc' } };

test('search is OAuth read-only and preserves listing cursor', async () => {
  const h = harness([listing([post])]);
  const items = await h.connector.search('term', { reddit: { subreddit: 'testing', time: 'week', sort: 'new' } });
  assert.equal(items[0].url, item.url); assert.equal(items[0].reddit.after, 't3_next');
  assert.equal(items[0].reddit.listingComplete, false);
  assert.equal(h.calls[0].url.pathname, '/r/testing/search');
  assert.equal(h.calls[0].init.redirect, 'error'); assert.equal(h.calls[0].init.method, 'GET');
  assert.equal(h.calls[0].init.headers.Authorization, 'Bearer secret-token');
  assert.equal(h.connector.capability.mode, 'official-api');
  assert.ok(!JSON.stringify(h.connector.capability).includes('secret-token'));
});
test('subreddit listing uses bounded endpoint and cursor', async () => {
  const h = harness([listing([post])]);
  await h.connector.search('', { limit: 500, reddit: { mode: 'subreddit', subreddit: 'testing', sort: 'rising', after: 't3_prev' } });
  assert.equal(h.calls[0].url.pathname, '/r/testing/rising');
  assert.equal(h.calls[0].url.searchParams.get('limit'), '100');
  assert.equal(h.calls[0].url.searchParams.get('after'), 't3_prev');
});
test('thread synthetic item requires no network and supports subtree', async () => {
  const h = harness([thread([comment('one', 't3_abc', listing([comment('two', 't1_one')]))])]);
  const [synthetic] = await h.connector.search('', { reddit: { mode: 'thread', postId: 't3_abc', commentId: 't1_one' } });
  assert.equal(h.calls.length, 0);
  const result = await h.connector.read(synthetic);
  assert.equal(result.content, 'Post text'); assert.equal(result.kind, 'reddit_thread');
  assert.equal(result.comments[0].children[0].id, 'two');
  assert.equal(result.comments[0].children[0].parent_id, 't1_one');
  assert.equal(h.calls[0].url.searchParams.get('comment'), 'one');
});
test('morechildren limits requests to two, 100 IDs each, and selected total 200', async () => {
  const ids = Array.from({ length: 200 }, (_, i) => `a${i}`);
  const h = harness([thread([more(ids)]), expanded(ids.slice(0, 100).map(v => comment(v))), expanded(ids.slice(100).map(v => comment(v)))]);
  const result = await h.connector.read(item, { maxComments: 999 });
  assert.equal(result.selectedCommentCount, 200); assert.equal(result.moreCalls, 2);
  for (const call of h.calls.slice(1)) { assert.ok(call.url.searchParams.get('children').split(',').length <= 100); assert.equal(call.url.searchParams.get('link_id'), 't3_abc'); }
  assert.deepEqual(h.keys.map(x => x.key), ['reddit-api', 'reddit-morechildren', 'reddit-api', 'reddit-morechildren', 'reddit-api']);
  assert.ok(h.keys.filter(x => x.key === 'reddit-morechildren').every(x => x.limit === 1));
});
test('429 during expansion preserves partial tree, marker and followup IDs', async () => {
  const h = harness([thread([comment('one'), more(['two'])]), response({ token: 'secret-token' }, { status: 429, headers: { 'retry-after': '2', 'x-ratelimit-reset': '3', 'x-ratelimit-remaining': '0' } })]);
  const result = await h.connector.read(item);
  assert.equal(result.comments[0].id, 'one'); assert.equal(result.errors[0].code, 'RATE_LIMIT');
  assert.equal(result.errors[0].retryAfterMs, 3000);
  assert.deepEqual(result.continuation.children, ['two']); assert.equal(result.truncated, true);
  assert.deepEqual(h.cooldowns, [{ key: 'reddit-api', ms: 3000 }]);
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});
test('blocked expansion and cross-thread explicit IDs cannot contaminate thread', async () => {
  const h = harness([thread([]), expanded([{ ...comment('two'), data: { ...comment('two').data, link_id: 't3_other' } }])]);
  const result = await h.connector.read({ ...item, reddit: { postId: 'abc', children: ['two'] } });
  assert.equal(result.selectedCommentCount, 0); assert.deepEqual(result.continuation.children, ['two']);
  const blocked = harness([thread([more(['two'])]), response({}, { status: 403 })]);
  assert.equal((await blocked.connector.read(item)).errors[0].code, 'ACCESS_DENIED');
});
test('zero budget and metadata remain bounded without expansions', async () => {
  const h = harness([thread([comment('one'), more(['two'])])]);
  const result = await h.connector.read({ ...item, reddit: { postId: 'abc', after: 't3_next' } }, { maxComments: 0 });
  assert.equal(result.selectedCommentCount, 0); assert.equal(result.commentCount, 3); assert.equal(result.moreCalls, 0);
  assert.equal(result.continuation.after, 't3_next'); assert.equal(result.truncated, true);
});
test('auth absent, descriptive agent absent, and raw errors are safe', async () => {
  for (const missing of [{}, { REDDIT_ACCESS_TOKEN: 'secret-token' }]) {
    const h = harness([], { env: missing });
    await assert.rejects(h.connector.search('x'), { code: 'AUTH_REQUIRED' }); assert.equal(h.calls.length, 0);
  }
  const h = harness([() => { throw Object.assign(new Error('secret-token https://user:password@bad'), { code: 'HTTP_ERROR' }); }]);
  await assert.rejects(h.connector.search('x'), e => e.code === 'NETWORK_ERROR' && !e.message.includes('secret-token') && !e.message.includes('password'));
});
test('invalid input and arbitrary URLs never reach network', async () => {
  const h = harness();
  for (const reddit of [{ mode: 'thread', postId: '../abc' }, { subreddit: 'a/b' }, { after: 'https://evil' }, { mode: 'thread', postId: 'abc', children: [12] }, { mode: 'subreddit' }, { sort: 'invalid' }]) await assert.rejects(h.connector.search('', { reddit }), { code: 'INVALID_INPUT' });
  for (const url of ['https://evil/comments/abc', 'http://www.reddit.com/comments/abc', 'https://www.reddit.com/comments/abc?token=x', 'https://www.reddit.com/comments/other']) await assert.rejects(h.connector.read({ ...item, url }), { code: 'INVALID_INPUT' });
  assert.equal(h.calls.length, 0);
});
test('redirect, oversized JSON, invalid JSON and missing read scope are denied', async () => {
  for (const [fixture, code] of [[new Response('', { status: 302 }), 'REDIRECT_DENIED'], [new Response('x'.repeat(2_000_001)), 'RESPONSE_TOO_LARGE'], [new Response('{}', { headers: { 'content-length': '2000001' } }), 'RESPONSE_TOO_LARGE'], [new Response('bad'), 'INVALID_RESPONSE'], [response({ scope: 'identity' }), 'INSUFFICIENT_SCOPE']]) {
    await assert.rejects(harness([fixture]).connector.search('x'), { code });
  }
});
test('cancellation interrupts fetch and pre-aborted operations do not fetch', async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness();
  await assert.rejects(h.connector.search('x', { signal: controller.signal }), { code: 'ABORTED' });
  const c = new AbortController();
  const stalled = harness([() => { c.abort(); return new Promise(() => {}); }]);
  await assert.rejects(stalled.connector.search('x', { signal: c.signal }), { code: 'ABORTED' });
});
test('explicit continuation prioritizes IDs and unavailable subtree returns no unrelated comments', async () => {
  const h = harness([thread([comment('one')]), expanded([comment('two')])]);
  const result = await h.connector.read({ ...item, reddit: { postId: 'abc', children: ['two'] } }, { maxComments: 1 });
  assert.equal(result.comments[0].id, 'two'); assert.equal(result.selectedCommentCount, 1);
  const unavailable = harness([thread([comment('one')]), expanded([])]);
  const missing = await unavailable.connector.read({ ...item, reddit: { postId: 'abc', commentId: 'two' } });
  assert.deepEqual(missing.comments, []); assert.equal(missing.errors[0].code, 'COMMENT_UNAVAILABLE');
  assert.deepEqual(missing.continuation.children, ['two']);
});
test('real shared scheduler enforces cross-connector workers and cooldown without retry', async () => {
  const scheduler = createScheduler();
  let active = 0, peak = 0;
  const fetchImpl = async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; return response(listing([])); };
  const a = createRedditConnector({ env, scheduler, fetchImpl, workers: 1 });
  const b = createRedditConnector({ env, scheduler, fetchImpl, workers: 2 });
  await Promise.all([a.search('a'), b.search('b'), a.search('c')]);
  assert.equal(peak, 1);
  const rate = harness([response({}, { status: 429, headers: { 'retry-after': '10' } })], { scheduler });
  await assert.rejects(rate.connector.search('x'), { code: 'RATE_LIMIT', retryAfterMs: 10000 });
  await assert.rejects(a.search('x'), error => error.code === 'RATE_LIMIT' && error.retryAfterMs > 0 && error.retryAfterMs <= 10000);
  assert.equal(rate.calls.length, 1);
});
test('last listing page with null or absent cursor can be read', async () => {
  for (const data of [{ children: [post], after: null }, { children: [post] }]) {
    const h = harness([{ data }, thread([comment('one')])]);
    const [found] = await h.connector.search('x');
    assert.equal(found.reddit.after, null);
    const result = await h.connector.read(found);
    assert.equal(result.content, 'Post text');
    assert.equal(result.continuation.after, null);
  }
});
test('cancelled noncooperative expansion retains serial slot until fetch settles', async () => {
  const scheduler = createScheduler();
  let release, started, active = 0, peak = 0, expansions = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const fetchImpl = async url => {
    if (!url.includes('/api/morechildren')) return response(thread([more(['two'])]));
    expansions++; active++; peak = Math.max(peak, active);
    if (expansions === 1) { started(); await gate; }
    active--;
    return response(expanded([comment('two')]));
  };
  const a = createRedditConnector({ env, scheduler, fetchImpl });
  const b = createRedditConnector({ env, scheduler, fetchImpl });
  const controller = new AbortController();
  const first = a.read(item, { signal: controller.signal });
  const rejected = assert.rejects(first, { code: 'ABORTED' });
  await entered;
  controller.abort(); await rejected;
  const second = b.read(item);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(expansions, 1);
    assert.equal(active, 1);
  } finally { release(); }
  const result = await second;
  assert.equal(result.comments[0].id, 'two');
  assert.equal(expansions, 2); assert.equal(peak, 1);
});
test('injected scheduler shares keys across connectors and respects workers', async () => {
  const keys = [];
  const scheduler = { run: async (key, fn, { limit }) => { keys.push([key, limit]); return fn(); }, cooldown() {} };
  const a = harness([listing([])], { scheduler, workers: 1 });
  const b = harness([listing([])], { scheduler, workers: 1 });
  await Promise.all([a.connector.search('a'), b.connector.search('b')]);
  assert.deepEqual(keys, [['reddit-api', 1], ['reddit-api', 1]]);
  assert.throws(() => createRedditConnector({ workers: 3 }), { code: 'INVALID_INPUT' });
});
