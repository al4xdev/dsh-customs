import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config, fixture } from './test-fixture.mjs';
import { envelope, eventId, hash, publicConfig, validEnvelope, validPayload, validReceipt } from './contracts.mjs';

const payload = () => ({ version: 1, eventId: eventId('own-session', 'own-goal', 2), sessionId: 'own-session', goalId: 'own-goal', revision: 2, phase: 'completed', timestamp: 1800000000000 });
test('event identity is exact SHA256 JSON companion/session/goal/completion revision', () => {
  assert.equal(eventId('s', 'g', 4), hash(JSON.stringify(['companion', 's', 'g', 4])));
  assert.notEqual(eventId('s', 'g', 4), eventId('s', 'g', 5));
  assert.equal(validPayload(payload()), true);
  for (const mutation of [{ revision: 1 }, { eventId: '0'.repeat(64) }, { phase: 'active' }, { timestamp: -1 }, { objective: 'private' }, { sessionId: '../private' }]) assert.equal(validPayload({ ...payload(), ...mutation }), false);
});

test('configured project/app/sender/package digest is exact and not accepted from caller claims', () => {
  const p = publicConfig(config);
  assert.equal(p.configDigest, hash([p.projectId, p.appId, p.senderId, 'dev.alex.dsh.companion'].join('|')));
  for (const patch of [{ androidPackage: 'foreign.app' }, { senderId: 'bad' }, { appId: '1:999999999999:android:0123456789abcdef' }, { projectId: '../foreign' }]) assert.equal(publicConfig({ ...config, publicConfig: { ...config.publicConfig, ...patch } }), null);
});

test('receipt and14-field envelope validate hashes, binding metadata, exact types and lease bounds', async () => {
  const f = fixture();
  try {
    const result = await f.call('register', f.request()), r = result.value;
    assert.equal(validReceipt(r), true);
    for (const mutation of [{ profile: 'other' }, { ownerScopeId: randomUUID() }, { expiresAt: r.issuedAt }, { expiresAt: r.issuedAt + 86400001 },
      { authGeneration: -1 }, { sessionIds: [] }, { token: 'private' }]) assert.equal(validReceipt({ ...r, ...mutation }), false);
    const data = envelope(payload(), r); assert.equal(validEnvelope(data), true);
    for (const mutation of [{ authGeneration: '01' }, { version: 1 }, { timestamp: '-1' }, { bindingId: 'foreign' }, { tokenDigest: 'bad' }, { eventId: '0'.repeat(64) }, { objective: 'private' }]) assert.equal(validEnvelope({ ...data, ...mutation }), false);
    const sameSizePrivate = { ...data, objective: 'private' }; delete sameSizePrivate.phase; assert.equal(validEnvelope(sameSizePrivate), false);
  } finally { f.close(); }
});
