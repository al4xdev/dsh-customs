import { sharedScheduler } from './scheduler.mjs';

const ORIGIN = 'https://oauth.reddit.com';
const MAX_BYTES = 2_000_000;
const safeErrors = new WeakSet();
const fail = (code, message) => { const error = Object.assign(new Error(message), { code }); safeErrors.add(error); return error; };
const invalid = () => fail('INVALID_INPUT', 'Invalid Reddit options or identifier');
const id = (value, prefix) => {
  if (typeof value !== 'string' || !new RegExp(`^(?:${prefix}_)?[a-z0-9]{1,20}$`).test(value)) throw invalid();
  return value.replace(new RegExp(`^${prefix}_`), '');
};
const integer = (value, fallback, max) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw invalid();
  return Math.min(value, max);
};
function options(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const o = { ...value, mode: value.mode ?? 'search' };
  if (!['search', 'subreddit', 'thread'].includes(o.mode)) throw invalid();
  if (o.subreddit !== undefined && (typeof o.subreddit !== 'string' || !/^[a-zA-Z0-9_]{1,21}$/.test(o.subreddit))) throw invalid();
  for (const [key, prefix] of [['postId', 't3'], ['commentId', 't1']]) if (o[key] !== undefined) o[key] = id(o[key], prefix);
  if (o.after === null) delete o.after;
  if (o.after !== undefined && (typeof o.after !== 'string' || !/^t3_[a-z0-9]{1,20}$/.test(o.after))) throw invalid();
  if (o.time !== undefined && !['hour', 'day', 'week', 'month', 'year', 'all'].includes(o.time)) throw invalid();
  const sorts = o.mode === 'thread' ? ['confidence', 'top', 'new', 'controversial', 'old', 'qa'] : o.mode === 'subreddit' ? ['new', 'hot', 'top', 'rising'] : ['relevance', 'hot', 'top', 'new', 'comments'];
  if (o.sort !== undefined && !sorts.includes(o.sort)) throw invalid();
  if (o.children !== undefined) {
    if (!Array.isArray(o.children) || o.children.length > 200) throw invalid();
    o.children = [...new Set(o.children.map(v => id(v, 't1')))];
  }
  if (o.mode === 'thread' && !o.postId || o.mode === 'subreddit' && !o.subreddit) throw invalid();
  if (o.mode !== 'thread' && (o.commentId !== undefined || o.children !== undefined)) throw invalid();
  return o;
}
const canonical = postId => `https://www.reddit.com/comments/${postId}`;
function postItem(data, extra = {}) {
  const postId = id(data.id ?? data.name, 't3');
  return { url: canonical(postId), title: String(data.title ?? 'Reddit thread'), snippet: String(data.selftext ?? '').slice(0, 1000), kind: 'search_snippet', reddit: { postId, subreddit: data.subreddit, ...extra } };
}

