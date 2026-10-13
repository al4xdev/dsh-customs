import { constants, createReadStream } from 'node:fs';
import { mkdir, lstat, realpath, open, statfs, writeFile, rename, unlink, opendir } from 'node:fs/promises';
import { join, relative, isAbsolute, sep, dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fail } from '../errors.mjs';

const metadataKeys = new Set(['width', 'height', 'durationMs', 'pageId', 'sessionId', 'generation', 'captureId', 'frameIndex']);
const inside = (root, path) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const sidecarPattern = new RegExp(`^(ba_${uuid})\\.json$`);
const artifactPattern = new RegExp(`^(ba_${uuid})\\.([a-z0-9]{1,12})$`);
const temporaryPattern = new RegExp(`^\\.ba_${uuid}-${uuid}\\.tmp$`);
const idPattern = new RegExp(`^ba_${uuid}$`);
const fields = new Set(['artifactId', 'kind', 'mime', 'bytes', 'state', 'path', 'name', 'sha256', 'createdAt', 'retentionUntil', ...metadataKeys]);
const states = new Set(['pending', 'finalized', 'partial', 'failed', 'expired']);

async function noLinks(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) fail('ARTIFACT_PATH_DENIED', 'Artifact namespace has a symlink ancestor.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === dirname(current)) break;
  }
}
async function boundedJson(path, limit) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) fail('ARTIFACT_PATH_DENIED', 'Owned metadata is not a bounded regular file.');
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > limit) fail('ARTIFACT_PATH_DENIED', 'Owned metadata exceeds its byte limit.');
    const value = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ARTIFACT_PATH_DENIED', 'Owned metadata must be a plain object.');
    return { value, bytes };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ARTIFACT_PATH_DENIED') throw error;
    fail('ARTIFACT_PATH_DENIED', 'Owned metadata could not be read safely.');
  } finally { await handle?.close(); }
}
function validateRecord(record, id, root) {
  if (Object.keys(record).some(key => !fields.has(key)) || record.artifactId !== id || !states.has(record.state)) fail('ARTIFACT_PATH_DENIED', 'Owned sidecar identity or fields are invalid.');
  for (const key of ['kind', 'mime', 'path', 'name', 'createdAt', 'retentionUntil']) if (typeof record[key] !== 'string' || !record[key] || record[key].length > 4096 || /[\x00-\x1f]/.test(record[key])) fail('ARTIFACT_PATH_DENIED', 'Owned sidecar text fields are invalid.');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(record.kind) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(record.mime)) fail('ARTIFACT_PATH_DENIED', 'Owned sidecar media fields are invalid.');
  const name = artifactPattern.exec(record.name);
  if (!name || name[1] !== id || record.path !== join(root, record.name)) fail('ARTIFACT_PATH_DENIED', 'Sidecar cannot grant an arbitrary file path.');
  for (const key of ['bytes', 'width', 'height', 'durationMs', 'generation', 'frameIndex']) {
    if ((key === 'bytes' || record[key] !== undefined) && (!Number.isSafeInteger(record[key]) || record[key] < 0)) fail('ARTIFACT_PATH_DENIED', 'Owned sidecar numeric fields are invalid.');
  }
  for (const key of ['pageId', 'sessionId', 'captureId']) if (record[key] !== undefined && (typeof record[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record[key]))) fail('ARTIFACT_PATH_DENIED', 'Owned sidecar handle fields are invalid.');
  if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.retentionUntil)) || (record.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(record.sha256))) fail('ARTIFACT_PATH_DENIED', 'Owned sidecar dates or checksum are invalid.');
  if (record.state === 'finalized' && record.sha256 === undefined) fail('ARTIFACT_PATH_DENIED', 'Finalized owned metadata lacks its frozen checksum.');
}

