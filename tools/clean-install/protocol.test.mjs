import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchProtocol, protocolTargets, installProtocol } from './protocol.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('pure patch adds only the required event at its unique audited anchor', () => {
  const bytes = Buffer.from('start\n    \'agent/inbox/spliced\',\nend\n');
  const target = { path: 'fixture', before: sha(bytes), anchor: "    'agent/inbox/spliced',", addition: "\n    'agent/self-heal'," };
  assert.equal(patchProtocol(bytes, target).toString(), "start\n    'agent/inbox/spliced',\n    'agent/self-heal',\nend\n");
  assert.throws(() => patchProtocol(Buffer.from('foreign'), target), /Unsupported/);
  const ambiguous = Buffer.from(target.anchor + target.anchor);
  assert.throws(() => patchProtocol(ambiguous, { ...target, before: sha(ambiguous) }), /Ambiguous/);
});

test('published protocol guards exactly two static session catalog faces', () => {
  assert.deepEqual(protocolTargets.map(target => target.path), ['lib/index.js', 'lib/types/known-event-types.js']);
  for (const target of protocolTargets) {
    assert.match(target.before, /^[a-f0-9]{64}$/);
    assert.match(target.addition, /agent\/self-heal/);
  }
});

test('incompatible fixture SDK refuses before any write', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-protocol-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'lib/types'), { recursive: true });
  await writeFile(join(root, 'lib/index.js'), 'foreign SDK');
  let writes = 0;
  await assert.rejects(installProtocol({ sessionRoot: root }, { writeFile() { writes++; } }), /Unsupported session SDK baseline/);
  assert.equal(writes, 0);
});

test('portable bridge has no implicit host target or side effects on relative input', async () => {
  await assert.rejects(installProtocol({ sessionRoot: 'relative' }), /absolute/);
});
