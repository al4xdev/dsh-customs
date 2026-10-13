import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, lstat, realpath, opendir, open, symlink, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeWriterOwnership, linuxDeviceKey, parseKernelFlocks } from './writer-observation.mjs';

const scratch = fileURLToPath(new URL('../../.dumps/', import.meta.url));
const readers = { lstat, realpath, opendir, open };
async function fixture(t, { projects = ['project'], id = 'owned' } = {}) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'writer-observation-'));
  t.after(async () => {
    assert.ok(directory.startsWith(join(scratch, 'writer-observation-')));
    await rm(directory, { recursive: true, force: true });
  });
  const root = join(directory, 'sessions'); await mkdir(root);
  const locks = [];
  for (const project of projects) {
    const session = join(root, project, id); await mkdir(session, { recursive: true });
    const path = join(session, 'session.lock'); await writeFile(path, ''); locks.push(path);
  }
  const proc = join(directory, 'proc-locks'); await writeFile(proc, '');
  const snapshot = { header: { id } };
  const observe = options => observeWriterOwnership([snapshot], { root, backend: 'jsonl', procLocksPath: proc, ...options });
  async function held(path = locks[0], pid = 99123) {
    const metadata = await lstat(path, { bigint: true });
    const key = linuxDeviceKey(metadata.dev, metadata.ino);
    await writeFile(proc, `1: FLOCK ADVISORY WRITE ${pid} ${key} 0 EOF\n`);
    return key;
  }
  return { directory, root, locks, proc, snapshot, observe, held };
}

