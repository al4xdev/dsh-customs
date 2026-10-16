// plugins/common.mjs
import { createRequire } from "node:module";
function resolveHost(id) {
  for (const base of [process.argv[1], "/home/alex/.local/share/dsh-cli/package.json"]) {
    try {
      return createRequire(base).resolve(id);
    } catch {
    }
  }
  throw new Error(`Cannot resolve ${id} from the running DSH install.`);
}
var { defineTool } = await import(resolveHost("@deepseek-ai/dsh-tools"));

// plugins/llm-resilience/policy.mjs
var TRANSIENT_CODES = Object.freeze(["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]);
var QUOTA_CODE = "ANTIGRAVITY_QUOTA_RESET";
var MAX_QUOTA_WAIT_MS = 864e5;
var DEFAULT_POLICY = Object.freeze({ mode: "normal", maxRetries: 9, initialDelayMs: 5e3, maxDelayMs: 12e5, jitterRatio: 0.1, retryableCodes: TRANSIENT_CODES });
var DEFAULT_AUXILIARY = Object.freeze({ maxBufferBytes: 16777216, maxChunks: 65536, replaySafePurposes: Object.freeze(["compaction", "session-title"]) });
var DEFAULT_SELF_HEAL = Object.freeze({ maxCycles: 3, initialDelayMs: 5e3, maxDelayMs: 2e4, jitterRatio: 0.1 });
var own = (object2, key) => Object.prototype.hasOwnProperty.call(object2, key);
function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${path} must be a plain object`);
}
function keys(value, allowed, path) {
  object(value, path);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${path}: unknown key ${key}`);
}
function number(value, path, min, max = Number.MAX_SAFE_INTEGER, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) throw new TypeError(`${path} is out of range`);
  return value;
}
var policyFields = ["maxRetries", "initialDelayMs", "maxDelayMs", "jitterRatio", "retryableCodes"];
function policyPatch(input, path) {
  keys(input, policyFields, path);
  const patch2 = {};
  for (const key of policyFields) {
    if (!own(input, key)) continue;
    if (key === "retryableCodes") {
      if (!Array.isArray(input[key]) || input[key].some((code) => !TRANSIENT_CODES.includes(code))) throw new TypeError(`${path}.retryableCodes must contain only known transient codes`);
      patch2[key] = Object.freeze([...new Set(input[key])]);
    } else patch2[key] = number(input[key], `${path}.${key}`, key === "maxRetries" || key === "jitterRatio" ? 0 : 1, key === "jitterRatio" ? 1 : key === "maxRetries" ? Number.MAX_SAFE_INTEGER : 2147483647, key === "maxRetries");
  }
  return Object.freeze(patch2);
}
function backoffInvariant(policy, path) {
  if (policy.initialDelayMs > policy.maxDelayMs) throw new TypeError(`${path}.initialDelayMs must not exceed maxDelayMs`);
  return policy;
}
function resolveConfig(input = {}) {
  keys(input, ["policy", "providers", "auxiliary", "selfHeal"], "llm-resilience");
  const policy = Object.freeze(backoffInvariant({ ...DEFAULT_POLICY, ...policyPatch(input.policy === void 0 ? {} : input.policy, "policy") }, "policy"));
  const providerInput = input.providers === void 0 ? {} : input.providers;
  object(providerInput, "providers");
  const providers = /* @__PURE__ */ Object.create(null);
  for (const [provider, value] of Object.entries(providerInput)) {
    if (!provider) throw new TypeError("providers requires nonempty provider names");
    providers[provider] = policyPatch(value, `providers.${provider}`);
    backoffInvariant({ ...policy, ...providers[provider] }, `providers.${provider}`);
  }
  const auxiliaryInput = input.auxiliary === void 0 ? {} : input.auxiliary;
  keys(auxiliaryInput, ["maxBufferBytes", "maxChunks", "replaySafePurposes"], "auxiliary");
  const auxiliary = { ...DEFAULT_AUXILIARY, ...auxiliaryInput };
  for (const key of ["maxBufferBytes", "maxChunks"]) number(auxiliary[key], `auxiliary.${key}`, 1, Number.MAX_SAFE_INTEGER, true);
  if (!Array.isArray(auxiliary.replaySafePurposes) || auxiliary.replaySafePurposes.some((value) => typeof value !== "string" || !value.length)) throw new TypeError("auxiliary.replaySafePurposes requires nonempty strings");
  auxiliary.replaySafePurposes = Object.freeze([...new Set(auxiliary.replaySafePurposes)]);
  const selfInput = input.selfHeal === void 0 ? {} : input.selfHeal;
  keys(selfInput, ["maxCycles", "initialDelayMs", "maxDelayMs", "jitterRatio"], "selfHeal");
  const selfHeal = { ...DEFAULT_SELF_HEAL, ...selfInput };
  number(selfHeal.maxCycles, "selfHeal.maxCycles", 0, Number.MAX_SAFE_INTEGER, true);
  number(selfHeal.initialDelayMs, "selfHeal.initialDelayMs", 1, 2147483647);
  number(selfHeal.maxDelayMs, "selfHeal.maxDelayMs", 1, 2147483647);
  number(selfHeal.jitterRatio, "selfHeal.jitterRatio", 0, 1);
  backoffInvariant(selfHeal, "selfHeal");
  return Object.freeze({ policy, providers: Object.freeze(providers), auxiliary: Object.freeze(auxiliary), selfHeal: Object.freeze(selfHeal) });
}
function resolvePolicy(config, provider, registeredPolicy) {
  const optedOut = registeredPolicy?.mode === "normal" && registeredPolicy.maxRetries === 0;
  const quota = provider === "google-antigravity" && registeredPolicy?.mode === "normal" && Array.isArray(registeredPolicy.retryableCodes) && registeredPolicy.retryableCodes.includes(QUOTA_CODE);
  const effective = { ...config.policy, ...own(config.providers, provider) ? config.providers[provider] : {} };
  if (optedOut) effective.maxRetries = 0;
  return Object.freeze({ ...effective, mode: "normal", retryableCodes: Object.freeze([...effective.retryableCodes, ...quota ? [QUOTA_CODE] : []]), sourceExtension: Object.freeze({ antigravityQuotaReset: quota }) });
}
function policyKey(policy) {
  return JSON.stringify(["normal", policy.maxRetries, [...policy.retryableCodes].sort(), policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio]);
}
function policyFromKey(provider, key) {
  try {
    const [mode, maxRetries, retryableCodes, initialDelayMs, maxDelayMs, jitterRatio, ...rest] = JSON.parse(key);
    if (mode !== "normal" || rest.length || !Array.isArray(retryableCodes) || retryableCodes.some((code) => typeof code !== "string")) return;
    number(maxRetries, "maxRetries", 0, Number.MAX_SAFE_INTEGER, true);
    number(initialDelayMs, "initialDelayMs", 1, 2147483647);
    number(maxDelayMs, "maxDelayMs", 1, 2147483647);
    number(jitterRatio, "jitterRatio", 0, 1);
    const policy = { mode, maxRetries, retryableCodes: Object.freeze([...retryableCodes]), initialDelayMs, maxDelayMs, jitterRatio, sourceExtension: Object.freeze({ antigravityQuotaReset: provider === "google-antigravity" && retryableCodes.includes(QUOTA_CODE) }) };
    backoffInvariant(policy, "captured policy");
    return Object.freeze(policy);
  } catch {
    return void 0;
  }
}
function isEligibleFailure(provider, failure2, policy) {
  if (!failure2 || typeof failure2 !== "object" || failure2.cancelled === true || failure2.aborted === true || failure2.permanent === true) return false;
  if (["auth", "authentication", "authorization", "permanent", "cancel", "cancelled", "canceled", "abort", "policy", "context", "invalid-request"].includes(failure2.category)) return false;
  if (Number.isFinite(failure2.status) && failure2.status >= 400 && failure2.status < 500 && ![408, 429].includes(failure2.status)) return false;
  if (failure2.code === QUOTA_CODE) return provider === "google-antigravity" && policy.sourceExtension?.antigravityQuotaReset === true && policy.retryableCodes.includes(QUOTA_CODE);
  return TRANSIENT_CODES.includes(failure2.code) && policy.retryableCodes.includes(failure2.code);
}
function localDelay(policy, retry, random) {
  const nominal = Math.min(policy.initialDelayMs * 2 ** Math.min(retry - 1, 1023), policy.maxDelayMs);
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new TypeError("random must return a finite number in [0, 1]");
  return Math.min(nominal * (1 - policy.jitterRatio + 2 * policy.jitterRatio * sample), policy.maxDelayMs);
}

