import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectors, createConnectors, fixedOriginFetch } from './connectors.mjs';
import { createScheduler } from './scheduler.mjs';

const unavailableWeb = { search() { throw new Error('Unexpected web search'); }, fetch() { throw new Error('Unexpected web fetch'); } };
function fixture(handler = () => ({ content: [{ type: 'text', text: 'excerpt' }] }), extra = {}) {
  const events = [];
  class Client {
    async connect(transport, options) { events.push(['connect', transport, options]); }
    async listTools(args, options) { events.push(['list', args, options]); return { tools: ['searchGitHub', 'resolve-library-id', 'query-docs'].map(name => ({ name, inputSchema: { type: 'object' } })) }; }
    async callTool(args, options) { events.push(['call', args, options]); return handler(args, options); }
    async close() { events.push(['close']); }
  }
  class StreamableHTTPClientTransport { constructor(url, options) { this.url = url; this.options = options; } }
  const deps = { scheduler: createScheduler(), redditEnv: {}, loadMcp: async () => ({ Client, StreamableHTTPClientTransport }), fetchMcp: () => { throw new Error('Network forbidden'); }, formatHtml: async response => `converted:${response.body.content}`, ...extra };
  return { connectors: buildConnectors(extra.web ?? unavailableWeb, deps), events };
}
const response = (content, kind = 'text') => ({ url: 'https://example.org/', statusCode: 200, body: { kind, content }, truncated: false });

test('public factory exposes exact six connectors without opening any connection', () => {
  const connectors = createConnectors({ web: unavailableWeb });
  assert.deepEqual(Object.keys(connectors), ['web', 'reddit', 'x', 'hackernews', 'grep', 'context7']);
  for (const connector of Object.values(connectors)) { assert.equal(typeof connector.search, 'function'); assert.equal(typeof connector.read, 'function'); assert.ok(connector.capability.mode); }
});

test('web-index fallbacks use real service shape, bounds, signals and explicit limitations', async () => {
  const signal = new AbortController().signal;
  const searches = [];
  const { connectors } = fixture(undefined, { web: {
    async search(args, received) { searches.push(args); assert.equal(received, signal); return { sources: [{ url: 'https://example.org', title: 'A', snippet: 's' }, { url: 'https://example.net' }], truncated: true }; },
    async fetch(args, received) { assert.equal(received, signal); return response('<p>Hello</p>', 'html'); },
  } });
  for (const [name, domain] of [['x', 'x.com']]) {
    assert.equal(connectors[name].capability.mode, 'web-index');
    const items = await connectors[name].search('topic', { signal, limit: 1 });
    assert.equal(items.length, 1); assert.equal(items[0].kind, 'search_snippet');
    assert.deepEqual(searches.at(-1), { query: `site:${domain} topic`, maxResults: 1 });
    const read = await connectors[name].read(items[0], { signal });
    assert.equal(read.content, 'converted:<p>Hello</p>'); assert.match(read.limitations[0], /does not establish complete/);
  }
});

test('public factory converts HTML through actual host formatter without network', async () => {
  const connectors = createConnectors({ web: { fetch: async () => response('<html><body><h1>Real heading</h1><p>Readable text</p></body></html>', 'html') } });
  const item = await connectors.web.read({ url: 'https://example.org' });
  assert.match(item.content, /Real heading/); assert.match(item.content, /Readable text/); assert.doesNotMatch(item.content, /<h1>/);
});

test('pre-aborted indexed search never invokes backend', async () => {
  const controller = new AbortController(); controller.abort(new Error('already stopped'));
  const { connectors } = fixture();
  await assert.rejects(connectors.web.search('query', { signal: controller.signal }), /already stopped/);
});

test('web HTTP failure is thrown so engine retains search snippet', async () => {
  const { connectors } = fixture(undefined, { web: { fetch: async () => ({ statusCode: 429 }) } });
  await assert.rejects(connectors.web.read({ url: 'https://example.org', snippet: 'keep me' }), /HTTP 429/);
});

