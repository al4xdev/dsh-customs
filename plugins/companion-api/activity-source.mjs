import { randomUUID } from 'node:crypto';
import { activityTime, rootHeader } from './activity-order.mjs';
import { verifiedMessageActivityHeader } from './message-heads.mjs';

/** Observe public post-commit metadata. Neither a waterfall answerer nor a history/Agent reader. */
export function createCatalogActivity(ctx, { identityOf } = {}) {
  if (typeof identityOf !== 'function') throw new TypeError('Invalid catalog activity configuration');
  const profile = ctx.get('profileContext');
  const profileDir = profile?.dir;
  const sessions = ctx.get('sessions');
  const persistence = ctx.get('sessionPersistence');
  const storageRoot = persistence?.config?.root;
  const compression = persistence?.config?.compression;
  const root = ctx.root;
  const ownerFiber = ctx.fiber, rootFiber = root.fiber;
  const ownerUid = ownerFiber.uid, rootUid = rootFiber.uid;
  const captured = [sessions, persistence].map(identityOf);
  // One shared bounded scalar ledger: historical enrichment can never downgrade newer live evidence.
  const rows = new Map();
  function note(header, time) {
    if (!rootHeader(header) || !Number.isSafeInteger(time) || time < header.createdAt) return false;
    const previous = rows.get(header.id);
    if (previous?.createdAt === header.createdAt && previous.updatedAt >= time) return false;
    rows.delete(header.id); rows.set(header.id, Object.freeze({ id: header.id, createdAt: header.createdAt, updatedAt: time }));
    while (rows.size > 4096) rows.delete(rows.keys().next().value);
    return true;
  }
  let closed = false;
  let invalid = false;
  let sourceId = randomUUID();
  let revision = 0;
  function current() {
    if (closed || invalid) return false;
    try {
      const valid = Number.isSafeInteger(ownerUid) && ownerUid >= 0 && Number.isSafeInteger(rootUid) && rootUid >= 0 &&
        ownerFiber.uid === ownerUid && rootFiber.uid === rootUid &&
        ctx.fiber === ownerFiber && ctx.root === root && root.fiber === rootFiber &&
        ctx.get('profileContext') === profile && profile?.name === 'companion' &&
        typeof profileDir === 'string' && profileDir.length > 0 && profile.dir === profileDir &&
        root.get('profileContext') === profile && captured.every(value => value != null) &&
        identityOf(ctx.get('sessions')) === captured[0] && identityOf(root.get('sessions')) === captured[0] &&
        identityOf(ctx.get('sessionPersistence')) === captured[1] && identityOf(root.get('sessionPersistence')) === captured[1] &&
        persistence?.config?.root === storageRoot && persistence?.config?.compression === compression;
      if (!valid) invalid = true;
      return valid;
    } catch { invalid = true; return false; }
  }
  function changed() {
    if (revision === Number.MAX_SAFE_INTEGER) { sourceId = randomUUID(); revision = 0; }
    else revision++;
  }
  function live(session) {
    return current() && rootHeader(session?.header) && session.id === session.header.id && sessions?.get(session.id) === session;
  }
  function receive(session, event) {
    if (!live(session) || !Number.isSafeInteger(event?.seq) || event.seq < 0 || event.seq >= session.seq) return;
    if (note(session.header, activityTime(event))) changed();
  }
  const disposeEvent = ctx.on('session/event', receive);
  const disposeCreated = ctx.on('session/created', session => { if (live(session)) changed(); });
  // Disposal changes membership, not the persisted last-message timestamp.
  const disposeDisposed = ctx.on('session/disposed', session => { if (current() && rootHeader(session?.header)) changed(); });
  return Object.freeze({
    current,
    state() { return current() ? { version: 1, profile: 'companion', sourceId, revision } : null; },
    noteCatalogMutation() { if (current()) changed(); },
    hint(snapshot) {
      if (!current() || !rootHeader(snapshot?.header)) return undefined;
      const row = rows.get(snapshot.header.id);
      return row?.createdAt === snapshot.header.createdAt ? row.updatedAt : undefined;
    },
    historicalHint(metadata) {
      try {
        if (!current()) return false;
        const header = verifiedMessageActivityHeader(metadata, root, profile, persistence, profileDir);
        if (!rootHeader(header) || metadata.id !== header.id || metadata.createdAt !== header.createdAt ||
            !Number.isSafeInteger(metadata.updatedAt) || metadata.updatedAt < header.createdAt) return false;
        const attached = sessions?.get(metadata.id);
        if (attached !== undefined && (!live(attached) || attached.header.createdAt !== metadata.createdAt)) return false;
        if (!current() || !note(header, metadata.updatedAt)) return false;
        changed(); return true;
      } catch { return false; }
    },
    exportMetadata() { return current() ? [...rows.values()].map(row => ({ ...row })) : []; },
    close() {
      if (closed) return;
      closed = true;
      disposeEvent(); disposeCreated(); disposeDisposed(); rows.clear();
    },
  });
}