// plugins/llm-resilience/controller.mjs
function createController(config = {}, internals = {}) {
  const resolved = resolveConfig(config);
  const random = internals.random ?? Math.random;
  const setTimer = internals.setTimeout ?? internals.clock?.setTimeout?.bind(internals.clock) ?? setTimeout;
  const clearTimer = internals.clearTimeout ?? internals.clock?.clearTimeout?.bind(internals.clock) ?? clearTimeout;
  const lifetime = new AbortController();
  const waits = /* @__PURE__ */ new Set();
  const policyFor = (provider, registeredPolicy) => resolvePolicy(resolved, provider, registeredPolicy);
  function plan({ provider, failure: failure2, previousRetry = 0, registeredPolicy, policy = policyFor(provider, registeredPolicy) }) {
    if (registeredPolicy?.mode === "normal" && registeredPolicy.maxRetries === 0) return;
    let captured;
    try {
      captured = policy?.mode === "normal" && policyFromKey(provider, policyKey(policy));
    } catch {
      return;
    }
    if (!captured) return;
    policy = Object.freeze({ ...captured, sourceExtension: Object.freeze({ antigravityQuotaReset: provider === "google-antigravity" && policy.sourceExtension?.antigravityQuotaReset === true }) });
    if (lifetime.signal.aborted || !Number.isSafeInteger(previousRetry) || previousRetry < 0 || previousRetry >= policy.maxRetries || !isEligibleFailure(provider, failure2, policy)) return;
    const retry = previousRetry + 1;
    const hint = failure2.providerRetryAfterMs;
    const quota = failure2.code === QUOTA_CODE;
    const hasHint = hint !== void 0;
    if ((hasHint || quota) && (!Number.isFinite(hint) || hint <= 0 || hint > (quota ? MAX_QUOTA_WAIT_MS : policy.maxDelayMs))) return;
    const delayMs = hasHint ? hint : localDelay(policy, retry, random);
    return Object.freeze({ provider, policy, policyKey: policyKey(policy), retry, delayMs, phase: "transient" });
  }
  function selfHealPlan(cycle) {
    const policy = resolved.selfHeal;
    if (lifetime.signal.aborted || !Number.isSafeInteger(cycle) || cycle < 1 || cycle > policy.maxCycles) return;
    return Object.freeze({ phase: "self-heal", retry: cycle, delayMs: localDelay(policy, cycle, random), policyKey: JSON.stringify(["self-heal", policy.maxCycles, policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio]) });
  }
  function wait(decision, signal) {
    signal = signal || void 0;
    if (lifetime.signal.aborted || signal?.aborted) return Promise.resolve(false);
    if (!decision || !Number.isFinite(decision.delayMs) || decision.delayMs < 0 || decision.delayMs > 2147483647) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      let timer, settled = false;
      const detach = () => {
        clearTimer(timer);
        signal?.removeEventListener("abort", onAbort);
        waits.delete(onAbort);
      };
      const finish = (elapsed) => {
        if (settled) return;
        settled = true;
        detach();
        resolve(elapsed && !signal?.aborted && !lifetime.signal.aborted);
      };
      const onAbort = () => finish(false);
      waits.add(onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        timer = setTimer(() => finish(true), decision.delayMs);
      } catch (error) {
        settled = true;
        detach();
        reject(error);
        return;
      }
      if (settled) clearTimer(timer);
      else if (signal?.aborted || lifetime.signal.aborted) finish(false);
    });
  }
  async function dispose() {
    lifetime.abort(new Error("llm-resilience disposed"));
    for (const cancel of [...waits]) cancel();
  }
  return Object.freeze({ config: resolved, policyFor, plan, selfHealPlan, wait, signal: lifetime.signal, dispose });
}

