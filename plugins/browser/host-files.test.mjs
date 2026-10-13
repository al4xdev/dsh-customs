import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, lstat, readdir, rename, symlink, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostRequire } from './host.mjs';
import { HostFiles } from './host-files.mjs';

const require = hostRequire();
const load = name => import(require.resolve(`@deepseek-ai/${name}`));
const [{ Context }, llm, sessions, policy] = await Promise.all([
  load('cordis'), load('dsh-llm'), load('dsh-session'), load('dsh-sandbox-policy'),
]);
const base = fileURLToPath(new URL('../../.dumps/tasks/task05-host-files-tests/', import.meta.url));
await mkdir(base, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bounded = { timeout: 30000 };
const denied = code => error => { assert.equal(error.code, code); return true; };
const absent = path => assert.rejects(lstat(path), { code: 'ENOENT' });

async function fixture() {
  const directory = await mkdtemp(join(base, 'native-'));
  const cwd = join(directory, 'workspace');
  await mkdir(cwd);
  const ctx = new Context();
  const handles = [];
  try {
    await ctx.plugin(llm.default);
    await ctx.plugin(sessions.default);
    await ctx.plugin((await load('dsh-session-projection')).default);
    await ctx.plugin(policy.default, { mode: 'danger-full-access', workspaceRoot: cwd });
    await ctx.plugin((await load('dsh-fs-local')).default, { cwd });
    await ctx.plugin((await load('dsh-subprocess-local')).default);
    await ctx.plugin((await load('dsh-sandbox-local')).default, { probeTimeoutMs: 1000 });
    const session = ctx.sessions.create(sessions.SessionId(`host-files-${randomUUID()}`), { meta: { cwd } });
    const agent = { session };
    const ownerId = `bo_${randomUUID()}`;
    const record = {
      agent, ownerId, artifactRoot: join(cwd, 'managed', ownerId), stagingBytes: 0,
      config: { rawRetentionMs: 60000, limits: { ownerBytes: 32 * 1024 * 1024 } },
    };
    record.artifactRoots = new Set([record.artifactRoot]);
    const files = new HostFiles(ctx);
    const subprocess = ctx.get('subprocess');
    const spawn = subprocess.spawn.bind(subprocess);
    // Observe the real provider's handles, not child PIDs or a fake subprocess backend.
    subprocess.spawn = spec => { const handle = spawn(spec); handles.push(handle); return handle; };
    const exec = () => ({ agent, callId: llm.ToolCallId(randomUUID()), signal: AbortSignal.timeout(10000) });
    await files.helper(record, 'bootstrap', {}, exec().signal);
    return {
      ctx, directory, cwd, record, agent, files, handles, exec,
      async close() {
        try {
          for (const handle of handles) {
            if (!await handle.waitForExit(AbortSignal.timeout(100))) handle.terminate();
            assert.equal(await handle.waitForExit(AbortSignal.timeout(3000)), true, 'native managed range must be empty');
            await handle.done;
          }
        } finally { await ctx.fiber.dispose(); }
      },
    };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}

async function artifact(f, content = 'owned artifact', retentionUntil = new Date(Date.now() + 60000).toISOString()) {
  const artifactId = `ba_${randomUUID()}`;
  const name = `${artifactId}.txt`;
  const path = join(f.record.artifactRoot, name);
  const bytes = Buffer.from(content);
  const dto = { artifactId, name, path, state: 'finalized', bytes: bytes.length, sha256: hash(bytes), retentionUntil };
  await writeFile(path, bytes, { flag: 'wx' });
  await writeFile(join(f.record.artifactRoot, `${artifactId}.json`), JSON.stringify(dto), { flag: 'wx' });
  return dto;
}

async function grant(f, dto, destination) {
  const fs = f.ctx.get('fs');
  const nativePolicy = f.files.policy(f.agent);
  return {
    destination: fs.processPath(await fs.resolve(destination, { cwd: nativePolicy.workspaceRoot })),
    workspaceRoot: fs.processPath(await fs.resolve(nativePolicy.workspaceRoot)),
    mode: nativePolicy.mode, artifactId: dto.artifactId,
  };
}
const request = (dto, destination) => ({ args: { artifactId: dto.artifactId, destination } });

test('bootstrap owns its marker; mismatched markers and every linked ancestor deny before artifact metadata/read', bounded, async () => {
  const f = await fixture();
  try {
    const dto = await artifact(f);
    const root = f.record.artifactRoot;
    const marker = join(root, '.owner.json');
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).ownerId, f.record.ownerId);
    assert.equal((await lstat(marker)).isSymbolicLink(), false);
    const fs = f.ctx.get('fs');
    const reads = [];
    let listings = 0;
    const readBytes = fs.readBytes.bind(fs), listDir = fs.listDir.bind(fs);
    fs.readBytes = (target, ...args) => { reads.push(fs.processPath(target)); return readBytes(target, ...args); };
    fs.listDir = (...args) => { listings++; return listDir(...args); };
    await writeFile(marker, JSON.stringify({ ownerId: `bo_${randomUUID()}` }));
    await assert.rejects(f.files.listArtifacts(f.record, f.exec().signal), denied('ARTIFACT_PATH_DENIED'));
    await assert.rejects(f.files.readArtifact(f.record, dto, f.exec().signal), denied('ARTIFACT_PATH_DENIED'));
    assert.equal(listings, 0);
    assert.ok(reads.every(path => path === marker));
    await writeFile(marker, JSON.stringify({ ownerId: f.record.ownerId }));
    // Aliases place a link at the owner directory, its parent, and a higher ancestor.
    const aliases = [
      [join(f.cwd, f.record.ownerId), root, ''],
      [join(f.cwd, 'parent-link'), dirname(root), f.record.ownerId],
      [join(f.directory, 'workspace-link'), f.cwd, join('managed', f.record.ownerId)],
    ];
    for (const [link, target, suffix] of aliases) {
      await symlink(target, link, 'dir');
      const aliasRoot = suffix ? join(link, suffix) : link;
      const record = { ...f.record, artifactRoot: aliasRoot, artifactRoots: new Set([aliasRoot]) };
      reads.length = 0;
      await assert.rejects(f.files.listArtifacts(record, f.exec().signal), denied('ARTIFACT_PATH_DENIED'));
      await assert.rejects(f.files.readArtifact(record, { ...dto, path: join(aliasRoot, dto.name) }, f.exec().signal), denied('ARTIFACT_PATH_DENIED'));
      assert.deepEqual(reads, []);
      assert.equal(listings, 0);
    }
    const savedMarker = join(root, 'saved-owner.json');
    await rename(marker, savedMarker);
    await symlink(savedMarker, marker);
    reads.length = 0;
    await assert.rejects(f.files.listArtifacts(f.record, f.exec().signal), denied('ARTIFACT_PATH_DENIED'));
    assert.deepEqual(reads, []);
    assert.equal(listings, 0);
  } finally { await f.close(); }
});