// Access-token-only deliberately avoids login, refresh grants, disk storage and
// implicit approval claims. The caller obtains an approved read-scoped token.
export function createRedditConnector({ fetchImpl = globalThis.fetch, env = process.env, scheduler = sharedScheduler, workers = 2 } = {}) {
  if (![1, 2].includes(workers)) throw invalid();
  const credentials = () => typeof env.REDDIT_ACCESS_TOKEN === 'string' && env.REDDIT_ACCESS_TOKEN.trim() && typeof env.REDDIT_USER_AGENT === 'string' && env.REDDIT_USER_AGENT.trim().length >= 10 && !/[\r\n]/.test(env.REDDIT_USER_AGENT) && !/[\s]/.test(env.REDDIT_ACCESS_TOKEN);
  function auth() { if (!credentials()) throw fail('AUTH_REQUIRED', 'Reddit access token and descriptive user agent required'); }
  async function request(path, params, parent, more = false) {
    auth();
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent?.aborted) throw fail('ABORTED', 'Reddit request cancelled');
    parent?.addEventListener('abort', abort, { once: true });
    let timeout = false;
    const timer = setTimeout(() => { timeout = true; controller.abort(); }, 25_000);
    const signal = controller.signal;
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password) throw invalid();
    for (const [k, v] of Object.entries({ raw_json: 1, ...params })) if (v !== undefined) url.searchParams.set(k, String(v));
    const work = async () => {
      signal.throwIfAborted();
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal, headers: { Authorization: `Bearer ${env.REDDIT_ACCESS_TOKEN}`, 'User-Agent': env.REDDIT_USER_AGENT, Accept: 'application/json' } });
      if (response.status >= 300 && response.status < 400 || response.redirected) { await response.body?.cancel(); throw fail('REDIRECT_DENIED', 'Reddit redirects are not allowed'); }
      const retry = response.headers.get('retry-after');
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const exhausted = response.headers.get('x-ratelimit-remaining') !== null && Number(response.headers.get('x-ratelimit-remaining')) <= 0;
      let retryAfterMs;
      if (response.status === 429 || exhausted) {
        const retryMs = retry === null ? 0 : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
        const ms = Math.min(86_400_000, Math.max(1000, Number.isFinite(retryMs) ? retryMs : 0, Number.isFinite(reset) ? reset * 1000 : 0, response.status === 429 && !retry && !reset ? 60_000 : 0));
        scheduler.cooldown('reddit-api', ms);
        retryAfterMs = ms;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const error = fail(response.status === 429 ? 'RATE_LIMIT' : response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : 'HTTP_ERROR', `Reddit API request failed (HTTP ${response.status})`);
        if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
        throw error;
      }
      if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw fail('RESPONSE_TOO_LARGE', 'Reddit JSON exceeds byte limit'); }
      if (!response.body?.getReader) throw fail('INVALID_RESPONSE', 'Reddit response has no readable body');
      const reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_BYTES) throw fail('RESPONSE_TOO_LARGE', 'Reddit JSON exceeds byte limit');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('INVALID_RESPONSE', 'Invalid Reddit JSON response'); }
      if (data.scope !== undefined && (typeof data.scope !== 'string' || !data.scope.split(/[ ,]+/).includes('read'))) throw fail('INSUFFICIENT_SCOPE', 'Reddit token requires read scope');
      return data;
    };
    let rejectAbort;
    const cancelled = new Promise((_, reject) => {
      rejectAbort = () => reject(fail(timeout ? 'TIMEOUT' : 'ABORTED', timeout ? 'Reddit request timed out' : 'Reddit request cancelled'));
      signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      // Acquire serial expansion first: waiting expansions never occupy one of
      // the two shared API slots. Every expansion also acquires reddit-api.
      // For nested acquisition the inner promise must represent actual task
      // settlement, not early caller cancellation, or the serial outer slot
      // would release while a noncooperative fetch remains in flight.
      const api = () => scheduler.run('reddit-api', work, { signal: more ? undefined : signal, limit: workers });
      return await Promise.race([cancelled, more ? scheduler.run('reddit-morechildren', api, { signal, limit: 1 }) : api()]);
    } catch (error) {
      const safeCodes = ['RATE_LIMIT', 'AUTH_REQUIRED', 'ACCESS_DENIED', 'HTTP_ERROR', 'REDIRECT_DENIED', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE', 'INSUFFICIENT_SCOPE', 'TIMEOUT', 'ABORTED'];
      if (safeErrors.has(error) && safeCodes.includes(error?.code)) throw error;
      if (error?.code === 'RATE_LIMIT') {
        const rate = fail('RATE_LIMIT', 'Reddit API is cooling down');
        if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) rate.retryAfterMs = Math.min(86_400_000, error.retryAfterMs);
        throw rate;
      }
      if (['QUEUE_FULL', 'KEY_CAPACITY'].includes(error?.code)) throw fail('SCHEDULER_BUSY', 'Reddit request capacity unavailable');
      throw fail(signal.aborted ? timeout ? 'TIMEOUT' : 'ABORTED' : 'NETWORK_ERROR', signal.aborted ? 'Reddit request cancelled or timed out' : 'Reddit request failed');
    } finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); signal.removeEventListener('abort', rejectAbort); }
  }
  return {
    capability: { mode: 'official-api', credentialStatus: credentials() ? 'configured' : 'missing', authentication: 'access-token-only', limitations: ['Requires approved Reddit API access and read-scoped OAuth token; configuration does not verify approval.', 'Access tokens expire; the owner must replace them. No automatic refresh or web fallback. Listings and comment trees are bounded snapshots, not complete coverage.'] },
    async search(query, { limit, signal, reddit = {} } = {}) {
      auth();
      if (typeof query !== 'string') throw invalid();
      const o = options(reddit), n = integer(limit, 4, 100);
      if (signal?.aborted) throw fail('ABORTED', 'Reddit request cancelled');
      if (!n) return [];
      if (o.mode === 'thread') return [{ url: canonical(o.postId), title: 'Reddit thread', snippet: '', kind: 'search_snippet', reddit: o }];
      const path = o.mode === 'subreddit' ? `/r/${o.subreddit}/${o.sort ?? 'hot'}` : o.subreddit ? `/r/${o.subreddit}/search` : '/search';
      const result = await request(path, { q: o.mode === 'search' ? query : undefined, restrict_sr: o.mode === 'search' && o.subreddit ? 1 : undefined, limit: n, sort: o.sort, t: o.time, after: o.after }, signal);
      if (!Array.isArray(result?.data?.children)) throw fail('INVALID_RESPONSE', 'Invalid Reddit listing');
      return result.data.children.filter(x => x.kind === 't3').slice(0, n).map(x => postItem(x.data, { after: result.data.after ?? null, listingComplete: false }));
    },
    async read(item, { signal, maxComments } = {}) {
      auth();
      if (!item || typeof item !== 'object') throw invalid();
      // Never fetch item.url. Even a supplied URL must be a canonical Reddit
      // thread URL matching the structured ID; arbitrary URLs are rejected.
      let urlId;
      if (item.url !== undefined) {
        if (typeof item.url !== 'string') throw invalid();
        const match = /^https:\/\/www\.reddit\.com\/comments\/([a-z0-9]{1,20})\/?$/.exec(item.url);
        if (!match) throw invalid();
        urlId = match[1];
      }
      const o = options({ ...item.reddit, mode: 'thread', postId: item.reddit?.postId ?? urlId });
      if (urlId && urlId !== o.postId) throw invalid();
      const budget = integer(maxComments, 40, 200), link = `t3_${o.postId}`;
      const result = await request(`/comments/${o.postId}`, { limit: Math.max(1, budget), sort: o.sort ?? 'confidence', comment: o.commentId }, signal);
      const post = result?.[0]?.data?.children?.find(x => x.kind === 't3')?.data;
      if (!post || id(post.id ?? post.name, 't3') !== o.postId || !Array.isArray(result?.[1]?.data?.children)) throw fail('INVALID_RESPONSE', 'Invalid Reddit thread');
      const nodes = new Map(), markers = [], pending = new Set(o.children ?? []), errors = [];
      let omitted = 0, moreCalls = 0, textChars = 0;
      function ingest(things) {
        const stack = things.slice(0, 2000);
        if (things.length > stack.length) omitted += things.length - stack.length;
        for (let cursor = 0; cursor < stack.length; cursor++) {
          const thing = stack[cursor], d = thing?.data;
          if (!d || !['t1', 'more'].includes(thing.kind)) continue;
          if (d.link_id && d.link_id !== link) continue;
          if (thing.kind === 'more') {
            const ids = (Array.isArray(d.children) ? d.children : []).filter(v => typeof v === 'string' && /^[a-z0-9]{1,20}$/.test(v)).slice(0, 200);
            if (markers.length < 50) markers.push({ kind: 'more', id: String(d.id ?? '').slice(0, 30), parent_id: String(d.parent_id ?? link).slice(0, 30), link_id: link, count: Number.isFinite(d.count) ? d.count : ids.length, children: [], remainingIds: ids.slice(0, 50) });
            else omitted++;
            if (ids.length > 50) omitted++;
            for (const child of ids) pending.add(child);
            continue;
          }
          if (typeof d.id !== 'string' || !/^[a-z0-9]{1,20}$/.test(d.id) || typeof d.parent_id !== 'string' || !/^(t1|t3)_[a-z0-9]{1,20}$/.test(d.parent_id)) continue;
          if (d.parent_id.startsWith('t3_') && d.parent_id !== link) continue;
          if (Array.isArray(d.replies?.data?.children)) {
            const children = d.replies.data.children.slice(0, Math.max(0, 2000 - stack.length));
            omitted += d.replies.data.children.length - children.length;
            stack.push(...children);
          }
          if (nodes.has(d.id)) continue;
          if (nodes.size >= budget) { pending.add(d.id); omitted++; continue; }
          const body = String(d.body ?? ''), selectedText = body.slice(0, Math.min(8000, Math.max(0, 64000 - textChars)));
          textChars += selectedText.length;
          if (selectedText.length < body.length) omitted++;
          nodes.set(d.id, { id: d.id, parent_id: d.parent_id, link_id: link, author: typeof d.author === 'string' ? d.author.slice(0, 256) : null, text: selectedText, text_format: 'markdown', truncated: selectedText.length < body.length, createdAt: Number.isFinite(d.created_utc) ? d.created_utc : null, children: [] });
          pending.delete(d.id);
        }
      }
      // Explicit ID continuation prioritizes those IDs rather than spending the
      // selection budget again on the first page of the same thread.
      if (!o.children?.length) ingest(result[1].data.children);
      if (o.commentId && !nodes.has(o.commentId)) pending.add(o.commentId);
      const attempted = new Set();
      // Explicit continuations are still scoped by link_id, and responses from
      // other threads are discarded; no IDs become request paths.
      while (pending.size && nodes.size < budget && moreCalls < 2) {
        const batch = [...pending].filter(v => !nodes.has(v) && !attempted.has(v)).slice(0, Math.min(100, budget - nodes.size));
        if (!batch.length) break;
        for (const child of batch) attempted.add(child);
        moreCalls++;
        try {
          const expanded = await request('/api/morechildren', { children: batch.join(','), api_type: 'json', link_id: link }, signal, true);
          if (!Array.isArray(expanded?.json?.data?.things) || expanded.json.errors?.length) throw fail('EXPANSION_FAILED', 'Reddit comment expansion unavailable');
          // Expansion comments must positively identify their owning thread.
          ingest(expanded.json.data.things.filter(x => x.data?.link_id === link));
        } catch (error) {
          if (error.code === 'ABORTED') throw error;
          errors.push({ code: error.code ?? 'EXPANSION_FAILED', message: 'Reddit comment expansion incomplete', ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}) }); break;
        }
      }
      const comments = [];
      for (const node of nodes.values()) {
        const parent = nodes.get(node.parent_id.replace(/^t1_/, ''));
        // Reject cycles without recursive traversal of attacker-controlled data.
        let cursor = parent, cycle = false; const seen = new Set([node.id]);
        while (cursor) { if (seen.has(cursor.id)) { cycle = true; break; } seen.add(cursor.id); cursor = nodes.get(cursor.parent_id.replace(/^t1_/, '')); }
        if (parent && !cycle) parent.children.push(node); else comments.push(node);
      }
      for (const marker of markers) {
        marker.remainingIds = marker.remainingIds.filter(v => !nodes.has(v));
        if (!marker.remainingIds.length && marker.count !== 0) continue;
        const parent = nodes.get(String(marker.parent_id).replace(/^t1_/, ''));
        (parent?.children ?? comments).push(marker);
      }
      if (o.commentId && !nodes.has(o.commentId)) {
        pending.add(o.commentId);
        errors.push({ code: 'COMMENT_UNAVAILABLE', message: 'Requested Reddit comment was not returned' });
      }
      const remainingIds = [...pending].filter(v => !nodes.has(v)).slice(0, 200);
      const selected = o.commentId ? nodes.has(o.commentId) ? [nodes.get(o.commentId)] : [] : comments;
      let selectedCount = 0; const selectedStack = [...selected];
      while (selectedStack.length) { const node = selectedStack.pop(); if (node.kind !== 'more') selectedCount++; selectedStack.push(...node.children); }
      const content = String(post.selftext || post.title || '[Reddit post without text]');
      const truncated = Boolean(content.length > 100000 || remainingIds.length || errors.length || omitted || (!o.commentId && Number(post.num_comments) > nodes.size));
      return { ...item, url: canonical(o.postId), title: String(post.title ?? item.title ?? 'Reddit thread').slice(0, 512), content: content.slice(0, 100000), kind: 'reddit_thread', postId: o.postId, reddit: { ...o, subreddit: typeof post.subreddit === 'string' ? post.subreddit.slice(0, 21) : undefined }, comments: selected, commentCount: Number.isFinite(post.num_comments) ? post.num_comments : null, selectedCommentCount: selectedCount, moreCalls, continuation: { postId: o.postId, commentId: o.commentId, children: remainingIds, remainingIdsTruncated: pending.size > 200, after: item.reddit?.after ?? null }, truncated, limitations: ['Bounded Reddit API snapshot; deleted, removed, inaccessible and unreturned comments may be absent. No completeness guarantee.'], errors };
    },
  };
}
