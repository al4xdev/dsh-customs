import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFcmSender } from './sender.mjs';
import { config, root } from './test-fixture.mjs';
import { envelope, eventId, hash, publicConfig } from './contracts.mjs';

const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function work() {
  const token = 'own-authored-fcm-token-not-a-real-device';
  const data = envelope({ version: 1, eventId: eventId('own-session', 'own-goal', 2), goalId: 'own-goal', sessionId: 'own-session', revision: 2, timestamp: 1800000000000, phase: 'completed' },
    { bindingId: '12345678-1234-4234-8234-123456789012', registrationId: '22345678-1234-4234-8234-123456789012', deviceId: '32345678-1234-4234-8234-123456789012',
      ownerScopeId: '0'.repeat(64), authGeneration: 1, configDigest: publicConfig(config).configDigest, tokenDigest: hash(token) });
  return { token, data };
}

test('unconfigured sender does not consult injected provider, fetch or any credential path', async () => {
  let count = 0;
  const sender = createFcmSender({ serviceAccountFile: '/must-not-open-secret' }, { authProvider: async () => { count++; }, fetchImpl: async () => { count++; } });
  assert.equal(sender.ready(), false); assert.equal((await sender.send(work())).ok, false); assert.equal(count, 0); sender.close();
});

test('configured sender emits only14 bound strings to exact project endpoint; never notification/title/body', async () => {
  const calls = [];
  const sender = createFcmSender(config, { authProvider: async args => { assert.equal(args.projectId, config.publicConfig.projectId); return 'authored-oauth-token'; },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response({ name: `projects/${config.publicConfig.projectId}/messages/own-response` }); } });
  try {
    assert.equal(sender.ready(), true); assert.deepEqual(await sender.send(work()), { ok: true, code: 'accepted' });
    assert.equal(calls.length, 1); const { url, options } = calls[0];
    assert.equal(url, 'https://fcm.googleapis.com/v1/projects/authored-fixture-only/messages:send');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer authored-oauth-token');
    const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body.message).sort(), ['android', 'data', 'token']);
    assert.equal(Object.keys(body.message.data).length, 14); assert.equal(body.message.android.ttl, '86400s');
    assert.equal('notification' in body.message, false); assert.equal('topic' in body.message, false); assert.equal('condition' in body.message, false);
  } finally { sender.close(); }
});

test('sender credential failure is not-ready and does not fetch external network', () => {
  let calls = 0;
  const path = join(root(), 'authored-invalid-credentials.json'); writeFileSync(path, '{}', { mode: 0o600 });
  const sender = createFcmSender({ ...config, serviceAccountFile: path }, { fetchImpl: async () => { calls++; } });
  assert.equal(sender.ready(), false); assert.equal(sender.status(), 'credentials-unavailable'); assert.equal(calls, 0); sender.close();
});

test('service-account RS256 JWT, pinned OAuth audience and bounded token cache use only synthetic keys', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const path = join(root(), 'authored-throwaway-key.json');
  writeFileSync(path, JSON.stringify({ type: 'service_account', project_id: config.publicConfig.projectId, client_email: 'authored@authored-fixture-only.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 });
  const calls = []; let clock = 1800000000000;
  const sender = createFcmSender({ ...config, serviceAccountFile: path }, { now: () => clock, fetchImpl: async (url, options) => {
    calls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      const params = new URLSearchParams(options.body), assertion = params.get('assertion'), [head, body, signature] = assertion.split('.');
      assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'RS256', typ: 'JWT' });
      const claims = JSON.parse(Buffer.from(body, 'base64url')); assert.equal(claims.aud, url); assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
      assert.equal(claims.exp - claims.iat, 3600); assert.equal(verify('RSA-SHA256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, 'base64url')), true);
      return response({ access_token: 'own-authored-access-token', token_type: 'Bearer', expires_in: 3600 });
    }
    return response({ name: 'projects/authored-fixture-only/messages/own' });
  } });
  try {
    assert.equal((await sender.send(work())).ok, true); assert.equal((await sender.send(work())).ok, true);
    assert.equal(calls.filter(x => x === 'https://oauth2.googleapis.com/token').length, 1);
    clock += 3600000; assert.equal((await sender.send(work())).ok, true);
    assert.equal(calls.filter(x => x === 'https://oauth2.googleapis.com/token').length, 2);
  } finally { sender.close(); }
});

test('sender timeout bounds a hung auth provider or fetch even when stub ignores abort', async () => {
  for (const authHang of [true, false]) {
    const sender = createFcmSender(config, { timeoutMs: 5, authProvider: async () => authHang ? new Promise(() => {}) : 'own-access-token', fetchImpl: async () => new Promise(() => {}) });
    try { const result = await sender.send(work()); assert.equal(result.code, 'timeout'); assert.equal(result.retryable, true); }
    finally { sender.close(); }
  }
});

test('redacted upstream failures, UNREGISTERED, invalid replies and oversize responses', async () => {
  for (const [status, body, expected, retryable] of [[429, { secret: 'MUST NOT RETURN' }, 'rate-limited', true], [503, {}, 'upstream-unavailable', true],
    [403, { token: 'MUST NOT RETURN' }, 'rejected', false], [404, { error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, 'unregistered', false],
    [200, { name: 'projects/foreign/messages/id' }, 'invalid-response', true], [200, { name: 'x'.repeat(70000) }, 'transport-unavailable', true]]) {
    const sender = createFcmSender(config, { authProvider: async () => 'own-access-token', fetchImpl: async () => response(body, status) });
    try { const result = await sender.send(work()); assert.equal(result.code, expected); assert.equal(result.retryable, retryable); assert.equal(JSON.stringify(result).includes('MUST NOT'), false); }
    finally { sender.close(); }
  }
});

test('privacy/size bounds and disabled-after-close prevent FCM calls', async () => {
  let calls = 0;
  const sender = createFcmSender(config, { authProvider: async () => 'own-access-token', fetchImpl: async () => { calls++; } });
  const invalid = work(); invalid.data.objective = 'not permitted';
  assert.equal((await sender.send(invalid)).code, 'invalid-payload');
  const huge = work(); huge.data.goalId = 'x'.repeat(4000); assert.equal((await sender.send(huge)).code, 'invalid-payload');
  sender.close(); assert.equal((await sender.send(work())).ok, false); assert.equal(calls, 0);
});
