import { constants } from 'node:fs';
import { lstat, realpath, readdir, open } from 'node:fs/promises';
import { isAbsolute, resolve, relative, join, dirname, basename, sep, parse } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import { Readable } from 'node:stream';

const HEADER_LIMIT = 128 * 1024;
const HEADER_FIELDS = ['type', 'id', 'version', 'cwd', 'agentPreset', 'origin', 'delegationDepth', 'parentSession', 'isSeeded'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const signature = stat => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs'].map(key => [key, String(stat[key])]));
const same = (a, b) => a && b && ['dev', 'ino', 'size', 'mtimeNs'].every(key => a[key] === b[key]);
const error = (code, message = code, cause) => Object.assign(new Error(message, { cause }), { code });
function aborted(signal) { if (signal?.aborted) throw error('FILE_ABORTED', 'File operation aborted.'); }
function normalized(cause) {
  if (cause?.code?.startsWith('FILE_')) return cause;
  return error(cause?.code === 'ENOENT' ? 'FILE_NOT_FOUND' : cause?.code === 'ELOOP' ? 'FILE_UNSAFE_PATH' : 'FILE_IO', 'File catalog operation failed.', cause);
}
function generation(name) {
  const match = /^session\.v([1-9][0-9]*)\.jsonl(\.zstd)?$/.exec(name);
  if (!match) return null;
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) throw error('FILE_VERSION', 'Invalid physical version.');
  return { version, encoding: match[2] ? 'zstd' : 'jsonl' };
}
function classify(header) {
  if (header.agentPreset === 'companion') return 'companion';
  if (header.origin === 'subagent' || header.delegationDepth > 0) return 'subagent';
  if (header.delegationDepth === 0) return 'main';
  return 'unknown';
}

/**
 * Physical metadata only: root must come from public sessionPersistence.config.
 * Paths are internal controller data, never model-facing references or authority
 * to resolve a logical session. The controller must separately validate header.id.
 * Counters are cumulative until clear(); discover returns a detached snapshot.
 */
