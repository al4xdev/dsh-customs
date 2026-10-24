import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, bridgeKey } from './index.mjs';
import { buildSystemPrompt } from './prompt.mjs';
import { useLegacyCodex } from './live-auth.mjs';

const current = { provider: 'test', model: 'model' };
const stop = { type: 'finish', reason: { kind: 'stop' } };
function setup(t, llm = {}, config) {
  const requests = [];
  const ctx = {
    llm: {
      async resolveModelInfo() { return { reasoning: false }; },
      async *stream(options) {
        requests.push(options);
        yield { type: 'text-delta', text: 'Corrected.' };
        yield stop;
      },
      ...llm,
    },
    effect(register) { this.dispose = register(); },
  };
  apply(ctx, config);
  t.after(() => ctx.dispose());
  return { bridge: globalThis[bridgeKey], ctx, requests };
}

test('language aliases and auto have unambiguous prompts', () => {
  for (const language of [undefined, 'auto', ' AUTO ']) {
    assert.match(buildSystemPrompt(language), /Preserve the original language/);
    assert.doesNotMatch(buildSystemPrompt(language), /Write the corrected text in/);
  }
  assert.match(buildSystemPrompt('pt'), /in Brazilian Portuguese \(pt-BR\)/);
  assert.match(buildSystemPrompt('pt-PT'), /in European Portuguese \(pt-PT\)/);
  assert.match(buildSystemPrompt('en'), /in English/);
});

test('configured model supports namespaced local IDs; metadata matches prompt', async (t) => {
  const { bridge, requests } = setup(t, {}, { model: 'local/org/model', language: 'en' });
  assert.equal(await bridge.fix('draft', current), 'Corrected.');
  assert.equal(requests[0].provider, 'local');
  assert.equal(requests[0].model, 'org/model');
  assert.equal(bridge.describe(current).language, 'English');
  assert.equal(requests[0].reasoningEffort, undefined);
  assert.equal(requests[0].temperature, undefined);
});

test('rejects invalid configuration and missing model/service', async (t) => {
  for (const model of ['', 'model', '/model', 'provider/', 'provider/with space']) {
    assert.throws(() => apply({}, { model }), /provider\/model/);
  }
  for (const language of ['', ' ', 'two\nlines', 'x'.repeat(81)]) {
    assert.throws(() => apply({}, { language }), /language must/);
  }
  for (const naturalTips of ['true', 1, {}]) {
    assert.throws(() => apply({}, { naturalTips }), /naturalTips must be a boolean/);
  }
  const { bridge, ctx } = setup(t);
  await assert.rejects(bridge.fix('draft'), /No model/);
  ctx.llm.stream = undefined;
  await assert.rejects(bridge.fix('draft', current), /no LLM service/);
});

test('blank drafts and bare slash commands never call LLM', async (t) => {
  const { bridge, requests } = setup(t);
  for (const draft of ['', '  ', '  /help', '/btw', '  /clear  ']) assert.equal(await bridge.fix(draft, current), draft);
  assert.equal(requests.length, 0);
});

test('slash command with text corrects the body while preserving command prefix', async (t) => {
  const { bridge, requests } = setup(t);
  assert.equal(await bridge.fix('/btw She have two file.', current), '/btw Corrected.');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[0].content[0].text, 'She have two file.');
});

test('suggestTip generates natural phrasing tips when enabled, empty when disabled', async (t) => {
  const { bridge } = setup(t, {}, { naturalTips: false });
  assert.equal(await bridge.suggestTip('have you committed', 'Have you committed?', current), '');
  const { bridge: enabledBridge, requests } = setup(t, {}, { naturalTips: true });
  assert.equal(await enabledBridge.suggestTip('have you committed', 'Have you committed?', current), 'Corrected.');
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[0].content[0].text, /Draft: have you committed/);
});

test('unsupported reasoning effort retries only supported candidates', async (t) => {
  const efforts = [];
  const { bridge } = setup(t, {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } }; },
    async *stream(options) {
      efforts.push(options.reasoningEffort);
      if (options.reasoningEffort === 'off') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'unsupported' } } };
        return;
      }
      yield { type: 'text-delta', text: 'Done.' };
      yield stop;
    },
  });
  assert.equal(await bridge.fix('draft', current), 'Done.');
  assert.deepEqual(efforts, ['off', 'low']);
});

test('llama.cpp template effort mismatch falls back, but not arbitrary server errors', async (t) => {
  const efforts = [];
  const { bridge } = setup(t, {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } }; },
    async *stream(options) {
      efforts.push(options.reasoningEffort);
      if (options.reasoningEffort === 'off') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', status: 500, message: 'Jinja Exception: Unexpected reasoning effort off. Supported types are xhigh, medium, and low.' } } };
        return;
      }
      yield { type: 'text-delta', text: 'Done.' };
      yield stop;
    },
  });
  assert.equal(await bridge.fix('draft', current), 'Done.');
  assert.deepEqual(efforts, ['off', 'low']);
});

test('metadata failure starts with provider defaults', async (t) => {
  const { bridge, requests } = setup(t, { async resolveModelInfo() { throw new Error('offline'); } });
  await bridge.fix('draft', current);
  assert.equal(requests[0].reasoningEffort, undefined);
});

