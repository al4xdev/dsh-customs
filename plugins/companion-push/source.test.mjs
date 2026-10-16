import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, config } from './test-fixture.mjs';
import { hash, MAX_ATTEMPTS, MAX_DEVICES, MAX_EVENTS, LEASE_MS } from './contracts.mjs';

const receipt = async (f, r = f.request()) => { const result = await f.call('register', r); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };

test('disabled/unconfigured/missing native ownership defaults never touch filesystem or send', async () => {
  for (const options of [{ config: {} }, { config: { enabled: true } }, { helpers: { ownsSession: undefined } }]) {
    const f = fixture(options);
    try {
      assert.equal(f.source.status().registrationReady, false);
      assert.equal((await f.call('register', f.request())).error.code, 'goalPush/not-ready');
      assert.equal(f.source.onGoalChanged(f.completion()), false);
      assert.equal(await f.source.flush(), 0);
      assert.equal(existsSync(join(f.directory, 'companion-push')), false);
      assert.equal(f.sends.length, 0);
    } finally { f.close(); }
  }
});

test('authenticated exact peer only; role/source/user/wire claims cannot substitute', async () => {
  const f = fixture();
  try {
    for (const peer of [undefined, null, {}, { ...f.operator }, { role: 'operator', ctx: f.operator.ctx }, { user: 'owner', source: 'operator' }]) {
      const response = await f.source.dispatch('goalPush/register', { args: { request: f.request() } }, undefined, peer);
      assert.equal(response.error.code, 'goalPush/operator-required');
    }
    const invalid = f.request({ role: 'operator' });
    assert.equal((await f.call('register', invalid)).error.code, 'goalPush/invalid-request');
    assert.equal(f.state().devices.length, 0);
    await receipt(f);
    f.services.connection = { operator: f.operator };
    assert.equal((await f.call('register', f.request())).error.code, 'goalPush/operator-required');
  } finally { f.close(); }
});

test('profile/context/operator replacement or disposed peer cannot access receipts', async () => {
  for (const mutate of [f => { f.profile.name = 'other'; }, f => { f.services.profileContext = { ...f.profile }; },
    f => { f.services.connection.operator = { ctx: f.operator.ctx }; }, f => { f.operator.ctx.fiber.isDisposed = true; }]) {
    const f = fixture();
    try { const r = f.request(); await receipt(f, r); mutate(f); assert.equal((await f.call('status', { version: 1, deviceId: r.deviceId, authGeneration: 1 })).ok, false); }
    finally { f.close(); }
  }
});

