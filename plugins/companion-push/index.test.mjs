import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CompanionGoalPushService, contribution, parseGoalPushRequest } from './index.mjs';
import { fixture } from './test-fixture.mjs';

test('strict additive public Typert contribution declares only three non-model methods', () => {
  const c = contribution();
  assert.deepEqual(c.model, { services: [], events: [], objects: [] });
  assert.deepEqual(c.invocations.map(d => d.id), ['goalPush/register', 'goalPush/unregister', 'goalPush/status']);
  for (const d of c.invocations) {
    assert.equal(d.service, 'companionGoalPush'); assert.equal(d.namespace, 'goalPush');
    assert.equal(d.parameters.length, 1); assert.equal(d.parameters[0].name, 'request');
    assert.equal(d.parameters[0].codec.mode, 'strict'); assert.equal(d.result.mode, 'strict'); assert.equal(d.cancellation.parameter, 'signal');
  }
  const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.rpc\.(?:intercept|handle)\s*\(|\.fetch\.register\s*\(/);
  assert.doesNotMatch(source, /\.registerTool\s*\(|process\.env|\.fallback\s*=/);
});

test('public service refuses no invocation, wrong method/service/namespace and fake peer before source dispatch', async () => {
  let calls = 0;
  const peer = {}, source = { dispatch: async () => { calls++; } };
  const base = { service: 'companionGoalPush', request: { namespace: 'goalPush', method: 'register' }, peer };
  for (const invocation of [undefined, { ...base, service: 'goals' }, { ...base, request: { namespace: 'goals', method: 'register' } },
    { ...base, request: { namespace: 'goalPush', method: 'status' } }, { ...base, peer: {} }]) {
    await assert.rejects(CompanionGoalPushService.prototype.invokePush.call({ ctx: { invocation, connection: { operator: peer } }, source }, 'register', {}, undefined), error => error.code === 'goalPush/operator-required');
  }
  assert.equal(calls, 0);
});

test('strict declared codecs reject extra caller claims and private response fields', async () => {
  const f = fixture();
  try {
    const request = f.request(); assert.equal(parseGoalPushRequest('register', request), request);
    assert.throws(() => parseGoalPushRequest('register', { ...request, profile: 'companion' }));
    const c = contribution(), descriptor = c.invocations[0];
    assert.throws(() => descriptor.parameters[0].codec.create().parse({ ...request, role: 'operator' }));
    const result = await f.call('register', request); assert.equal(result.ok, true);
    assert.deepEqual(descriptor.result.create().parse(result.value), result.value);
    assert.throws(() => descriptor.result.create().parse({ ...result.value, token: request.token }));
    assert.throws(() => parseGoalPushRequest('status', { version: 1, deviceId: request.deviceId, authGeneration: 1, role: 'operator' }));
  } finally { f.close(); }
});