/** Only generated namespaces reach engine writers; remote/site filenames are never destinations. */
export class ArtifactStore {
  constructor({ root, ownerId, limits = {}, resourceBudget = {} }) {
    if (!isAbsolute(root) || typeof ownerId !== 'string' || !ownerId || ownerId.length > 1024) fail('ARTIFACT_PATH_DENIED', 'Artifact store requires a private owned namespace.');
    for (const key of ['bytes', 'count']) if (resourceBudget[key] !== undefined && (!Number.isSafeInteger(resourceBudget[key]) || resourceBudget[key] < 0)) fail('BACKEND_UNAVAILABLE', 'Private external artifact budget is invalid.');
    this.root = root;
    this.ownerId = ownerId;
    this.externalBytes = resourceBudget.bytes ?? 0;
    this.externalCount = resourceBudget.count ?? 0;
    this.sidecarBytes = new Map();
    this.recoveryBytes = 0;
    this.recoveryCount = 0;
    this.limits = limits;
    this.records = new Map();
    this.ready = null;
    this.reservations = Promise.resolve();
  }
  async initialize() {
    if (!this.ready) this.ready = (async () => {
      await noLinks(this.root);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await noLinks(this.root);
      this.root = await realpath(this.root);
      const markerPath = join(this.root, '.owner.json');
      let marker;
      try { marker = await boundedJson(markerPath, 4096); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // An absent marker is adopted ONLY for a new empty directory, never legacy foreign content.
        const directory = await opendir(this.root);
        let first;
        try { first = await directory.read(); } finally { await directory.close(); }
        if (first) fail('ARTIFACT_PATH_DENIED', 'Nonempty artifact namespace lacks its owner marker.');
        const handle = await open(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(JSON.stringify({ ownerId: this.ownerId, createdAt: new Date().toISOString() })); } finally { await handle.close(); }
        marker = await boundedJson(markerPath, 4096);
      }
      if (marker.value.ownerId !== this.ownerId) fail('ARTIFACT_PATH_DENIED', 'Artifact namespace belongs to another owner.');
      this.recoveryBytes += marker.bytes;
      await this.recover();
    })();
    await this.ready;
  }
  totalBytes() { return this.externalBytes + this.recoveryBytes + [...this.sidecarBytes.values()].reduce((sum, bytes) => sum + bytes, 0) + [...this.records.values()].reduce((sum, record) => sum + record.bytes, 0); }
  totalCount() { return this.externalCount + this.recoveryCount + this.records.size; }
  async recover() {
    const payloads = new Map();
    const updates = [];
    let entries = 0;
    const directory = await opendir(this.root);
    for await (const entry of directory) {
      if (++entries > 4000) fail('LIMIT_EXCEEDED', 'Owned artifact namespace exceeds the bounded recovery scan.');
      if (entry.name === '.owner.json') continue;
      if (['tmp', 'home', 'staging'].includes(entry.name)) {
        if (!entry.isDirectory()) fail('ARTIFACT_PATH_DENIED', 'Private runtime directory is not concrete.');
        continue;
      }
      const path = join(this.root, entry.name);
      const sidecar = sidecarPattern.exec(entry.name);
      if (sidecar) {
        if (this.records.size >= 1000) fail('LIMIT_EXCEEDED', 'Persisted artifact metadata limit reached.');
        const { value: record, bytes } = await boundedJson(path, 16384);
        validateRecord(record, sidecar[1], this.root);
        this.sidecarBytes.set(record.artifactId, bytes);
        this.records.set(record.artifactId, record);
      } else if (artifactPattern.test(entry.name)) {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size)) fail('ARTIFACT_PATH_DENIED', 'Owned artifact payload must be a regular file.');
        payloads.set(entry.name, info.size);
      } else if (temporaryPattern.test(entry.name)) {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) fail('ARTIFACT_PATH_DENIED', 'Owned metadata spool is invalid.');
        this.recoveryBytes += info.size;
        this.recoveryCount++;
      } else if (entry.name.endsWith('.json')) fail('ARTIFACT_PATH_DENIED', 'Foreign artifact sidecar is not accepted.');
    }
    let hashBudget = Math.min(this.limits.ownerBytes ?? 500 * 1024 ** 2, 512 * 1024 ** 2);
    for (const record of this.records.values()) {
      const bytes = payloads.get(record.name);
      payloads.delete(record.name);
      const priorState = record.state;
      const priorBytes = record.bytes;
      record.bytes = bytes ?? 0;
      if (bytes === undefined || priorState === 'pending') {
        record.state = bytes ? 'partial' : 'failed';
        delete record.sha256;
      } else if (priorState === 'finalized') {
        if (bytes !== priorBytes || bytes > hashBudget) record.state = 'partial';
        else {
          hashBudget -= bytes;
          const handle = await open(record.path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const before = await handle.stat();
            if (!before.isFile() || before.size !== bytes) fail('ARTIFACT_PATH_DENIED', 'Owned payload changed during recovery.');
            const hash = createHash('sha256');
            let readBytes = 0;
            for await (const chunk of handle.createReadStream({ autoClose: false })) {
              readBytes += chunk.length;
              if (readBytes > bytes) fail('ARTIFACT_PATH_DENIED', 'Owned payload grew during recovery.');
              hash.update(chunk);
            }
            const after = await handle.stat();
            if (readBytes !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || hash.digest('hex') !== record.sha256) record.state = 'partial';
          } finally { await handle.close(); }
        }
        // A changed source never receives a newly "approved" checksum during recovery.
        if (record.state !== 'finalized') delete record.sha256;
      }
      if (record.state !== priorState || record.bytes !== priorBytes) updates.push(record);
    }
    // A crash between exclusive payload creation and sidecar publication still consumes quota.
    this.recoveryCount += payloads.size;
    this.recoveryBytes += [...payloads.values()].reduce((sum, bytes) => sum + bytes, 0);
    for (const record of updates) await this.persist(record);
  }
  async checkSpace() {
    await this.initialize();
    const status = await statfs(this.root);
    const free = Number(status.bavail) * Number(status.bsize);
    if (free < (this.limits.freeDiskBytes ?? 1024 ** 3)) fail('LIMIT_EXCEEDED', 'Insufficient free disk space for a browser artifact.');
    if (this.totalBytes() >= (this.limits.ownerBytes ?? 500 * 1024 ** 2)) fail('LIMIT_EXCEEDED', 'Owned browser artifact budget is exhausted.');
  }
  reserve(spec) {
    // Automatic video finalization can race foreground screenshots; admission spans the file awaits.
    const result = this.reservations.then(() => this.reserveOwned(spec));
    this.reservations = result.then(() => {}, () => {});
    return result;
  }
  async reserveOwned({ kind, mime, extension, ...metadata }) {
    await this.checkSpace();
    if (this.totalCount() >= 1000) fail('LIMIT_EXCEEDED', 'Owned artifact metadata limit reached.');
    if (!/^[a-z0-9]{1,12}$/.test(extension)) fail('INVALID_ARGS', 'Artifact format is not supported.');
    const artifactId = `ba_${randomUUID()}`;
    const path = join(this.root, `${artifactId}.${extension}`);
    const createdAt = new Date().toISOString();
    const record = { artifactId, kind, mime, bytes: 0, state: 'pending', path, name: `${artifactId}.${extension}`, createdAt, retentionUntil: new Date(Date.now() + (this.limits.retentionMs ?? 7 * 86400_000)).toISOString() };
    for (const [key, value] of Object.entries(metadata)) if (metadataKeys.has(key) && value !== undefined) record[key] = value;
    validateRecord(record, artifactId, this.root);
    const charge = Buffer.byteLength(JSON.stringify(record) + '\n');
    if (charge > 16384 || this.totalBytes() + charge > (this.limits.ownerBytes ?? 500 * 1024 ** 2)) fail('LIMIT_EXCEEDED', 'Artifact metadata reservation exceeds the owned byte budget.');
    if (this.records.has(artifactId)) fail('BACKEND_INVALID_OUTPUT', 'Generated artifact identity collided.');
    // Charge count and pending sidecar BEFORE the first physical file commit, including on persistence failure.
    this.records.set(artifactId, record);
    this.sidecarBytes.set(artifactId, charge);
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.close();
      await this.persist(record);
    } catch (error) { record.state = 'failed'; throw error; }
    return { ...record };
  }
  inspect(artifactId) {
    const record = this.records.get(artifactId);
    if (!record) fail('ARTIFACT_NOT_FOUND', 'Owned artifact was not found.');
    return { ...record };
  }
  async confirmDelivery(artifactIds, context = {}) {
    // Never invoke caller getters at this private boundary.
    if (!Array.isArray(artifactIds) || Object.getPrototypeOf(artifactIds) !== Array.prototype || artifactIds.length < 1 || artifactIds.length > 8) fail('INVALID_ARGS', 'Delivery requires one to eight unique artifact IDs.');
    const descriptors = Object.getOwnPropertyDescriptors(artifactIds);
    if (Reflect.ownKeys(descriptors).length !== artifactIds.length + 1) fail('INVALID_ARGS', 'Delivery IDs must be a dense plain array.');
    const ids = [];
    for (let index = 0; index < artifactIds.length; index++) {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !idPattern.test(descriptor.value)) fail('INVALID_ARGS', 'Delivery IDs must be opaque owned artifact IDs.');
      ids.push(descriptor.value);
    }
    if (new Set(ids).size !== ids.length) fail('INVALID_ARGS', 'Delivery IDs must be unique.');
    const result = this.reservations.then(() => this.confirmDeliveryOwned(ids, context));
    this.reservations = result.then(() => {}, () => {});
    return result;
  }
  async confirmDeliveryOwned(ids, { signal, deadlineMs } = {}) {
    const check = () => {
      if (signal?.aborted) fail('CANCELLED', 'Artifact delivery was cancelled.');
      if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs)) fail('DEADLINE_EXCEEDED', 'Artifact delivery deadline expired.');
    };
    check();
    await this.initialize();
    await noLinks(this.root);
    const marker = await boundedJson(join(this.root, '.owner.json'), 4096);
    if (marker.value.ownerId !== this.ownerId) fail('ARTIFACT_PATH_DENIED', 'Artifact namespace belongs to another owner.');
    const updated = [];
    for (const id of ids) {
      check();
      const record = this.records.get(id);
      if (!record) fail('ARTIFACT_NOT_FOUND', 'Owned artifact was not found.');
      if (record.state !== 'finalized') fail('ARTIFACT_NOT_FINALIZED', 'Only finalized artifacts can be delivered.');
      validateRecord(record, id, this.root);
      const { value: persisted } = await boundedJson(join(this.root, `${id}.json`), 16384);
      validateRecord(persisted, id, this.root);
      if (JSON.stringify(persisted) !== JSON.stringify(record)) fail('ARTIFACT_PATH_DENIED', 'Owned artifact sidecar changed before delivery.');
      let handle;
      try {
        handle = await open(record.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = await handle.stat();
        if (!before.isFile() || before.size !== record.bytes) fail('ARTIFACT_NOT_FINALIZED', 'Finalized artifact source changed before delivery.');
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          check();
          bytes += chunk.length;
          if (bytes > record.bytes) fail('ARTIFACT_NOT_FINALIZED', 'Finalized artifact source grew before delivery.');
          hash.update(chunk);
        }
        const after = await handle.stat();
        const current = await lstat(record.path);
        if (bytes !== record.bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs || hash.digest('hex') !== record.sha256) fail('ARTIFACT_NOT_FINALIZED', 'Finalized artifact source changed before delivery.');
      } catch (error) {
        if (error.code === 'ENOENT') fail('ARTIFACT_NOT_FOUND', 'Owned artifact file was not found.');
        if (error.code === 'ELOOP') fail('ARTIFACT_PATH_DENIED', 'Owned artifact file cannot be a symlink.');
        throw error;
      } finally { await handle?.close(); }
      check();
      // Replace raw TTL, including delivery policies narrowed below raw retention.
      const promoted = { ...record, retentionUntil: new Date(Date.now() + (this.limits.deliveryRetentionMs ?? 7 * 86400_000)).toISOString() };
      await this.persist(promoted);
      this.records.set(id, promoted);
      check();
      updated.push({ ...promoted });
    }
    return updated;
  }
  list({ sessionId, kind, state } = {}) {
    return [...this.records.values()].filter(record => (!sessionId || record.sessionId === sessionId) && (!kind || record.kind === kind) && (!state || record.state === state)).map(record => ({ ...record }));
  }
  async finalize(artifactId, metadata = {}) {
    const record = this.records.get(artifactId);
    if (!record) fail('ARTIFACT_NOT_FOUND', 'Owned artifact was not found.');
    if (!inside(this.root, record.path)) fail('ARTIFACT_PATH_DENIED', 'Artifact path escaped its namespace.');
    const input = await open(record.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let info;
    try { info = await input.stat(); } finally { await input.close(); }
    if (!info.isFile()) fail('ARTIFACT_PATH_DENIED', 'Artifact is not a regular file.');
    const previousBytes = record.bytes;
    record.bytes = info.size;
    for (const [key, value] of Object.entries(metadata)) if (metadataKeys.has(key) && value !== undefined) record[key] = value;
    record.state = metadata.state ?? 'finalized';
    const session = [...this.records.values()].filter(item => item.sessionId === record.sessionId).reduce((sum, item) => sum + item.bytes, 0);
    let exceeded = this.totalBytes() > (this.limits.ownerBytes ?? 500 * 1024 ** 2) || session > (this.limits.sessionBytes ?? 250 * 1024 ** 2);
    if (exceeded) record.state = 'partial';
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(record.path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) hash.update(chunk);
    record.sha256 = hash.digest('hex');
    await this.persist(record);
    if (!exceeded && this.totalBytes() > (this.limits.ownerBytes ?? 500 * 1024 ** 2)) { exceeded = true; record.state = 'partial'; await this.persist(record); }
    if (exceeded) fail('LIMIT_EXCEEDED', 'Browser artifact exceeded the owned quota; the artifact is partial, not an approved delivery.', { artifactId, effectState: 'partial', previousBytes });
    return { ...record };
  }
  async write({ data, ...spec }) {
    const record = await this.reserve(spec);
    if (!(data instanceof Uint8Array)) fail('BACKEND_INVALID_OUTPUT', 'Artifact data must be binary bytes.');
    if (data.byteLength > (this.limits.ownerBytes ?? 500 * 1024 ** 2)) {
      await this.mark(record.artifactId, 'failed');
      fail('LIMIT_EXCEEDED', 'Browser artifact is too large.');
    }
    const handle = await open(record.path, constants.O_WRONLY | constants.O_NOFOLLOW);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    return this.finalize(record.artifactId);
  }
  async mark(artifactId, state) {
    const record = this.records.get(artifactId);
    if (!record) return;
    record.state = state;
    try {
      const info = await lstat(record.path);
      if (info.isFile()) record.bytes = info.size;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.persist(record);
  }
  async persist(record) {
    // Sidecars survive worker loss. They are metadata, never a grant to read/export another owner.
    const target = join(this.root, `${record.artifactId}.json`);
    const temporary = join(this.root, `.${record.artifactId}-${randomUUID()}.tmp`);
    const contents = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(contents) > 16384) fail('LIMIT_EXCEEDED', 'Artifact metadata exceeds its persisted limit.');
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    try { await rename(temporary, target); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    this.sidecarBytes.set(record.artifactId, Buffer.byteLength(contents));
  }
}