test('export rejects a canonical approval grant after an inside destination parent becomes an outside symlink', bounded, async () => {
  const f = await fixture();
  try {
    const dto = await artifact(f);
    const parent = join(f.cwd, 'approved');
    const outside = join(f.directory, 'outside');
    await mkdir(parent); await mkdir(outside);
    const destination = join(parent, 'export.txt');
    const approved = await grant(f, dto, destination);
    assert.equal(approved.destination, destination);
    const launches = f.handles.length;
    for (const invalid of [undefined, { ...approved, artifactId: `ba_${randomUUID()}` }, { ...approved, mode: 'workspace-write' }, { ...approved, workspaceRoot: outside }, { ...approved, destination: join(outside, 'export.txt') }]) {
      await assert.rejects(f.files.export(f.record, request(dto, destination), f.exec(), invalid), denied('POLICY_CHANGED'));
      await absent(destination);
    }
    await rename(parent, join(f.cwd, 'approved-before-swap'));
    await symlink(outside, parent, 'dir');
    await assert.rejects(f.files.export(f.record, request(dto, destination), f.exec(), approved), denied('POLICY_CHANGED'));
    assert.equal(f.handles.length, launches, 'deny before launching publication helper');
    await absent(join(outside, 'export.txt'));
    await absent(join(f.cwd, 'approved-before-swap', 'export.txt'));
    assert.deepEqual(await readdir(outside), []);
    assert.equal(await readFile(dto.path, 'utf8'), 'owned artifact');
  } finally { await f.close(); }
});

