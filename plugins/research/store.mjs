import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';

const exec = promisify(execFile);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const CONFIG = new RegExp(`^c-${UUID}$`);
const REF = new RegExp(`^e-${UUID}$`);
const RUN = /^r-[1-9][0-9]{0,14}-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{12}$/;
const MAX_JSON = 2_000_000;
const MAX_OUTPUT = 16000;
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
// Upstream metadata is archival data, not a safe context-sized tool response.
function compactMetadata(metadata) {
  const result = { truncation: { content: metadata.truncation?.content === true, comments: metadata.truncation?.comments === true } };
  for (const key of ['content_length', 'stored_length', 'comments_count', 'stored_comments_count', 'comment_nodes_count', 'comments_selected_count', 'comments_available_count', 'commentCount', 'selectedCommentCount', 'moreCalls', 'attempted_count', 'fetched_count', 'skipped_count']) {
    if (Number.isSafeInteger(metadata[key]) && metadata[key] >= 0) result[key] = metadata[key];
  }
  let shortened = false;
  for (const key of ['reddit', 'continuation']) {
    const input = metadata[key];
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    const value = {};
    for (const field of ['postId', 'commentId', 'subreddit', 'after']) if (typeof input[field] === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(input[field])) value[field] = input[field];
    if (Array.isArray(input.children)) {
      value.children = input.children.filter(v => typeof v === 'string' && /^[a-z0-9]{1,20}$/.test(v)).slice(0, 10);
      value.remainingIdsTruncated = input.remainingIdsTruncated === true || input.children.length > value.children.length;
    }
    if (typeof input.listingComplete === 'boolean') value.listingComplete = input.listingComplete;
    result[key] = value;
  }
  // Identity and provenance take precedence over optional descriptive fields.
  for (const [key, size] of Object.entries({ libraryId: 256, provenance: 256, text_format: 64, source: 64, kind: 64, comments_count_scope: 64, sourceUrls: 256, url: 1024, title: 256, collected_at: 64, publishedAt: 64, limitations: 320, errors: 320 })) {
    const value = metadata[key];
    if (value === undefined) continue;
    let bounded;
    if (typeof value === 'string') {
      bounded = value.slice(0, size);
      shortened ||= value.length > size;
    } else if (Array.isArray(value)) {
      bounded = value.slice(0, 3).map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry)).slice(0, size));
      shortened ||= value.length > 3 || value.some(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry)).length > size);
    } else { shortened = true; continue; }
    if (jsonBytes({ ...result, [key]: bounded }) <= 3000) result[key] = bounded;
    else shortened = true;
  }
  if (shortened) result.truncation.metadata = true;
  return result;
}
function boundContent(result) {
  if (jsonBytes(result) <= MAX_OUTPUT) return result;
  let low = 0;
  let high = result.content.length;
  const content = result.content;
  result.truncated = true;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonBytes({ ...result, content: content.slice(0, mid) }) <= MAX_OUTPUT) low = mid;
    else high = mid - 1;
  }
  result.content = content.slice(0, low);
  return result;
}
const clone = value => JSON.parse(JSON.stringify(value));
const valid = (value, pattern) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Invalid research id/ref');
  return value;
};
const object = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return clone(value);
};

/**
 * Local, owner-scoped JSON storage. readRun returns the manifest, including a
 * relative `path`; configs and evidence are immutable; writeRun preserves the
 * identity, owner, config, path and creation timestamp. inspect without ref lists
 * saved files, independent of manifest checkpoints. Offsets/limits count UTF-16
 * code units; query filters the index or selects the first match within evidence.
 * section:'comments' (requires ref) pages JSON text with the same content/offset
 * contract. Metadata is allowlisted and compact, including saveEvidence returns;
 * comments remain on disk only unless requested. inspect output is <=16000 UTF-8
 * JSON bytes, content <=12000 code units, index <=20 entries (offset counts entries).
 *
 * Every access checks ancestors with lstat/realpath; file opens use O_NOFOLLOW.
 * Node lacks portable openat/renameat directory-fd operations: a malicious local
 * process can still race ancestor replacement between checks and syscalls. This
 * is best-effort protection, NOT a sandbox against concurrent hostile OS users.
 * Private directories/files must not be shared with untrusted local processes.
 */
