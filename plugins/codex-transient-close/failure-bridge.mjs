import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveHost } from '../common.mjs';
const { LlmError } = await import(resolveHost('@deepseek-ai/dsh-llm'));
const contexts = new AsyncLocalStorage();
const codes = new Set(['AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'SERVER', 'RATE_LIMIT', 'TRANSPORT', 'TIMEOUT', 'ABORTED', 'EMPTY_RESPONSE']);
const permanent = new Set(['AUTH', 'QUOTA', 'QUOTA_EXCEEDED', 'ACCOUNT_QUOTA', 'INVALID_CREDENTIAL', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'POLICY', 'CONTENT_FILTER', 'PERMISSION_DENIED', 'NOT_FOUND', 'NOT_SUPPORTED']);
function own(value, key) {
  if (typeof value !== 'object' || value === null) return undefined;
  try { const entry = Object.getOwnPropertyDescriptor(value, key); return entry && 'value' in entry ? entry.value : undefined; } catch { return undefined; }
}
function dataFields(value, keys) {
  try {
    return keys.every(key => {
      const entry = Object.getOwnPropertyDescriptor(value, key);
      return !entry || 'value' in entry;
    });
  } catch { return false; }
}

// A v1 marker alone proves only the original Codex observer. Generic coverage
// requires the SDK's public, immutable list of actually instrumented APIs.
export function providerFailureCapabilities(sdk) {
  const observerAvailable = own(sdk, 'PROVIDER_FAILURE_OBSERVER_VERSION') === 1 && typeof own(sdk, 'subscribeProviderFailures') === 'function';
  const value = own(sdk, 'PROVIDER_FAILURE_APIS');
  let apis;
  try {
    if (observerAvailable && Array.isArray(value) && Object.isFrozen(value) && value.length > 0 && value.length <= 256) {
      const entries = Array.from({ length: value.length }, (_, index) => own(value, String(index)));
      if (entries.every(api => typeof api === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(api))) apis = new Set(entries);
    }
  } catch { /* Malformed capabilities cannot widen legacy capture. */ }
  return { observerAvailable, apis };
}
function requestId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
}
function message(provider, code) {
  return `${provider === 'openai-codex' ? 'Codex provider' : 'Provider'} failure (${code})`;
}

/** Package-local subscriber callback: ignore late, foreign and unknown reports. */
export function captureProviderFailure(dto) {
  const context = contexts.getStore();
  if (!context?.active || !context.capture || context.signal.aborted || context.failure || own(dto, 'provider') !== context.provider) return;
  if (typeof context.provider !== 'string' || !context.provider || !dataFields(dto, ['provider', 'api', 'code', 'message', 'status', 'requestId', 'providerRetryAfterMs'])) return;
  const code = own(dto, 'code'), status = own(dto, 'status'), hint = own(dto, 'providerRetryAfterMs'), api = own(dto, 'api');
  if (!codes.has(code) || typeof own(dto, 'message') !== 'string') return;
  try { if (!Object.isFrozen(dto)) return; } catch { return; }
  // Old Codex DTOs omit API. A matching DTO remains useful without per-request
  // API proof, but an explicitly foreign/uninstrumented API is never admitted.
  if (api !== undefined && (typeof api !== 'string' || (context.apis ? !context.apis.has(api) : api !== 'openai-codex-responses'))) return;
  if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) return;
  if (hint !== undefined && (!Number.isFinite(hint) || hint < 0 || hint > 2147483647)) return;
  try {
    // Even a malformed external observer must not forward arbitrary display text.
    const id = requestId(own(dto, 'requestId'));
    context.failure = new LlmError(message(context.provider, code), code, {
      ...(status === undefined ? {} : { status }), ...(hint === undefined || hint === 0 ? {} : { providerRetryAfterMs: hint }),
      ...(id === undefined ? {} : { requestId: id }),
    }).failure;
  } catch { /* Observer validation cannot alter the upstream stream settlement. */ }
}
function terminal(chunk, context) {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error' || context.signal.aborted || !context.failure) return chunk;
  const original = chunk.reason.failure;
  // The host's caller/watchdog and established permanent facts retain priority.
  const originalCode = own(original, 'code');
  if (['ABORTED', 'TIMEOUT'].includes(originalCode) || permanent.has(originalCode)) return chunk;
  const oldStatus = own(original, 'status'), oldHint = own(original, 'providerRetryAfterMs'), oldId = own(original, 'requestId');
  const validStatus = Number.isInteger(oldStatus) && oldStatus >= 100 && oldStatus <= 599 ? oldStatus : undefined;
  const validHint = typeof oldHint === 'number' && Number.isFinite(oldHint) && oldHint > 0 && oldHint <= 2147483647 ? oldHint : undefined;
  const id = context.failure.requestId ?? requestId(oldId);
  let code = context.failure.code;
  let status = context.failure.status ?? validStatus;
  const hint = context.failure.providerRetryAfterMs ?? validHint;
  // A contradictory permanent HTTP fact cannot be reopened by a transient DTO.
  // Prefer the original permanent status even if the new DTO supplies a 5xx.
  const permanentStatus = [validStatus, status].find(value => value !== undefined && value >= 400 && value < 500 && value !== 408 && value !== 429);
  if (code !== 'ABORTED' && permanentStatus !== undefined) {
    code = permanentStatus === 401 || permanentStatus === 403 ? 'AUTH' : 'INVALID_REQUEST';
    status = permanentStatus;
  }
  const failure = new LlmError(message(context.provider, code), code, {
    ...(status === undefined ? {} : { status }), ...(hint === undefined ? {} : { providerRetryAfterMs: hint }),
    ...(id === undefined ? {} : { requestId: id }),
  }).failure;
  const { replayState: _successfulReplay, ...rest } = chunk;
  return { ...rest, reason: { ...chunk.reason, kind: code === 'ABORTED' ? 'aborted' : 'error', failure } };
}

