import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const protocolTargets = Object.freeze([
  { path: 'lib/index.js', before: '87ea85e2fb5318bf1f826db9a1c88c1b26d3ea328027a7f32b211880c4d62b9d', anchor: '\t"agent/inbox/spliced",', addition: '\n\t"agent/self-heal",' },
  { path: 'lib/types/known-event-types.js', before: '8f38e6fc9439bb4e47f2bd3aa21c86d5141ef9679f41181c9d9a48765c67d3be', anchor: "    'agent/inbox/spliced',", addition: "\n    'agent/self-heal'," },
]);

export function patchProtocol(bytes, target) {
  assert.equal(hash(bytes), target.before, `Unsupported session SDK baseline: ${target.path}`);
  const text = bytes.toString('utf8');
  assert.equal(text.split(target.anchor).length, 2, 'Ambiguous session event catalog anchor');
  return Buffer.from(text.replace(target.anchor, target.anchor + target.addition));
}

/** Fresh-container-only bridge. No host defaults, private backups or session reads. */
export async function installProtocol({ sessionRoot }, io = {}) {
  assert.equal(sessionRoot, resolve(sessionRoot), 'sessionRoot must be absolute and normalized');
  assert.equal(await realpath(sessionRoot), sessionRoot, 'Session package must be canonical');
  const read = io.readFile ?? readFile;
  const write = io.writeFile ?? writeFile;
  const prepared = [];
  for (const target of protocolTargets) {
    const path = join(sessionRoot, target.path);
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Catalog must be a regular file');
    assert.equal(await realpath(path), path, 'Catalog parents must be canonical');
    const before = await read(path);
    const after = patchProtocol(before, target);
    prepared.push({ path, before, after });
  }
  // All faces pass before writing. A failed installation stays failed, never rolls
  // back a live SDK or hides partial state; this helper targets a fresh image only.
  for (const file of prepared) {
    assert.equal(hash(await read(file.path)), hash(file.before), 'Concurrent SDK edit');
    await write(file.path, file.after);
    assert.equal(hash(await read(file.path)), hash(file.after), 'SDK write verification failed');
  }
  return { event: 'agent/self-heal', targets: prepared.map(file => ({ path: file.path, beforeSha256: hash(file.before), afterSha256: hash(file.after) })) };
}
