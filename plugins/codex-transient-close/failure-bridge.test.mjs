import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveHost } from '../common.mjs';
import { applyWithObserver } from './index.mjs';
import { bridgeRequestFailures, captureProviderFailure, providerFailureCapabilities } from './failure-bridge.mjs';
import { resolveHostSdkEntry } from './sdk-host.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Same runtime location rule as the dsh launcher: XDG_DATA_HOME, else ~/.local/share.
const hostRoot = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'dsh-cli');
const { Context } = await import(resolveHost('@deepseek-ai/cordis'));
const { markAgentLoopRequest, isAgentLoopRequest } = await import(resolveHost('@deepseek-ai/dsh-llm'));
const options = (extra = {}, marked = true) => Object.freeze(marked ? markAgentLoopRequest({ provider: 'openai-codex', messages: [], ...extra }) : { provider: 'openai-codex', messages: [], ...extra });
const failure = (code = 'PI_AI_ERROR', extra = {}) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: 'unclassified source', ...extra } } });
const dto = (extra = {}) => Object.freeze({ provider: 'openai-codex', code: 'SERVER', message: 'safe SDK message', ...extra });
function sdk(generic = false) {
  const listeners = new Set();
  return { PROVIDER_FAILURE_OBSERVER_VERSION: 1, ...(generic ? { PROVIDER_FAILURE_APIS: Object.freeze(['openai-completions', 'openai-codex-responses', 'anthropic-messages']) } : {}), subscribeProviderFailures(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(value) { for (const listener of [...listeners]) listener(value); }, size() { return listeners.size; } };
}
async function collect(stream) { const values = []; for await (const value of stream) values.push(value); return values; }
async function wrap(request, factory, observer = sdk()) {
  const ctx = new Context(); let dispatches = 0;
  try {
    applyWithObserver(ctx, observer);
    return await collect(ctx.waterfall('llm/stream', request, () => { dispatches++; return factory(observer); }));
  } finally { await ctx.fiber.dispose(); assert.equal(observer.size(), 0); assert.equal(dispatches, 1); }
}
test('adapter-anchored resolver loads exact host root rather than private SDK', async () => {
  const entry = resolveHostSdkEntry();
  assert(entry.endsWith('/@earendil-works/pi-ai/dist/index.js'));
  assert.strictEqual(await import(entry), await import(pathToFileURL(join(hostRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href));
});
test('known DTO projects only terminal error, freezes failure, preserves partial chunks and metadata', async () => {
  const partial = Object.freeze({ type: 'text-delta', text: 'partial', signature: 'fixture' });
  const before = { ...failure(), replayState: { success: true }, providerMetadata: { retained: true } };
  const values = await wrap(options(), async function* (observer) { yield partial; await Promise.resolve(); observer.emit(dto({ status: 503, providerRetryAfterMs: 7000, payload: 'CANARY' })); yield before; });
  assert.equal(values[0], partial); assert.notEqual(values[1], before);
  assert.equal(values[1].reason.failure.code, 'SERVER'); assert.equal(values[1].reason.failure.status, 503);
  assert.equal(values[1].reason.failure.providerRetryAfterMs, 7000); assert(Object.isFrozen(values[1].reason.failure));
  assert(!('replayState' in values[1])); assert.equal(values[1].providerMetadata, before.providerMetadata);
  assert(!JSON.stringify(values[1].reason.failure).includes('CANARY'));
  assert.equal(before.reason.failure.code, 'PI_AI_ERROR');
});
test('unknown and incidental overload phrases remain original; DTO never converts successful stop', async () => {
  for (const original of [failure(), { type: 'finish', reason: { kind: 'stop' }, replayState: { success: true } }]) {
    const values = await wrap(options(), async function* (observer) { observer.emit(dto({ code: 'UNKNOWN_CODE' })); yield original; });
    assert.equal(values[0], original);
  }
  const original = { type: 'finish', reason: { kind: 'stop' } };
  const values = await wrap(options(), async function* (observer) { observer.emit(dto()); yield original; });
  assert.equal(values[0], original);
});
test('foreign scopes and caller-aborted requests remain original', async () => {
  const aborted = new AbortController(); aborted.abort();
  const observer = sdk();
  for (const request of [options({ provider: 'other' }), options({ purpose: 'compaction' }), options({ purpose: 'session-title' }), options({ purpose: '' }), options({ signal: aborted.signal })]) {
    const original = failure();
    assert.equal((await wrap(request, async function* (source) { source.emit(dto()); yield original; }, observer))[0], original);
  }
  const ctx = new Context(); applyWithObserver(ctx, observer);
  try {
    const request = options({}, false), original = failure();
    const stream = ctx.waterfall('llm/stream', request, () => (async function* () { observer.emit(dto()); yield original; })());
    assert.equal((await collect(stream))[0], original);
  } finally { await ctx.fiber.dispose(); }
});
test('permanent and caller/watchdog failures cannot be reopened by a transient DTO', async () => {
  for (const code of ['AUTH', 'QUOTA', 'QUOTA_EXCEEDED', 'ACCOUNT_QUOTA', 'INVALID_REQUEST', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED', 'TIMEOUT']) {
    const original = failure(code);
    assert.equal((await wrap(options(), async function* (observer) { observer.emit(dto()); yield original; }))[0], original);
  }
});
test('malformed/foreign/oversized/accessor DTOs do not replace failure', async () => {
  let reads = 0; const accessor = Object.freeze({ provider: 'openai-codex', get code() { reads++; throw new Error('CANARY'); } });
  for (const value of [dto({ provider: 'other' }), dto({ status: 503.5 }), dto({ status: 999 }), dto({ providerRetryAfterMs: Infinity }), dto({ providerRetryAfterMs: -1 }), dto({ providerRetryAfterMs: 2147483648 }), { provider: 'openai-codex', code: 'SERVER', message: 'not frozen' }, accessor]) {
    const original = failure(); assert.equal((await wrap(options(), async function* (observer) { observer.emit(value); yield original; }))[0], original);
  }
  assert.equal(reads, 0);
});
test('concurrent A error/B success and late producer reports cannot cross request contexts', async () => {
  const observer = sdk(), ctx = new Context(); applyWithObserver(ctx, observer);
  let release, late;
  const pending = new Promise(resolve => release = resolve);
  try {
    const a = ctx.waterfall('llm/stream', options(), () => (async function* () {
      late = () => observer.emit(dto({ code: 'QUOTA' }));
      setImmediate(() => { observer.emit(dto()); release(); });
      await pending; yield failure();
    })());
    const bOriginal = { type: 'finish', reason: { kind: 'stop' } };
    const b = ctx.waterfall('llm/stream', options(), () => (async function* () { yield bOriginal; })());
    const [ar, br] = await Promise.all([collect(a), collect(b)]);
    assert.equal(ar[0].reason.failure.code, 'SERVER'); assert.equal(br[0], bOriginal);
    late();
    const original = failure();
    const next = ctx.waterfall('llm/stream', options(), () => (async function* () { yield original; })());
    assert.equal((await collect(next))[0], original);
  } finally { await ctx.fiber.dispose(); }
});
test('observer subscription dispose/remount uses one listener and preserves plain requests', async () => {
  const observer = sdk(), ctx = new Context();
  const plugin = { name: 'fixture-observer', apply: ctx => applyWithObserver(ctx, observer) };
  try {
    const fiber = await ctx.plugin(plugin); assert.equal(observer.size(), 1); await fiber.dispose(); assert.equal(observer.size(), 0);
    await ctx.plugin(plugin); assert.equal(observer.size(), 1);
  } finally { await ctx.fiber.dispose(); }
});
test('iterator dispatch/next preserve request identity and propagate thrown observer-free failures', async () => {
  const request = options(), reason = new Error('consumer fixture'); let returns = 0;
  const source = { [Symbol.asyncIterator]() { return { next() { captureProviderFailure(dto()); return Promise.reject(reason); }, return() { returns++; return Promise.resolve({ done: true }); } }; } };
  await assert.rejects(collect(bridgeRequestFailures(request, received => { assert.equal(received, request); assert(isAgentLoopRequest(received)); return source; })), error => error === reason);
  assert.equal(returns, 1);
});
test('owned return interrupts wrapper wait but does not claim upstream transport cancellation', async () => {
  const request = options(); let returned = 0, resolvePending;
  const pending = new Promise(resolve => resolvePending = resolve);
  const stream = bridgeRequestFailures(request, received => {
    assert.equal(received, request);
    return { [Symbol.asyncIterator]() { return { next: () => pending, return: () => { returned++; return Promise.resolve({ done: true }); } }; } };
  });
  const iterator = stream[Symbol.asyncIterator]();
  const waiting = iterator.next(); const rejected = assert.rejects(waiting, error => error.code === 'ABORTED');
  await iterator.return(); await rejected; assert.equal(returned, 1);
  resolvePending({ done: true }); await Promise.resolve();
});
test('consumer throw runs cleanup inside context without translating consumer error', async () => {
  let returned = 0;
  const iterator = bridgeRequestFailures(options(), () => ({ [Symbol.asyncIterator]() { return { next: () => Promise.resolve({ done: false, value: { type: 'text-delta', text: 'x' } }), return: () => { returned++; return Promise.resolve({ done: true }); } }; } }))[Symbol.asyncIterator]();
  await iterator.next(); const error = new Error('consumer throwing');
  await assert.rejects(iterator.throw(error), value => value === error); assert.equal(returned, 1);
});
test('original permanent 4xx status outranks transient DTO even when original code is transient', async () => {
  for (const status of [400, 401, 403, 413]) for (const originalCode of ['PI_AI_ERROR', 'SERVER', 'TRANSPORT']) for (const reportCode of ['SERVER', 'TRANSPORT']) {
    const original = failure(originalCode, { status });
    const values = await wrap(options(), async function* (observer) { observer.emit(dto({ code: reportCode, status: 503 })); yield original; });
    assert.equal(values[0].reason.failure.code, status === 401 || status === 403 ? 'AUTH' : 'INVALID_REQUEST');
    assert.equal(values[0].reason.failure.status, status, 'preserve the actual permanent status, never fake a 503');
    assert(!['SERVER', 'TRANSPORT', 'RATE_LIMIT', 'TIMEOUT'].includes(values[0].reason.failure.code));
  }
});
test('408/429 remain eligible transient facts, but explicit AUTH/QUOTA codes retain priority', async () => {
  for (const status of [408, 429]) {
    const original = failure('PI_AI_ERROR', { status });
    const values = await wrap(options(), async function* (observer) { observer.emit(dto()); yield original; });
    assert.equal(values[0].reason.failure.code, 'SERVER'); assert.equal(values[0].reason.failure.status, status);
    for (const code of ['AUTH', 'QUOTA']) {
      const permanent = failure(code, { status });
      assert.equal((await wrap(options(), async function* (observer) { observer.emit(dto()); yield permanent; }))[0], permanent);
    }
  }
});
test('safe original requestId/status/hint are preserved only when new facts omit them', async () => {
  const original = failure('PI_AI_ERROR', { requestId: 'req_original-001', status: 503, providerRetryAfterMs: 1700, cause: 'PRIVATE_CAUSE', payload: 'PRIVATE_PAYLOAD', arbitrary: 'PRIVATE_EXTRA' });
  const values = await wrap(options(), async function* (observer) { observer.emit(dto()); yield original; });
  assert.deepEqual(values[0].reason.failure, { code: 'SERVER', message: 'Codex provider failure (SERVER)', status: 503, providerRetryAfterMs: 1700, requestId: 'req_original-001' });
  assert(Object.isFrozen(values[0].reason.failure)); assert(!JSON.stringify(values[0].reason.failure).includes('PRIVATE_'));
  const replacement = await wrap(options(), async function* (observer) { observer.emit(dto({ status: 502, providerRetryAfterMs: 2900 })); yield original; });
  assert.equal(replacement[0].reason.failure.status, 502); assert.equal(replacement[0].reason.failure.providerRetryAfterMs, 2900);
  assert.equal(replacement[0].reason.failure.requestId, 'req_original-001');
});
test('invalid original metadata is dropped without executing accessors or forwarding controls', async () => {
  for (const extra of [
    { status: NaN, providerRetryAfterMs: NaN, requestId: 'req\nPRIVATE' },
    { status: 503.5, providerRetryAfterMs: Infinity, requestId: 'x'.repeat(257) },
    { status: '401', providerRetryAfterMs: -1, requestId: '' },
    { status: 999, providerRetryAfterMs: 0, requestId: 42 },
  ]) {
    const original = failure('PI_AI_ERROR', extra);
    const value = (await wrap(options(), async function* (observer) { observer.emit(dto()); yield original; }))[0].reason.failure;
    assert.deepEqual(Object.keys(value).sort(), ['code', 'message']); assert.equal(value.code, 'SERVER');
  }
  let reads = 0; const original = failure();
  Object.defineProperty(original.reason.failure, 'requestId', { get() { reads++; throw new Error('PRIVATE'); } });
  const value = (await wrap(options(), async function* (observer) { observer.emit(dto()); yield original; }))[0];
  assert.equal(value.reason.failure.requestId, undefined); assert.equal(reads, 0);
});
test('zero SDK hint is omitted rather than inventing positive delay or losing category', async () => {
  const values = await wrap(options(), async function* (observer) { observer.emit(dto({ providerRetryAfterMs: 0 })); yield failure(); });
  assert.equal(values[0].reason.failure.code, 'SERVER'); assert.equal(values[0].reason.failure.providerRetryAfterMs, undefined);
});
test('permanent status is normalized only with known scoped DTO; unknown/foreign stays untouched', async () => {
  const original = failure('SERVER', { status: 401 });
  assert.equal((await wrap(options(), async function* () { yield original; }))[0], original);
  assert.equal((await wrap(options({ provider: 'other' }), async function* (observer) { observer.emit(dto()); yield original; }))[0], original);
});

test('capable SDK covers arbitrary providers, auxiliary purposes and unmarked public requests', async () => {
  for (const provider of ['unlisted-provider', 'strata-local', 'openai-codex']) for (const purpose of [undefined, 'compaction', 'session-title', '']) for (const marked of [true, false]) {
    const request = options({ provider, purpose }, marked);
    const values = await wrap(request, async function* (observer) {
      observer.emit(dto({ provider, api: 'openai-completions', status: 503, requestId: 'request-structured', providerRetryAfterMs: 1800 }));
      yield failure();
    }, sdk(true));
    assert.deepEqual(values[0].reason.failure, { code: 'SERVER', message: `${provider === 'openai-codex' ? 'Codex provider' : 'Provider'} failure (SERVER)`, status: 503, requestId: 'request-structured', providerRetryAfterMs: 1800 });
  }
});

test('capabilities, not provider names or request API proof, gate generic capture', async () => {
  const request = options({ provider: 'future-native' }, false);
  const original = failure();
  assert.equal((await wrap(request, async function* (observer) { observer.emit(dto({ provider: request.provider })); yield original; }, sdk()))[0], original);
  const result = await wrap(request, async function* (observer) { observer.emit(dto({ provider: request.provider })); yield original; }, sdk(true));
  assert.equal(result[0].reason.failure.code, 'SERVER');
  for (const api of ['not-instrumented-api', '', 42]) {
    assert.equal((await wrap(request, async function* (observer) { observer.emit(dto({ provider: request.provider, api })); yield original; }, sdk(true)))[0], original);
  }
  for (const apis of [[], ['openai-completions'], Object.freeze(['Bad API']), Object.freeze([42])]) {
    const observer = sdk(); observer.PROVIDER_FAILURE_APIS = apis;
    assert.equal(providerFailureCapabilities(observer).apis, undefined);
    assert.equal((await wrap(request, async function* (source) { source.emit(dto({ provider: request.provider })); yield original; }, observer))[0], original);
  }
});

test('native facts and all successful partial/tool/usage/meta chunks retain identity without a matching DTO', async () => {
  const chunks = [
    Object.freeze({ type: 'text-delta', text: 'partial' }),
    Object.freeze({ type: 'tool-call-delta', id: 'tool', argumentsDelta: '{}' }),
    Object.freeze({ type: 'usage', usage: { inputTokens: 5 } }),
    Object.freeze({ type: 'provider-metadata', value: { opaque: true } }),
    Object.freeze({ type: 'finish', reason: { kind: 'stop' }, replayState: { success: true } }),
  ];
  const successful = await wrap(options({ provider: 'native-adapter' }, false), async function* (observer) { observer.emit(dto({ provider: 'native-adapter' })); yield* chunks; }, sdk(true));
  chunks.forEach((chunk, index) => assert.equal(successful[index], chunk));
  for (const code of ['SERVER', 'TIMEOUT', 'TRANSPORT', 'NATIVE_CUSTOM']) {
    const original = failure(code, { message: 'opaque native fact', status: 503, requestId: 'native' });
    const result = await wrap(options({ provider: 'native-adapter' }, false), async function* (observer) { observer.emit(dto({ provider: 'foreign' })); yield original; }, sdk(true));
    assert.equal(result[0], original);
  }
});

test('generic matching reports remain isolated across same-provider and cross-provider concurrent requests', async () => {
  for (const providers of [['same-provider', 'same-provider'], ['provider-a', 'provider-b']]) {
    const observer = sdk(true), ctx = new Context(); applyWithObserver(ctx, observer);
    let releaseA, releaseB;
    const aReady = new Promise(resolve => releaseA = resolve), bReady = new Promise(resolve => releaseB = resolve);
    try {
      const streams = providers.map((provider, index) => ctx.waterfall('llm/stream', options({ provider }, false), () => (async function* () {
        if (index === 0) { releaseA(); await bReady; } else { releaseB(); await aReady; }
        await new Promise(resolve => setImmediate(resolve));
        observer.emit(dto({ provider, code: index === 0 ? 'SERVER' : 'TRANSPORT', requestId: `request-${index}` }));
        yield failure();
      })()));
      const values = await Promise.all(streams.map(collect));
      assert.equal(values[0][0].reason.failure.code, 'SERVER'); assert.equal(values[1][0].reason.failure.code, 'TRANSPORT');
      assert.equal(values[0][0].reason.failure.requestId, 'request-0'); assert.equal(values[1][0].reason.failure.requestId, 'request-1');
    } finally { await ctx.fiber.dispose(); }
  }
});

test('nested marked/unmarked/auxiliary calls never infect their outer scope, including legacy exclusions', async () => {
  for (const generic of [false, true]) for (const inner of [options(), options({}, false), options({ purpose: 'compaction' }), options({ provider: 'different' }, false)]) {
    const observer = sdk(generic), ctx = new Context(); applyWithObserver(ctx, observer);
    const outerOriginal = failure(), innerOriginal = failure(); let outerDispatches = 0, innerDispatches = 0;
    try {
      const stream = ctx.waterfall('llm/stream', options(), () => {
        outerDispatches++;
        return (async function* () {
          const nested = ctx.waterfall('llm/stream', inner, () => {
            innerDispatches++;
            // Emission at dispatch, not just from an async generator's next().
            observer.emit(dto({ provider: inner.provider }));
            return (async function* () { observer.emit(dto({ provider: inner.provider })); yield innerOriginal; })();
          });
          const values = await collect(nested);
          const eligible = generic || (isAgentLoopRequest(inner) && inner.provider === 'openai-codex' && inner.purpose === undefined);
          assert.equal(values[0].reason.failure.code, eligible ? 'SERVER' : 'PI_AI_ERROR');
          yield outerOriginal;
        })();
      });
      assert.equal((await collect(stream))[0], outerOriginal);
      assert.equal(outerDispatches, 1); assert.equal(innerDispatches, 1);
    } finally { await ctx.fiber.dispose(); }
  }
});

test('scheduled late reports after finish and consumer close cannot affect later calls', async () => {
  const observer = sdk(true), ctx = new Context(); applyWithObserver(ctx, observer);
  let lateDone;
  const late = new Promise(resolve => lateDone = resolve);
  try {
    const stream = ctx.waterfall('llm/stream', options({ provider: 'same' }, false), () => (async function* () {
      setImmediate(() => { observer.emit(dto({ provider: 'same', code: 'QUOTA' })); lateDone(); });
      yield { type: 'finish', reason: { kind: 'stop' } };
    })());
    await collect(stream);
    const original = failure();
    const second = ctx.waterfall('llm/stream', options({ provider: 'same' }, false), () => (async function* () { await late; yield original; })());
    assert.equal((await collect(second))[0], original);
    let cleanupDone;
    const cleanup = new Promise(resolve => cleanupDone = resolve);
    const closing = ctx.waterfall('llm/stream', options(), () => ({ [Symbol.asyncIterator]() { return {
      next() { return Promise.resolve({ value: { type: 'text-delta', text: 'x' } }); },
      return() { observer.emit(dto()); setImmediate(() => { observer.emit(dto()); cleanupDone(); }); return Promise.resolve({ done: true }); },
    }; } }))[Symbol.asyncIterator]();
    await closing.next(); await closing.return(); await cleanup;
    assert.equal((await collect(ctx.waterfall('llm/stream', options(), () => (async function* () { yield original; })())))[0], original);
  } finally { await ctx.fiber.dispose(); }
});

test('DTO requestId is selected safely and overrides original only when valid', async () => {
  for (const id of ['request-dto', 'x'.repeat(256), '', '  ', 'x'.repeat(257), 'private\nvalue', 42]) {
    const result = await wrap(options({ provider: 'arbitrary' }), async function* (observer) {
      observer.emit(dto({ provider: 'arbitrary', requestId: id, message: 'SECRET_INSTRUCTION' }));
      yield failure('PI_AI_ERROR', { requestId: 'request-original' });
    }, sdk(true));
    assert.equal(result[0].reason.failure.requestId, typeof id === 'string' && id.trim() && id.length <= 256 && !id.includes('\n') ? id : 'request-original');
    assert(!JSON.stringify(result).includes('SECRET_INSTRUCTION'));
  }
});

test('generic 429 and named quota stay distinct; original permanent/watchdog/abort facts win', async () => {
  for (const code of ['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA']) {
    const result = await wrap(options({ provider: 'generic' }, false), async function* (observer) {
      observer.emit(dto({ provider: 'generic', code, status: 429 })); yield failure();
    }, sdk(true));
    assert.equal(result[0].reason.failure.code, code); assert.equal(result[0].reason.failure.status, 429);
  }
  for (const code of ['AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'POLICY', 'ABORTED', 'TIMEOUT']) {
    const original = failure(code, { status: 429 });
    assert.equal((await wrap(options({ provider: 'generic' }, false), async function* (observer) {
      observer.emit(dto({ provider: 'generic', code: 'RATE_LIMIT', status: 429 })); yield original;
    }, sdk(true)))[0], original);
  }
  for (const status of [400, 401, 403, 413]) {
    const result = await wrap(options({ provider: 'generic' }, false), async function* (observer) {
      observer.emit(dto({ provider: 'generic', status: 503 })); yield failure('PI_AI_ERROR', { status });
    }, sdk(true));
    assert.equal(result[0].reason.failure.status, status);
    assert.equal(result[0].reason.failure.code, [401, 403].includes(status) ? 'AUTH' : 'INVALID_REQUEST');
  }
});

test('old SDK without marker keeps only legacy fallback and never subscribes', async () => {
  const observer = sdk(true); delete observer.PROVIDER_FAILURE_OBSERVER_VERSION;
  const ctx = new Context(); applyWithObserver(ctx, observer);
  try {
    assert.equal(observer.size(), 0);
    const original = failure('PI_AI_ERROR', { message: 'WebSocket closed 1012' });
    const legacy = ctx.waterfall('llm/stream', options(), () => (async function* () { yield original; })());
    assert.equal((await collect(legacy))[0].reason.failure.code, 'TRANSPORT');
    const unknown = ctx.waterfall('llm/stream', options({ provider: 'generic' }, false), () => (async function* () { observer.emit(dto({ provider: 'generic' })); yield original; })());
    assert.equal((await collect(unknown))[0], original);
  } finally { await ctx.fiber.dispose(); }
});

test('generic observer reload/disposal leaves exactly one subscription and one waterfall wrapper', async () => {
  const observer = sdk(true), ctx = new Context();
  const plugin = { name: 'generic-observer', apply: ctx => applyWithObserver(ctx, observer) };
  try {
    const first = await ctx.plugin(plugin); assert.equal(observer.size(), 1);
    await first.dispose(); assert.equal(observer.size(), 0);
    await ctx.plugin(plugin); assert.equal(observer.size(), 1);
    let dispatches = 0;
    const result = await collect(ctx.waterfall('llm/stream', options({ provider: 'generic' }, false), () => {
      dispatches++; observer.emit(dto({ provider: 'generic' })); return (async function* () { yield failure(); })();
    }));
    assert.equal(dispatches, 1); assert.equal(result[0].reason.failure.code, 'SERVER');
  } finally { await ctx.fiber.dispose(); assert.equal(observer.size(), 0); }
});

test('generic frozen DTO accessors are rejected without execution, including optional facts', async () => {
  let reads = 0;
  for (const key of ['provider', 'api', 'code', 'message', 'status', 'requestId', 'providerRetryAfterMs']) {
    const value = { provider: 'arbitrary', api: 'openai-completions', code: 'SERVER', message: 'safe' };
    Object.defineProperty(value, key, { get() { reads++; throw new Error('PRIVATE_ACCESSOR'); } });
    Object.freeze(value);
    const original = failure();
    const result = await wrap(options({ provider: 'arbitrary' }, false), async function* (observer) { observer.emit(value); yield original; }, sdk(true));
    assert.equal(result[0], original);
  }
  assert.equal(reads, 0);
  const observer = sdk();
  const apis = [];
  Object.defineProperty(apis, '0', { get() { reads++; throw new Error('PRIVATE_CAPABILITY'); } });
  observer.PROVIDER_FAILURE_APIS = Object.freeze(apis);
  assert.equal(providerFailureCapabilities(observer).apis, undefined); assert.equal(reads, 0);
});

test('an aborted generic caller and an aborted finish remain identical despite matching reports', async () => {
  const controller = new AbortController();
  const original = failure();
  const values = await wrap(options({ provider: 'arbitrary', signal: controller.signal }, false), async function* (observer) {
    observer.emit(dto({ provider: 'arbitrary' })); controller.abort(); observer.emit(dto({ provider: 'arbitrary' })); yield original;
  }, sdk(true));
  assert.equal(values[0], original);
  const aborted = { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'caller cancelled' } } };
  assert.equal((await wrap(options({ provider: 'arbitrary' }, false), async function* (observer) { observer.emit(dto({ provider: 'arbitrary' })); yield aborted; }, sdk(true)))[0], aborted);
});

test('prepended auxiliary recovery observes classified terminal facts in either registration order', async () => {
  for (const bridgeFirst of [false, true]) {
    const ctx = new Context(), observer = sdk(true), seen = [];
    const recovery = () => ctx.on('llm/stream', (_options, next) => (async function* () {
      for await (const chunk of next()) { if (chunk.type === 'finish') seen.push(chunk.reason.failure.code); yield chunk; }
    })(), { prepend: true });
    if (bridgeFirst) { applyWithObserver(ctx, observer); recovery(); } else { recovery(); applyWithObserver(ctx, observer); }
    try {
      const result = await collect(ctx.waterfall('llm/stream', options({ provider: 'aux-route', purpose: 'compaction' }, false), () => (async function* () {
        observer.emit(dto({ provider: 'aux-route' })); yield failure();
      })()));
      assert.deepEqual(seen, ['SERVER']); assert.equal(result[0].reason.failure.code, 'SERVER');
    } finally { await ctx.fiber.dispose(); }
  }
});
