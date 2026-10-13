import { lstat, realpath, opendir, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const SOURCE = 'linux-kernel-flock';
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const DEFAULT_LIMITS = Object.freeze({ snapshots: 4096, projects: 256, entries: 20000, procBytes: 1024 * 1024 });
const filesystem = Object.freeze({ lstat, realpath, opendir, open });

/** Linux dev_t encodes split major/minor fields; dev.toString(16) is NOT a tuple. */
export function linuxDeviceKey(device, inode) {
  const dev = BigInt(device);
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return `${major.toString(16)}:${minor.toString(16)}:${BigInt(inode).toString()}`;
}

/** Parse a complete proc snapshot. Blocked '->' entries are waiters, not holders. */
export function parseKernelFlocks(text) {
  const locks = new Map();
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const match = /^(\d+):\s+(?:(->)\s+)?(FLOCK|POSIX|OFDLCK)\s+(ADVISORY|MANDATORY)\s+(READ|WRITE)\s+(-?\d+)\s+([\da-f]+):([\da-f]+):(\d+)\s+(\d+)\s+(EOF|\d+)\s*$/i.exec(line);
    if (match === null) return { valid: false, locks };
    const [, , waiter, type, scope, access, owner, major, minor, inode, start, end] = match;
    if (waiter !== undefined || type !== 'FLOCK' || scope !== 'ADVISORY' || access !== 'WRITE' || start !== '0' || end !== 'EOF') continue;
    const key = `${BigInt(`0x${major}`).toString(16)}:${BigInt(`0x${minor}`).toString(16)}:${BigInt(inode).toString()}`;
    const pid = Number(owner);
    const owners = locks.get(key) ?? new Set();
    owners.add(Number.isSafeInteger(pid) && pid > 0 ? pid : undefined);
    locks.set(key, owners);
  }
  return { valid: true, locks };
}

function refusal(reason) { return Object.assign(new Error(reason), { diagnosticReason: reason }); }
function hasCode(error, code) { return typeof error === 'object' && error !== null && error.code === code; }
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function boundedLimit(value, fallback) { return Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback; }