test('concurrent native exports exclusively publish one checked file and never overwrite it', bounded, async () => {
  const f = await fixture();
  try {
    const dto = await artifact(f, 'exclusive publication');
    const destination = join(f.cwd, 'export.txt');
    const approved = await grant(f, dto, destination);
    const helper = f.files.helper.bind(f.files);
    let arrivals = 0, openGate;
    const gate = new Promise(resolve => { openGate = resolve; });
    // Both HostFiles checks finish before either real helper publishes; exercise link(O_EXCL), not just preflight.
    f.files.helper = async (...args) => {
      if (args[1] === 'export') {
        if (++arrivals === 2) openGate();
        const signal = args[3];
        signal.throwIfAborted();
        let aborted;
        const cancellation = new Promise((_, reject) => {
          aborted = () => reject(signal.reason);
          signal.addEventListener('abort', aborted, { once: true });
        });
        try { await Promise.race([gate, cancellation]); }
        finally { signal.removeEventListener('abort', aborted); }
        signal.throwIfAborted();
      }
      return helper(...args);
    };
    const results = await Promise.allSettled([
      f.files.export(f.record, request(dto, destination), f.exec(), approved),
      f.files.export(f.record, request(dto, destination), f.exec(), approved),
    ]);
    assert.equal(arrivals, 2);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'DESTINATION_EXISTS');
    assert.equal(await readFile(destination, 'utf8'), 'exclusive publication');
    await assert.rejects(f.files.export(f.record, request(dto, destination), f.exec(), approved), denied('DESTINATION_EXISTS'));
    assert.equal(await readFile(destination, 'utf8'), 'exclusive publication');
    assert.equal((await readdir(f.cwd)).some(name => name.startsWith('.dsh-browser-export-')), false);
  } finally { await f.close(); }
});

test('zero-byte staging succeeds and release deletes only generated stage files, never the original', bounded, async () => {
  const f = await fixture();
  try {
    const original = join(f.cwd, 'empty.txt');
    await writeFile(original, '');
    const staged = await f.files.stage(f.record, [original], f.exec());
    assert.equal(staged.length, 1);
    assert.equal(staged[0].bytes, 0);
    assert.equal(staged[0].sha256, hash(Buffer.alloc(0)));
    assert.equal(dirname(staged[0].path), join(f.record.artifactRoot, 'staging'));
    assert.match(basename(staged[0].path), /^bs_[a-f0-9-]{36}$/);
    assert.equal((await readFile(staged[0].path)).length, 0);
    await assert.rejects(f.files.release(f.record, [{ path: original }]), denied('ARTIFACT_PATH_DENIED'));
    await f.files.release(f.record, staged);
    await absent(staged[0].path);
    assert.equal((await readFile(original)).length, 0);
    assert.equal(f.record.stagingBytes, 0);
  } finally { await f.close(); }
});