test('Linux split dev_t major/minor encoding handles high bits correctly', () => {
  assert.equal(linuxDeviceKey(0x812n, 123n), '8:12:123');
  const major = 0x12345678n, minor = 0x9abcdef0n;
  const device = (major & 0xfffn) << 8n | (major & 0xfffff000n) << 32n | minor & 0xffn | (minor & 0xffffff00n) << 12n;
  assert.equal(linuxDeviceKey(device, 987n), '12345678:9abcdef0:987');
});
test('parser distinguishes held FLOCK WRITE from readers, POSIX and blocked waiters', () => {
  const parsed = parseKernelFlocks('1: FLOCK ADVISORY WRITE 11 08:12:123 0 EOF\n2: -> FLOCK ADVISORY WRITE 22 08:12:456 0 EOF\n3: FLOCK ADVISORY READ 33 08:12:789 0 EOF\n4: POSIX ADVISORY WRITE 44 08:12:987 0 0\n5: OFDLCK ADVISORY WRITE -1 08:12:654 0 EOF\n');
  assert.equal(parsed.valid, true); assert.deepEqual([...parsed.locks.keys()], ['8:12:123']); assert.deepEqual([...parsed.locks.get('8:12:123')], [11]);
  assert.equal(parseKernelFlocks('not a kernel row').valid, false);
});
test('matching stable inode reports held without using process existence as agent proof', async t => {
  const f = await fixture(t); await f.held();
  const row = (await f.observe()).get('owned');
  assert.equal(row.state, 'held'); assert.equal(row.pid, 99123); assert.equal(row.source, 'linux-kernel-flock'); assert.ok(Number.isFinite(Date.parse(row.observedAt)));
  assert.equal('capabilities' in row, false); assert.equal('status' in row, false);
});
test('an empty surviving lock file alone does not prove a writer', async t => {
  const f = await fixture(t); const row = (await f.observe()).get('owned');
  assert.equal(row.state, 'not-observed'); assert.equal(row.reason, 'matching-kernel-writer-not-observed');
});
test('same inode on a different device does not match and kernel waiters are excluded', async t => {
  const f = await fixture(t); const metadata = await lstat(f.locks[0], { bigint: true });
  await writeFile(f.proc, `1: FLOCK ADVISORY WRITE 99 ff:ff:${metadata.ino.toString()} 0 EOF\n2: -> FLOCK ADVISORY WRITE 101 ${linuxDeviceKey(metadata.dev, metadata.ino)} 0 EOF\n`);
  assert.equal((await f.observe()).get('owned').state, 'not-observed');
});
test('duplicate id directories remain unknown even if only one path carries a held lock', async t => {
  const f = await fixture(t, { projects: ['one', 'two'] }); await f.held();
  const row = (await f.observe()).get('owned'); assert.equal(row.state, 'unknown'); assert.equal(row.reason, 'ambiguous-session-path');
});
test('lock symlinks and project symlinks never become ownership or free evidence', async t => {
  const f = await fixture(t); await rename(f.locks[0], `${f.locks[0]}.fixture`); await symlink(`${f.locks[0]}.fixture`, f.locks[0]);
  assert.equal((await f.observe()).get('owned').state, 'unknown');
  const other = await fixture(t); await symlink(join(other.root, 'project'), join(other.root, 'alias'));
  const row = (await other.observe()).get('owned'); assert.equal(row.state, 'unknown'); assert.equal(row.reason, 'unsafe-directory');
});
test('lock replacement between the proc cut and post-stat is detected', async t => {
  const f = await fixture(t); await f.held(); let changed = false;
  const io = { ...readers, open: async (path, flags) => {
    assert.equal(flags, 'r');
    if (path === f.proc && !changed) { changed = true; await rename(f.locks[0], `${f.locks[0]}.old`); await writeFile(f.locks[0], ''); }
    return open(path, flags);
  } };
  const row = (await f.observe({ io })).get('owned'); assert.equal(row.state, 'unknown'); assert.equal(row.reason, 'lock-file-changed');
});
test('disappearing lock and recreated session directory produce unknown cuts', async t => {
  const f = await fixture(t); await f.held();
  const io = { ...readers, open: async (path, flags) => { if (path === f.proc) await rename(f.locks[0], `${f.locks[0]}.gone`); return open(path, flags); } };
  assert.equal((await f.observe({ io })).get('owned').reason, 'lock-file-changed');
  const second = await fixture(t); const session = join(second.root, 'project', 'owned');
  const changed = { ...readers, open: async (path, flags) => { if (path === second.proc) { await rename(session, `${session}.old`); await mkdir(session); await writeFile(join(session, 'session.lock'), ''); } return open(path, flags); } };
  assert.equal((await second.observe({ io: changed })).get('owned').reason, 'session-path-changed');
});
test('missing locks and absent known session directories remain explicit non-observations', async t => {
  const f = await fixture(t); await rename(f.locks[0], `${f.locks[0]}.unused`);
  assert.equal((await f.observe()).get('owned').reason, 'lock-file-not-observed');
  const results = await observeWriterOwnership([{ header: { id: 'not-materialized' } }], { root: f.root, backend: 'jsonl', procLocksPath: f.proc });
  assert.equal(results.get('not-materialized').state, 'not-observed');
});
test('configured backend and absolute root are mandatory; unsupported platform is unknown', async t => {
  const f = await fixture(t);
  for (const options of [{ backend: 'other' }, { backend: undefined }, { root: undefined }, { root: 'relative' }, { platform: 'win32' }, { root: join(f.directory, 'absent') }]) {
    assert.equal((await f.observe(options)).get('owned').state, 'unknown');
  }
});
test('unreadable and malformed kernel snapshots never mean free', async t => {
  const f = await fixture(t);
  assert.equal((await f.observe({ procLocksPath: join(f.directory, 'missing') })).get('owned').reason, 'kernel-snapshot-unavailable');
  await writeFile(f.proc, 'garbled'); assert.equal((await f.observe()).get('owned').reason, 'kernel-snapshot-invalid');
});
test('proc byte, directory entry and project caps fail closed and cannot be raised', async t => {
  const f = await fixture(t, { projects: ['one', 'two'] });
  assert.equal((await f.observe({ limits: { projects: 1 } })).get('owned').reason, 'project-limit');
  assert.equal((await f.observe({ limits: { entries: 1 } })).get('owned').reason, 'directory-entry-limit');
  await writeFile(f.proc, 'x'.repeat(33)); assert.equal((await f.observe({ limits: { procBytes: 32 } })).get('owned').reason, 'proc-byte-limit');
  await writeFile(f.proc, 'x'.repeat(1024 * 1024 + 1)); assert.equal((await f.observe({ limits: { procBytes: 99999999 } })).get('owned').reason, 'proc-byte-limit');
});
test('snapshot cap bounds output and invalid ids never reach filesystem paths', async t => {
  const f = await fixture(t);
  const io = { ...readers, lstat: () => { assert.fail('invalid id must not touch the filesystem'); } };
  const invalid = await observeWriterOwnership([{ header: { id: '../payload' } }], { root: f.root, backend: 'jsonl', io });
  assert.equal(invalid.get('../payload').reason, 'invalid-session-id');
  const many = await observeWriterOwnership([f.snapshot, { header: { id: 'two' } }], { root: f.root, backend: 'jsonl', limits: { snapshots: 1 } });
  assert.equal(many.size, 1); assert.equal(many.get('owned').reason, 'snapshot-limit');
});
test('conflicting kernel owners are unknown; an unavailable owner pid still means held', async t => {
  const f = await fixture(t); const key = await f.held();
  await writeFile(f.proc, `1: FLOCK ADVISORY WRITE 12 ${key} 0 EOF\n2: FLOCK ADVISORY WRITE 13 ${key} 0 EOF\n`);
  assert.equal((await f.observe()).get('owned').reason, 'kernel-holder-ambiguous');
  await writeFile(f.proc, `1: FLOCK ADVISORY WRITE -1 ${key} 0 EOF\n`);
  const row = (await f.observe()).get('owned'); assert.equal(row.state, 'held'); assert.equal('pid' in row, false);
});
test('proc handle opens read-only and is closed even at its byte cap', async t => {
  const f = await fixture(t); await writeFile(f.proc, 'x'.repeat(33)); let closed = 0;
  const io = { ...readers, open: async (path, flags) => {
    assert.equal(path, f.proc); assert.equal(flags, 'r'); const handle = await open(path, flags);
    return { read: (...args) => handle.read(...args), close: async () => { closed++; await handle.close(); } };
  } };
  assert.equal((await f.observe({ io, limits: { procBytes: 32 } })).get('owned').state, 'unknown'); assert.equal(closed, 1);
});
test('aborted observations throw instead of misreporting an ownership snapshot', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.observe({ signal: controller.signal }), error => error.name === 'AbortError');
});
