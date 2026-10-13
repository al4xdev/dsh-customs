import { constants } from 'node:fs';
import { mkdir, lstat, realpath, readdir, open, link, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { BrowserError, fail, safeError } from './errors.mjs';

// This fixed helper runs inside the native managed/confining runner. It is not a tool or code evaluator.
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort(new BrowserError('CANCELLED', 'Filesystem operation cancelled.')));
process.once('SIGINT', () => controller.abort(new BrowserError('CANCELLED', 'Filesystem operation cancelled.')));
const signal = controller.signal;
const inside = (base, candidate) => { const part = relative(base, candidate); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const ownerPattern = /^bo_[a-f0-9-]{36}$/;

async function noLinks(path) {
  for (let current = path;; current = dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail('ARTIFACT_PATH_DENIED', 'Filesystem paths cannot have symlink ancestors.');
    if (dirname(current) === current) return;
  }
}
async function secureDirectory(path) {
  if (!isAbsolute(path)) fail('INVALID_ARGS', 'An absolute managed directory is required.');
  let current = dirname(path);
  const missing = [path];
  for (;;) {
    try { await lstat(current); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing.push(current); current = dirname(current); }
  }
  await noLinks(current);
  for (const directory of missing.reverse()) {
    signal.throwIfAborted();
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('ARTIFACT_PATH_DENIED', 'Managed directory is not a real directory.');
  }
}
async function ownedRoot(data, create = false) {
  if (!ownerPattern.test(data.ownerId) || !isAbsolute(data.root) || basename(data.root) !== data.ownerId) fail('ARTIFACT_PATH_DENIED', 'Managed owner namespace is invalid.');
  if (create) await secureDirectory(data.root);
  await noLinks(data.root);
  const root = await realpath(data.root);
  const marker = join(root, '.owner.json');
  if (create) {
    const handle = await open(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600).catch(async error => {
      if (error.code !== 'EEXIST') throw error;
      return undefined;
    });
    if (handle) { try { await handle.writeFile(JSON.stringify({ ownerId: data.ownerId, createdAt: new Date().toISOString() })); } finally { await handle.close(); } }
  }
  const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
  let markerData;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096) fail('ARTIFACT_PATH_DENIED', 'Managed owner marker is invalid.');
    markerData = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  if (markerData.ownerId !== data.ownerId) fail('ARTIFACT_PATH_DENIED', 'Managed namespace belongs to another owner.');
  return root;
}