test('HN searches stories and preserves bounded tree when article fetch fails', async () => {
  const requests = [];
  const { connectors } = fixture(undefined, { web: { async fetch({ url }) {
    requests.push(url);
    if (url.includes('/search?')) return response(JSON.stringify({ hits: [{ objectID: '12', title: 'Story', url: 'https://example.org/article' }] }));
    if (url.endsWith('/item/12.json')) return response(JSON.stringify({ id: 12, type: 'story', title: 'Story', text: 'body', url: 'https://example.org/article', kids: [1], descendants: 3 }));
    if (url.endsWith('/item/1.json')) return response(JSON.stringify({ id: 1, type: 'comment', parent: 12, text: 'one', kids: [2, 3] }));
    if (url.endsWith('/item/2.json')) return response(JSON.stringify({ id: 2, type: 'comment', parent: 1, text: 'two' }));
    throw new Error('HTTP 503');
  } } });
  const [item] = await connectors.hackernews.search('a b', { limit: 1 });
  assert.equal(new URL(requests[0]).searchParams.get('query'), 'a b');
  assert.ok(new URL(requests[0]).searchParams.has('attributesToRetrieve'));
  const read = await connectors.hackernews.read(item, { maxComments: 2 });
  assert.equal(read.comments.length, 1); assert.equal(read.comments[0].children[0].id, 2);
  assert.equal(read.comment_nodes_count, 2);
  assert.equal(read.comments_selected_count, 2); assert.equal(read.comments_available_count, 3);
  assert.equal(read.comments[0].children[0].text_format, 'html');
  assert.equal(read.truncated, true); assert.match(read.content, /body/); assert.equal(read.errors[0].stage, 'article');
});

test('HN large topic needs only a post fetch when zero comments are requested', async () => {
  const requests = [];
  const { connectors } = fixture(undefined, { web: { fetch: async ({url}) => {
    requests.push(url);
    return response(JSON.stringify({ id: 1, type: 'story', title: 'Story', text: 'retained', kids: Array.from({length: 1000}, (_,i) => i+2), descendants: 20000 }));
  } } });
  const empty = await connectors.hackernews.read({ hnId: '1' }, { maxComments: 0 });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].startsWith('https://hacker-news.firebaseio.com/'));
  assert.equal(empty.comments_selected_count, 0); assert.equal(empty.comments_available_count, 20000); assert.equal(empty.truncated, true);
  assert.match(empty.content, /retained/);
});

test('HN rejects truncated JSON rather than pretending tree is complete', async () => {
  const { connectors } = fixture(undefined, { web: { fetch: async () => ({ ...response('{}'), truncated: true }) } });
  await assert.rejects(connectors.hackernews.read({ hnId: '1' }), /truncated/);
});

test('grep discovers tool schema, forwards options, preserves provenance, closes each call', async () => {
  const { connectors, events } = fixture(() => ({ content: [{ type: 'text', text: 'code at https://github.com/a/b/blob/main/x.js' }] }));
  const [item] = await connectors.grep.search('function foo', { limit: 2 });
  assert.equal(item.kind, 'code_excerpt'); assert.equal(item.url, 'https://github.com/a/b/blob/main/x.js'); assert.equal(item.provenance, 'https://mcp.grep.app');
  const call = events.find(x => x[0] === 'call');
  assert.deepEqual(call[1], { name: 'searchGitHub', arguments: { query: 'function foo' } });
  assert.equal(call[2].toolDefinition.name, 'searchGitHub'); assert.equal(call[2].timeout, 25000); assert.ok(call[2].signal);
  assert.equal(events.at(-1)[0], 'close');
  assert.equal((await connectors.grep.read(item)).kind, 'code_excerpt');
  assert.equal(events.filter(x => x[0] === 'connect').length, 1);
});

test('grep forwards only typed filters and preserves literal code query', async () => {
  const { connectors, events } = fixture();
  const filters = { repo: 'facebook/react', language: ['TypeScript', 'JavaScript'], path: 'src/', matchCase: true, useRegexp: false };
  const [item] = await connectors.grep.search('useState(', { filters });
  assert.deepEqual(events.find(x => x[0] === 'call')[1].arguments, { query: 'useState(', ...filters });
  assert.deepEqual(item.filters, filters);
});