test('request, device, generation, digest, token, session and exact endpoint fences', async () => {
  const f = fixture();
  try {
    const cases = [ { version: 2 }, { deviceId: 'not-uuid' }, { authGeneration: -1 }, { authGeneration: 1.2 }, { authGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { token: 'short', tokenDigest: hash('short') }, { token: 'x'.repeat(4097), tokenDigest: hash('x'.repeat(4097)) }, { tokenDigest: '0'.repeat(64) },
      { configDigest: 'bad' }, { sessionIds: [] }, { sessionIds: ['own-session', 'own-session'] }, { sessionIds: ['../private'] },
      { sessionIds: Array.from({ length: 257 }, (_, i) => `session${i}`) } ];
    for (const invalid of cases) assert.equal((await f.call('register', f.request(invalid))).error.code, 'goalPush/invalid-request');
    assert.equal((await f.call('register', f.request({ configDigest: '0'.repeat(64) }))).error.code, 'goalPush/config-mismatch');
    assert.equal((await f.call('register', f.request({ sessionIds: ['foreign-session'] }))).error.code, 'goalPush/not-owned');
    const request = f.request(); Object.defineProperty(request, 'token', { get() { throw new Error('secret getter executed'); }, enumerable: true });
    assert.equal((await f.call('register', request)).error.code, 'goalPush/invalid-request');
    assert.equal((await f.source.dispatch('goalPush/register/extra', { args: { request: f.request() } }, undefined, f.operator)).error.code, 'goalPush/invalid-request');
    assert.equal((await f.source.dispatch('goalPush/register', { args: { request: f.request(), profile: 'companion' } }, undefined, f.operator)).error.code, 'goalPush/invalid-request');
    const abort = new AbortController(); abort.abort(); assert.equal((await f.call('register', f.request(), f.operator, abort.signal)).ok, false);
    assert.equal(f.state().devices.length, 0);
  } finally { f.close(); }
});

test('stable receipt, validated subset, generation rotation and revoked tombstone survive reopen', async () => {
  let f = fixture(); const directory = f.directory, r = f.request();
  try {
    const first = await receipt(f, r), replay = await receipt(f, r);
    assert.deepEqual(first, replay); assert.equal(first.profile, 'companion'); assert.match(first.ownerScopeId, /^[a-f0-9]{64}$/);
    assert.equal(first.tokenDigest, hash(r.token)); assert.equal(first.expiresAt - first.issuedAt, LEASE_MS);
    assert.equal(Object.keys(first).length, 12); assert.equal(JSON.stringify(first).includes(r.token), false);
    const rotated = { ...r, token: 'own-rotated-not-a-real-fcm-token' }; rotated.tokenDigest = hash(rotated.token);
    assert.equal((await f.call('register', rotated)).error.code, 'goalPush/stale-generation');
    const second = await receipt(f, { ...rotated, authGeneration: 2 });
    assert.notEqual(second.bindingId, first.bindingId);
    assert.equal((await f.call('register', r)).error.code, 'goalPush/stale-generation');
    assert.equal((await f.call('unregister', { version: 1, deviceId: r.deviceId, registrationId: first.registrationId, authGeneration: 2 })).ok, false);
    assert.equal((await f.call('unregister', { version: 1, deviceId: r.deviceId, registrationId: second.registrationId, authGeneration: 2 })).ok, true);
    assert.equal(f.state().devices[0].token, null);
    f.close(); f = fixture({ directory });
    assert.equal((await f.call('register', { ...rotated, authGeneration: 2 })).error.code, 'goalPush/stale-generation');
    const third = await receipt(f, { ...rotated, authGeneration: 3 }); assert.equal(third.ownerScopeId, first.ownerScopeId);
  } finally { f.close(); }
});

test('expiry cannot silently renew a captured request and status hides stale receipts', async () => {
  const f = fixture();
  try {
    const r = f.request(); const first = await receipt(f, r);
    const status = () => f.call('status', { version: 1, deviceId: r.deviceId, authGeneration: 1 });
    assert.deepEqual((await status()).value.receipt, first);
    f.allowed.clear(); assert.equal((await status()).value.receipt, null); f.allowed.add('own-session');
    f.advance(LEASE_MS + 1); assert.equal((await status()).value.receipt, null);
    assert.equal((await f.call('register', r)).error.code, 'goalPush/stale-generation');
    await receipt(f, { ...r, authGeneration: 2 });
    assert.equal((await status()).value.receipt, null);
  } finally { f.close(); }
});

test('verified seven-field completion produces exact14 bound data-only envelope and persistent delivery dedup', async () => {
  let f = fixture(); const directory = f.directory;
  try {
    const r = f.request(), binding = await receipt(f, r), event = f.completion();
    assert.equal(f.source.onGoalChanged(event), true);
    for (let i = 0; i < 10; i++) assert.equal(f.source.onGoalChanged(event), false);
    assert.equal(await f.source.flush(), 1); assert.equal(await f.source.flush(), 0);
    assert.equal(f.sends.length, 1); const data = f.sends[0].data;
    assert.equal(Object.keys(data).length, 14); assert.equal(Object.values(data).every(x => typeof x === 'string'), true);
    for (const key of ['bindingId', 'registrationId', 'ownerScopeId', 'tokenDigest', 'configDigest', 'deviceId']) assert.equal(data[key], binding[key]);
    assert.equal(data.authGeneration, '1'); assert.equal(data.sessionId, 'own-session');
    assert.equal(JSON.stringify(data).includes('PRIVATE'), false); assert.equal(JSON.stringify(data).includes(r.token), false);
    assert.equal(f.state().events[0].targets[0].state, 'delivered');
    f.close(); f = fixture({ directory });
    assert.equal(f.source.onGoalChanged(f.completion()), false); assert.equal(await f.source.flush(), 0); assert.equal(f.sends.length, 0);
    assert.equal(readFileSync(join(directory, 'companion-push/state-v1.json'), 'utf8').includes('PRIVATE'), false);
  } finally { f.close(); }
});

test('forged goal refs, root/preset/seed/scope/service/snapshot mismatches never enqueue', async () => {
  const f = fixture();
  try {
    await receipt(f);
    const mutations = [ e => { e.change.operation = 'edit'; }, e => { e.change.ref.revision++; }, e => { e.change.goal = { ...e.change.goal, objective: 'forged' }; },
      e => { e.agent = { ...e.agent }; }, e => { e.agent.session.header.agentPreset = 'other'; }, e => { e.agent.session.header.isSeeded = true; },
      e => { e.agent.session.header.origin = 'subagent'; }, e => { e.agent.ctx.preset = 'other'; }, e => { e.agent.session.id = 'foreign'; },
      e => { e.agent.session.header.id = 'foreign'; }, e => { e.agent.session.snapshotEvents = () => []; },
      e => { const rows = e.agent.session.snapshotEvents(); rows[0].data.goal.id = 'wrong'; } ];
    for (const mutate of mutations) { const e = f.completion(); mutate(e); assert.equal(f.source.onGoalChanged(e), false); }
    assert.equal(f.state().events.length, 0); assert.equal(await f.source.flush(), 0);
  } finally { f.close(); }
});

test('each recipient/event ACK is separate; rotation, logout, scope loss and expiry revoke unsent work', async () => {
  const f = fixture();
  try {
    const r = f.request(); await receipt(f, r); await receipt(f, f.request());
    assert.equal(f.source.onGoalChanged(f.completion()), true);
    const rotated = { ...r, authGeneration: 2 }; await receipt(f, rotated);
    await f.source.flush();
    assert.equal(f.sends.length, 1); assert.deepEqual(f.state().events[0].targets.map(t => t.state), ['revoked', 'delivered']);
    assert.equal(f.source.onGoalChanged(f.completion('own-session', 'own-second')), true);
    f.allowed.clear(); await f.source.flush(); assert.equal(f.sends.length, 1);
    assert.equal(f.state().events[1].targets.every(t => t.state === 'revoked'), true);
    f.allowed.add('own-session'); assert.equal(f.source.onGoalChanged(f.completion('own-session', 'own-third')), true);
    f.advance(LEASE_MS); await f.source.flush(); assert.equal(f.sends.length, 1);
  } finally { f.close(); }
});

test('bounded retry attempts persisted before send and max failures never forget event IDs', async () => {
  let f = fixture({ sendResult: { ok: false, retryable: true } }); const directory = f.directory;
  try {
    await receipt(f); f.source.onGoalChanged(f.completion());
    await f.source.flush(); assert.equal(f.state().events[0].targets[0].attempts, 1);
    f.close(); f = fixture({ directory, sendResult: { ok: false, retryable: true } });
    for (let n = 1; n < MAX_ATTEMPTS; n++) { f.advance(60000); await f.source.flush(); }
    assert.equal(f.state().events[0].targets[0].state, 'exhausted'); assert.equal(f.state().events[0].targets[0].attempts, MAX_ATTEMPTS);
    f.advance(60000); assert.equal(await f.source.flush(), 0); assert.equal(f.source.onGoalChanged(f.completion()), false);
  } finally { f.close(); }
});

test('zero-recipient completions are remembered; later registrations do not receive history', async () => {
  const f = fixture();
  try { const event = f.completion(); assert.equal(f.source.onGoalChanged(event), true); await receipt(f); assert.equal(f.source.onGoalChanged(event), false); await f.source.flush(); assert.equal(f.sends.length, 0); }
  finally { f.close(); }
});

test('device tombstones and ledger enforce capacity without eviction or native goal rollback', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < MAX_DEVICES; i++) await receipt(f);
    assert.equal((await f.call('register', f.request())).error.code, 'goalPush/device-limit');
    for (let i = 0; i < MAX_EVENTS; i++) assert.equal(f.source.onGoalChanged(f.completion('own-session', `own-goal-${i}`)), true);
    const overflow = f.completion('own-session', 'overflow'); assert.equal(f.source.onGoalChanged(overflow), false);
    assert.equal(overflow.agent.goal.phase, 'complete'); assert.equal(f.state().events.length, MAX_EVENTS);
    assert.equal(f.warnings.every(w => w === 'companion-push: delivery unavailable; native goal unchanged'), true);
  } finally { f.close(); }
});

