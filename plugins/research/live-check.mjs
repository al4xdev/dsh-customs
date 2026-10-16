// Explicit, bounded public-network smoke. No private keys, paid X API or profile activation.
import { resolveHost } from '../common.mjs';
import { createConnectors } from './connectors.mjs';
import { createEngine } from './engine.mjs';
const { HttpFetchProvider, DEFAULT_USER_AGENT } = await import(resolveHost('@deepseek-ai/dsh-web-fetch-http'));
const provider = new HttpFetchProvider({ maxResponseBytes: 2000000, maxBodyChars: 300000, timeoutMs: 20000, maxRedirects: 3, userAgent: DEFAULT_USER_AGENT });
const web = { fetch: (request, signal) => provider.fetch(request, signal), search: async () => { throw new Error('Web backend deliberately unavailable in isolated public smoke; test partial-failure reporting'); } };
const engine = createEngine({ connectors: createConnectors({ web }) });
const context = { cwd: process.cwd(), owner: 'research-live-check', signal: AbortSignal.timeout(85000) };
const c = await engine.execute({ action: 'config', config: { sources: ['web', 'hackernews', 'grep', 'context7'], maxDurationMs: 75000, resultsPerSource: 1, readsPerSource: 1, maxComments: 3 } }, context);
const result = await engine.execute({ action: 'search', config_id: c.config_id, query: 'useState', library: '/react/react', title: 'Research public connector smoke' }, context);
console.log(JSON.stringify(result, null, 2));
for (const ref of result.references) {
  const inspected = await engine.execute({ action: 'inspect', run_id: result.run_id, ref: ref.ref, limit: 160 }, context);
  console.log(JSON.stringify({ source: ref.source, kind: ref.kind, recovered: inspected.content.length, total: inspected.total }));
}
if (!result.errors.some(e => e.source === 'web')) throw new Error('Expected explicit isolated web failure');
if (!result.evidence_count) process.exitCode = 1;
