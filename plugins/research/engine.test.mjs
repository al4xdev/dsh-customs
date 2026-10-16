import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, configure, safeError } from './engine.mjs';

function fixture(connectors) {
  const configs = new Map(), runs = new Map(), evidence = new Map();
  let id = 0;
  const store = {
    async saveConfig(c) { const key = `c-${++id}`; configs.set(key, structuredClone(c)); return key; },
    async loadConfig(id) { return structuredClone(configs.get(id)); },
    async createRun(title, config) { const r = { id: `r-${++id}`, title, config, evidence: [] }; runs.set(r.id, structuredClone(r)); return r; },
    async readRun(id) { return structuredClone(runs.get(id)); },
    async writeRun(id, run) { runs.set(id, structuredClone(run)); },
    async event() {},
    async saveEvidence(run, value) { const ref = `e-${++id}`; evidence.set(ref, structuredClone(value)); return { ref, metadata: { url: value.url } }; },
    async inspect(_run, { ref }) { return evidence.get(ref); },
  };
  const engine = createEngine({ connectors, storeFactory: async () => store });
  const context = { cwd: '/fixture', owner: 'session', signal: new AbortController().signal };
  return { call: args => engine.execute(args, context), context, runs, evidence };
}
const connector = (name, overrides = {}) => ({
  capability: { mode: 'fixture' },
  async search(q) { return [{ url: `https://example.org/${name}/${encodeURIComponent(q)}`, title: name, snippet: 'snippet' }]; },
  async read(item) { return { ...item, content: 'actual content', kind: 'document_excerpt' }; },
  ...overrides,
});

test('configuration rejects elevated budgets and unknown fields', () => {
  assert.throws(() => configure({ maxPages: 1000 }));
  assert.throws(() => configure({ sources: ['web', 'web'] }));
  assert.throws(() => configure({ token: 'secret' }));
  assert.throws(() => configure({ readsPerSource: 3, resultsPerSource: 2 }));
});

test('one rate limited provider does not discard another source and automatic reading', async () => {
  const f = fixture({ web: connector('web'), x: connector('x', { async search() { throw new Error('HTTP 429 quota reached'); } }) });
  const c = await f.call({ action: 'config', config: { sources: ['web', 'x'] } });
  const result = await f.call({ action: 'search', config_id: c.config_id, query: 'news' });
  assert.equal(result.evidence_count, 1);
  assert.equal(result.coverage.web.read, 1);
  assert.equal(result.errors[0].source, 'x');
  assert.equal(result.errors[0].code, 'RATE_LIMIT');
  assert.equal(result.references[0].kind, 'document_excerpt');
  assert.ok(!JSON.stringify(result).includes('actual content'));
});

test('reading failure persists snippet with explicit error, not full-document claim', async () => {
  const f = fixture({ reddit: connector('reddit', { async read() { throw new Error('HTTP 403 blocked'); } }) });
  const c = await f.call({ action: 'config', config: { sources: ['reddit'] } });
  const r = await f.call({ action: 'search', config_id: c.config_id, query: 'test' });
  assert.equal(r.references[0].kind, 'snippet');
  assert.equal(r.coverage.reddit.read, 0);
  assert.equal(r.errors[0].code, 'BLOCKED');
});

test('continue shares budget and deduplicates already seen URLs', async () => {
  const f = fixture({ web: connector('web') });
  const c = await f.call({ action: 'config', config: { sources: ['web'], maxQueries: 2 } });
  const first = await f.call({ action: 'search', config_id: c.config_id, query: 'same' });
  const next = await f.call({ action: 'continue', run_id: first.run_id, query: 'same' });
  assert.equal(next.evidence_count, 1);
  assert.equal(next.budget.queries, 2);
  assert.equal(next.budget.pages, 1);
  const end = await f.call({ action: 'continue', run_id: first.run_id, query: 'new' });
  assert.equal(end.reason, 'budget_exhausted');
  assert.equal(end.budget.queries, 2);
});

test('a source timeout returns other evidence without waiting indefinitely', async () => {
  const f = fixture({ web: connector('web'), x: connector('x', { async search() { return new Promise(() => {}); } }) });
  const c = await f.call({ action: 'config', config: { sources: ['web', 'x'], operationTimeoutMs: 20 } });
  const r = await f.call({ action: 'search', config_id: c.config_id, query: 'test' });
  assert.equal(r.evidence_count, 1);
  assert.equal(r.errors[0].code, 'TIMEOUT');
});

test('partial reader errors preserve text and surface source warning', async () => {
  const f = fixture({ hackernews: connector('hn', { async read(item) { return { ...item, content: 'post plus some comments', kind: 'thread_partial', errors: [{ message: 'HTTP 429 comments page' }] }; } }) });
  const c = await f.call({ action: 'config', config: { sources: ['hackernews'] } });
  const r = await f.call({ action: 'search', config_id: c.config_id, query: 'test' });
  assert.equal(r.coverage.hackernews.read, 1);
  assert.equal(r.coverage.hackernews.partial, true);
  assert.equal(r.errors[0].stage, 'read_partial');
  assert.equal(r.references[0].kind, 'thread_partial');
});

test('queries and useful data survive total provider failure as a report', async () => {
  const f = fixture({ web: connector('web', { async search() { throw new Error('HTTP 401 authorization required'); } }) });
  const c = await f.call({ action: 'config', config: { sources: ['web'] } });
  const r = await f.call({ action: 'search', config_id: c.config_id, query: 'test' });
  assert.equal(r.evidence_count, 0);
  assert.equal(r.errors[0].code, 'AUTH_REQUIRED');
});

test('a failed source cannot suppress another reader for the same URL', async () => {
  const item = { url: 'https://example.org/shared', snippet: 'discovery' };
  const f = fixture({ web: connector('web', { async search() { return [item]; }, async read() { throw new Error('HTTP 429'); } }), reddit: connector('reddit', { async search() { return [item]; } }) });
  const c = await f.call({ action: 'config', config: { sources: ['web', 'reddit'] } });
  const r = await f.call({ action: 'search', config_id: c.config_id, query: 'test' });
  assert.equal(r.coverage.reddit.read, 1);
  assert.equal(r.errors[0].source, 'web');
});

test('failed snippet remains eligible for a successful continuation', async () => {
  let fail = true;
  const f = fixture({ web: connector('web', { async read(item) { if (fail) throw new Error('HTTP 429'); return { ...item, content: 'now read', kind: 'web_page' }; } }) });
  const c = await f.call({ action: 'config', config: { sources: ['web'] } });
  const first = await f.call({ action: 'search', config_id: c.config_id, query: 'same' });
  fail = false;
  const next = await f.call({ action: 'continue', run_id: first.run_id, query: 'same' });
  assert.equal(next.coverage.web.read, 1);
  assert.equal(next.evidence_count, 2);
});

test('partial errors are sanitized before persistence as well as summary', async () => {
  const f = fixture({ web: connector('web', { async read(item) { return { ...item, content: 'safe body', kind: 'web_page', errors: [{ message: 'failed https://example.org/?token=private123' }] }; } }) });
  const c = await f.call({ action: 'config', config: { sources: ['web'] } });
  await f.call({ action: 'search', config_id: c.config_id, query: 'test' });
  assert.ok(!JSON.stringify([...f.evidence.values()]).includes('private123'));
});

test('errors scrub URL queries and bearer credentials', () => {
  const e = safeError(new Error('HTTP 429 https://example.org/path?token=abcdef Authorization: Bearer secret123'));
  assert.ok(!e.message.includes('abcdef'));
  assert.ok(!e.message.includes('secret123'));
});
