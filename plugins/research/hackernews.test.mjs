import test from 'node:test';
import assert from 'node:assert/strict';
import { createHackerNewsConnector } from './hackernews.mjs';

const item = { hnId: '1', title: 'Original', url: 'https://news.ycombinator.com/item?id=1' };
const story = (extra = {}) => ({ id: 1, type: 'story', title: 'Post preserved', text: '<p>Body</p>', kids: [], ...extra });
const comment = (id, parent = 1, extra = {}) => ({ id, parent, type: 'comment', by: 'reader', text: '<p>Hello</p>', time: 1700000000, ...extra });
function fixture(nodes, extra = {}) {
  const calls = [];
  const connector = createHackerNewsConnector({
    json: async (url, signal) => {
      const id = Number(url.match(/\/(\d+)\.json$/)?.[1]);
      calls.push(id);
      const value = nodes[id];
      if (typeof value === 'function') return value(signal);
      if (value instanceof Error) throw value;
      return value;
    },
    readArticle: async () => ({ content: 'Article', truncated: false }),
    ...extra,
  });
  return { connector, calls };
}

test('search selects only short Algolia attributes and safe IDs, caps limit', async () => {
  let request;
  const connector = createHackerNewsConnector({ json: async url => {
    request = new URL(url);
    return { hits: [{ objectID: '123', title: 'Story', url: 'https://example.com', created_at: '2025-01-01' }, { objectID: '9007199254740992' }] };
  } });
  const results = await connector.search('test & query', { limit: 100 });
  assert.equal(request.searchParams.get('hitsPerPage'), '20');
  assert.equal(request.searchParams.get('tags'), 'story');
  assert.equal(request.searchParams.get('attributesToRetrieve'), 'objectID,title,url,created_at');
  assert.equal(request.searchParams.get('query'), 'test & query');
  assert.equal(results.length, 1);
  assert.equal(results[0].hnId, '123');
  assert.equal(results[0].metadata.hnId, '123');
  assert.equal(results[0].publishedAt, '2025-01-01');
  assert.deepEqual(await connector.search('none', { limit: 0 }), []);
});

test('1000 kids and max2 make exactly two comment requests, preserving post', async () => {
  const kids = Array.from({ length: 1000 }, (_, i) => i + 2);
  const { connector, calls } = fixture({ 1: story({ kids, descendants: 1000 }), 2: comment(2), 3: comment(3) });
  const result = await connector.read(item, { maxComments: 2 });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.match(result.content, /Post preserved/);
  assert.equal(result.comments_selected_count, 2);
  assert.equal(result.comments_available_count, 1000);
  assert.equal(result.comment_nodes_count, 2);
  assert.equal(result.evidence.comment_nodes_count, 2);
  assert.equal(result.attempted_count, 2);
  assert.equal(result.fetched_count, 2);
  assert.equal(result.pendingCommentIds.length, 200);
  assert.equal(result.truncated, true);
});

test('max0 only reads story and does not invent available count', async () => {
  const { connector, calls } = fixture({ 1: story({ kids: [2] }) });
  const result = await connector.read(item, { maxComments: 0 });
  assert.deepEqual(calls, [1]);
  assert.equal(result.comments_selected_count, 0);
  assert.equal(Object.hasOwn(result, 'comments_available_count'), false);
  assert.equal(result.comments_count_scope, 'hn_reported_descendants');
  assert.deepEqual(result.pendingCommentIds, ['2']);
});

test('individual truncated JSON failure preserves post and successful comments', async () => {
  const { connector } = fixture({ 1: story({ kids: [2, 3, 4] }), 2: comment(2), 3: new Error('JSON response truncated or oversized'), 4: comment(4) });
  const result = await connector.read(item, { maxComments: 3 });
  assert.deepEqual(result.comments.map(x => x.id), [2, 4]);
  assert.match(result.content, /Body/);
  assert.equal(result.attempted_count, 3);
  assert.equal(result.fetched_count, 2);
  assert.match(result.errors[0].message, /JSON response truncated/);
  assert.equal(result.truncated, true);
});

test('BFS preserves nested relationships and explicit HTML metadata', async () => {
  const { connector, calls } = fixture({ 1: story({ kids: [2, 3] }), 2: comment(2, 1, { kids: [4] }), 3: comment(3), 4: comment(4, 2) });
  const result = await connector.read(item);
  assert.deepEqual(calls, [1, 2, 3, 4]);
  const child = result.comments[0].children[0];
  assert.equal(child.parent_id, 2);
  assert.equal(child.author, 'reader');
  assert.equal(child.text_format, 'html');
  assert.equal(child.createdAt, '2023-11-14T22:13:20.000Z');
  assert.equal(result.comment_nodes_count, 3);
});

