import { lstat, realpath, opendir } from 'node:fs/promises';
import { isAbsolute, resolve, relative, join, dirname, basename, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { READ_LIMITS, readError } from './read-contracts.mjs';
import { redact } from './contracts.mjs';
import { resolveHost } from '../common.mjs';
const { symbols: { original: serviceOriginal } } = await import(resolveHost('@deepseek-ai/cordis'));

export function componentPrefix(path, prefix) {
  if (typeof path !== 'string' || !isAbsolute(path)) return false;
  const part = relative(resolve(prefix), resolve(path));
  return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function identity(stat) { return `${stat.dev}:${stat.ino}`; }
// Version-fenced implementation of the published JSONL directory layout, used
// only in the FORWARD direction from a public-service-validated header. Never
// reconstruct cwd from a project directory: this encoding is intentionally lossy.
export function canonicalSessionDirectory(root, header) {
  if (header.version !== 4 || typeof header.id !== 'string' || !header.id.length) return undefined;
  const unit = ch => /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  const encode = raw => raw === '.' ? '~002E' : raw === '..' ? '~002E~002E' : raw.split('').map(unit).join('');
  let project = '_no-cwd';
  if (header.cwd !== undefined) {
    if (typeof header.cwd !== 'string' || !header.cwd.length) return undefined;
    let readable = '', separators = false;
    for (const ch of header.cwd.split('')) {
      if (ch === '/' || ch === '\\' || ch === ':') { if (!separators) readable += '-'; separators = true; }
      else { readable += unit(ch); separators = false; }
    }
    project = `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
  }
  return join(root, project, encode(header.id));
}
// This is only a layout locator, not a codec or a reconstructed header. The
// public persistence service must confirm the decoded candidate identity.
export function segmentCandidate(segment) {
  if (!/^(?:[A-Za-z0-9._-]|~[0-9A-F]{4})+$/.test(segment) || ['.', '..'].includes(segment)) return undefined;
  return segment.replace(/~([0-9A-F]{4})/g, (_, value) => String.fromCharCode(parseInt(value, 16)));
}
export function generationCandidate(name) {
  const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/.exec(name);
  if (!match) return undefined;
  const version = Number(match[1] ?? 0);
  return Number.isSafeInteger(version) ? { version, compression: match[2] ? 'zstd' : 'none' } : undefined;
}

/** Metadata-only navigation. It neither opens SQLite nor reads log bodies. */
export function createSourceLocator(ctx, codec, options = {}) {
  const refs = new Map();
  const identities = new Map();
  const queryIdentities = new Map();
  let queryObjectIdentities = new WeakMap();
  const now = options.now ?? Date.now;
  function source() {
    const persistence = ctx.sessionPersistence;
    if (!persistence) throw readError('backend_unavailable');
    const binding = persistence.identity ?? persistence;
    if (!identities.has(binding)) {
      if (identities.size >= 16) identities.clear();
      identities.set(binding, randomUUID());
    }
    const root = persistence.config?.root;
    const query = ctx.sessionQuery;
    // Cordis publicly exports `original`: each contextual service read returns
    // a new tracing proxy. Unwrap ONLY for identity, never for API calls/config;
    // using the proxy as the binding would stale every real SDK request.
    const queryBinding = query?.identity ?? query?.[serviceOriginal] ?? query;
    const queryObjects = queryBinding !== null && ['object', 'function'].includes(typeof queryBinding);
    const queryIds = queryObjects ? queryObjectIdentities : queryIdentities;
    if (queryBinding && !queryIds.has(queryBinding)) {
      if (queryIdentities.size >= 16) queryIdentities.clear();
      queryIds.set(queryBinding, randomUUID());
    }
    const config = query?.config;
    const native = typeof query?.searchEvents === 'function' && typeof config?.path === 'string' && ['startup', 'first-search', 'never'].includes(config?.openAt);
    const configured = native && config.openAt !== 'never';
    const authorized = options.allowManagedIndex === true;
    const sourceId = codec.revision([identities.get(binding), queryIds.get(queryBinding) ?? null, persistence.name ?? 'public-persistence', root ?? null, persistence.config?.compression ?? null, native ? [config.path, config.openAt] : null]);
    return { sourceId, persistence, query, binding, root: typeof root === 'string' && isAbsolute(root) ? resolve(root) : undefined, compression: persistence.config?.compression ?? 'zstd', nativeSearch: configured && authorized,
      public: { sourceId, backend: persistence.name ?? 'public-persistence', canonical: 'public-session-persistence', persistenceRoot: typeof root === 'string' && isAbsolute(root) ? redact(root) : null, physicalPaths: persistence.name === 'session-persistence-jsonl' && typeof root === 'string' && isAbsolute(root), logFormat: 'service-decoded; physical version is discovered separately', index: { backend: native ? 'native-sqlite-derived' : 'unavailable', path: native ? redact(config.path) : null, openAt: native ? config.openAt : null, enabled: configured && authorized, reason: !native ? 'provider_unavailable' : !configured ? 'search_disabled' : !authorized ? 'managed_index_not_authorized' : null, writesDerivedCache: configured && authorized, canonicalWrites: false, liveOverlay: native ? 'same-public-service-only; external-reader-unavailable' : 'unavailable', freshness: 'checked-per-candidate; not inferred from mtime', synchronousNativeCall: native } } };
  }
  function checkSource(args) {
    const value = source();
    if (args.sourceId !== undefined && args.sourceId !== value.sourceId) throw readError('source_changed');
    return value;
  }
  function putRef(value, location) {
    const signature = codec.revision([value.sourceId, location.path, location.role, location.identity]);
    refs.delete(signature);
    refs.set(signature, { ...location, sourceId: value.sourceId, expires: now() + READ_LIMITS.ttlMs });
    while (refs.size > READ_LIMITS.refs) refs.delete(refs.keys().next().value);
    return signature;
  }
  async function safePath(value, path) {
    if (!value.root || !value.public.physicalPaths) throw readError('source_unsupported', 'Physical paths require the configured public JSONL backend.');
    const root = await realpath(value.root).catch(() => { throw readError('path_unavailable'); });
    const actual = resolve(path);
    if (!componentPrefix(actual, value.root)) throw readError('path_outside_source');
    // Resolve each ancestor: rejecting an interior symlink also closes directory
    // filters that would silently jump into a different store.
    let current = value.root;
    for (const part of relative(value.root, actual).split(sep).filter(Boolean)) {
      current = join(current, part);
      const meta = await lstat(current).catch(() => { throw readError('path_unavailable'); });
      if (meta.isSymbolicLink()) throw readError('path_unsafe');
    }
    if (!componentPrefix(await realpath(actual), root)) throw readError('path_unsafe');
    const stat = await lstat(await realpath(actual));
    return { path: actual, identity: identity(stat), directory: stat.isDirectory(), file: stat.isFile() };
  }
  async function resolveRef(value, token) {
    const ref = refs.get(token);
    if (!ref || ref.expires < now()) { refs.delete(token); throw readError('path_ref_expired'); }
    if (ref.sourceId !== value.sourceId) throw readError('source_changed');
    const current = await safePath(value, ref.path);
    if (current.identity !== ref.identity) throw readError('path_changed');
    return ref;
  }
  async function readEntries(value, path, signal, counters) {
    const before = await safePath(value, path);
    if (!before.directory) throw readError('path_role_mismatch', 'Directory required.');
    const entries = [];
    for await (const entry of await opendir(path)) {
      signal?.throwIfAborted();
      if (++counters.entries > READ_LIMITS.entries) throw readError('directory_entry_budget', 'Navigate a narrower explicit directory.');
      if (entry.isSymbolicLink()) entries.push({ name: entry.name, unsafe: true });
      else if (entry.isDirectory() || entry.isFile()) entries.push({ name: entry.name, directory: entry.isDirectory() });
    }
    const after = await safePath(value, path);
    if (before.identity !== after.identity) throw readError('path_changed');
    return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  async function bindDirectory(value, path, id, stored, entries, signal, counters) {
    if (id === undefined || stored?.header?.id !== id) return { confirmed: false, readable: false };
    const expected = canonicalSessionDirectory(value.root, stored.header);
    if (!expected) return { confirmed: false, readable: false };
    try {
      const [actual, canonical] = await Promise.all([safePath(value, path), safePath(value, expected)]);
      if (!actual.directory || actual.identity !== canonical.identity) return { confirmed: false, readable: false };
      const children = entries ?? await readEntries(value, path, signal, counters);
      const logs = children.flatMap(entry => !entry.directory && !entry.unsafe && generationCandidate(entry.name) ? [generationCandidate(entry.name)] : []);
      const highest = Math.max(-1, ...logs.map(log => log.version));
      const selected = logs.filter(log => log.version === highest);
      const readable = selected.length === 1 && selected[0].compression === value.compression && highest <= stored.header.version && logs.every(log => log.compression === value.compression);
      // Empty leftover aliases and future/mixed generations cannot bind a
      // locator to a globally resolved Session id, even if stat(id) succeeds.
      return { confirmed: readable, readable, highest };
    } catch { signal?.throwIfAborted(); return { confirmed: false, readable: false }; }
  }
  async function navigate(value, args, signal, counters) {
    let path = args.directory ?? value.root;
    if (args.pathRef) path = (await resolveRef(value, args.pathRef)).path;
    if (args.sessionId) {
      // Native ids are never interpolated into host paths. Find the encoded
      // candidate in bounded metadata, then ask stat to verify its identity.
      const matches = [];
      for (const project of await readEntries(value, value.root, signal, counters)) {
        if (!project.directory || project.unsafe) continue;
        for (const candidate of await readEntries(value, join(value.root, project.name), signal, counters)) if (candidate.directory && !candidate.unsafe && segmentCandidate(candidate.name) === args.sessionId) matches.push(join(value.root, project.name, candidate.name));
      }
      if (matches.length > 1) throw readError('path_ambiguous');
      if (!matches.length) throw readError('not_found');
      path = matches[0];
    }
    const location = await safePath(value, path);
    if (location.file) path = dirname(path);
    const depth = relative(value.root, path).split(sep).filter(Boolean).length;
    if (depth > 2) throw readError('path_role_mismatch');
    const role = ['persistenceRoot', 'projectDir', 'sessionDir'][depth];
    if (depth === 0 && (args.project || args.projectPrefix)) throw readError('path_role_mismatch', 'Project filters require a project/session directory; use list for header cwd discovery.');
    const entries = await readEntries(value, path, signal, counters);
    const rows = [];
    let snapshot;
    let candidateId;
    if (depth === 2) {
      candidateId = segmentCandidate(basename(path));
      try { snapshot = candidateId === undefined ? undefined : await value.persistence.stat(candidateId, { signal }); counters.stats++; }
      catch (error) { signal?.throwIfAborted(); snapshot = undefined; }
    }
    const generations = depth === 2 ? entries.flatMap(entry => !entry.directory && !entry.unsafe && generationCandidate(entry.name) ? [{ ...entry, ...generationCandidate(entry.name) }] : []) : [];
    const highest = Math.max(-1, ...generations.map(entry => entry.version));
    const directoryProof = depth === 2 ? await bindDirectory(value, path, candidateId, snapshot, entries, signal, counters) : undefined;
    for (const entry of entries) {
      if (entry.unsafe) { rows.push({ role: 'unsafe', name: redact(entry.name), code: 'path_unsafe' }); continue; }
      if (depth < 2 && !entry.directory) continue;
      const generation = depth === 2 ? generationCandidate(entry.name) : undefined;
      if (depth === 2 && (entry.directory || !generation)) continue;
      const child = await safePath(value, join(path, entry.name));
      const childRole = depth < 2 ? ['projectDir', 'sessionDir'][depth] : 'logGeneration';
      let id = depth === 1 ? segmentCandidate(entry.name) : candidateId;
      let stored = snapshot;
      if (depth === 1 && id !== undefined) {
        try { stored = await value.persistence.stat(id, { signal }); counters.stats++; }
        catch { signal?.throwIfAborted(); stored = undefined; }
      }
      if (args.project && stored?.header?.cwd !== args.project || args.projectPrefix && !componentPrefix(stored?.header?.cwd, args.projectPrefix)) continue;
      const proof = depth === 1 ? await bindDirectory(value, child.path, id, stored, undefined, signal, counters) : directoryProof;
      const confirmed = proof?.confirmed === true;
      const readable = confirmed && (!generation || generation.version === highest);
      rows.push({ role: childRole, path: redact(child.path), pathRef: putRef(value, { ...child, role: childRole, readable, ...(confirmed ? { sessionId: id } : {}) }), ...(confirmed ? { sessionId: id, project: redact(stored.header.cwd ?? ''), revision: codec.revision([value.sourceId, stored.revision, stored.header]) } : depth > 0 ? { identityConfirmed: false, code: 'canonical_location_unconfirmed' } : {}), ...(generation ? { physicalFormatVersion: generation.version, compression: generation.compression, selected: generation.version === highest, readable } : {}) });
    }
    return { location: { role, path: redact(path), pathRef: putRef(value, { ...(await safePath(value, path)), role, readable: directoryProof?.readable, ...(directoryProof?.confirmed ? { sessionId: candidateId } : {}) }) }, rows };
  }
  async function confirmRef(value, ref, signal, counters) {
    if (!ref.sessionId || ref.readable !== true) throw readError('path_role_mismatch', 'Only confirmed selected canonical locations can target logical reads.');
    counters.stats++;
    let stored;
    try { stored = await value.persistence.stat(ref.sessionId, { signal }); }
    catch { signal?.throwIfAborted(); throw readError('canonical_location_changed'); }
    const proof = await bindDirectory(value, ref.role === 'logGeneration' ? dirname(ref.path) : ref.path, ref.sessionId, stored, undefined, signal, counters);
    if (!proof.confirmed || ref.role === 'logGeneration' && generationCandidate(basename(ref.path))?.version !== proof.highest) throw readError('canonical_location_changed');
  }
  return { source, checkSource, safePath, resolveRef, confirmRef, navigate, putRef, clear: () => { refs.clear(); identities.clear(); queryIdentities.clear(); queryObjectIdentities = new WeakMap(); } };
}
