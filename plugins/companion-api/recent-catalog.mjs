import { createRecencyPager } from './activity-order.mjs';

/** Existing wire validators/metadata mapping remain the authority; activity only enriches ordering. */
export function createRecentCatalog(persistence, activity, base, contracts, options = {}) {
  const { parseListRequest, parseListOutput, companionMetadata, refusal, SESSION_ID, MAX_SNAPSHOTS } = contracts;
  if (![parseListRequest, parseListOutput, companionMetadata, refusal, activity?.current, activity?.hint, base?.detail].every(value => typeof value === 'function')) throw new TypeError('Invalid recent catalog binding');
  if (Object.keys(options).some(key => !['maxBytes', 'now', 'ttlMs', 'maxSnapshots'].includes(key))) throw new TypeError('Unsupported recent catalog option');
  const pager = createRecencyPager({ ...options, fail: refusal });
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
      return output;
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
    return parseListOutput(pager.list(rows, request));
  }
  async function detail(raw, signal) {
    requireCurrent(signal);
    const value = await base.detail(raw, signal);
    requireCurrent(signal);
    return value;
  }
  return Object.freeze({ listChats, detail, close() { pager.clear(); } });
}