/** Lazy generator construction alone does not establish ALS for iterator operations. */
export function bridgeRequestFailures(options, dispatch, { capture = true, apis } = {}) {
  return {
    [Symbol.asyncIterator]() {
      const controller = new AbortController();
      const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
      // Waterfall next() is zero-argument: preserve the immutable public request
      // and its loop WeakSet brand. Owned cancellation can stop our wait, but the
      // upstream adapter still receives the original caller signal.
      const context = { active: true, capture, provider: options.provider, apis, signal, failure: undefined, earlyClose: false };
      let iterator, exhausted = false;
      const run = operation => contexts.run(context, operation);
      const generator = (async function* () {
        try {
          iterator = run(() => dispatch(options)[Symbol.asyncIterator]());
          while (true) {
            const result = await new Promise((resolve, reject) => {
              const abort = () => reject(new LlmError('Stream consumer stopped', 'ABORTED'));
              if (controller.signal.aborted) { abort(); return; }
              controller.signal.addEventListener('abort', abort, { once: true });
              Promise.resolve(run(() => iterator.next())).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
            });
            if (result.done) { exhausted = true; return; }
            const chunk = terminal(result.value, context);
            if (chunk.type === 'finish') {
              context.active = false;
              context.failure = undefined;
              yield chunk;
              return;
            }
            yield chunk;
          }
        } finally {
          context.active = false;
          context.failure = undefined;
          controller.abort();
          // A zero-argument middleware cannot inject an upstream abort. If the
          // consumer closes a pending read, detach guarded cleanup rather than
          // hang behind a transport that ignores its original caller signal.
          if (!exhausted && iterator?.return) {
            const cleanup = Promise.resolve().then(() => run(() => iterator.return()));
            if (context.earlyClose) void cleanup.catch(() => {});
            else await cleanup;
          }
        }
      })();
      return {
        next: () => run(() => generator.next()),
        return: value => { context.earlyClose = true; context.active = false; context.failure = undefined; controller.abort(); return run(() => generator.return(value)); },
        throw: error => { context.earlyClose = true; context.active = false; context.failure = undefined; controller.abort(); return run(() => generator.throw(error)); },
      };
    },
  };
}