test('grep rejects unknown and ill-typed filters before opening MCP', async () => {
  const { connectors, events } = fixture();
  for (const filters of [null, [], 'repo', { unknown: 'x' }, { query: 'override' }, { repo: [] }, { path: '' }, { matchCase: 'true' }, { useRegexp: 1 }, { language: 'JavaScript' }, { language: [] }, { language: [2] }, { language: Array(21).fill('JS') }, { repo: 'x'.repeat(501) }]) {
    await assert.rejects(connectors.grep.search('code', { filters }), /filter/);
  }
  assert.equal(events.length, 0);
});

test('MCP isError becomes error and still closes session', async () => {
  const { connectors, events } = fixture(() => ({ isError: true, content: [{ type: 'text', text: 'rate limit 429' }] }));
  await assert.rejects(connectors.grep.search('query'), /429/); assert.equal(events.at(-1)[0], 'close');
});

test('Context7 requires library and rejects ambiguous resolution without choosing', async () => {
  const { connectors, events } = fixture(() => ({ content: [{ type: 'text', text: 'Library ID: /a/lib\nLibrary ID: /b/lib' }] }));
  await assert.rejects(connectors.context7.search('query'), /explicit library/); assert.equal(events.length, 0);
  await assert.rejects(connectors.context7.search('query', { library: 'lib' }), /ambiguous/);
  assert.equal(events.filter(x => x[0] === 'call').length, 1); assert.equal(events.at(-1)[0], 'close');
});

test('Context7 resolves unique ID and returns document excerpt, not fabricated source URL', async () => {
  const { connectors, events } = fixture(({ name }) => ({ content: [{ type: 'text', text: name === 'resolve-library-id' ? 'Context7-compatible library ID: /org/lib' : 'Documentation only' }] }));
  const [item] = await connectors.context7.search('usage', { library: 'lib' });
  assert.equal(item.url, 'https://mcp.context7.com/mcp'); assert.equal(item.kind, 'document_excerpt'); assert.equal(item.libraryId, '/org/lib');
  assert.deepEqual(events.filter(x => x[0] === 'call').at(-1)[1], { name: 'query-docs', arguments: { libraryId: '/org/lib', query: 'usage' } });
});

test('Context7 optional key only enters authorization and is redacted from provider echoes', async () => {
  const previous = process.env.CONTEXT7_API_KEY;
  process.env.CONTEXT7_API_KEY = 'test-secret-not-for-results';
  try {
    const { connectors, events } = fixture(() => ({ content: [{ type: 'text', text: `echo ${process.env.CONTEXT7_API_KEY}` }] }));
    const [item] = await connectors.context7.search('usage', { library: '/org/lib' });
    assert.equal(events[0][1].options.requestInit.headers.Authorization, 'Bearer test-secret-not-for-results');
    assert.ok(!JSON.stringify(item).includes('test-secret-not-for-results'));
  } finally { if (previous === undefined) delete process.env.CONTEXT7_API_KEY; else process.env.CONTEXT7_API_KEY = previous; }
});

test('MCP abort stops waiting on uncooperative provider and closes session', async () => {
  const controller = new AbortController();
  const { connectors, events } = fixture(() => { controller.abort(new Error('caller cancelled')); return new Promise(() => {}); });
  await assert.rejects(connectors.grep.search('query', { signal: controller.signal }), /cancelled/);
  assert.equal(events.at(-1)[0], 'close');
});

test('fixed-origin MCP fetch blocks off-origin, credentials, redirects and oversized bodies', async () => {
  let calls = 0;
  const safe = fixedOriginFetch('https://mcp.grep.app', async (_input, init) => { calls++; assert.equal(init.redirect, 'error'); return new Response('ok'); });
  for (const url of ['http://mcp.grep.app', 'https://evil.test/', 'https://user:pass@mcp.grep.app']) await assert.rejects(safe(url), /not allowed/);
  assert.equal(calls, 0); assert.equal(await (await safe('https://mcp.grep.app')).text(), 'ok');
  await assert.rejects(fixedOriginFetch('https://mcp.grep.app', async () => new Response('', { status: 302 }))('https://mcp.grep.app'), /redirects/);
  const oversized = await fixedOriginFetch('https://mcp.grep.app', async () => new Response('x'.repeat(2_000_001)))('https://mcp.grep.app');
  await assert.rejects(oversized.text(), /byte limit/);
});
