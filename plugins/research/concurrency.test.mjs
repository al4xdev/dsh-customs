import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createScheduler } from './scheduler.mjs';
import { buildConnectors } from './connectors.mjs';
import { createEngine } from './engine.mjs';
const exec = promisify(execFile);
const page = content => ({ url: 'https://example.org/', statusCode: 200, body: { kind: 'text', content }, truncated: false });
async function workspace(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'research-integration-'));
  t.after(async () => { assert.ok(cwd.startsWith(path.join(os.tmpdir(), 'research-integration-'))); await fs.rm(cwd, { recursive: true, force: true }); });
  await exec('git', ['init', '--quiet'], { cwd });
  await fs.writeFile(path.join(cwd, '.gitignore'), '.dumps/\n');
  return cwd;
}

test('navigation inspection recovers IDs beyond the compact ten-ID preview', async t => {
  const { openStore } = await import('./store.mjs');
  const cwd = await workspace(t), store = await openStore(cwd, 'nav');
  const run = await store.createRun('Navigation test', {});
  const children = Array.from({ length: 30 }, (_, i) => `a${i}`);
  const { ref } = await store.saveEvidence(run.id, { content: 'Post', continuation: { postId: 'abc', children } });
  const preview = await store.inspect(run.id, { ref });
  assert.equal(preview.metadata.continuation.children.length, 10);
  const full = await store.inspect(run.id, { ref, section: 'navigation' });
  assert.deepEqual(JSON.parse(full.content).continuation.children, children);
});

test('many searches across connector instances and X share two backend workers', async () => {
  const scheduler = createScheduler();
  let active = 0, peak = 0, count = 0;
  const web = { async search() { peak = Math.max(peak, ++active); await delay(5); active--; count++; return { sources: [] }; } };
  const a = buildConnectors(web, { scheduler, redditEnv: {} });
  const b = buildConnectors(web, { scheduler, redditEnv: {} });
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a.web : b.x).search('same backend', {})));
  assert.equal(count, 12); assert.equal(peak, 2); assert.equal(scheduler.stats('web-search').active, 0);
});

test('web quota cools queued X work but does not block Hacker News', async () => {
  const scheduler = createScheduler();
  let searches = 0;
  const c = buildConnectors({ async search() { searches++; throw new Error('HTTP 429'); }, async fetch() { return page(JSON.stringify({ hits: [] })); } }, { scheduler, workers: 1, redditEnv: {} });
  const results = await Promise.allSettled([c.web.search('q', {}), c.x.search('q', {}), c.hackernews.search('q', {})]);
  assert.equal(searches, 1); assert.equal(results[1].reason.code, 'RATE_LIMIT'); assert.equal(results[2].status, 'fulfilled');
});

test('distinct persisted runs advance concurrently with bounded backend calls', async t => {
  const cwd = await workspace(t), scheduler = createScheduler();
  let active = 0, peak = 0;
  const connectors = buildConnectors({
    async search({ query }) { peak = Math.max(peak, ++active); await delay(5); active--; return { sources: [{ url: `https://example.org/${query}`, title: query }] }; },
    async fetch() { return page('bounded document'); },
  }, { scheduler, redditEnv: {} });
  const engine = createEngine({ connectors });
  const ctx = { cwd, owner: 'integration', signal: AbortSignal.timeout(10000) };
  const config = await engine.execute({ action: 'config', config: { sources: ['web'], resultsPerSource: 1, readsPerSource: 1 } }, ctx);
  const runs = await Promise.all(['one', 'two', 'three'].map(query => engine.execute({ action: 'search', config_id: config.config_id, query }, ctx)));
  assert.equal(new Set(runs.map(r => r.run_id)).size, 3); assert.equal(peak, 2);
  assert.ok(runs.every(r => r.evidence_count === 1 && r.budget.pages === 1 && r.budget.queries === 1));
});

test('official subreddit navigation persists partial comments, errors and expansion cursor', async t => {
  const cwd = await workspace(t), scheduler = createScheduler();
  const post = { kind: 't3', data: { id: 'abc', title: 'Actual title', selftext: 'Post text', subreddit: 'testing', num_comments: 2 } };
  const listing = children => ({ data: { children, after: null } });
  const comment = { kind: 't1', data: { id: 'one', parent_id: 't3_abc', link_id: 't3_abc', author: 'reader', body: 'First response', created_utc: 123 } };
  const more = { kind: 'more', data: { id: 'more', parent_id: 't3_abc', count: 1, children: ['two'] } };
  const calls = [];
  const connectors = buildConnectors({ search() { throw new Error('No fallback'); } }, { scheduler, redditEnv: { REDDIT_ACCESS_TOKEN: 'fixture-secret', REDDIT_USER_AGENT: 'research-test/1.0 fixture' }, fetchReddit: async input => {
    const url = new URL(input); calls.push(url.pathname);
    if (url.pathname === '/r/testing/new') return Response.json(listing([post]));
    if (url.pathname === '/comments/abc') return Response.json([listing([post]), listing([comment, more])]);
    assert.equal(url.pathname, '/api/morechildren');
    return Response.json({}, { status: 429, headers: { 'retry-after': '1' } });
  } });
  const engine = createEngine({ connectors }), ctx = { cwd, owner: 'reddit-test', signal: AbortSignal.timeout(10000) };
  const config = await engine.execute({ action: 'config', config: { sources: ['reddit'], resultsPerSource: 1, readsPerSource: 1, maxComments: 3 } }, ctx);
  const run = await engine.execute({ action: 'search', config_id: config.config_id, reddit: { mode: 'subreddit', subreddit: 'testing', sort: 'new' } }, ctx);
  assert.equal(run.evidence_count, 1); assert.equal(run.coverage.reddit.read, 1); assert.ok(run.coverage.reddit.partial);
  const ref = run.references[0].ref;
  const content = await engine.execute({ action: 'inspect', run_id: run.run_id, ref }, ctx);
  assert.equal(content.content, 'Post text'); assert.equal(content.metadata.selectedCommentCount, 1);
  const comments = await engine.execute({ action: 'inspect', run_id: run.run_id, ref, section: 'comments' }, ctx);
  assert.match(comments.content, /First response/);
  const navigation = await engine.execute({ action: 'inspect', run_id: run.run_id, ref, section: 'navigation' }, ctx);
  assert.deepEqual(JSON.parse(navigation.content).continuation.children, ['two']);
  assert.ok(!JSON.stringify([run, content, comments, navigation]).includes('fixture-secret'));
  assert.deepEqual(calls, ['/r/testing/new', '/comments/abc', '/api/morechildren']);
});