test('invalid, cyclic, duplicate and mismatched nodes never expand', async () => {
  const { connector, calls } = fixture({
    1: story({ kids: [1, 2, 2, '9007199254740992', 'bad', 3, 4] }),
    2: comment(2, 1, { kids: [1, 2] }), 3: comment(3, 9, { kids: [5] }), 4: comment(8),
  });
  const result = await connector.read(item);
  assert.deepEqual(calls, [1, 2, 3, 4]);
  assert.equal(result.comments_selected_count, 1);
  assert.equal(result.skipped_count, 2);
  assert.equal(result.errors.length, 2);
  assert.equal(result.truncated, true);
  await assert.rejects(connector.read({ hnId: '9007199254740992' }), /Invalid/);
  await assert.rejects(fixture({ 1: comment(1) }).connector.read(item), /Invalid Hacker News story/);
});

test('deleted, dead and null are skipped rather than counted as read comments', async () => {
  const { connector } = fixture({ 1: story({ kids: [2, 3, 4, 5] }), 2: comment(2, 1, { deleted: true, kids: [6] }), 3: null, 4: comment(4, 1, { dead: true }), 5: comment(5), 6: comment(6, 2) });
  const result = await connector.read(item);
  assert.equal(result.skipped_count, 3);
  assert.equal(result.fetched_count, 5);
  assert.equal(result.comments_selected_count, 2);
  assert.equal(result.comments[1].parent_id, 2);
});

test('article errors preserve discussion', async () => {
  const { connector } = fixture({ 1: story({ url: 'https://example.com', kids: [2] }), 2: comment(2) }, { readArticle: async () => { throw new Error('Article unavailable'); } });
  const result = await connector.read(item);
  assert.equal(result.comments.length, 1);
  assert.match(result.content, /Post preserved/);
  assert.equal(result.errors[0].stage, 'article');
  assert.equal(result.truncated, true);
});

test('batch concurrency is at most two and default budget is exactly 40', async () => {
  let active = 0, peak = 0;
  const connector = createHackerNewsConnector({ json: async url => {
    const id = Number(url.match(/\/(\d+)\.json$/)[1]);
    if (id === 1) return story({ kids: Array.from({ length: 60 }, (_, i) => i + 2) });
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return comment(id);
  } });
  const result = await connector.read(item);
  assert.equal(peak, 2);
  assert.equal(result.attempted_count, 40);
  assert.equal(result.comments_selected_count, 40);
});

test('injected deadline abort returns selected partial comments and stops future batches', async () => {
  const controller = new AbortController();
  const { connector, calls } = fixture({ 1: story({ kids: [2, 3, 4, 5, 6] }), 2: comment(2), 3: comment(3),
    4: () => { controller.abort(new Error('selected deadline exceeded')); throw controller.signal.reason; },
    5: () => { throw controller.signal.reason; },
  });
  const result = await connector.read(item, { signal: controller.signal });
  assert.deepEqual(calls, [1, 2, 3, 4, 5]);
  assert.equal(result.comments_selected_count, 2);
  assert.equal(result.attempted_count, 4);
  assert.deepEqual(result.pendingCommentIds, ['4', '5', '6']);
  assert.match(result.errors[0].message, /deadline/);
  assert.equal(result.truncated, true);
});

test('text, aggregate, pending, queue and maximum attempt limits are bounded', async () => {
  const connector = createHackerNewsConnector({ json: async url => {
    const id = Number(url.match(/\/(\d+)\.json$/)[1]);
    return id === 1 ? story({ text: 's'.repeat(110000), kids: Array.from({ length: 1500 }, (_, i) => i + 2) }) : comment(id, 1, { text: 'x'.repeat(9000) });
  } });
  const result = await connector.read(item, { maxComments: 500 });
  assert.equal(result.attempted_count, 200);
  assert.equal(result.content.length, 100000);
  assert.equal(result.comments.reduce((sum, node) => sum + node.text.length, 0), 64000);
  assert.equal(result.comments[0].text.length, 8000);
  assert.equal(result.pendingCommentIds.length, 200);
  assert.equal(result.truncated, true);
});
