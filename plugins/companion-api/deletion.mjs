import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDetailRequest, companionMetadata, refusal } from './contracts.mjs';
import { resolveHost } from '../common.mjs';
const { RemoteError } = await import(resolveHost('@deepseek-ai/dsh-typert-protocol'));
const { SessionAlreadyOwnedError } = await import(resolveHost('@deepseek-ai/dsh-session-persistence'));

const inside = (root, path) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const fail = code => refusal(`delete-${code}`);
const safeRefusals = new Set(['invalid-request', 'foreign-session', 'delete-invalid-request', 'delete-unsupported', 'delete-busy', 'delete-unavailable', 'delete-changed']);

function sanitized(operation) {
  return async (raw, signal) => {
    let mutationStarted = false;
    try { return await operation(raw, signal, () => { mutationStarted = true; }); }
    catch (error) {
      // The Gateway otherwise serializes ordinary FS error messages, including private paths.
      if (mutationStarted || error?.code === 'companion/delete-unconfirmed') throw fail('unconfirmed');
      const code = error instanceof RemoteError ? error.code?.replace(/^companion\//, '') : undefined;
      if (safeRefusals.has(code)) throw refusal(code);
      throw fail('unavailable');
    }
  };
}

function request(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('invalid-request');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => !['id', 'createdAt', 'confirmation'].includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw fail('invalid-request');
  const { id } = parseDetailRequest({ id: value.id });
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || value.confirmation !== 'delete-companion-chat') throw fail('invalid-request');
  return { id, createdAt: value.createdAt };
}

async function directory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('unavailable');
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) throw fail('unavailable');
  return canonical;
}
async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Recoverable removal from the actual JSONL corpus, never an app-local hide flag. */
export function createDeletion(persistence, { trashRoot = join(homedir(), '.dsh/session-companion/deleted') } = {}) {
  return sanitized(async function deleteChat(raw, signal, markMutation) {
    const { id, createdAt } = request(raw);
    signal?.throwIfAborted();
    if (persistence?.name !== 'session-persistence-jsonl' || typeof persistence.resolveCurrentLog !== 'function' ||
        typeof persistence.acquireWriteLease !== 'function' || typeof persistence.config?.root !== 'string') throw fail('unsupported');
    const snapshot = await persistence.stat(id, { signal });
    if (!companionMetadata(snapshot) || snapshot.header.id !== id || snapshot.header.createdAt !== createdAt) throw refusal('foreign-session');
    if (persistence.hasPendingSession?.(id)) throw fail('busy');
    const root = await directory(resolve(persistence.config.root));
    const log = await persistence.resolveCurrentLog(id, signal);
    if (typeof log !== 'string' || !isAbsolute(log)) throw fail('unsupported');
    const source = await directory(dirname(log));
    // The backend chooses the path. The wire cannot address a file or another root.
    if (!inside(root, source) || dirname(source) === root || !(await lstat(log)).isFile() || (await lstat(log)).isSymbolicLink()) throw fail('unavailable');
    let lease;
    try { lease = await persistence.acquireWriteLease(snapshot.header); }
    catch (error) { signal?.throwIfAborted(); throw fail(error instanceof SessionAlreadyOwnedError ? 'busy' : 'unavailable'); }
    try {
      signal?.throwIfAborted();
      const fresh = await persistence.stat(id, { signal });
      if (!companionMetadata(fresh) || fresh.header.id !== id || fresh.header.createdAt !== createdAt ||
          await persistence.resolveCurrentLog(id, signal) !== log || await directory(dirname(log)) !== source) throw fail('changed');
      const trash = resolve(trashRoot);
      if (trash === root || inside(root, trash) || inside(source, trash) || inside(trash, root)) throw fail('unavailable');
      await mkdir(trash, { recursive: true, mode: 0o700 });
      await directory(trash);
      const destination = resolve(trash, `${id}-${randomUUID()}`);
      if (!inside(trash, destination) || destination === source) throw fail('unavailable');
      signal?.throwIfAborted();
      // The public native kernel lease excludes active writers. Never close/take over an Agent.
      // Keep the lock inode with the archived directory until release; never unlink its lock file.
      markMutation();
      await rename(source, destination);
      await syncDirectory(dirname(source));
      await syncDirectory(trash);
      return { profile: 'companion', id, deleted: true, recoverable: true };
    } finally {
      try { await lease.release(); } catch {
        // Release uncertainty must override even a success receipt; never authorize replay.
        // eslint-disable-next-line no-unsafe-finally
        throw fail('unconfirmed');
      }
    }
  });
}

export const deletionCodecs = Object.freeze({
  request: { mode: 'strict', typeSymbol: 'CompanionDeleteRequest', create: () => ({ parse: value => { request(value); return value; } }) },
  output: { mode: 'strict', typeSymbol: 'CompanionDeleteOutput', create: () => ({ parse: value => {
    if (value?.profile !== 'companion' || value.deleted !== true || value.recoverable !== true || Object.keys(value).sort().join(',') !== 'deleted,id,profile,recoverable') throw refusal('invalid-output');
    parseDetailRequest({ id: value.id });
    return value;
  } }) },
});