export function createFileCatalog({ root, maxEntries = 20000, headerCacheSize = 2048 } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw error('FILE_ROOT', 'An absolute persistence root is required.');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(headerCacheSize) || headerCacheSize < 0) throw error('FILE_OPTIONS', 'Invalid catalog bounds.');
  root = resolve(root);
  const cache = new Map();
  let issued = new Map();
  const counters = {};
  const resetCounters = () => Object.assign(counters, { entries: 0, directories: 0, stats: 0, candidates: 0, skipped: 0, headerReads: 0, headerBytes: 0, cacheHits: 0 });
  resetCounters();
  async function meta(path) { counters.stats++; return lstat(path, { bigint: true }); }
  // Check every component, including ancestors above the configured root. Do not
  // silently canonicalize a symlinked root into a different persistence store.
  async function safePath(path, signal) {
    aborted(signal);
    let current = parse(path).root;
    let stat = await meta(current);
    for (const part of relative(current, path).split(sep).filter(Boolean)) {
      if (!stat.isDirectory()) throw error('FILE_UNSAFE_PATH');
      current = join(current, part);
      stat = await meta(current);
      if (stat.isSymbolicLink()) throw error('FILE_UNSAFE_PATH');
      aborted(signal);
    }
    if (await realpath(path) !== path) throw error('FILE_UNSAFE_PATH');
    return stat;
  }
  async function directory(path, signal) {
    const before = await safePath(path, signal);
    if (!before.isDirectory()) throw error('FILE_UNSAFE_PATH');
    counters.directories++;
    const entries = await readdir(path, { withFileTypes: true });
    const after = await safePath(path, signal);
    if (before.dev !== after.dev || before.ino !== after.ino) throw error('FILE_CHANGED');
    return entries.sort((a, b) => compare(a.name, b.name));
  }
  async function discover({ signal } = {}) {
    try {
      const candidates = [];
      let used = 0, truncated = false;
      function take() {
        aborted(signal);
        if (used >= maxEntries) { truncated = true; return false; }
        used++; counters.entries++; return true;
      }
      outer: for (const project of await directory(root, signal)) {
        if (!take()) break;
        if (!project.isDirectory() || project.isSymbolicLink()) { counters.skipped++; continue; }
        for (const session of await directory(join(root, project.name), signal)) {
          if (!take()) break outer;
          if (!session.isDirectory() || session.isSymbolicLink()) { counters.skipped++; continue; }
          const sessionDir = join(root, project.name, session.name);
          const files = [];
          let unsafeVersion = -1;
          for (const entry of await directory(sessionDir, signal)) {
            // An incomplete directory cannot establish its highest generation.
            if (!take()) break outer;
            const info = generation(entry.name);
            if (!info) continue;
            const path = join(sessionDir, entry.name);
            const stat = await meta(path);
            if (!stat.isFile() || stat.isSymbolicLink()) {
              unsafeVersion = Math.max(unsafeVersion, info.version);
              counters.skipped++; continue;
            }
            files.push({ path, signature: signature(stat), mtimeMs: Number(stat.mtimeNs) / 1e6, size: Number(stat.size), ...info, sessionDir });
          }
          files.sort((a, b) => b.version - a.version || b.mtimeMs - a.mtimeMs || compare(a.path, b.path));
          // A linked/unreadable newest generation must not authorize an older
          // fallback, even though the unsafe generation itself is never issued.
          if (files.length && files[0].version > unsafeVersion) candidates.push(files[0]);
        }
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || compare(a.path, b.path));
      issued = new Map(candidates.map(candidate => [candidate.path, structuredClone(candidate)]));
      counters.candidates += candidates.length;
      return { candidates, counters: { ...counters }, truncated };
    } catch (cause) { throw normalized(cause); }
  }
  async function firstLine(handle, encoding, signal) {
    counters.headerReads++;
    // Own the fd independently of stream destruction: Node may close a
    // FileHandle-backed ReadStream on early destroy despite autoClose:false.
    const input = Readable.from((async function* () {
      let position = 0;
      while (true) {
        aborted(signal);
        const buffer = Buffer.allocUnsafe(1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) return;
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    })(), { objectMode: false, highWaterMark: 1024 });
    const decoder = encoding === 'zstd' ? createZstdDecompress({ chunkSize: 1024, readableHighWaterMark: 1024, writableHighWaterMark: 1024 }) : null;
    const output = decoder ?? input;
    // Piping does not forward source errors; always attach this before pipe().
    const onInputError = cause => decoder?.destroy(cause);
    input.on('error', onInputError);
    const onAbort = () => { output.destroy(error('FILE_ABORTED')); input.destroy(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const parts = [];
    let length = 0;
    try {
      aborted(signal);
      if (decoder) input.pipe(decoder);
      for await (const chunk of output) {
        aborted(signal);
        counters.headerBytes += chunk.length;
        const newline = chunk.indexOf(10);
        const part = newline < 0 ? chunk : chunk.subarray(0, newline);
        length += part.length;
        if (length > HEADER_LIMIT) throw error('FILE_HEADER_LIMIT');
        parts.push(part);
        if (newline >= 0) return Buffer.concat(parts, length).toString('utf8');
      }
      throw error('FILE_HEADER_INCOMPLETE');
    } catch (cause) {
      if (cause?.code?.startsWith('FILE_')) throw cause;
      throw error('FILE_HEADER_DECODE', 'Cannot decode the session header.', cause);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      input.unpipe(decoder ?? undefined);
      output.destroy();
      input.destroy();
    }
  }
  async function openAnchored(path, signal) {
    // Node has no openat API. Linux procfs fd anchors provide the equivalent
    // component walk; only our own descriptors are followed, never disk links.
    // Fail closed elsewhere rather than claim race-free ancestor validation.
    if (process.platform !== 'linux') throw error('FILE_PLATFORM', 'Safe header reads require Linux procfs.');
    let directoryHandle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const parts = path.slice(1).split('/');
      for (const part of parts.slice(0, -1)) {
        aborted(signal);
        const next = await open(`/proc/self/fd/${directoryHandle.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await directoryHandle.close();
        directoryHandle = next;
      }
      aborted(signal);
      return await open(`/proc/self/fd/${directoryHandle.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } finally { await directoryHandle.close(); }
  }
  async function describe(candidate, { signal } = {}) {
    let handle;
    try {
      aborted(signal);
      const trusted = issued.get(candidate?.path);
      if (!trusted || !same(trusted.signature, candidate.signature) || ['version', 'encoding', 'sessionDir', 'size', 'mtimeMs'].some(key => candidate[key] !== trusted[key])) throw error('FILE_CANDIDATE', 'Candidate was not issued by this catalog.');
      const rel = relative(root, trusted.path).split(sep);
      if (rel.length !== 3 || rel.some(part => !part || part === '..') || dirname(trusted.path) !== trusted.sessionDir || !generation(basename(trusted.path))) throw error('FILE_UNSAFE_PATH');
      const before = await safePath(trusted.path, signal);
      if (!before.isFile() || !same(signature(before), trusted.signature)) throw error('FILE_CHANGED');
      const key = JSON.stringify([trusted.path, trusted.signature]);
      if (cache.has(key)) {
        const value = cache.get(key);
        cache.delete(key); cache.set(key, value); counters.cacheHits++;
        return { ...structuredClone(trusted), ...structuredClone(value) };
      }
      if (![3, 4].includes(trusted.version)) return { ...structuredClone(trusted), header: null, classification: 'unreadable' };
      handle = await openAnchored(trusted.path, signal);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !same(signature(opened), trusted.signature)) throw error('FILE_CHANGED');
      // No bytes are read until the opened inode and the entire path agree with
      // an issued metadata candidate. O_NOFOLLOW also fences final-link swaps.
      if (!same(signature(await safePath(trusted.path, signal)), trusted.signature)) throw error('FILE_CHANGED');
      const text = await firstLine(handle, trusted.encoding, signal);
      if (!same(signature(await handle.stat({ bigint: true })), trusted.signature) || !same(signature(await safePath(trusted.path, signal)), trusted.signature)) throw error('FILE_CHANGED');
      let raw;
      try { raw = JSON.parse(text); } catch (cause) { throw error('FILE_HEADER_INVALID', 'Invalid header JSON.', cause); }
      if (!raw || Array.isArray(raw) || raw.type !== 'session' || typeof raw.id !== 'string' || !raw.id.length || raw.version !== trusted.version) throw error('FILE_HEADER_INVALID', 'Header identity or version is invalid.');
      const header = Object.fromEntries(HEADER_FIELDS.filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]));
      const value = { header, classification: classify(header) };
      if (headerCacheSize > 0) {
        cache.set(key, structuredClone(value));
        while (cache.size > headerCacheSize) cache.delete(cache.keys().next().value);
      }
      return { ...structuredClone(trusted), ...value };
    } catch (cause) { throw normalized(cause); }
    finally { await handle?.close(); }
  }
  function clear() { issued.clear(); cache.clear(); resetCounters(); }
  return { discover, describe, clear };
}
