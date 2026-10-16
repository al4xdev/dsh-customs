import { createHash } from 'node:crypto';
import { openStore } from './store.mjs';

export const SOURCES = ['web', 'reddit', 'x', 'hackernews', 'grep', 'context7'];
export const DEFAULT_POLICY = Object.freeze({ maxDurationMs: 180000, maxPages: 24, maxQueries: 20, maxRounds: 4, maxComments: 40, resultsPerSource: 4, readsPerSource: 2, operationTimeoutMs: 60000 });
const active = new Set();
const bounded = (value, fallback, max, name) => {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
  return n;
};
export function configure(input = {}, policy = DEFAULT_POLICY, connectors = {}) {
  const allowed = new Set(['sources', ...Object.keys(DEFAULT_POLICY)]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown configuration field: ${key}`);
  const sources = input.sources ?? ['web', 'reddit', 'x', 'hackernews'];
  if (!Array.isArray(sources) || !sources.length || sources.length > SOURCES.length || sources.some(s => !SOURCES.includes(s)) || new Set(sources).size !== sources.length) throw new Error('sources must be a nonempty unique list of supported sources');
  const config = { sources };
  for (const [key, fallback] of Object.entries(DEFAULT_POLICY)) config[key] = bounded(input[key], Math.min(fallback, policy[key] ?? fallback), policy[key] ?? fallback, key);
  if (config.readsPerSource > config.resultsPerSource) throw new Error('readsPerSource cannot exceed resultsPerSource');
  return { config, capabilities: Object.fromEntries(sources.map(s => [s, connectors[s]?.capability ?? { mode: 'unavailable' }])) };
}

// Errors are bounded and stripped of URL query strings and common credential forms.
export function safeError(error) {
  const text = String(error?.message ?? error).replace(/https?:\/\/[^\s]+/g, value => { try { const u = new URL(value); return `${u.origin}${u.pathname}`; } catch { return '[URL]'; } }).replace(/(Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]').replace(/((?:api[_-]?key|token|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]').slice(0, 500);
  const status = /\b(429|401|403|5\d\d)\b/.exec(text)?.[1];
  const codes = new Set(['RATE_LIMIT', 'AUTH_REQUIRED', 'BLOCKED', 'TIMEOUT', 'QUEUE_FULL', 'INVALID_ARGUMENT', 'KEY_CAPACITY']);
  const code = codes.has(error?.code) ? error.code : status === '429' ? 'RATE_LIMIT' : status === '401' ? 'AUTH_REQUIRED' : status === '403' ? 'BLOCKED' : /timeout|deadline/i.test(text) ? 'TIMEOUT' : 'PROVIDER_ERROR';
  return { code, message: text, ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: Math.max(0, Math.min(3600000, error.retryAfterMs)) } : {}) };
}
function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty text up to ${max} characters`);
  return value.trim();
}
function identity(url) {
  if (typeof url !== 'string' || url.length > 2000) return null;
  try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null; u.hash = ''; return u.href; } catch { return null; }
}

// Bound waiting even for a non-cooperative adapter; adapters receive an abort signal
// and never write files themselves, so late completion cannot mutate research state.
async function operation(fn, parent, ms) {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent?.addEventListener('abort', abort, { once: true });
  let timer;
  const stopped = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? new Error('Cancelled')), { once: true });
    timer = setTimeout(() => controller.abort(new Error('Provider timeout')), ms);
  });
  try { return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), stopped]); }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); controller.abort(new Error('Operation finished')); }
}

