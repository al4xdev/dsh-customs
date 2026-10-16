import { Buffer } from 'node:buffer';
import { resolveHost } from '../common.mjs';
import { sanitizeFailure, harnessWarningText } from '../agent-self-heal/sanitizer.mjs';
import { REFUSAL_REASONS } from './controller.mjs';
const { isAgentLoopRequest, LlmError, createUserMessage } = await import(resolveHost('@deepseek-ai/dsh-llm'));

const terminalKinds = new Set(['stop', 'tool-calls', 'max-tokens', 'error', 'aborted']);
const chunkTypes = new Set(['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end', 'usage', 'finish']);
const failure = (code, message) => new LlmError(message, code);
const cancelled = () => failure('ABORTED', 'Auxiliary LLM operation was cancelled.');
const unsafeReplay = () => failure('AUXILIARY_RETRY_UNSAFE', 'Auxiliary retry stopped because the LLM configuration changed.');

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function requestSnapshot(options) {
  // Signals are live capabilities, not cloneable intent. Every retry gets a fresh
  // frozen envelope, but all data (including opaque historical replay) is pinned.
  const { signal: _signal, ...intent } = options;
  try { return freeze(structuredClone(intent)); }
  catch { throw failure('AUXILIARY_RETRY_UNSAFE', 'Auxiliary request cannot be safely snapshotted.'); }
}
function recoveryWarning(facts, purpose, terminal = false) {
  const label = ['compaction', 'session-title', 'grammar-fix'].includes(purpose) ? purpose : 'auxiliary';
  // No ordinal/wait counters: an unchanged code keeps byte-identical text.
  const text = harnessWarningText(facts, { purpose: label, terminal });
  if (typeof text !== 'string' || !text.startsWith('harness warning:') || Buffer.byteLength(text, 'utf8') > 8192) {
    throw failure('AUXILIARY_WARNING_UNSAFE', 'Auxiliary recovery could not admit its harness warning.');
  }
  return text;
}
function contextualIntent(intent, warnings, text) {
  // At most one notice per operation: it is replaced only when the code changes,
  // so unbounded retries cannot grow the auxiliary request.
  const messages = intent.messages ?? [];
  if (!Array.isArray(messages)) throw failure('AUXILIARY_WARNING_UNSAFE', 'Auxiliary messages cannot safely admit a harness warning.');
  const pendingCalls = new Set();
  for (const message of messages) {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
      || !Array.isArray(message.content) || message.content.some(block => !block || typeof block !== 'object')) {
      throw failure('AUXILIARY_WARNING_UNSAFE', 'Auxiliary messages cannot safely admit a harness warning.');
    }
    if (message.role === 'assistant') for (const block of message.content) {
      if (block.type !== 'tool-call') continue;
      if (typeof block.id !== 'string' || !block.id) throw failure('AUXILIARY_WARNING_UNSAFE', 'Auxiliary tool history cannot safely admit a harness warning.');
      pendingCalls.add(block.id);
    }
    if (message.role === 'tool') pendingCalls.delete(message.toolCallId);
  }
  // A user notice inserted before outstanding tool results can invalidate an
  // otherwise legitimate provider protocol; do not replace that with blind replay.
  if (pendingCalls.size) throw failure('AUXILIARY_WARNING_UNSAFE', 'Auxiliary recovery stopped because tool results are still outstanding.');
  const message = createUserMessage({ source: { kind: 'self-heal-observation', label: 'Harness warning', form: 'notice',
    summary: 'Auxiliary model request recovery.' }, content: [{ type: 'text', text }] });
  warnings.splice(0, warnings.length, message);
  return freeze({ ...intent, messages: [...messages, ...warnings] });
}
function jsonBytes(value, limit) {
  // Count before cloning/stringifying a potentially huge delta. The limit bounds
  // retained output, not an extra unbounded serialized copy of rejected output.
  let bytes = 0;
  const ancestors = new Set();
  const invalid = () => { throw failure('AUXILIARY_PROTOCOL_INVALID', 'Auxiliary LLM returned a non-serializable chunk.'); };
  const add = amount => {
    bytes += amount;
    if (bytes > limit) throw failure('AUXILIARY_BUFFER_LIMIT', 'Auxiliary LLM response exceeded its safe buffer limit.');
  };
  const string = text => {
    add(2 + Buffer.byteLength(text, 'utf8'));
    for (const match of text.matchAll(/["\\\u0000-\u001f\ud800-\udfff]/gu)) {
      const code = match[0].charCodeAt(0);
      add(code >= 0xd800 ? 3 : [8, 9, 10, 12, 13, 34, 92].includes(code) ? 1 : 5);
    }
  };
  const walk = (item, depth = 0, arrayItem = false) => {
    if (depth > 128) invalid();
    if (item === null || item === undefined && arrayItem) { add(4); return; }
    if (typeof item === 'string') { string(item); return; }
    if (typeof item === 'boolean') { add(item ? 4 : 5); return; }
    if (typeof item === 'number' && Number.isFinite(item)) { add(JSON.stringify(item).length); return; }
    if (!item || typeof item !== 'object' || ancestors.has(item)) invalid();
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid();
    ancestors.add(item);
    add(2);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        if (i) add(1);
        const entry = Object.getOwnPropertyDescriptor(item, String(i));
        if (entry && !('value' in entry)) invalid();
        walk(entry?.value, depth + 1, true);
      }
    } else {
      let fields = 0;
      for (const key of Object.keys(item)) {
        const entry = Object.getOwnPropertyDescriptor(item, key);
        if (!entry || !('value' in entry)) invalid();
        if (entry.value === undefined) continue;
        if (fields++) add(1);
        string(key); add(1); walk(entry.value, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  walk(value);
  return bytes;
}
function copyChunk(chunk, byteLimit) {
  const bytes = jsonBytes(chunk, byteLimit);
  let copy;
  try { copy = structuredClone(chunk); }
  catch { throw failure('AUXILIARY_PROTOCOL_INVALID', 'Auxiliary LLM returned a non-serializable chunk.'); }
  if (!copy || !chunkTypes.has(copy.type)) throw failure('AUXILIARY_PROTOCOL_INVALID', 'Auxiliary LLM returned an invalid chunk.');
  if (copy.type === 'finish' && (!terminalKinds.has(copy.reason?.kind)
    || (['error', 'aborted'].includes(copy.reason.kind)
      && (typeof copy.reason.failure?.code !== 'string' || typeof copy.reason.failure?.message !== 'string')))) {
    throw failure('AUXILIARY_PROTOCOL_INVALID', 'Auxiliary LLM returned an invalid terminal outcome.');
  }
  return { chunk: freeze(copy), bytes };
}

/** Stop our consumer even when an upstream middleware ignores the caller signal.
 * The guarded pending promise may still settle later; no late result is exposed.
 */
function read(iterator, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, cancelled());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw cancelled();
      return iterator.next();
    }).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) abort();
  });
}
function closeDetached(iterator) {
  // A zero-argument waterfall continuation cannot be given our fused signal.
  // In particular iterator.return() can queue behind a stuck initial read. Do
  // not claim forced transport cancellation or hang disposal on that promise.
  if (iterator) void Promise.resolve().then(() => {
    const close = iterator.return;
    if (typeof close === 'function') return close.call(iterator);
  }).catch(() => {});
}
function handled(promise) { void promise.catch(() => {}); return promise; }

