import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedditConnector } from './reddit.mjs';
import { createScheduler } from './scheduler.mjs';
const comment = id => ({ kind: 't1', data: { id, parent_id: 't3_abc', link_id: 't3_abc', body: 'Comment', author: 'fixture' } });
const more = children => ({ kind: 'more', data: { id: 'more', parent_id: 't3_abc', link_id: 't3_abc', children } });
const listing = children => ({ data: { children } });
const thread = children => [listing([{ kind: 't3', data: { id: 'abc', title: 'Link post title', selftext: '', num_comments: 2 } }]), listing(children)];
const expand = things => ({ json: { data: { things } } });
function fixture(responses) {
  const requests = [];
  const c = createRedditConnector({ env: { REDDIT_ACCESS_TOKEN: 'fixture', REDDIT_USER_AGENT: 'fixture-test/1.0' }, scheduler: createScheduler(), fetchImpl: async url => { requests.push(new URL(url)); assert.ok(responses.length); return Response.json(responses.shift()); } });
  return { c, requests };
}
test('expansion producing another marker continues without repeating attempted IDs', async () => {
  const { c, requests } = fixture([thread([more(['one'])]), expand([more(['two'])]), expand([comment('two')])]);
  const result = await c.read({ url: 'https://www.reddit.com/comments/abc' });
  assert.equal(result.moreCalls, 2); assert.equal(result.selectedCommentCount, 1);
  assert.equal(requests[2].searchParams.get('children'), 'two');
  assert.equal(result.content, 'Link post title');
});
test('missing requested comment is expanded within the same read', async () => {
  const { c, requests } = fixture([thread([]), expand([comment('one')])]);
  const result = await c.read({ reddit: { postId: 'abc', commentId: 'one' } });
  assert.equal(result.selectedCommentCount, 1); assert.equal(result.comments[0].id, 'one');
  assert.equal(requests[1].pathname, '/api/morechildren');
});
test('large trees are bounded independently of saved comment count', async () => {
  const children = Array.from({ length: 3000 }, (_, i) => comment(`a${i}`));
  const { c, requests } = fixture([thread(children)]);
  const result = await c.read({ reddit: { postId: 'abc' } }, { maxComments: 1 });
  assert.equal(result.selectedCommentCount, 1); assert.equal(requests.length, 1);
  assert.equal(result.truncated, true); assert.ok(result.continuation.children.length <= 200);
});