// plugins/llm-resilience/main-driver.mjs
import { randomUUID } from "node:crypto";
var { z } = await import(resolveHost("zod"));
var retryStateKey = (provider, policyKey2) => JSON.stringify([provider, policyKey2]);
var llmRetryProjection = {
  key: "llmRetry",
  stateVersion: 1,
  stateSchema: z.record(z.string(), z.object({ retry: z.number().int().nonnegative(), retryId: z.string() })),
  init: () => ({}),
  apply(state, event) {
    if (event.type === "step/start" || event.type === "turn/end") return {};
    if (event.type !== "llm/retry") return state;
    const key = retryStateKey(event.data.provider, event.data.policyKey);
    const entry = state[key];
    if (entry?.retry === event.data.retry && entry.retryId === event.data.retryId) return state;
    return { ...state, [key]: { retry: event.data.retry, retryId: event.data.retryId } };
  }
};
function installMainDriver(ctx, controller) {
  const unregisterProjection = ctx.sessionProjections.register(llmRetryProjection);
  const lifetime = new AbortController();
  const active = /* @__PURE__ */ new Set();
  const pinned = /* @__PURE__ */ new WeakMap();
  let cleanupPromise;
  function chainFor(session, provider, turn, step, registeredPolicy, state) {
    const scope = JSON.stringify([provider, turn, step]);
    let chains = pinned.get(session);
    if (!chains || chains.scope !== JSON.stringify([turn, step])) {
      chains = { scope: JSON.stringify([turn, step]), providers: /* @__PURE__ */ new Map() };
      pinned.set(session, chains);
    }
    if (chains.providers.has(scope)) return chains.providers.get(scope);
    const captured = [];
    for (const [key, entry] of Object.entries(state)) {
      try {
        const [route, policyKey2] = JSON.parse(key);
        if (route === provider) captured.push({ policyKey: policyKey2, ...entry });
      } catch {
      }
    }
    const prior = captured.at(-1);
    const chain = {
      policy: (prior && policyFromKey(provider, prior.policyKey)) ?? controller.policyFor(provider, registeredPolicy),
      retryId: prior?.retryId ?? randomUUID(),
      // Preserve consumed retries even if a legacy engine changed keys mid-step.
      previousRetry: captured.reduce((total, entry) => total + entry.retry, 0)
    };
    chains.providers.set(scope, chain);
    return chain;
  }
  async function recover({ agent, turn, step, provider, failure: failure2, retryPolicy, signal }, next) {
    if (signal?.aborted || lifetime.signal.aborted || controller.signal.aborted) return;
    const state = ctx.sessionProjections.stateOf(agent.session, "llmRetry");
    const chain = chainFor(agent.session, provider, turn, step, retryPolicy, state);
    const plan = controller.plan({ provider, failure: failure2, previousRetry: chain.previousRetry, policy: chain.policy, registeredPolicy: retryPolicy });
    if (!plan) return next();
    const fusedSignal = AbortSignal.any([lifetime.signal, ...signal ? [signal] : []]);
    if (fusedSignal.aborted || controller.signal.aborted) return;
    agent.session.append("llm/retry", {
      retryId: chain.retryId,
      turn,
      step,
      provider,
      mode: "normal",
      policyKey: plan.policyKey,
      retry: plan.retry,
      maxRetries: plan.policy.maxRetries,
      delayMs: plan.delayMs,
      failure: failure2
    });
    chain.previousRetry = plan.retry;
    if (!await controller.wait(plan, fusedSignal) || fusedSignal.aborted || controller.signal.aborted) return;
    agent.session.append("llm/retry-started", { retryId: chain.retryId, turn, step, retry: plan.retry });
    return { kind: "retry" };
  }
  const unregisterListener = ctx.on("agent/request-error", (payload, next) => {
    let settle;
    const tracked = new Promise((resolve) => {
      settle = resolve;
    });
    active.add(tracked);
    const operation = recover(payload, next);
    const done = () => {
      active.delete(tracked);
      settle();
    };
    operation.then(done, done);
    return operation;
  });
  function cleanup() {
    if (!cleanupPromise) {
      lifetime.abort(new Error("llm-resilience main driver disposed"));
      unregisterListener();
      cleanupPromise = Promise.allSettled([...active]).then(() => unregisterProjection?.());
    }
    return cleanupPromise;
  }
  ctx.effect(() => cleanup, "llm-resilience: drain main recovery and unregister projection");
  return cleanup;
}

