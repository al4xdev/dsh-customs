import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchCodexSource, baselineCodexHash } from './codex-failure-categories.mjs';
import { verifyCodexFailureCandidate } from './verify-codex-failure-candidate.mjs';
const candidate = resolve(process.env.CODEX_FAILURE_CANDIDATE ?? '.dumps/codex-failure-categories-20261013-candidate3/package');
const sdk = await import(pathToFileURL(join(candidate, 'dist/index.js')).href);
const helper = await import(pathToFileURL(join(candidate, 'dist/utils/provider-failure.js')).href);
const api = await import(pathToFileURL(join(candidate, 'dist/api/openai-codex-responses.js')).href);
const canary = 'PRIVATE_BODY_TOKEN_ACCOUNT_CANARY';
const model = { id: 'gpt-6.1-sol', name: 'Offline', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://offline.invalid', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 };
const token = ['e30', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-not-account' } })).toString('base64url'), 'fixture'].join('.');
const context = { messages: [{ role: 'user', content: 'offline fixture', timestamp: 0 }] };
globalThis.fetch = () => { throw new Error('External HTTP forbidden'); };
globalThis.WebSocket = class { constructor() { throw new Error('External WebSocket forbidden'); } };
const sse = event => new Response(`data: ${JSON.stringify(event)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
async function request(fetch, signal) {
  const observed = [], events = [];
  const dispose = sdk.subscribeProviderFailures(value => observed.push(value));
  try { for await (const event of api.stream(model, context, { apiKey: token, transport: 'sse', fetch, maxRetries: 0, ...(signal ? { signal } : {}) })) events.push(event); }
  finally { dispose(); }
  return { observed, events };
}
for (const [facts, code] of [
  [{ code: 'server_error' }, 'SERVER'], [{ type: 'overloaded_error' }, 'SERVER'], [{ status: 503 }, 'SERVER'],
  [{ code: 'service_unavailable', message: 'no keyword' }, 'SERVER'],
  [{ code: 'rate_limit_exceeded' }, 'RATE_LIMIT'], [{ status: 429 }, 'RATE_LIMIT'],
  [{ code: 'insufficient_quota', status: 429 }, 'QUOTA'], [{ code: 'usage_limit_reached', type: 'server_error', status: 503 }, 'QUOTA'],
  [{ code: 'billing_error' }, 'QUOTA'], [{ code: 'authentication_error', status: 503 }, 'AUTH'],
  [{ status: 401, code: 'server_error' }, 'AUTH'], [{ status: 403 }, 'AUTH'],
  [{ code: 'invalid_request_error', status: 503 }, 'INVALID_REQUEST'], [{ status: 413 }, 'INVALID_REQUEST'],
  [{ code: 'content_policy_violation', type: 'server_error' }, 'INVALID_REQUEST'],
  [{ code: 'context_length_exceeded', type: 'server_error' }, 'CONTEXT_WINDOW_EXCEEDED'],
  [{ code: 'timeout_error' }, 'TIMEOUT'], [{ name: 'TimeoutError' }, 'TIMEOUT'], [{ status: 408 }, 'TIMEOUT'],
  [{ code: 'ECONNRESET' }, 'TRANSPORT'], [{ cause: { code: 'ECONNREFUSED' } }, 'TRANSPORT'],
]) test(`structured category ${JSON.stringify(facts)} → ${code}`, () => {
  const result = helper.classifyCodexFailure({ ...facts, message: canary, payload: { ignored: canary } });
  assert.equal(result.code, code); assert(Object.isFrozen(result)); assert(!JSON.stringify(result).includes(canary));
  assert.deepEqual(Object.keys(result).filter(key => !['provider', 'code', 'message', 'status', 'providerRetryAfterMs'].includes(key)), []);
});
test('unknown machine code, overload wording, controls and invalid status/hints are never evidence', () => {
  for (const value of [{ message: 'Our servers are currently overloaded. Please try again later.' }, { code: 'unreviewed_error' }, { code: 'server_error\n' }, { code: 'server_error\r' }, { status: '503' }, { status: 503.5 }, { status: Infinity }, { status: 999 }]) assert.equal(helper.classifyCodexFailure(value), undefined);
  for (const hint of [NaN, Infinity, -1, '3000', 2147483648]) assert.equal(helper.classifyCodexFailure({ code: 'server_error', providerRetryAfterMs: hint }).providerRetryAfterMs, undefined);
  assert.equal(helper.classifyCodexFailure({ code: 'server_error' }, true).code, 'ABORTED');
});
test('untrusted getters/prototypes are not executed or used', () => {
  let gets = 0;
  const value = Object.create({ code: 'server_error' });
  Object.defineProperty(value, 'payload', { get() { gets++; throw new Error(canary); } });
  assert.equal(helper.classifyCodexFailure(value), undefined); assert.equal(gets, 0);
});
test('retry-after numeric/date/ms facts validate bounds and controls', () => {
  const headers = value => ({ get: key => key === 'retry-after' ? value : null });
  assert.equal(helper.providerRetryAfterMs(headers('2.5')), 2500);
  assert.equal(helper.providerRetryAfterMs(headers('Thu, 01 Jan 1970 00:00:05 GMT'), 1000), 4000);
  assert.equal(helper.providerRetryAfterMs({ get: key => key === 'retry-after-ms' ? '19' : '2' }), 19);
  for (const value of ['', '-1', '+3', 'NaN', 'Infinity', '2147484', '3\n', 'Fri, 99 Jan 1970 00:00:05 GMT']) {
    assert.equal(helper.providerRetryAfterMs(headers(value)), undefined, value);
  }
});
test('subscriber registrations are independent, exceptions isolated and disposers idempotent', async () => {
  assert.equal(sdk.PROVIDER_FAILURE_OBSERVER_VERSION, 1);
  assert.equal(sdk.subscribeProviderFailures, helper.subscribeProviderFailures);
  let count = 0; const callback = () => count++;
  const a = sdk.subscribeProviderFailures(callback), b = sdk.subscribeProviderFailures(callback);
  const c = sdk.subscribeProviderFailures(() => { throw new Error(canary); });
  const d = sdk.subscribeProviderFailures(async () => { throw new Error(canary); });
  helper.reportCodexFailure({ code: 'server_error' }, 'openai-codex'); assert.equal(count, 2);
  a(); a(); helper.reportCodexFailure({ code: 'server_error' }, 'openai-codex'); assert.equal(count, 3);
  helper.reportCodexFailure({ code: 'server_error' }, 'other'); assert.equal(count, 3);
  b(); c(); d(); await new Promise(resolve => setImmediate(resolve));
});
for (const event of [
  { type: 'error', code: 'server_error', message: canary },
  { type: 'error', error: { code: 'overloaded_error', message: canary } },
  { type: 'error', error: { type: 'server_error', message: canary } },
  { type: 'response.failed', response: { error: { code: 'server_error', message: canary } } },
  { type: 'response.failed', response: { error: { type: 'server_error', message: canary } } },
]) test(`actual SDK ${JSON.stringify(event)} carries one safe terminal SERVER`, async () => {
  const result = await request(async () => sse(event));
  assert.equal(result.events.at(-1).type, 'error'); assert.equal(result.observed.length, 1);
  assert.equal(result.observed[0].code, 'SERVER'); assert.equal(result.observed[0].status, undefined);
  assert(!JSON.stringify(result.observed).includes(canary));
});
for (const [status, body, code] of [
  [503, { error: { message: canary } }, 'SERVER'],
  [429, { error: { code: 'rate_limit_exceeded', message: canary } }, 'RATE_LIMIT'],
  [429, { error: { message: canary } }, 'RATE_LIMIT'],
  [429, { error: { code: 'insufficient_quota', message: canary } }, 'QUOTA'],
  [401, { error: { code: 'server_error', message: canary } }, 'AUTH'],
  [413, { error: { message: canary } }, 'INVALID_REQUEST'],
]) test(`actual SDK HTTP ${status}/${code} preserves facts before display collapse`, async () => {
  const result = await request(async () => new Response(JSON.stringify(body), { status, headers: { 'Retry-After': '3' } }));
  assert.equal(result.observed.length, 1); assert.equal(result.observed[0].code, code);
  assert.equal(result.observed[0].status, status); assert.equal(result.observed[0].providerRetryAfterMs, 3000);
  assert(!JSON.stringify(result.observed).includes(canary));
  if (code === 'RATE_LIMIT') assert(!result.events.at(-1).error.errorMessage.includes('usage limit'));
});
test('actual SDK unknown overload text emits no invented facts', async () => {
  const result = await request(async () => sse({ type: 'error', message: 'Our servers are currently overloaded. Please try again later.' }));
  assert.equal(result.observed.length, 0); assert.equal(result.events.at(-1).type, 'error');
});
test('actual SDK successful response emits no observer failure', async () => {
  const result = await request(async () => sse({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } }));
  assert.equal(result.events.at(-1).type, 'done'); assert.equal(result.observed.length, 0);
});
test('actual SDK typed transport and abort are safe terminal evidence', async () => {
  const transport = await request(async () => { throw Object.assign(new Error(canary), { code: 'ECONNRESET' }); });
  assert.equal(transport.observed[0].code, 'TRANSPORT');
  const controller = new AbortController(); controller.abort();
  const aborted = await request(async () => { throw new Error('must not fetch'); }, controller.signal);
  assert.equal(aborted.events.at(-1).reason, 'aborted'); assert.equal(aborted.observed[0].code, 'ABORTED');
});
test('recipe refuses unknown source before output and preserves exact baseline identity', async () => {
  const source = await readFile('.dumps/pi-ai-fork/206545bfd51e-34a0a629dac6/build-dCYilU/packages/ai/src/api/openai-codex-responses.ts', 'utf8');
  assert.match(baselineCodexHash, /^[a-f0-9]{64}$/);
  assert.throws(() => patchCodexSource(source + '\n'), /baseline/);
  const patched = patchCodexSource(source);
  assert(patched.includes('reportCodexFailure(error, model.provider'));
  assert(patched.includes('throw new CodexApiError(info.friendlyMessage || info.message, info)'));
});
test('candidate preflight proves exact compiler outputs, protected files and unchanged package metadata', async () => {
  const proof = await verifyCodexFailureCandidate(resolve(candidate, '..', 'candidate-manifest.json'));
  assert.equal(proof.targets.length, 12); assert.equal(proof.targets.filter(entry => entry.changed).length, 11);
  assert.equal(proof.targets.filter(entry => entry.beforeSha256 === null).length, 4);
  assert.equal(proof.packageVersion, '0.87.1+alex.codex-default.206545bfd51e');
  assert(proof.packageMetadataUnchanged); assert(proof.protectedSdkFiles > 700);
  assert(!proof.promoted); assert.notEqual(proof.featureVariant, proof.packageVersion);
});