export async function openStore(cwd, owner) {
  if (typeof owner !== 'string' || !owner || owner.length > 1024) throw new Error('Invalid session owner');
  const base = path.resolve(cwd);
  const root = path.join(base, '.dumps/research');
  const anchors = new Map();

  async function check(target, missing = false) {
    const absolute = path.resolve(target);
    if (absolute !== base && !absolute.startsWith(base + path.sep)) throw new Error('Unsafe research path');
    const parts = absolute.split(path.sep).filter(Boolean);
    let current = path.parse(absolute).root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = await fs.lstat(current); } catch (error) {
        if (missing && error.code === 'ENOENT' && i === parts.length - 1) return;
        throw error;
      }
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) throw new Error('Unsafe research path: symlink or non-directory');
      if (await fs.realpath(current) !== current) throw new Error('Unsafe research realpath');
      const previous = anchors.get(current);
      if (previous && (previous.dev !== stat.dev || previous.ino !== stat.ino)) throw new Error('Research directory was replaced');
    }
  }
  async function directory(target) {
    await check(path.dirname(target));
    await check(target, true);
    try { await fs.mkdir(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await check(target);
    const stat = await fs.lstat(target);
    if (!stat.isDirectory()) throw new Error('Expected research directory');
    anchors.set(target, { dev: stat.dev, ino: stat.ino });
    // Do not change project/.dumps permissions; only directories owned by storage.
    if (target === root || target.startsWith(root + path.sep)) await fs.chmod(target, 0o700);
  }
  await check(base);
  await check(path.join(base, '.dumps'), true);
  anchors.set(base, await fs.lstat(base));
  try {
    await exec('git', ['check-ignore', '--quiet', '.dumps/research/probe'], { cwd: base, timeout: 5000 });
  } catch (error) {
    if (error?.code === 128 || /not a git repository/i.test(error?.stderr ?? '')) {
      throw new Error('Research storage refused: working directory is not a Git repository. Research requires a Git repository (run `git init` or switch to a project with git).');
    }
    throw new Error('Research storage refused: git check-ignore .dumps/research/probe must succeed. Add `.dumps/` (or `.dumps/research/`) to `.gitignore` before using research; no gitignore was modified.');
  }
  await directory(path.join(base, '.dumps'));
  await directory(root);
  for (const name of ['configs', 'runs', 'allocations']) await directory(path.join(root, name));

  async function read(file) {
    await check(file);
    const initial = await fs.lstat(file);
    if (!initial.isFile() || initial.size > MAX_JSON) throw new Error('Invalid research file size/type');
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_JSON) throw new Error('Invalid research file size/type');
      const data = await handle.readFile('utf8');
      await check(file);
      return JSON.parse(data);
    } finally { await handle.close(); }
  }
  async function atomic(file, data, exclusive = false) {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    if (Buffer.byteLength(text) > MAX_JSON) throw new Error('Research JSON exceeds storage limit');
    await check(file, true);
    const temp = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
    await check(path.dirname(file));
    const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await check(temp);
      await check(file, true);
      if (exclusive) {
        await fs.link(temp, file);
        await check(temp);
        await fs.unlink(temp);
      } else await fs.rename(temp, file);
      await check(file);
    } catch (error) {
      // Never clean through an ancestor that has become unsafe.
      try { await check(temp); await fs.unlink(temp); } catch { /* orphan temp is harmless */ }
      throw error;
    }
  }
  const runDir = id => path.join(root, 'runs', valid(id, RUN));
  async function readRun(id) {
    const manifest = await read(path.join(runDir(id), 'manifest.json'));
    if (manifest.owner !== owner || manifest.id !== id || manifest.path !== `.dumps/research/runs/${id}`) throw new Error('Research run owner/identity mismatch');
    return manifest;
  }
  async function index(manifest) {
    const entries = Array.isArray(manifest.evidence) ? manifest.evidence : [];
    const text = [`# ${String(manifest.title).replace(/[\r\n]/g, ' ')}`, '', `Run: ${manifest.id}`, ...entries.map(e => typeof e === 'string' ? e : `${e.ref ?? ''} ${e.title ?? e.metadata?.title ?? ''}`)].join('\n').slice(0, 12000);
    await atomic(path.join(runDir(manifest.id), 'index.md'), text);
  }
  async function writeRun(id, input) {
    const before = await readRun(id);
    const manifest = object(input);
    for (const key of ['id', 'owner', 'config', 'path', 'created_at']) {
      if (!isDeepStrictEqual(before[key], manifest[key])) throw new Error(`Immutable research manifest field: ${key}`);
    }
    manifest.updated_at = new Date().toISOString();
    await atomic(path.join(runDir(id), 'manifest.json'), manifest);
    await index(manifest);
    return manifest;
  }
  return {
    async saveConfig(config) {
      const id = `c-${randomUUID()}`;
      await atomic(path.join(root, 'configs', `${id}.json`), { id, owner, config: object(config) }, true);
      return id;
    },
    async loadConfig(id) {
      const envelope = await read(path.join(root, 'configs', `${valid(id, CONFIG)}.json`));
      if (envelope.owner !== owner || envelope.id !== id) throw new Error('Research config owner/identity mismatch');
      return envelope.config;
    },
    async createRun(title, config) {
      const snapshot = object(config);
      if (typeof title !== 'string' || !title.trim()) throw new Error('Run title required');
      const allocations = path.join(root, 'allocations');
      await check(allocations);
      const names = await fs.readdir(allocations);
      let counter = names.reduce((max, name) => /^[1-9][0-9]{0,14}$/.test(name) ? Math.max(max, Number(name)) : max, 0) + 1;
      let allocated = false;
      // Reservations survive crashes: gaps are intentional, and no stale lock can block future work.
      for (let attempt = 0; attempt < 1024; attempt++, counter++) {
        if (counter > 999999999999999) throw new Error('Research counter exhausted');
        await check(allocations);
        try { await fs.mkdir(path.join(allocations, String(counter)), { mode: 0o700 }); allocated = true; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (!allocated) throw new Error('Research allocation contention: retry later');
      const slug = title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '') || 'research';
      const id = `r-${counter}-${slug}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await directory(runDir(id));
      await directory(path.join(runDir(id), 'evidence'));
      await directory(path.join(runDir(id), 'events'));
      const now = new Date().toISOString();
      const manifest = { id, owner, title: title.slice(0, 500), config: snapshot, path: `.dumps/research/runs/${id}`, created_at: now, updated_at: now, evidence: [] };
      await atomic(path.join(runDir(id), 'manifest.json'), manifest, true);
      await index(manifest);
      return manifest;
    },
    readRun, writeRun,
    async withRunLock(runId, fn) {
      await readRun(runId);
      if (typeof fn !== 'function') throw new Error('Run lock callback required');
      const lock = path.join(runDir(runId), '.continue-lock');
      await check(lock, true);
      try { await fs.mkdir(lock, { mode: 0o700 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const busy = new Error('Research run BUSY: active or abandoned continuation lock; no automatic stale-lock removal');
        busy.code = 'BUSY';
        throw busy;
      }
      const identity = await fs.lstat(lock);
      try { return await fn(); }
      finally {
        await check(lock);
        const current = await fs.lstat(lock);
        if (identity.ino !== current.ino || identity.dev !== current.dev) throw new Error('Research lock was replaced');
        await fs.rmdir(lock);
      }
    },
    async saveEvidence(runId, evidence) {
      await readRun(runId);
      const input = object(evidence);
      if (typeof input.content !== 'string') throw new Error('Evidence content must be a string');
      if (input.comments !== undefined && !Array.isArray(input.comments)) throw new Error('Evidence comments must be an array');
      const ref = `e-${randomUUID()}`;
      const { content, comments, ...rest } = input;
      const metadata = { ...rest, content_length: content.length, stored_length: Math.min(content.length, 100000), comments_count: comments?.length ?? 0, stored_comments_count: Math.min(comments?.length ?? 0, 200), truncation: { content: content.length > 100000, comments: (comments?.length ?? 0) > 200 }, ...(comments === undefined ? {} : { comments: comments.slice(0, 200) }) };
      await atomic(path.join(runDir(runId), 'evidence', `${ref}.json`), { ref, metadata, content: content.slice(0, 100000) }, true);
      return { ref, metadata: compactMetadata(metadata) };
    },
    async inspect(runId, { ref, offset = 0, limit = 6000, query, section = 'content' } = {}) {
      await readRun(runId);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0 || limit > 100000) throw new Error('Invalid inspect bounds');
      if (query !== undefined && (typeof query !== 'string' || query.length > 1000)) throw new Error('Invalid inspect query');
      if (!['content', 'comments', 'navigation'].includes(section) || (section !== 'content' && ref === undefined)) throw new Error('Invalid inspect section: comments/navigation require ref');
      const dir = path.join(runDir(runId), 'evidence');
      if (ref !== undefined) {
        const item = await read(path.join(dir, `${valid(ref, REF)}.json`));
        if (item.ref !== ref) throw new Error('Evidence identity mismatch');
        const content = section === 'comments' ? JSON.stringify(item.metadata.comments ?? []) : section === 'navigation' ? JSON.stringify({ reddit: item.metadata.reddit, continuation: item.metadata.continuation }) : item.content;
        const match = query ? content.toLowerCase().indexOf(query.toLowerCase(), offset) : offset;
        const start = match < 0 ? offset : match;
        const count = Math.min(limit, 12000);
        return boundContent({ ref, section, metadata: compactMetadata(item.metadata), content: match < 0 ? '' : content.slice(start, start + count), offset: start, total: content.length, truncated: start > 0 || start + count < content.length || item.metadata.truncation?.[section] === true, ...(query ? { matched: match >= 0 } : {}) });
      }
      await check(dir);
      const names = (await fs.readdir(dir)).filter(name => name.endsWith('.json') && REF.test(name.slice(0, -5))).sort();
      const items = [];
      for (const name of names) {
        const item = await read(path.join(dir, name));
        if (item.ref !== name.slice(0, -5)) throw new Error('Evidence identity mismatch');
        if (!query || JSON.stringify(item).toLowerCase().includes(query.toLowerCase())) items.push({ ref: item.ref, metadata: compactMetadata(item.metadata) });
      }
      // Index offsets count entries; cap both entry count and serialized bytes.
      const selected = [];
      const result = { items: selected, offset, total: items.length, truncated: true };
      for (const item of items.slice(offset, offset + Math.min(limit, 20))) {
        selected.push(item);
        if (jsonBytes(result) > MAX_OUTPUT - 128) { selected.pop(); break; }
      }
      result.truncated = offset + selected.length < items.length;
      return result;
    },
    async event(runId, event) {
      await readRun(runId);
      const id = randomUUID();
      await atomic(path.join(runDir(runId), 'events', `${id}.json`), { id, at: new Date().toISOString(), event: object(event) }, true);
    },
  };
}