// plugins/llm-resilience/aux-driver.mjs
import { Buffer } from "node:buffer";
var { isAgentLoopRequest, LlmError } = await import(resolveHost("@deepseek-ai/dsh-llm"));
var terminalKinds = /* @__PURE__ */ new Set(["stop", "tool-calls", "max-tokens", "error", "aborted"]);
var chunkTypes = /* @__PURE__ */ new Set(["block-start", "text-delta", "reasoning-delta", "tool-call-delta", "block-end", "usage", "finish"]);
var failure = (code, message) => new LlmError(message, code);
var cancelled = () => failure("ABORTED", "Auxiliary LLM operation was cancelled.");
var unsafeReplay = () => failure("AUXILIARY_RETRY_UNSAFE", "Auxiliary retry stopped because the LLM configuration changed.");
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function requestSnapshot(options) {
  const { signal: _signal, ...intent } = options;
  try {
    return freeze(structuredClone(intent));
  } catch {
    throw failure("AUXILIARY_RETRY_UNSAFE", "Auxiliary request cannot be safely snapshotted.");
  }
}
function jsonBytes(value, limit) {
  let bytes = 0;
  const ancestors = /* @__PURE__ */ new Set();
  const invalid = () => {
    throw failure("AUXILIARY_PROTOCOL_INVALID", "Auxiliary LLM returned a non-serializable chunk.");
  };
  const add = (amount) => {
    bytes += amount;
    if (bytes > limit) throw failure("AUXILIARY_BUFFER_LIMIT", "Auxiliary LLM response exceeded its safe buffer limit.");
  };
  const string = (text) => {
    add(2 + Buffer.byteLength(text, "utf8"));
    for (const match of text.matchAll(/["\\\u0000-\u001f\ud800-\udfff]/gu)) {
      const code = match[0].charCodeAt(0);
      add(code >= 55296 ? 3 : [8, 9, 10, 12, 13, 34, 92].includes(code) ? 1 : 5);
    }
  };
  const walk = (item, depth = 0, arrayItem = false) => {
    if (depth > 128) invalid();
    if (item === null || item === void 0 && arrayItem) {
      add(4);
      return;
    }
    if (typeof item === "string") {
      string(item);
      return;
    }
    if (typeof item === "boolean") {
      add(item ? 4 : 5);
      return;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      add(JSON.stringify(item).length);
      return;
    }
    if (!item || typeof item !== "object" || ancestors.has(item)) invalid();
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid();
    ancestors.add(item);
    add(2);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        if (i) add(1);
        const entry = Object.getOwnPropertyDescriptor(item, String(i));
        if (entry && !("value" in entry)) invalid();
        walk(entry?.value, depth + 1, true);
      }
    } else {
      let fields = 0;
      for (const key of Object.keys(item)) {
        const entry = Object.getOwnPropertyDescriptor(item, key);
        if (!entry || !("value" in entry)) invalid();
        if (entry.value === void 0) continue;
        if (fields++) add(1);
        string(key);
        add(1);
        walk(entry.value, depth + 1);
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
  try {
    copy = structuredClone(chunk);
  } catch {
    throw failure("AUXILIARY_PROTOCOL_INVALID", "Auxiliary LLM returned a non-serializable chunk.");
  }
  if (!copy || !chunkTypes.has(copy.type)) throw failure("AUXILIARY_PROTOCOL_INVALID", "Auxiliary LLM returned an invalid chunk.");
  if (copy.type === "finish" && (!terminalKinds.has(copy.reason?.kind) || ["error", "aborted"].includes(copy.reason.kind) && (typeof copy.reason.failure?.code !== "string" || typeof copy.reason.failure?.message !== "string"))) {
    throw failure("AUXILIARY_PROTOCOL_INVALID", "Auxiliary LLM returned an invalid terminal outcome.");
  }
  return { chunk: freeze(copy), bytes };
}
function read(iterator, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => finish(reject, cancelled());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw cancelled();
      return iterator.next();
    }).then((value) => finish(resolve, value), (error) => finish(reject, error));
    if (signal.aborted) abort();
  });
}
function closeDetached(iterator) {
  if (iterator) void Promise.resolve().then(() => {
    const close = iterator.return;
    if (typeof close === "function") return close.call(iterator);
  }).catch(() => {
  });
}
function handled(promise) {
  void promise.catch(() => {
  });
  return promise;
}
function installAuxDriver(ctx, controller) {
  const owned = /* @__PURE__ */ new WeakSet();
  const active = /* @__PURE__ */ new Set();
  const lifetime = new AbortController();
  let generation = 0;
  const changed = () => {
    generation++;
  };
  const stops = [ctx.on("llm/adapters-updated", changed)];
  for (const event of ["loader/entry-init", "loader/config-update", "loader/partial-dispose", "loader/volatile-update"]) stops.push(ctx.on(event, changed));
  stops.push(ctx.on("loader/patch-context", (_entry, next) => {
    changed();
    return next();
  }));
  const diagnostics = (decision) => {
    try {
      ctx.logger?.debug?.(`llm-resilience: auxiliary retry ${decision.retry}; wait ${Math.round(decision.delayMs)}ms`);
    } catch {
    }
  };
  stops.push(ctx.on("llm/stream", function auxiliary(options, next) {
    if (isAgentLoopRequest(options) || owned.has(options)) return next();
    const service = this;
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, lifetime.signal, controller.signal, ...options.signal ? [options.signal] : []]);
    let resolveDone;
    const operation = { cancel: () => wrapper.return(), done: new Promise((resolve) => {
      resolveDone = resolve;
    }) };
    async function* produce() {
      active.add(operation);
      let iterator, exhausted = false, retryRequest;
      try {
        if (signal.aborted) throw cancelled();
        const intent = requestSnapshot(options);
        const buffered = controller.config.auxiliary.replaySafePurposes.includes(intent.purpose);
        const policy = controller.policyFor(intent.provider, service.providerRetryPolicy(intent.provider));
        const initialGeneration = generation;
        let previousRetry = 0, exposed = false, first = true;
        while (true) {
          if (signal.aborted) throw cancelled();
          if (!first && generation !== initialGeneration) throw unsafeReplay();
          exhausted = false;
          if (first) {
            iterator = next()[Symbol.asyncIterator]();
            first = false;
          } else {
            retryRequest = Object.freeze({ ...intent, signal });
            owned.add(retryRequest);
            try {
              iterator = service.stream(retryRequest)[Symbol.asyncIterator]();
            } catch (error) {
              owned.delete(retryRequest);
              retryRequest = void 0;
              throw error;
            }
          }
          let terminal, count = 0, bytes = 0;
          const chunks = [];
          while (true) {
            const item = await read(iterator, signal);
            if (item.done) {
              exhausted = true;
              break;
            }
            if (terminal) throw failure("AUXILIARY_PROTOCOL_INVALID", "Auxiliary LLM returned data after its terminal outcome.");
            if (buffered && ++count > controller.config.auxiliary.maxChunks) throw failure("AUXILIARY_BUFFER_LIMIT", "Auxiliary LLM response exceeded its safe buffer limit.");
            const copied = copyChunk(item.value, buffered ? controller.config.auxiliary.maxBufferBytes - bytes : Infinity);
            const chunk = copied.chunk;
            if (buffered) {
              bytes += copied.bytes;
              chunks.push(chunk);
            }
            if (chunk.type === "finish") terminal = chunk;
            else if (!buffered) {
              exposed = true;
              yield chunk;
            }
          }
          iterator = void 0;
          if (retryRequest) {
            owned.delete(retryRequest);
            retryRequest = void 0;
          }
          if (!terminal) throw failure("AUXILIARY_PROTOCOL_INVALID", "Auxiliary LLM ended without a terminal outcome.");
          if (terminal.reason.kind === "error" && !exposed) {
            const decision = controller.plan({ provider: intent.provider, failure: terminal.reason.failure, previousRetry, policy });
            if (decision) {
              if (generation !== initialGeneration) throw unsafeReplay();
              previousRetry = decision.retry;
              chunks.length = 0;
              terminal = void 0;
              diagnostics(decision);
              if (!await controller.wait(decision, signal) || signal.aborted) throw cancelled();
              continue;
            }
          }
          if (buffered && ["stop", "tool-calls"].includes(terminal.reason.kind)) {
            for (const chunk of chunks) {
              if (signal.aborted) throw cancelled();
              yield chunk;
            }
          } else {
            chunks.length = 0;
            if (signal.aborted) throw cancelled();
            yield ["error", "aborted", "max-tokens"].includes(terminal.reason.kind) ? Object.freeze({ type: "finish", reason: terminal.reason }) : terminal;
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
      [Symbol.asyncIterator]() {
        return this;
      },
      next: (value) => handled(generator.next(value)),
      return: (value) => {
        stop.abort();
        return handled(generator.return(value));
      },
      throw: (error) => {
        stop.abort();
        return handled(generator.throw(error));
      }
    };
    return wrapper;
  }, { prepend: true }));
  ctx.effect(() => async () => {
    lifetime.abort();
    for (const stop of stops) stop();
    const operations = [...active];
    await Promise.allSettled(operations.map((operation) => operation.cancel()));
    await Promise.allSettled(operations.map((operation) => operation.done));
  }, "llm-resilience: cancel and drain auxiliary consumers");
}

// plugins/llm-resilience/index.mjs
var { default: z2 } = await import(resolveHost("@deepseek-ai/schemastery"));
var name = "alex-llm-resilience";
var inject = ["llm", "agents", "sessionProjections"];
var positiveDelay = () => z2.number().min(1).max(2147483647);
var patch = () => z2.object({
  maxRetries: z2.natural().max(Number.MAX_SAFE_INTEGER),
  initialDelayMs: positiveDelay(),
  maxDelayMs: positiveDelay(),
  jitterRatio: z2.number().min(0).max(1),
  retryableCodes: z2.array(z2.union(TRANSIENT_CODES.map((code) => z2.const(code))))
});
var Config = z2.transform(z2.object({
  policy: patch(),
  providers: z2.dict(patch()),
  auxiliary: z2.object({ maxBufferBytes: z2.natural().min(1).max(Number.MAX_SAFE_INTEGER), maxChunks: z2.natural().min(1).max(Number.MAX_SAFE_INTEGER), replaySafePurposes: z2.array(z2.string().min(1)) }),
  selfHeal: z2.object({ maxCycles: z2.natural().max(Number.MAX_SAFE_INTEGER), initialDelayMs: positiveDelay(), maxDelayMs: positiveDelay(), jitterRatio: z2.number().min(0).max(1) })
}), (value) => {
  resolveConfig(value);
  return value;
});
function apply(ctx, config = {}, internals = {}) {
  const controller = createController(config, internals);
  ctx.provide("llmResilience", controller);
  ctx.effect(() => () => controller.dispose(), "llm-resilience: abort and drain shared waits");
  installMainDriver(ctx, controller);
  installAuxDriver(ctx, controller);
}
export {
  Config,
  apply,
  createController,
  inject,
  name
};
