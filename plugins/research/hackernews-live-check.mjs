// Opt-in bounded public smoke; never prints the fetched discussion or article.
import { writeFile } from 'node:fs/promises';
import { resolveHost } from '../common.mjs';
import { createConnectors } from './connectors.mjs';
import { createEngine } from './engine.mjs';
const { HttpFetchProvider, DEFAULT_USER_AGENT } = await import(resolveHost('@deepseek-ai/dsh-web-fetch-http'));
const provider = new HttpFetchProvider({ maxResponseBytes: 5000000, maxBodyChars: 100000, timeoutMs: 20000, maxRedirects: 3, userAgent: DEFAULT_USER_AGENT });
const requests = [];
const web = { search: async () => { throw new Error('Unexpected web search'); }, fetch: async (request, signal) => { const response = await provider.fetch(request, signal); requests.push({ url: request.url, truncated: response.truncated, chars: response.body.content.length }); return response; } };
const connectors = createConnectors({ web });
const engine = createEngine({ connectors });
const ctx = { cwd: process.cwd(), owner: 'hackernews-incremental-smoke', signal: AbortSignal.timeout(90000) };
const config = await engine.execute({ action: 'config', config: { sources: ['hackernews'], maxComments: 4, resultsPerSource: 1, readsPerSource: 1, maxDurationMs: 70000 } }, ctx);
const result = await engine.execute({ action: 'search', config_id: config.config_id, query: 'GPT-4', title: 'HN incremental large-topic regression' }, ctx);
const ref = result.references[0]?.ref;
if (!ref || result.coverage.hackernews.read !== 1) throw new Error(`HN smoke failed: ${JSON.stringify(result.errors)}`);
const inspected = await engine.execute({ action: 'inspect', run_id: result.run_id, ref, section: 'comments', limit: 160 }, ctx);
const id = new URL(result.references[0].url).searchParams.get('id');
// Reproduce the former path once under the SAME native body cap. Not used as evidence.
let former;
try {
  const old = await provider.fetch({ url: `https://hn.algolia.com/api/v1/items/${id}` }, ctx.signal);
  former = { status: old.statusCode, truncated: old.truncated, chars: old.body.content.length };
} catch (error) { former = { error: String(error.message).slice(0, 250) }; }
const report = { run_id: result.run_id, topic: result.references[0].url, former_whole_tree: former, incremental: { reads: result.coverage.hackernews.read, selected_comments: inspected.metadata.comments_selected_count, reported_descendants: inspected.metadata.comments_available_count, recovered_sample_chars: inspected.content.length, requests: requests.length, item_requests: requests.filter(r => r.url.startsWith('https://hacker-news.firebaseio.com/')).length, errors: result.errors }, node_response_max_chars: Math.max(0, ...requests.filter(r => r.url.startsWith('https://hacker-news.firebaseio.com/')).map(r => r.chars)) };
await writeFile('.dumps/hackernews-incremental-smoke.json', JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (!(report.incremental.selected_comments > 0)) process.exitCode = 1;
