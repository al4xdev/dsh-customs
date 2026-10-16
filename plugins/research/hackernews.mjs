const count = (value, fallback, max) => Number.isInteger(value) ? Math.max(0, Math.min(value, max)) : fallback;
const safeId = value => {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : undefined;
};
const date = seconds => {
  if (!Number.isFinite(seconds)) return undefined;
  const value = new Date(seconds * 1000);
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
};
const endpoint = id => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

// Transport, deadlines and cross-search origin concurrency belong to the injected scheduler.
export function createHackerNewsConnector({ json, readArticle, cleanError = error => String(error?.message ?? error).slice(0, 500) }) {
  return {
    capability: { mode: 'algolia-api', limitations: ['Algolia search may lag; Firebase comments and article reads are bounded and may be partial.'] },
    async search(query, { limit, signal } = {}) {
      const n = count(limit, 4, 20);
      if (!n) return [];
      const url = new URL('https://hn.algolia.com/api/v1/search');
      url.search = new URLSearchParams({ query, tags: 'story', hitsPerPage: String(n), attributesToRetrieve: 'objectID,title,url,created_at', attributesToHighlight: '', attributesToSnippet: '' }).toString();
      const result = await json(url.href, signal);
      return (Array.isArray(result?.hits) ? result.hits : []).slice(0, n).flatMap(hit => {
        const hnId = safeId(hit?.objectID);
        if (!hnId) return [];
        return [{ url: `https://news.ycombinator.com/item?id=${hnId}`, title: hit.title || 'Hacker News story',
          hnId, articleUrl: hit.url || undefined, publishedAt: hit.created_at,
          metadata: { hnId, publishedAt: hit.created_at }, kind: 'search_snippet' }];
      });
    },
    async read(item, { signal, maxComments } = {}) {
      let candidate = item.metadata?.hnId ?? item.hnId;
      if (candidate == null) {
        try { candidate = new URL(item.url).searchParams.get('id'); } catch { /* Validated below. */ }
      }
      const id = safeId(candidate);
      if (!id) throw new Error('Invalid Hacker News item ID');
      const story = await json(endpoint(id), signal);
      if (!story || safeId(story.id) !== id || story.type !== 'story' || story.deleted || story.dead) throw new Error('Invalid Hacker News story');
      const budget = count(maxComments, 40, 200);
      const comments = [], errors = [], queue = [], seen = new Set([id]);
      const interrupted = [];
      let truncated = false, attempted = 0, fetched = 0, selected = 0, skipped = 0, textChars = 0;
      const limitations = [
        'Bounded Firebase snapshot; not a complete or atomic thread read. Counts of available comments, when present, are HN-reported descendants, not an enumerated tree.',
        'Comment text is untrusted HTML (text_format:html). Limits: attempts=maxComments (default 40, maximum 200), batch 2, queue 1000, pending IDs 200, comment 8000 characters, aggregate comment text 64000 characters, content 100000 characters.',
        'The injected transport owns deadlines. Abort after the story returns partial evidence; an external engine deadline may still discard that result.',
      ];
      function enqueue(kids, parent, target) {
        for (const value of Array.isArray(kids) ? kids : []) {
          const child = safeId(value);
          if (!child || seen.has(child)) { truncated = true; continue; }
          if (queue.length >= 1000) { truncated = true; break; }
          seen.add(child);
          queue.push({ id: child, parent, target });
        }
      }
      enqueue(story.kids, id, comments);
      while (queue.length && attempted < budget) {
        if (signal?.aborted) {
          errors.push({ stage: 'comments', message: cleanError(signal.reason ?? new Error('Aborted')) });
          truncated = true;
          break;
        }
        const batch = queue.splice(0, Math.min(2, budget - attempted));
        attempted += batch.length;
        const results = await Promise.all(batch.map(async entry => {
          try { return { entry, node: await json(endpoint(entry.id), signal) }; }
          catch (error) { return { entry, error }; }
        }));
        let aborted = false;
        for (const result of results) {
          const { entry, node, error } = result;
          if ('error' in result) {
            errors.push({ stage: 'comment', id: entry.id, message: cleanError(error) });
            truncated = true;
            interrupted.push(entry.id);
            if (signal?.aborted || error?.name === 'AbortError') aborted = true;
            continue;
          }
          fetched++;
          if (node == null) { skipped++; continue; }
          if (safeId(node.id) !== entry.id || node.type !== 'comment' || safeId(node.parent) !== entry.parent) {
            skipped++;
            truncated = true;
            errors.push({ stage: 'comment', id: entry.id, message: 'Invalid comment ID, type or parent' });
            continue;
          }
          if (node.deleted || node.dead) {
            skipped++;
            // Descendants may remain live; preserve their actual parent_id even when the parent is omitted.
            enqueue(node.kids, entry.id, entry.target);
            continue;
          }
          const raw = typeof node.text === 'string' ? node.text : '';
          const text = raw.slice(0, Math.min(8000, 64000 - textChars));
          textChars += text.length;
          truncated ||= text.length < raw.length;
          const comment = { id: Number(entry.id), parent_id: Number(entry.parent), author: node.by, text,
            text_format: 'html', createdAt: date(node.time), children: [], truncated: text.length < raw.length };
          entry.target.push(comment);
          selected++;
          enqueue(node.kids, entry.id, comment.children);
        }
        if (aborted || signal?.aborted) {
          truncated = true;
          if (!aborted) errors.push({ stage: 'comments', message: cleanError(signal.reason ?? new Error('Aborted')) });
          break;
        }
      }
      let content = `${story.title ?? item.title ?? ''}\n\n${story.text ?? ''}`;
      truncated ||= content.length > 100000;
      content = content.slice(0, 100000);
      const articleUrl = story.url || item.articleUrl;
      if (articleUrl) {
        try {
          if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
          const article = await readArticle(articleUrl, { signal });
          const addition = `\n\nArticle extract (${articleUrl}):\n${article.content ?? ''}`;
          truncated ||= Boolean(article.truncated) || content.length + addition.length > 100000;
          content = (content + addition).slice(0, 100000);
        } catch (error) { errors.push({ stage: 'article', message: cleanError(error) }); truncated = true; }
      }
      const available = Number.isSafeInteger(story.descendants) && story.descendants >= 0 ? story.descendants : undefined;
      truncated ||= queue.length > 0 || interrupted.length > 0 || (available !== undefined && available > selected);
      const metrics = { comment_nodes_count: selected, comments_selected_count: selected,
        ...(available !== undefined ? { comments_available_count: available } : {}),
        comments_count_scope: 'hn_reported_descendants', fetched_count: fetched, attempted_count: attempted, skipped_count: skipped };
      return { ...item, content, text_format: 'mixed', kind: 'hn_thread', comments, ...metrics,
        evidence: { ...item.evidence, ...metrics }, pendingCommentIds: [...interrupted, ...queue.map(entry => entry.id)].slice(0, 200),
        truncated, errors, limitations };
    },
  };
}
