#!/usr/bin/env node
// Local downstream protocol bridge, not a general allow-unknown-event switch.
import { readFile, open, mkdir, rename, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Same runtime location rule as the fish `dsh` launcher: XDG_DATA_HOME, else ~/.local/share.
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
const root = join(dataHome, 'dsh-cli/node_modules/@deepseek-ai/dsh-session');
const backup = join(dataHome, 'dsh-customs-backups/self-heal-persistence-task50');
const targets = [
  { path: join(root, 'lib/index.js'), name: 'session-index.js',
    before: '87ea85e2fb5318bf1f826db9a1c88c1b26d3ea328027a7f32b211880c4d62b9d',
    anchor: '\t"agent/inbox/spliced",', addition: '\n\t"agent/self-heal",' },
  { path: join(root, 'lib/types/known-event-types.js'), name: 'known-event-types.js',
    before: '8f38e6fc9439bb4e47f2bd3aa21c86d5141ef9679f41181c9d9a48765c67d3be',
    anchor: "    'agent/inbox/spliced',", addition: "\n    'agent/self-heal'," },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function syncDir(path) { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function exclusive(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncDir(dirname(path));
}
async function receipt(record) {
  const path = join(backup, `receipt-${Date.now()}-${process.pid}.json`);
  await exclusive(path, JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ receipt: path, ...record }, null, 2));
}
async function replaceGuarded(path, expected, bytes) {
  // Targets are explicit absolute paths. Never replace a changed concurrent edit.
  if (hash(await readFile(path)) !== expected) throw new Error(`Concurrent change: ${path}`);
  const staging = `${path}.task50-${process.pid}.staged`;
  await exclusive(staging, bytes);
  if (hash(await readFile(path)) !== expected) throw new Error(`Concurrent change; retained staging: ${staging}`);
  await rename(staging, path);
  await syncDir(dirname(path));
  if (hash(await readFile(path)) !== hash(bytes)) throw new Error(`Post-write verification failed: ${path}`);
}
async function baseline(target) {
  const path = join(backup, target.name);
  const bytes = await readFile(path);
  if (hash(bytes) !== target.before) throw new Error(`Invalid backup: ${path}`);
  const text = bytes.toString('utf8');
  if (text.split(target.anchor).length !== 2) throw new Error(`Ambiguous patch context: ${target.path}`);
  return { bytes, patched: Buffer.from(text.replace(target.anchor, target.anchor + target.addition)) };
}
const mode = process.argv[2];
if (!['--apply', '--verify', '--rollback', '--backup-session'].includes(mode)) {
  throw new Error('Use --apply, --verify, --rollback, or --backup-session. Only the audited local install is supported.');
}
await mkdir(backup, { recursive: true, mode: 0o700 });
if (mode === '--backup-session') {
  // Historical task84 session (its directory name is the recorded workspace slug, not this machine's path).
  const source = process.env.SELF_HEAL_TASK84_SESSION ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions/--home-alex-git-my-alex-tavern--/e8d530cf-b66a-46c9-82f2-272317e6f0ce/session.v4.jsonl.zstd');
  const before = hash(await readFile(source));
  const destination = join(backup, `task84-${Date.now()}-${process.pid}.jsonl.zstd`);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  const handle = await open(destination, 'r'); try { await handle.sync(); } finally { await handle.close(); }
  await syncDir(backup);
  if (hash(await readFile(destination)) !== before || hash(await readFile(source)) !== before) throw new Error('Session changed during backup; do not use this snapshot.');
  await receipt({ mode, source, destination, sha256: before, sessionModified: false });
} else {
  // Preflight every target before touching any; multi-file promotion is not atomic.
  if (mode === '--apply') {
    for (const target of targets) {
      const current = await readFile(target.path);
      const backupPath = join(backup, target.name);
      try { await readFile(backupPath); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (hash(current) !== target.before) throw new Error(`Unsupported SDK baseline: ${target.path}`);
        await exclusive(backupPath, current);
      }
    }
  }
  const prepared = await Promise.all(targets.map(async target => {
    const { bytes, patched } = await baseline(target);
    const current = hash(await readFile(target.path));
    const after = hash(patched);
    if (![target.before, after].includes(current)) throw new Error(`Refusing foreign SDK edits: ${target.path}`);
    if (mode === '--verify' && current !== after) throw new Error(`Bridge not installed: ${target.path}`);
    return { ...target, bytes, patched, current, after };
  }));
  await receipt({ mode, phase: 'preflight', targets: prepared.map(({ path, before, after, current }) => ({ path, before, after, current })) });
  for (const target of prepared) {
    const desired = mode === '--rollback' ? target.bytes : target.patched;
    if (mode !== '--verify' && hash(desired) !== target.current) await replaceGuarded(target.path, target.current, desired);
  }
  await receipt({ mode, phase: 'verified', targets: await Promise.all(prepared.map(async ({ path, before, after }) => ({ path, before, after, current: hash(await readFile(path)) }))) });
}
