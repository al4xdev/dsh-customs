#!/usr/bin/env node
import { readFile, open, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { assertPersistenceCompatible } from './persistence.mjs';
const target = '/home/alex/.dsh/profiles/dsh-tui/cordis.patch.yml';
const backup = '/home/alex/.local/share/dsh-customs-backups/self-heal-persistence-task50';
const oldBundle = '/home/alex/git/my/dsh-customs/plugins/agent-self-heal/lib/index-v2.mjs';
const newBundle = '/home/alex/git/my/dsh-customs/plugins/agent-self-heal/lib/index-v2-persistence.mjs';
const expected = '4650fa5167faeda0afeee9dc7adb7c5f64f0d1f220bd3abfe50e3781e95255cb';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function syncDir(path) { const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); } }
async function exclusive(path, bytes) {
  const fd = await open(path, 'wx', 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  await syncDir(dirname(path));
}
assertPersistenceCompatible();
const before = await readFile(target);
if (hash(before) !== expected) throw new Error('Profile changed; refusing to replace it.');
if (before.toString().split(oldBundle).length !== 2) throw new Error('Ambiguous self-heal profile entry.');
const module = await import(newBundle);
if (module.name !== 'alex-agent-self-heal' || typeof module.apply !== 'function') throw new Error('Invalid compiled plugin.');
const bundleHash = hash(await readFile(newBundle));
const after = Buffer.from(before.toString().replace(oldBundle, newBundle));
await mkdir(backup, { recursive: true, mode: 0o700 });
await exclusive(join(backup, 'cordis.patch.before.yml'), before);
const staging = `${target}.task50-${process.pid}.staged`;
await exclusive(staging, after);
if (hash(await readFile(target)) !== expected || hash(await readFile(newBundle)) !== bundleHash) throw new Error('Concurrent profile/bundle edit; retained staging.');
// The absolute target above was preflighted; this is one profile-only promotion.
await rename(staging, target);
await syncDir(dirname(target));
if (hash(await readFile(target)) !== hash(after)) throw new Error('Profile verification failed.');
const receipt = { target, before: expected, after: hash(after), oldBundle, newBundle, bundleHash,
  sdkCompatible: true, processRestarted: false, checkpointVersion: 1, maxCycles: 3 };
await exclusive(join(backup, 'profile-promotion.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