for (const [name, chunks, pattern] of [
  ['empty', [stop], /complete correction/],
  ['whitespace', [{ type: 'text-delta', text: ' ' }, stop], /complete correction/],
  ['missing finish', [{ type: 'text-delta', text: 'partial' }], /complete correction/],
  ['length limit', [{ type: 'text-delta', text: 'partial' }, { type: 'finish', reason: { kind: 'max-tokens' } }], /Incomplete/],
  ['provider error', [{ type: 'text-delta', text: 'partial' }, { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'rate limit' } } }], /rate limit/],
  ['generic server error', [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'server failure' } } }], /server failure/],
  ['provider abort', [{ type: 'finish', reason: { kind: 'aborted' } }], /canceled/],
]) {
  test(`rejects ${name} without returning partial text or generic retries`, async (t) => {
    let calls = 0;
    const { bridge } = setup(t, { async *stream() { calls++; yield* chunks; } });
    await assert.rejects(bridge.fix('draft', current), pattern);
    assert.equal(calls, 1);
    await assert.rejects(bridge.fix('draft', current), pattern);
    assert.equal(calls, 2); // A failure must release busy.
  });
}

test('cancellation releases busy even when metadata ignores the signal', async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const { bridge, ctx } = setup(t, {
    resolveModelInfo() { entered(); return new Promise(() => {}); },
  });
  const abort = new AbortController();
  const pending = bridge.fix('draft', current, abort.signal);
  await started;
  await assert.rejects(bridge.fix('second', current), /already in progress/);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  ctx.llm.resolveModelInfo = async () => ({ reasoning: false });
  assert.equal(await bridge.fix('second', current), 'Corrected.');
});

test('cancels stalled stream and observes late rejection', async (t) => {
  let entered, rejectStream;
  const started = new Promise((resolve) => { entered = resolve; });
  const { bridge } = setup(t, {
    async *stream() { entered(); await new Promise((_, reject) => { rejectStream = reject; }); },
  });
  const abort = new AbortController();
  const pending = bridge.fix('draft', current, abort.signal);
  await started;
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  rejectStream(new Error('late failure'));
});

test('disposal aborts active correction and preserves a newer bridge', async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const first = setup(t, { resolveModelInfo() { entered(); return new Promise(() => {}); } });
  const pending = first.bridge.fix('draft', current);
  await started;
  const second = setup(t);
  first.ctx.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(globalThis[bridgeKey], second.bridge);
  await assert.rejects(first.bridge.fix('draft', current), /unloaded/);
});

test('deadline releases a stalled correction', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const { bridge, ctx } = setup(t, {
    resolveModelInfo() { entered(); return new Promise(() => {}); },
  });
  const pending = bridge.fix('draft', current);
  await started;
  t.mock.timers.tick(120_000);
  await assert.rejects(pending, { name: 'TimeoutError' });
  ctx.llm.resolveModelInfo = async () => ({ reasoning: false });
  assert.equal(await bridge.fix('new draft', current), 'Corrected.');
});

test('pre-aborted signal and throwing progress callbacks do not lock bridge', async (t) => {
  const { bridge } = setup(t);
  await assert.rejects(bridge.fix('draft', current, AbortSignal.abort()), { name: 'AbortError' });
  await assert.rejects(bridge.fix('draft', current, undefined, () => { throw new Error('progress'); }), /progress/);
  assert.equal(await bridge.fix('draft', current), 'Corrected.');
});

const codexKey = 'llm-pi-ai/openai-codex';
const grant = { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', accountId: 'synthetic-account', expires: 1_000_000 };
const readLegacy = async () => JSON.stringify({ providers: { 'openai-codex': grant } });
function credentialFixture(record) {
  return {
    async readRecord() { return record; },
    async modifyRecord(key, mutate) { return mutate(record); },
    async deleteRecord() { return 'deleted'; },
  };
}

test('legacy GPT grant is cloned, read-only, and restored without changing other credentials', async () => {
  const other = { kind: 'api-key', key: 'synthetic-other' };
  const credentials = credentialFixture(undefined);
  credentials.readRecord = async (key) => key === codexKey ? undefined : other;
  const originals = { ...credentials };
  const restore = await useLegacyCodex(credentials, codexKey, 'unused', 0, readLegacy);
  const first = await credentials.readRecord(codexKey);
  assert.deepEqual(first, { kind: 'grant', payload: grant });
  first.payload.access = 'changed';
  assert.equal((await credentials.readRecord(codexKey)).payload.access, grant.access);
  assert.equal(await credentials.readRecord('other'), other);
  let mutated = false;
  await assert.rejects(credentials.modifyRecord(codexKey, () => { mutated = true; }), /read-only/);
  await assert.rejects(credentials.deleteRecord(codexKey), /read-only/);
  assert.equal(mutated, false);
  assert.equal(await credentials.modifyRecord('other', () => 'delegated'), 'delegated');
  assert.equal(await credentials.deleteRecord('other'), 'deleted');
  restore();
  assert.deepEqual(credentials, originals);
});

test('native GPT credential wins and missing legacy file is harmless', async () => {
  const native = { kind: 'grant', payload: grant };
  const credentials = credentialFixture(native);
  await useLegacyCodex(credentials, codexKey, 'unused', 0, () => { throw new Error('must not read legacy'); });
  assert.equal(await credentials.readRecord(codexKey), native);
  const empty = credentialFixture(undefined);
  await useLegacyCodex(empty, codexKey, 'unused', 0, async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
  assert.equal(await empty.readRecord(codexKey), undefined);
});

test('legacy compatibility rejects invalid or expiring grants without touching service', async () => {
  for (const invalid of [{ ...grant, type: 'api_key' }, { ...grant, access: '' }, { ...grant, expires: 300_000 }]) {
    const credentials = credentialFixture(undefined);
    const original = credentials.readRecord;
    await assert.rejects(useLegacyCodex(credentials, codexKey, 'unused', 0, async () => JSON.stringify({ providers: { 'openai-codex': invalid } })));
    assert.equal(credentials.readRecord, original);
  }
  await assert.rejects(useLegacyCodex(credentialFixture(), codexKey, 'unused', 0, async () => '{'), /Cannot load/);
});
