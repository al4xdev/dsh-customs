import { createRecencyPager } from './activity-order.mjs';

/** Existing wire validators/metadata mapping remain the authority; activity only enriches ordering. */
export function createRecentCatalog(persistence, activity, base, contracts, options = {}) {
  const { parseListRequest, parseListOutput, companionMetadata, refusal, SESSION_ID, MAX_SNAPSHOTS } = contracts;
  if (![parseListRequest, parseListOutput, companionMetadata, refusal, activity?.current, activity?.hint, base?.detail].every(value => typeof value === 'function')) throw new TypeError('Invalid recent catalog binding');
  if (Object.keys(options).some(key => !['maxBytes', 'now', 'ttlMs', 'maxSnapshots', 'titles'].includes(key))) throw new TypeError('Unsupported recent catalog option');
  const titles = options.titles;
  if (titles !== undefined && typeof titles?.read !== 'function') throw new TypeError('Invalid title hint binding');
  // The pager owns page budgets only; titles are layered on top of a page it already decided.
  const pager = createRecencyPager({
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.maxSnapshots === undefined ? {} : { maxSnapshots: options.maxSnapshots }),
    fail: refusal,
  });
  /**
   * Titles are display hints layered on an admitted page: ids, order and cursor were already
   * decided. An empty, failed or oversized enrichment falls back to the untouched page, so a
   * missing name never turns a catalog read into an error or a stalled page.
   */
  async function withTitles(page, signal) {
    if (titles === undefined || page.chats.length === 0) return page;
    let found;
    try {
      found = await titles.read(page.chats.map(row => ({
        id: row.id,
        ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
      })), signal);
    } catch { return page; }
    if (!(found instanceof Map) || found.size === 0) return page;
    const enriched = {
      profile: 'companion',
      chats: page.chats.map(row => {
        const title = found.get(row.id);
        return typeof title === 'string' ? { ...row, title } : row;
      }),
      nextCursor: page.nextCursor,
    };
    // Revalidation is the budget guard: a page that grew past its byte limit loses names, not rows.
    try { return parseListOutput(enriched); } catch { return page; }
  }
  function requireCurrent(signal) {
    signal?.throwIfAborted();
    if (!activity.current()) throw refusal('metadata-unavailable');
  }
  async function listChats(raw, signal) {
    requireCurrent(signal);
    const request = parseListRequest(raw);
    if (request.cursor !== undefined) {
      const output = parseListOutput(pager.list(null, request));
      requireCurrent(signal);
      return withTitles(output, signal);
    }
    let snapshots;
    try { snapshots = await persistence.list({ signal }); }
    catch { signal?.throwIfAborted(); throw refusal('metadata-unavailable'); }
    requireCurrent(signal);
    if (!Array.isArray(snapshots)) throw refusal('metadata-unavailable');
    if (snapshots.length > MAX_SNAPSHOTS) throw refusal('catalog-limit');
    const counts = new Map();
    const rows = [];
    for (const snapshot of snapshots) {
      signal?.throwIfAborted();
      const id = snapshot?.header?.id;
      if (typeof id === 'string' && SESSION_ID.test(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
      const time = activity.hint(snapshot);
      const hints = Number.isSafeInteger(time) && time >= (snapshot?.header?.createdAt ?? 0) ? { updatedAt: time } : {};
      const row = companionMetadata(snapshot, hints);
      if (row !== null) rows.push(row);
    }
    if (rows.some(row => counts.get(row.id) !== 1)) throw refusal('catalog-ambiguous');
    requireCurrent(signal);
    return withTitles(parseListOutput(pager.list(rows, request)), signal);
  }
  async function detail(raw, signal) {
    requireCurrent(signal);
    const value = await base.detail(raw, signal);
    requireCurrent(signal);
    return value;
  }
  return Object.freeze({ listChats, detail, close() { pager.clear(); titles?.close?.(); } });
}