async function readProc(io, path, maximum, signal) {
  // Proc files report st_size=0. Read until EOF with an explicit byte budget,
  // rather than trusting size metadata or allocating an unbounded readFile.
  const handle = await io.open(path, 'r');
  const chunks = []; let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(65536, maximum + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximum) throw refusal('proc-byte-limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally { await handle.close(); }
}

/**
 * Transparent Linux diagnostics, NOT a DSH ownership API or a mount permission.
 * Caller must supply the trusted configured JSONL root and backend explicitly.
 * No leases are acquired or logs read, and no explicit filesystem/timestamp
 * writes occur. Ordinary reads may still cause kernel-managed access-time updates.
 * `not-observed` means no matching kernel writer was seen in this bounded cut;
 * it never authorizes send/resume. Native atomic write-open remains authoritative.
 * io/procLocksPath/platform/limits are constructor-only deterministic test seams,
 * never model request arguments. Limits can be lowered but never raised.
 */
export async function observeWriterOwnership(snapshots, options = {}) {
  const { root, signal, backend, platform = process.platform, procLocksPath = '/proc/locks', io = filesystem } = options;
  signal?.throwIfAborted();
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([name, value]) => [name, boundedLimit(options.limits?.[name], value)]));
  const results = new Map();
  const observedAt = new Date().toISOString();
  const row = (state, reason, pid) => ({ state, source: SOURCE, observedAt, ...(reason === undefined ? {} : { reason }), ...(pid === undefined ? {} : { pid }) });
  const requested = new Set();
  if (!Array.isArray(snapshots)) return results;
  for (const snapshot of snapshots.slice(0, limits.snapshots)) {
    const id = snapshot?.header?.id;
    if (typeof id !== 'string') continue;
    results.set(id, row('unknown', ID.test(id) ? 'not-inspected' : 'invalid-session-id'));
    if (ID.test(id)) requested.add(id);
  }
  const unknown = reason => {
    for (const id of requested) results.set(id, row('unknown', reason));
    return results;
  };
  if (snapshots.length > limits.snapshots) return unknown('snapshot-limit');
  if (requested.size === 0) return results;
  if (platform !== 'linux') return unknown('unsupported-platform');
  if (backend !== 'jsonl') return unknown('unsupported-persistence-backend');
  if (typeof root !== 'string' || !isAbsolute(root)) return unknown('configured-root-required');
  const base = resolve(root);
  const candidates = new Map();
  const unsafe = new Set();
  let entries = 0; let projects = 0;
  function budget() {
    signal?.throwIfAborted();
    if (++entries > limits.entries) throw refusal('directory-entry-limit');
  }
  async function directory(path) {
    const metadata = await io.lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || await io.realpath(path) !== path) throw refusal('unsafe-directory');
    return metadata;
  }
  async function lockCandidate(project, session) {
    const sessionPath = join(project.path, session);
    const sessionStat = await directory(sessionPath);
    const path = join(sessionPath, 'session.lock');
    let metadata;
    try { metadata = await io.lstat(path, { bigint: true }); }
    catch (error) { if (hasCode(error, 'ENOENT')) return { project, sessionPath, sessionStat, path, missing: true }; throw error; }
    if (metadata.isSymbolicLink() || !metadata.isFile() || await io.realpath(path) !== path) throw refusal('unsafe-lock-file');
    return { project, sessionPath, sessionStat, path, metadata, missing: false };
  }
  let rootStat;
  try {
    rootStat = await directory(base);
    for await (const projectEntry of await io.opendir(base)) {
      budget();
      // A skipped symlink could conceal a second path for a requested id.
      // Refuse the entire cut rather than report a false absence.
      if (projectEntry.isSymbolicLink()) throw refusal('unsafe-directory');
      if (!projectEntry.isDirectory()) continue;
      if (++projects > limits.projects) throw refusal('project-limit');
      const path = join(base, projectEntry.name);
      const project = { path, metadata: await directory(path) };
      for await (const sessionEntry of await io.opendir(path)) {
        budget();
        if (!requested.has(sessionEntry.name)) continue;
        if (sessionEntry.isSymbolicLink() || !sessionEntry.isDirectory()) { unsafe.add(sessionEntry.name); continue; }
        const found = candidates.get(sessionEntry.name) ?? [];
        // Count directory paths even when a lock is absent: an id appearing in
        // two projects is ambiguous, not a guess about which header was listed.
        found.push(await lockCandidate(project, sessionEntry.name));
        candidates.set(sessionEntry.name, found);
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    return unknown(error.diagnosticReason ?? 'root-metadata-unavailable');
  }
  let kernel;
  try { kernel = parseKernelFlocks(await readProc(io, procLocksPath, limits.procBytes, signal)); }
  catch (error) {
    signal?.throwIfAborted();
    return unknown(error.diagnosticReason ?? 'kernel-snapshot-unavailable');
  }
  if (!kernel.valid) return unknown('kernel-snapshot-invalid');
  try {
    const afterRoot = await directory(base);
    if (!sameIdentity(rootStat, afterRoot)) return unknown('root-changed');
  } catch (error) { signal?.throwIfAborted(); return unknown(error.diagnosticReason ?? 'root-metadata-unavailable'); }
  for (const id of requested) {
    signal?.throwIfAborted();
    const paths = candidates.get(id) ?? [];
    if (unsafe.has(id)) { results.set(id, row('unknown', 'unsafe-session-path')); continue; }
    if (paths.length > 1) { results.set(id, row('unknown', 'ambiguous-session-path')); continue; }
    if (paths.length === 0) { results.set(id, row('not-observed', 'session-directory-not-observed')); continue; }
    const candidate = paths[0];
    try {
      const afterProject = await directory(candidate.project.path);
      const afterSession = await directory(candidate.sessionPath);
      if (!sameIdentity(candidate.project.metadata, afterProject) || !sameIdentity(candidate.sessionStat, afterSession)) {
        results.set(id, row('unknown', 'session-path-changed')); continue;
      }
      let after;
      try { after = await io.lstat(candidate.path, { bigint: true }); }
      catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
        results.set(id, candidate.missing ? row('not-observed', 'lock-file-not-observed') : row('unknown', 'lock-file-changed')); continue;
      }
      if (after.isSymbolicLink() || !after.isFile() || await io.realpath(candidate.path) !== candidate.path) {
        results.set(id, row('unknown', 'unsafe-lock-file')); continue;
      }
      if (candidate.missing || !sameIdentity(candidate.metadata, after)) { results.set(id, row('unknown', 'lock-file-changed')); continue; }
      const holders = kernel.locks.get(linuxDeviceKey(after.dev, after.ino));
      if (holders === undefined) results.set(id, row('not-observed', 'matching-kernel-writer-not-observed'));
      else if (holders.size !== 1) results.set(id, row('unknown', 'kernel-holder-ambiguous'));
      else results.set(id, row('held', undefined, [...holders][0]));
    } catch (error) {
      signal?.throwIfAborted();
      results.set(id, row('unknown', error.diagnosticReason ?? 'lock-metadata-unavailable'));
    }
  }
  return results;
}