test('FCM unregistered token revokes lease while permanent errors stop retries', async () => {
  for (const sendResult of [{ ok: false, unregistered: true }, { ok: false, retryable: false }]) {
    const f = fixture({ sendResult });
    try {
      await receipt(f); f.source.onGoalChanged(f.completion()); await f.source.flush();
      assert.equal(f.state().events[0].targets[0].state, sendResult.unregistered ? 'revoked' : 'exhausted');
      assert.equal(f.state().devices[0].active, !sendResult.unregistered);
    } finally { f.close(); }
  }
});

test('native scope-chain, ownership loss and service identity replacement independently fence completion', async () => {
  for (const mode of ['scope', 'ownership', 'service']) {
    const f = fixture(mode === 'scope' ? { helpers: { scopeChainOf: () => [] } } : {});
    try {
      await receipt(f); const event = f.completion();
      if (mode === 'ownership') f.allowed.clear();
      if (mode === 'service') f.services.goals = { ...f.services.goals };
      assert.equal(f.source.onGoalChanged(event), false); assert.equal(f.state().events.length, 0);
    } finally { f.close(); }
  }
});

test('4096-character token is accepted without truncation and digest remains exact', async () => {
  const f = fixture();
  try { const token = 'a'.repeat(4096), r = f.request({ token, tokenDigest: hash(token) }); await receipt(f, r); assert.equal(f.state().devices[0].token.length, 4096); }
  finally { f.close(); }
});