async function copyExclusive({ source, target, maxBytes, sha256 }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !/^[a-f0-9]{64}$/.test(sha256)) fail('INVALID_ARGS', 'Bounded content and an observed checksum are required.');
  await noLinks(dirname(source));
  await noLinks(dirname(target));
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const temporary = join(dirname(target), `.dsh-browser-export-${randomUUID()}.tmp`);
  let output;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size > maxBytes) fail('LIMIT_EXCEEDED', 'Source is not a bounded regular file.');
    output = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) fail('LIMIT_EXCEEDED', 'Source grew beyond the authorized byte budget.');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let offset = 0;
      while (offset < bytesRead) {
        signal.throwIfAborted();
        const { bytesWritten } = await output.write(chunk, offset, bytesRead - offset, null);
        if (!bytesWritten) fail('IO_ERROR', 'Filesystem copy made no progress.');
        offset += bytesWritten;
      }
    }
    const after = await input.stat();
    const measured = hash.digest('hex');
    if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || measured !== sha256) fail('ARTIFACT_CHANGED', 'Observed source changed before publication.');
    await output.sync();
    await output.close(); output = undefined;
    signal.throwIfAborted();
    // Atomic exclusive publication: another writer wins rather than being overwritten.
    try { await link(temporary, target); }
    catch (error) { if (error.code === 'EEXIST') fail('DESTINATION_EXISTS', 'Browser export never overwrites an existing destination.'); throw error; }
    return { path: target, bytes: total, sha256: measured };
  } finally {
    await input.close();
    if (output) await output.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function main(operation, data) {
  const root = await ownedRoot(data, operation === 'bootstrap');
  if (operation === 'bootstrap') {
    for (const name of ['tmp', 'home', 'staging']) await secureDirectory(join(root, name));
    return { root };
  }
  if (operation === 'release') {
    if (!Array.isArray(data.files) || data.files.length > 16) fail('INVALID_ARGS', 'Only bounded owned staged files can be released.');
    let bytes = 0;
    for (const file of data.files) {
      signal.throwIfAborted();
      if (dirname(file.path) !== join(root, 'staging') || !/^bs_[a-f0-9-]{36}$/.test(basename(file.path))) fail('ARTIFACT_PATH_DENIED', 'Staging release cannot target another namespace or an original source.');
      await noLinks(dirname(file.path));
      const info = await lstat(file.path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink() || await realpath(file.path) !== file.path) fail('ARTIFACT_PATH_DENIED', 'Staging release target is not a concrete owned regular file.');
      bytes += info.size;
      await unlink(file.path);
    }
    return { releasedBytes: bytes };
  }
  if (operation === 'expire') {
    let removed = 0;
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > 3000) fail('LIMIT_EXCEEDED', 'Owned namespace exceeds its bounded maintenance count.');
    for (const entry of entries) {
      signal.throwIfAborted();
      if (!/^ba_[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) fail('ARTIFACT_PATH_DENIED', 'Artifact sidecar cannot be a symlink.');
      const metadataPath = join(root, entry.name);
      const handle = await open(metadataPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let metadata;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 16384) fail('ARTIFACT_PATH_DENIED', 'Artifact sidecar is not a bounded regular file.');
        metadata = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
      const expires = Date.parse(metadata.retentionUntil);
      if (!Number.isFinite(expires) || expires > Date.now() || (metadata.state === 'pending' && data.workerActive)) continue;
      const artifactId = entry.name.slice(0, -5);
      if (metadata.artifactId !== artifactId || typeof metadata.name !== 'string' || !metadata.name.startsWith(`${artifactId}.`) || !/^[a-z0-9]+$/.test(metadata.name.slice(artifactId.length + 1))) fail('ARTIFACT_PATH_DENIED', 'Expired artifact does not have a generated owned filename.');
      const path = join(root, metadata.name);
      if (metadata.path !== path) fail('ARTIFACT_PATH_DENIED', 'Expired artifact points outside its namespace.');
      const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (info && (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path)) fail('ARTIFACT_PATH_DENIED', 'Expired artifact is not a concrete owned regular file.');
      if (info) await unlink(path);
      await unlink(metadataPath);
      removed++;
    }
    let releasedBytes = 0;
    if (!data.workerActive && Number.isSafeInteger(data.retentionMs) && data.retentionMs > 0) {
      const staging = join(root, 'staging');
      await noLinks(staging);
      const files = await readdir(staging, { withFileTypes: true });
      if (files.length > 1000) fail('LIMIT_EXCEEDED', 'Staging exceeds its bounded maintenance count.');
      for (const file of files) {
        signal.throwIfAborted();
        if (!/^bs_[a-f0-9-]{36}$/.test(file.name)) continue;
        const path = join(staging, file.name);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) fail('ARTIFACT_PATH_DENIED', 'Expired staging is not a concrete owned regular file.');
        if (info.mtimeMs + data.retentionMs > Date.now()) continue;
        releasedBytes += info.size;
        await unlink(path);
      }
    }
    return { removed, releasedBytes };
  }
  if (operation === 'stage') {
    if (!Array.isArray(data.sources) || data.sources.length < 1 || data.sources.length > 16) fail('INVALID_ARGS', 'Staging requires bounded observed sources.');
    const result = [];
    for (const source of data.sources) {
      signal.throwIfAborted();
      const path = join(root, 'staging', `bs_${randomUUID()}`);
      const copied = await copyExclusive({ source: source.path, target: path, maxBytes: source.bytes, sha256: source.sha256 });
      result.push({ ...copied, name: basename(source.name ?? source.path).slice(0, 255) });
    }
    return { files: result };
  }
  if (operation === 'export') {
    const sourceRoot = data.sourceRoot ? await ownedRoot({ ...data, root: data.sourceRoot }) : root;
    if (!isAbsolute(data.source) || !inside(sourceRoot, data.source) || !isAbsolute(data.destination)) fail('ARTIFACT_PATH_DENIED', 'Export paths must be concrete and bound to the owned namespace.');
    await noLinks(dirname(data.destination));
    const parent = await realpath(dirname(data.destination));
    const roots = await Promise.all(data.writableRoots.map(path => realpath(path)));
    if (!roots.some(path => inside(path, parent))) fail('ARTIFACT_PATH_DENIED', 'Export destination is outside the authorized roots.');
    const target = join(parent, basename(data.destination));
    try { await lstat(target); fail('DESTINATION_EXISTS', 'Browser export never overwrites an existing destination.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return copyExclusive({ source: data.source, target, maxBytes: data.maxBytes, sha256: data.sha256 });
  }
  fail('UNKNOWN_OPERATION', 'Filesystem helper operation is not allowlisted.');
}

try {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) fail('LIMIT_EXCEEDED', 'Filesystem helper request is too large.');
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const result = await main(process.argv[2], data);
  process.stdout.write(JSON.stringify({ ok: true, data: result }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: safeError(error) }) + '\n');
  process.exitCode = 1;
}