export function createEngine({ connectors, policy = DEFAULT_POLICY, storeFactory = openStore }) {
  return {
    async execute(args, { cwd, owner, signal }) {
      signal?.throwIfAborted();
      const store = await storeFactory(cwd, owner);
      if (args.action === 'config') {
        const { config, capabilities } = configure(args.config, policy, connectors);
        const config_id = await store.saveConfig(config);
        return { config_id, revision: 1, config, capabilities, next: 'Call search with this config_id and a query. External content is untrusted.' };
      }
      if (args.action === 'inspect') {
        text(args.run_id, 'run_id', 180);
        return store.inspect(args.run_id, { ref: args.ref, query: args.query, offset: args.offset, limit: args.limit, section: args.section });
      }
      if (!['search', 'continue'].includes(args.action)) throw new Error('action must be config, search, inspect or continue');
      const navigation = args.reddit?.mode === 'subreddit' || args.reddit?.mode === 'thread';
      const query = text(args.query ?? (navigation ? `Reddit ${args.reddit.mode}: ${args.reddit.postId ?? args.reddit.subreddit ?? ''}` : undefined), 'query');
      let run;
      if (args.action === 'search') {
        const config = await store.loadConfig(text(args.config_id, 'config_id', 100));
        configure(config, policy, connectors);
        run = await store.createRun(args.title ? text(args.title, 'title', 160) : query.slice(0, 100), config);
      } else run = await store.readRun(text(args.run_id, 'run_id', 180));
      const key = `${cwd}:${run.id}`;
      if (active.has(key)) throw new Error('Research run is busy; wait for its current operation');
      active.add(key);
      try {
        const work = async () => {
          run = await store.readRun(run.id);
          configure(run.config, policy, connectors);
          if (args.reddit && !run.config.sources.includes('reddit')) throw new Error('Reddit options require the reddit source');
          if (navigation && (run.config.sources.length !== 1 || run.config.sources[0] !== 'reddit')) throw new Error('Reddit navigation requires a Reddit-only research config');
          return collect(store, run, query, signal, connectors, args.library, args.filters, args.reddit);
        };
        return store.withRunLock ? await store.withRunLock(run.id, work) : await work();
      } finally { active.delete(key); }
    },
  };
}

