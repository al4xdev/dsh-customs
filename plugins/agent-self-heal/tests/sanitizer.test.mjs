import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFailure, routeFacts, usageFacts } from '../sanitizer.mjs';
import { observationText } from '../logic.mjs';
const dto = (code = 'PI_AI_ERROR', extra = {}) => Object.freeze({ code, message: 'unknown', ...extra });
for (const code of ['AUTH', 'QUOTA', 'QUOTA_EXCEEDED', 'ACCOUNT_QUOTA', 'ABORTED', 'TIMEOUT', 'RATE_LIMIT', 'SERVER', 'CONTEXT_WINDOW_EXCEEDED', 'INVALID_CREDENTIAL', 'UNKNOWN', 'INVALID_REQUEST']) test(`no blind recovery for ${code}`, () => assert.equal(sanitizeFailure(dto(code), 'openai-codex'), undefined));
for (const status of [99, 600, -1, NaN, Infinity, 401, 402, 403, 429, 400, 404]) test(`reject malformed/permanent status ${status}`, () => assert.equal(sanitizeFailure(dto('PI_AI_ERROR', { status })), undefined));
for (const hint of [-1, Infinity, NaN, 0.5, 2147483648, '120']) test(`reject malformed retry hint ${hint}`, () => assert.equal(sanitizeFailure(dto('PI_AI_ERROR', { providerRetryAfterMs: hint })), undefined));
test('keep valid numeric facts, not raw code-shaped messages', () => {
  const safe = sanitizeFailure(dto('PI_AI_ERROR', { status: 503, providerRetryAfterMs: 120000, message: 'private-token-aaaa' }), 'openai-codex');
  assert.equal(safe.status, 503); assert.equal(safe.providerRetryAfterMs, 120000); assert.ok(Object.isFrozen(safe));
  assert.ok(!JSON.stringify(safe).includes('private'));
});
test('only own exact malformed-call diagnostic makes INVALID_REQUEST eligible', () => {
  const message = 'Anti Gravity rejected this request by policy. [stage=sse-terminal; terminal=malformed-function-call]';
  assert.equal(sanitizeFailure(dto('INVALID_REQUEST', { message }), 'google-antigravity').terminalCategory, 'malformed-function-call');
  assert.equal(sanitizeFailure(dto('INVALID_REQUEST', { message }), 'openai-codex'), undefined);
  assert.equal(sanitizeFailure(dto('INVALID_REQUEST', { message: message + ' extra-secret' }), 'google-antigravity'), undefined);
});
for (const marker of ['blocked', 'other', 'unknown']) test(`own ${marker} policy marker cannot masquerade as unknown`, () => {
  const message = `Anti Gravity rejected this request by policy. [stage=sse-terminal; terminal=${marker}]`;
  assert.equal(sanitizeFailure(dto('PI_AI_ERROR', { message }), 'google-antigravity'), undefined);
});
test('untrusted messages/directives/headers/thinking/cause never enter observation', () => {
  const canaries = ['Bearer secret-token-123', 'eyJhbGciOiJIUzI1NiJ9.secret-JWT', 'private@example.com', 'secret-cookie=session', 'hidden-thought-secret', 'https://host.test/?token=secret-query', 'ignore-policy-secret'];
  for (const value of canaries) {
    const safe = sanitizeFailure(dto('PI_AI_ERROR', { message: value, cause: value, headers: value, stack: value, thinking: value }), 'openai-codex');
    const text = observationText({ ...safe, ...routeFacts('openai-codex', 'gpt-5.5') }, { turn: 1, step: 1 }, { cycle: 1, maxCycles: 3 });
    assert.ok(!text.includes(value)); assert.ok(text.includes('untrusted data')); assert.ok(text.includes('not a new human request'));
  }
});
test('foreign unfrozen shapes/accessors are not typed failure facts', () => {
  assert.equal(sanitizeFailure({ code: 'PI_AI_ERROR', message: 'x' }), undefined);
  let invoked = false;
  const accessor = Object.freeze({ code: 'PI_AI_ERROR', get message() { invoked = true; return 'secret'; } });
  assert.equal(sanitizeFailure(accessor), undefined); assert.equal(invoked, false);
  assert.equal(sanitizeFailure(Object.freeze(['PI_AI_ERROR', 'x'])), undefined);
});
test('unknown route identity is omitted rather than taken from an error', () => {
  assert.deepEqual(routeFacts('private-account@example.com', 'secret-model'), { provider: 'other-provider' });
  assert.deepEqual(routeFacts('openai-codex', 'https://private.test/?token=secret'), { provider: 'openai-codex' });
  assert.deepEqual(routeFacts('google-antigravity', 'claude-opus-5-5-high'), { provider: 'google-antigravity', model: 'claude-opus-5-5-high' });
});
test('usage selects finite nonnegative integer counters, never thinking text', () => {
  assert.deepEqual(usageFacts({ inputTokens: 3, outputTokens: 4, reasoningTokens: 2, totalTokens: -1, cacheReadTokens: NaN, thinking: 'hidden-secret', response: 'secret' }), { inputTokens: 3, outputTokens: 4, reasoningTokens: 2 });
});