test('per-target failure cannot acknowledge or exhaust another recipient/event', async () => {
  let count = 0;
  const f = fixture({ sender: { ready: () => true, close() {}, async send() { count++; return count === 1 ? { ok: false, retryable: true } : { ok: true }; } } });
  try {
    await receipt(f); await receipt(f); f.source.onGoalChanged(f.completion());
    await f.source.flush(); assert.deepEqual(f.state().events[0].targets.map(t => t.state), ['pending', 'delivered']);
    f.advance(60000); await f.source.flush(); assert.equal(count, 3); assert.equal(f.state().events[0].targets.every(t => t.state === 'delivered'), true);
  } finally { f.close(); }
});

test('in-flight rotation never acknowledges the successor binding; concurrent flush does not duplicate', async () => {
  let resolveSend, calls = 0;
  const sender = { ready: () => true, close() {}, send: () => { calls++; return new Promise(resolve => { resolveSend = resolve; }); } };
  const f = fixture({ sender });
  try {
    const r = f.request(); await receipt(f, r); f.source.onGoalChanged(f.completion());
    const pending = f.source.flush(); assert.equal(await f.source.flush(), 0);
    await receipt(f, { ...r, authGeneration: 2 }); resolveSend({ ok: true }); await pending;
    assert.equal(calls, 1); assert.equal(f.state().events[0].targets[0].state, 'revoked');
  } finally { f.close(); }
});