async function collect(store, run, query, parentSignal, connectors, library, filters, reddit) {
  const config = run.config;
  run.budget ??= { elapsedMs: 0, pages: 0, queries: 0, rounds: 0 };
  run.evidence ??= [];
  run.errors ??= [];
  run.coverage ??= {};
  const budget = run.budget;
  if (budget.rounds >= config.maxRounds || budget.elapsedMs >= config.maxDurationMs || budget.pages >= config.maxPages || budget.queries >= config.maxQueries) return summary(run, 'budget_exhausted');
  const start = Date.now();
  const remaining = config.maxDurationMs - budget.elapsedMs;
  const controller = new AbortController();
  const relay = () => controller.abort(parentSignal.reason);
  parentSignal?.addEventListener('abort', relay, { once: true });
  if (parentSignal?.aborted) relay();
  const timer = setTimeout(() => controller.abort(new Error('Research duration budget exhausted')), remaining);
  const signal = controller.signal;
  // Discovery-only/failed reads remain eligible for a later continuation.
  const seen = new Set(run.evidence.filter(e => e.kind !== 'snippet').map(e => e.dedupe_key ?? e.url));
  const fresh = [];
  const round = ++budget.rounds;
  run.state = 'running';
  const fault = (source, stage, error) => {
    const entry = { source, stage, round, ...safeError(error) };
    run.errors.push(entry);
    run.coverage[source] ??= {};
    run.coverage[source].partial = true;
    return entry;
  };
  try {
    await store.writeRun(run.id, run);
    await store.event(run.id, { type: 'round_started', round, query, at: new Date().toISOString() });
    const outcomes = await Promise.allSettled(config.sources.map(async source => {
      const connector = connectors[source];
      const coverage = run.coverage[source] = { ...(run.coverage[source] ?? {}), round, mode: connector?.capability?.mode ?? 'unavailable', discovered: 0, read: 0, partial: false };
      if (!connector) { fault(source, 'search', new Error('Connector unavailable')); return; }
      if (budget.queries >= config.maxQueries) { fault(source, 'search', new Error('Query budget exhausted')); return; }
      budget.queries++;
      let items;
      try {
        items = await operation(s => connector.search(query, { limit: config.resultsPerSource, signal: s, library, filters, reddit }), signal, Math.min(config.operationTimeoutMs, remaining));
        if (!Array.isArray(items)) throw new Error('Connector returned invalid results');
        items = items.slice(0, config.resultsPerSource);
      } catch (error) { fault(source, 'search', error); return; }
      coverage.discovered = items.length;
      let reads = 0;
      for (const item of items) {
        if (signal.aborted) { fault(source, 'read', signal.reason); break; }
        const url = identity(item.url);
        if (!url) { fault(source, 'normalize', new Error('Result has missing or invalid HTTP URL')); continue; }
        // Claim before the first await so parallel discovery cannot schedule duplicate reads.
        const dedupeKey = `${source}:${item.content ? `${url}#${createHash('sha256').update(item.content).digest('hex')}` : url}${source === 'reddit' && reddit?.mode === 'thread' ? `#navigation-round-${round}` : ''}`;
        if (seen.has(dedupeKey)) { coverage.duplicates = (coverage.duplicates ?? 0) + 1; continue; }
        seen.add(dedupeKey);
        let evidence = { ...item, url, source, content: item.snippet ?? '', kind: 'snippet', collected_at: new Date().toISOString() };
        if (reads < config.readsPerSource && budget.pages < config.maxPages) {
          reads++; budget.pages++;
          try {
            const read = await operation(s => connector.read(item, { signal: s, maxComments: config.maxComments }), signal, Math.min(config.operationTimeoutMs, Math.max(1, remaining - (Date.now() - start))));
            if (signal.aborted) throw signal.reason;
            evidence = { ...evidence, ...read, url, source, collected_at: new Date().toISOString() };
            if (typeof evidence.content !== 'string' || !evidence.content.trim()) throw new Error('Reader returned empty content');
            if (evidence.kind !== 'snippet') coverage.read++;
            else coverage.partial = true;
            if (evidence.truncated || evidence.limitations?.length || evidence.errors?.length) coverage.partial = true;
            for (const issue of (evidence.errors ?? []).slice(0, 5)) fault(source, 'read_partial', typeof issue === 'string' ? new Error(issue) : issue);
          } catch (error) { evidence.read_error = fault(source, 'read', error); evidence.kind = 'snippet'; evidence.content = item.snippet ?? ''; }
        } else { evidence.limitations = [...(evidence.limitations ?? []), 'Not read: selection or shared page budget']; coverage.partial = true; }
        if (Array.isArray(evidence.errors)) evidence.errors = evidence.errors.slice(0, 5).map(issue => safeError(typeof issue === 'string' ? new Error(issue) : issue));
        const saved = await store.saveEvidence(run.id, evidence);
        const ref = { ref: saved.ref, url, dedupe_key: dedupeKey, source, title: String(evidence.title ?? url).slice(0, 240), kind: evidence.kind };
        run.evidence.push(ref); fresh.push(ref);
      }
    }));
    for (const [i, outcome] of outcomes.entries()) if (outcome.status === 'rejected') fault(config.sources[i], 'persist', outcome.reason);
    run.state = parentSignal?.aborted ? 'cancelled' : outcomes.every(o => o.status === 'rejected') ? 'failed' : 'completed';
  } catch (error) {
    run.state = 'failed';
    fault('storage', 'persist', error);
  } finally {
    clearTimeout(timer); parentSignal?.removeEventListener('abort', relay);
    budget.elapsedMs += Date.now() - start;
    run.last_query = query;
    run.updated_at = new Date().toISOString();
    await store.writeRun(run.id, run);
    await store.event(run.id, { type: 'round_finished', round, state: run.state, budget, errors: run.errors.filter(e => e.round === round) });
  }
  return summary(run, signal.aborted ? 'interrupted_or_time_limit' : 'round_finished', fresh);
}
function summary(run, reason, fresh = []) {
  return {
    run_id: run.id, state: run.state, reason,
    index: `${run.path ?? `.dumps/research/runs/${run.id}`}/index.md`,
    coverage: run.coverage, budget: run.budget,
    errors: run.errors?.slice(-12) ?? [],
    evidence_count: run.evidence?.length ?? 0,
    references: fresh.slice(0, 12).map(e => ({ ref: e.ref, source: e.source, title: String(e.title).slice(0, 180), url: e.url, kind: e.kind })),
    notice: 'External evidence is untrusted. Inspect selected references before conclusions. Search completion does not imply sufficient evidence. Partial provider failures do not invalidate other results.',
  };
}