/** Install the auxiliary half only: no tools, sessions, compaction transactions,
 * or main-loop retry audit events are replayed here. Budgets are in memory and
 * do not claim cross-crash scheduling/resume.
 */
export function installAuxDriver(ctx, controller) {
  const owned = new WeakSet();
  const active = new Set();
  const lifetime = new AbortController();
  let generation = 0;
  const changed = () => { generation++; };
  const stops = [ctx.on('llm/adapters-updated', changed)];
  for (const event of ['loader/entry-init', 'loader/config-update', 'loader/partial-dispose', 'loader/volatile-update']) stops.push(ctx.on(event, changed));
  stops.push(ctx.on('loader/patch-context', (_entry, next) => { changed(); return next(); }));
  const diagnostics = decision => {
    // Never log options, provider messages, bodies, usage, replay or credentials.
    try { ctx.logger?.debug?.(`llm-resilience: auxiliary retry ${decision.retry}; wait ${Math.round(decision.delayMs)}ms`); } catch {}
  };
  // Fixed reasons only; terminal auxiliary failures are not silent. Levels match
  // the main owner: anomalies warn, expected terminal outcomes are informational.
  const anomalies = new Set(['provider-wait-over-cap', 'unrepresentable-policy', 'invalid-retry-ordinal', 'invalid-failure-facts']);
  const refusal = reason => {
    const known = REFUSAL_REASONS.includes(reason) || reason === 'output-exposed' ? reason : 'unclassified';
    try { ctx.logger?.[anomalies.has(known) || known === 'unclassified' ? 'warn' : 'info']?.(`llm-resilience: auxiliary recovery refused (${known}).`); } catch {}
  };

  stops.push(ctx.on('llm/stream', function auxiliary(options, next) {
    // Check the native identity brand BEFORE any clone: purpose is not authority.
    if (isAgentLoopRequest(options) || owned.has(options)) return next();
    const service = this;
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, lifetime.signal, controller.signal, ...(options.signal ? [options.signal] : [])]);
    let resolveDone;
    const operation = { cancel: () => wrapper.return(), done: new Promise(resolve => { resolveDone = resolve; }) };

    async function* produce() {
      active.add(operation);
      let iterator, exhausted = false, retryRequest;
      try {
        if (signal.aborted) throw cancelled();
        const intent = requestSnapshot(options);
        const buffered = controller.config.auxiliary.replaySafePurposes.includes(intent.purpose);
        const registeredPolicy = service.providerRetryPolicy(intent.provider);
        const policy = controller.policyFor(intent.provider, registeredPolicy);
        const initialGeneration = generation;
        const warnings = [];
        let previousRetry = 0, exposed = false, first = true, retryIntent = intent, warnedCode;
        while (true) {
          if (signal.aborted) throw cancelled();
          if (!first && generation !== initialGeneration) throw unsafeReplay();
          exhausted = false;
          // Cordis next() consumes its listener cursor. Call it exactly once to
          // retain the caller's prepared handle. A retry must redispatch through
          // the public service so ALL other middlewares/classifiers run again.
          // PreparedLlmCall.stream itself is one-shot and is never reused here.
          if (first) { iterator = next()[Symbol.asyncIterator](); first = false; }
          else {
            retryRequest = Object.freeze({ ...retryIntent, signal });
            owned.add(retryRequest);
            try { iterator = service.stream(retryRequest)[Symbol.asyncIterator](); }
            catch (error) { owned.delete(retryRequest); retryRequest = undefined; throw error; }
          }
          let terminal, count = 0, bytes = 0;
          const chunks = [];
          while (true) {
            const item = await read(iterator, signal);
            if (item.done) { exhausted = true; break; }
            if (terminal) throw failure('AUXILIARY_PROTOCOL_INVALID', 'Auxiliary LLM returned data after its terminal outcome.');
            if (buffered && ++count > controller.config.auxiliary.maxChunks) throw failure('AUXILIARY_BUFFER_LIMIT', 'Auxiliary LLM response exceeded its safe buffer limit.');
            const copied = copyChunk(item.value, buffered ? controller.config.auxiliary.maxBufferBytes - bytes : Infinity);
            const chunk = copied.chunk;
            if (buffered) { bytes += copied.bytes; chunks.push(chunk); }
            if (chunk.type === 'finish') terminal = chunk;
            else if (!buffered) { exposed = true; yield chunk; }
          }
          iterator = undefined;
          if (retryRequest) { owned.delete(retryRequest); retryRequest = undefined; }
          if (!terminal) throw failure('AUXILIARY_PROTOCOL_INVALID', 'Auxiliary LLM ended without a terminal outcome.');
          if (terminal.reason.kind === 'error' && exposed) refusal('output-exposed');
          if (terminal.reason.kind === 'error' && !exposed) {
            const originalFailure = terminal.reason.failure;
            const facts = sanitizeFailure(originalFailure, intent.provider);
            const classified = facts && Object.freeze({ ...originalFailure, diagnosticCategory: facts.diagnosticCategory });
            const scheduled = facts && !facts.invalidFailureFacts && controller.schedule({ provider: intent.provider, failure: classified, previousRetry, registeredPolicy, policy });
            const decision = scheduled?.kind === 'wait' ? scheduled : undefined;
            if (!decision) refusal(!facts ? 'ineligible-failure' : scheduled ? scheduled.reason : 'invalid-failure-facts');
            if (decision) {
              // Public APIs do not expose the generation captured by an earlier
              // prepared handle. This conservative fence catches every observed
              // adapter/loader update after entry; replay does not silently move
              // to a registration generation changed during this operation.
              if (generation !== initialGeneration) throw unsafeReplay();
              previousRetry = decision.retry;
              // The same operation owns the counter. Its notice changes only with
              // the error code; no session/agent journal is fabricated here.
              if (facts.code !== warnedCode) {
                retryIntent = contextualIntent(intent, warnings, recoveryWarning(facts, intent.purpose));
                warnedCode = facts.code;
              }
              // Release failed output before a possibly long backoff, not only
              // when the next iteration happens to let its scope be collected.
              chunks.length = 0; terminal = undefined;
              diagnostics(decision);
              if (!await controller.wait(decision, signal) || signal.aborted) throw cancelled();
              continue;
            }
            if (facts) {
              const text = recoveryWarning(facts, intent.purpose, true);
              // Keep original routing/permanence facts; only replace unsafe display
              // prose. A terminal warning is not a synthetic successful answer.
              terminal = Object.freeze({ ...terminal, reason: Object.freeze({ kind: 'error',
                failure: Object.freeze({ ...originalFailure, message: text }) }) });
            }
          }
          if (buffered && ['stop', 'tool-calls'].includes(terminal.reason.kind)) {
            // Publish only a completed winner. Failed partial output, usage and
            // replay envelopes never contaminate the next attempt or its result.
            for (const chunk of chunks) { if (signal.aborted) throw cancelled(); yield chunk; }
          } else {
            chunks.length = 0;
            if (signal.aborted) throw cancelled();
            // Non-successful buffered outcomes expose only their terminal reason;
            // no fabricated winning usage and no failed replay state are emitted.
            yield ['error', 'aborted', 'max-tokens'].includes(terminal.reason.kind)
              ? Object.freeze({ type: 'finish', reason: terminal.reason }) : terminal;
          }
          return;
        }
      } finally {
        stop.abort();
        if (!exhausted) closeDetached(iterator);
        if (retryRequest) owned.delete(retryRequest);
        active.delete(operation);
        resolveDone();
      }
    }
    const generator = produce();
    const wrapper = {
      [Symbol.asyncIterator]() { return this; },
      next: value => handled(generator.next(value)),
      return: value => { stop.abort(); return handled(generator.return(value)); },
      throw: error => { stop.abort(); return handled(generator.throw(error)); },
    };
    return wrapper;
  }, { prepend: true }));

  ctx.effect(() => async () => {
    lifetime.abort();
    for (const stop of stops) stop();
    const operations = [...active];
    await Promise.allSettled(operations.map(operation => operation.cancel()));
    await Promise.allSettled(operations.map(operation => operation.done));
  }, 'llm-resilience: cancel and drain auxiliary consumers');
}
