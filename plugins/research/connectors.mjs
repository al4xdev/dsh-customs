import { createRequire } from 'node:module';
import { resolveHost } from '../common.mjs';
import { sharedScheduler } from './scheduler.mjs';
import { createRedditConnector } from './reddit.mjs';
import { createHackerNewsConnector } from './hackernews.mjs';

const TEXT_LIMIT = 240_000;
const BYTE_LIMIT = 2_000_000;
const TIMEOUT = 25_000;
const ENDPOINTS = { grep: 'https://mcp.grep.app', context7: 'https://mcp.context7.com/mcp' };
const count = (n, fallback, max) => Number.isInteger(n) ? Math.max(0, Math.min(n, max)) : fallback;
const redact = (value) => {
  let text = String(value);
  if (process.env.CONTEXT7_API_KEY) text = text.split(process.env.CONTEXT7_API_KEY).join('[REDACTED]');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
};
const cleanError = error => redact(error?.message ?? error).slice(0, 500);
const urlsIn = text => [...new Set(text.match(/https?:\/\/[^\s<>"\])]+/g) ?? [])];

// This fetch is only for the two fixed MCP origins. Ordinary GETs use ctx.web's
// SSRF-safe service instead. Redirects and oversized streamed bodies are denied.
export function fixedOriginFetch(endpoint, fetchImpl = globalThis.fetch) {
  const origin = new URL(endpoint).origin;
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('MCP origin is not allowed');
    const response = await fetchImpl(input, { ...init, redirect: 'error' });
    if (response.status >= 300 && response.status < 400) throw new Error('MCP redirects are not allowed');
    if (Number(response.headers.get('content-length')) > BYTE_LIMIT) { await response.body?.cancel(); throw new Error('MCP response exceeds byte limit'); }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) { controller.close(); return; }
          bytes += part.value.byteLength;
          if (bytes > BYTE_LIMIT) { await reader.cancel(); throw new Error('MCP response exceeds byte limit'); }
          controller.enqueue(part.value);
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function loadMcp() {
  const require = createRequire(resolveHost('@deepseek-ai/dsh-mcp-client'));
  return import(require.resolve('@modelcontextprotocol/client'));
}
async function formatHtml(result) {
  const { formatFetchOutput } = await import(resolveHost('@deepseek-ai/dsh-tool-web'));
  return formatFetchOutput(result, TEXT_LIMIT);
}

async function withMcp(source, parent, deps, work) {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('MCP deadline exceeded')), TIMEOUT);
  const signal = controller.signal;
  let client, transport;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(signal.reason ?? new Error('MCP aborted')); signal.addEventListener('abort', rejectAbort, { once: true }); });
  try {
    return await Promise.race([aborted, (async () => {
      const { Client, StreamableHTTPClientTransport } = await deps.loadMcp();
      signal.throwIfAborted();
      const headers = source === 'context7' && process.env.CONTEXT7_API_KEY ? { Authorization: `Bearer ${process.env.CONTEXT7_API_KEY}` } : {};
      transport = new StreamableHTTPClientTransport(new URL(ENDPOINTS[source]), {
        requestInit: { headers, signal }, fetch: fixedOriginFetch(ENDPOINTS[source], (input, init) => deps.fetchMcp(input, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal })),
      });
      client = new Client({ name: 'dsh-research', version: '1.0.0' });
      await client.connect(transport, { signal, timeout: TIMEOUT });
      signal.throwIfAborted();
      const definitions = new Map();
      let cursor;
      for (let page = 0; page < 8; page++) {
        const listed = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: TIMEOUT });
        for (const tool of listed.tools ?? []) definitions.set(tool.name, tool);
        cursor = listed.nextCursor;
        if (!cursor) break;
      }
      return work(async (name, args) => {
        signal.throwIfAborted();
        const toolDefinition = definitions.get(name);
        if (!toolDefinition) throw new Error(`MCP tool unavailable: ${name}`);
        const result = await client.callTool({ name, arguments: args }, { signal, timeout: TIMEOUT, toolDefinition });
        if (result.isError) throw new Error(`MCP ${name}: ${mcpText(result)}`);
        return result;
      });
    })()]);
  } catch (error) { throw new Error(cleanError(error)); }
  finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    signal.removeEventListener('abort', rejectAbort);
    controller.abort(new Error('MCP operation finished'));
    // A malfunctioning close must not extend the provider deadline indefinitely.
    let closeTimer;
    try { await Promise.race([Promise.resolve().then(() => client ? client.close() : transport?.close()).catch(() => {}), new Promise(resolve => { closeTimer = setTimeout(resolve, 250); })]); }
    finally { clearTimeout(closeTimer); }
  }
}
function mcpText(result) {
  const text = (result.content ?? []).map(part => part.type === 'text' ? part.text : part.type === 'resource' ? part.resource?.text ?? '' : '').filter(Boolean).join('\n\n');
  return text || (result.structuredContent ? JSON.stringify(result.structuredContent) : '');
}
function excerpt(source, query, result) {
  const full = redact(mcpText(result));
  const urls = urlsIn(full);
  return { url: urls[0] ?? ENDPOINTS[source], title: `${source}: ${query}`, content: full.slice(0, TEXT_LIMIT), kind: source === 'grep' ? 'code_excerpt' : 'document_excerpt', provenance: ENDPOINTS[source], sourceUrls: urls, truncated: full.length > TEXT_LIMIT, limitations: ['MCP excerpt; not a full document or repository read.'] };
}