test('expire removes only expired owned raw artifact and metadata, preserving unexpired files and outside exports', bounded, async () => {
  const f = await fixture();
  try {
    const expired = await artifact(f, 'expired raw', new Date(Date.now() - 60000).toISOString());
    const retained = await artifact(f, 'still retained');
    const outside = join(f.directory, 'published.txt');
    await f.files.export(f.record, request(expired, outside), f.exec(), await grant(f, expired, outside));
    const result = await f.files.helper(f.record, 'expire', { workerActive: false, retentionMs: 60000 }, f.exec().signal);
    assert.equal(result.removed, 1);
    await absent(expired.path);
    await absent(join(f.record.artifactRoot, `${expired.artifactId}.json`));
    assert.equal(await readFile(retained.path, 'utf8'), 'still retained');
    assert.equal(JSON.parse(await readFile(join(f.record.artifactRoot, `${retained.artifactId}.json`), 'utf8')).artifactId, retained.artifactId);
    assert.equal(await readFile(outside, 'utf8'), 'expired raw');
    assert.equal(JSON.parse(await readFile(join(f.record.artifactRoot, '.owner.json'), 'utf8')).ownerId, f.record.ownerId);
  } finally { await f.close(); }
});

test('expire refuses linked raw files, linked metadata, and metadata pointing outside the owner root', bounded, async () => {
  const f = await fixture();
  try {
    const outside = join(f.directory, 'private.txt');
    await writeFile(outside, 'outside survives');
    const dto = await artifact(f, 'expired', new Date(Date.now() - 60000).toISOString());
    const metadata = join(f.record.artifactRoot, `${dto.artifactId}.json`);
    const rawSaved = join(f.record.artifactRoot, 'saved-raw.txt');
    await rename(dto.path, rawSaved); await symlink(outside, dto.path);
    const expire = () => f.files.helper(f.record, 'expire', { workerActive: false, retentionMs: 60000 }, f.exec().signal);
    await assert.rejects(expire(), denied('ARTIFACT_PATH_DENIED'));
    assert.equal((await lstat(dto.path)).isSymbolicLink(), true);
    assert.equal(JSON.parse(await readFile(metadata, 'utf8')).artifactId, dto.artifactId);
    // These are fixture-owned links; unlink never follows their outside targets.
    await unlink(dto.path); await rename(rawSaved, dto.path);
    const metadataSaved = join(f.record.artifactRoot, 'saved-metadata.json');
    await rename(metadata, metadataSaved); await symlink(metadataSaved, metadata);
    await assert.rejects(expire(), denied('ARTIFACT_PATH_DENIED'));
    assert.equal((await lstat(metadata)).isSymbolicLink(), true);
    assert.equal(await readFile(dto.path, 'utf8'), 'expired');
    await unlink(metadata);
    await writeFile(metadata, JSON.stringify({ ...dto, path: outside }));
    await assert.rejects(expire(), denied('ARTIFACT_PATH_DENIED'));
    assert.equal(await readFile(outside, 'utf8'), 'outside survives');
    assert.equal(await readFile(dto.path, 'utf8'), 'expired');
    assert.equal(JSON.parse(await readFile(metadata, 'utf8')).path, outside);
  } finally { await f.close(); }
});

test('actual native read-only session policy denies helpers before executable lookup, confinement, or spawn', bounded, async () => {
  const f = await fixture();
  try {
    policy.setSandboxMode(f.agent.session, 'read-only');
    assert.equal(f.files.policy(f.agent).mode, 'read-only');
    assert.equal(f.ctx.sessionProjections.stateOf(f.agent.session, 'sandboxMode'), 'read-only');
    const calls = [];
    for (const [service, name] of [[f.ctx.get('subprocess'), 'resolveExecutable'], [f.ctx.get('subprocess'), 'spawn'], [f.ctx.get('sandbox'), 'confine']]) {
      const original = service[name].bind(service);
      service[name] = (...args) => { calls.push(name); return original(...args); };
    }
    const launches = f.handles.length;
    await assert.rejects(f.files.helper(f.record, 'bootstrap', {}, f.exec().signal), denied('POLICY_DENIED'));
    await assert.rejects(f.files.helper(f.record, 'expire', { workerActive: false, retentionMs: 60000 }, f.exec().signal), denied('POLICY_DENIED'));
    assert.deepEqual(calls, []);
    assert.equal(f.handles.length, launches);
  } finally { await f.close(); }
});