export function createConnectors({ web, workers = 2 }) { return buildConnectors(web, { loadMcp, formatHtml, fetchMcp: globalThis.fetch, workers }); }

// Explicit dependency seam keeps tests offline without changing the public factory contract.
export function buildConnectors(web, deps) {
  const scheduler = deps.scheduler ?? sharedScheduler;
  const workers = deps.workers ?? 2;
  if (![1, 2].includes(workers)) throw new Error('Research provider workers must be 1 or 2');
  async function scheduled(key, signal, task) {
    return scheduler.run(key, async () => {
      try { return await task(); }
      catch (error) {
        // Backends without headers still get a short shared cooldown, not a retry storm.
        if (error?.code === 'RATE_LIMIT' || /\b429\b/.test(String(error?.message))) scheduler.cooldown(key, error.retryAfterMs ?? 30000);
        throw error;
      }
    }, { signal, limit: workers });
  }
  async function fetchPage(url, signal) {
    signal?.throwIfAborted();
    const origin = new URL(url).origin;
    return scheduled(`http:${origin}`, signal, async () => {
      const response = await web.fetch({ url }, signal);
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`HTTP ${response.statusCode}`);
      return response;
    });
  }
  async function json(url, signal) {
    const response = await fetchPage(url, signal);
    if (response.truncated || response.body.content.length > BYTE_LIMIT) throw new Error('JSON response truncated or oversized');
    return JSON.parse(response.body.content);
  }
  const indexed = (site) => ({
    capability: { mode: site ? 'web-index' : 'web', limitations: site ? ['Public web-index fallback only; no authenticated API, complete thread, or complete comments.'] : ['Search index coverage and HTTP extraction may be partial.'] },
    async search(query, { limit, signal } = {}) {
      signal?.throwIfAborted();
      const maxResults = count(limit, 4, 20);
      if (!maxResults) return [];
      const result = await scheduled('web-search', signal, () => web.search({ query: site ? `site:${site} ${query}` : query, maxResults }, signal));
      return (result.sources ?? []).slice(0, maxResults).map(item => ({ ...item, title: item.title || item.url, kind: 'search_snippet', truncated: Boolean(result.truncated), ...(site ? { mode: 'web-index' } : {}) }));
    },
    async read(item, { signal } = {}) {
      const response = await fetchPage(item.url, signal);
      const full = response.body.kind === 'html' ? await deps.formatHtml(response) : response.body.content;
      if (full.includes('[HTML content omitted: unable to convert safely.]')) throw new Error('HTML extraction unavailable; page was not read');
      return { ...item, content: full.slice(0, TEXT_LIMIT), kind: 'web_page', fetchedUrl: response.url, truncated: Boolean(response.truncated || full.length >= TEXT_LIMIT), limitations: site ? ['HTTP page only; does not establish complete comments or thread coverage.'] : [] };
    },
  });
  const hackernews = createHackerNewsConnector({ json, readArticle: (url, options) => indexed().read({ url }, options), cleanError });
  const grep = {
    capability: { mode: 'mcp', limitations: ['Public indexed code excerpts; not complete repository contents.'] },
    async search(query, { signal, limit, filters = {} } = {}) {
      if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('grep filters must be an object');
      const args = { query };
      for (const [key, value] of Object.entries(filters)) {
        if (!['repo', 'language', 'path', 'matchCase', 'useRegexp'].includes(key)) throw new Error(`Unknown grep filter: ${key}`);
        const validString = text => typeof text === 'string' && text.trim().length > 0 && text.length <= 500;
        const valid = key === 'language' ? Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(validString)
          : ['matchCase', 'useRegexp'].includes(key) ? typeof value === 'boolean' : validString(value);
        if (!valid) throw new Error(`Invalid grep filter: ${key}`);
        args[key] = value;
      }
      if (count(limit, 4, 20) === 0) return [];
      return scheduled('mcp:grep', signal, () => withMcp('grep', signal, deps, async call => [{ ...excerpt('grep', query, await call('searchGitHub', args)), filters: { ...filters } }]));
    },
    async read(item, { signal } = {}) { signal?.throwIfAborted(); return { ...item, kind: 'code_excerpt', content: item.content ?? item.snippet ?? '' }; },
  };
  const context7 = {
    capability: { mode: 'mcp', requiresLibrary: true, limitations: ['Explicit library name or Context7 library ID required; ambiguous names require caller selection. Documentation excerpts only.'] },
    async search(query, { signal, library, limit } = {}) {
      if (typeof library !== 'string' || !library.trim()) throw new Error('Context7 requires an explicit library name or ID');
      if (count(limit, 4, 20) === 0) return [];
      return scheduled('mcp:context7', signal, () => withMcp('context7', signal, deps, async call => {
        let libraryId = library.trim();
        if (!/^\/[^/\s]+\/[^/\s]+(?:\/[^\s]+)?$/.test(libraryId)) {
          const resolved = await call('resolve-library-id', { libraryName: libraryId, query });
          const text = mcpText(resolved);
          const structured = resolved.structuredContent;
          const candidates = structured?.libraries ?? structured?.results ?? [];
          const ids = [...new Set([...candidates.map(x => x.id ?? x.libraryId), ...[...text.matchAll(/(?:Context7-compatible library ID|Library ID|libraryId)\s*[:=]\s*["`]?\s*(\/[^\s"`]+)/gi)].map(m => m[1])].filter(Boolean))];
          if (ids.length !== 1) throw new Error(`Context7 library resolution ${ids.length ? 'ambiguous; select an explicit library ID' : 'did not yield a unique library ID'}: ${ids.join(', ').slice(0, 500)}`);
          libraryId = ids[0];
        }
        return [{ ...excerpt('context7', query, await call('query-docs', { libraryId, query })), libraryId }];
      }));
    },
    async read(item, { signal } = {}) { signal?.throwIfAborted(); return { ...item, kind: 'document_excerpt', content: item.content ?? item.snippet ?? '' }; },
  };
  const reddit = deps.redditConnector ?? createRedditConnector({ scheduler, workers, ...(deps.redditEnv ? { env: deps.redditEnv } : {}), ...(deps.fetchReddit ? { fetchImpl: deps.fetchReddit } : {}) });
  return { web: indexed(), reddit, x: indexed('x.com'), hackernews, grep, context7 };
}
