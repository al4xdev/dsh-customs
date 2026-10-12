import { buildSystemPrompt, languageLabel } from './prompt.mjs';

export const name = 'grammar-fix';
export const inject = ['llm'];
export const bridgeKey = Symbol.for('alex.dsh.grammar-fix');

function isUnsupportedEffortError(error) {
  const code = error?.code;
  const message = error?.message ?? '';
  return code === 'UNSUPPORTED_REASONING_EFFORT'
    || /does not support reasoning effort/i.test(message)
    // llama.cpp templates report this specific mismatch as HTTP 500, not 400.
    || /Unexpected reasoning effort\b.*Supported types are/is.test(message);
}

async function resolveCandidateEfforts(ctx, current, signal) {
  try {
    const info = await ctx.llm?.resolveModelInfo?.(current.provider, current.model, signal);
    if (!info?.reasoning) {
      // Non-reasoning model: do not pass reasoningEffort.
      return [undefined];
    }
    const supported = (info.reasoning.efforts ?? []).map((e) => e.id);
    const candidates = [];
    if (supported.includes('off')) candidates.push('off');
    if (supported.includes('low')) candidates.push('low');
    if (info.reasoning.defaultEffort && !candidates.includes(info.reasoning.defaultEffort)) {
      candidates.push(info.reasoning.defaultEffort);
    }
    for (const id of supported) {
      if (!candidates.includes(id)) candidates.push(id);
    }
    candidates.push(undefined);
    return candidates;
  } catch {
    signal.throwIfAborted();
    // Metadata failure is not evidence that a model supports a custom effort.
    return [undefined, 'off', 'low'];
  }
}

// A signal alone cannot release the editor if a provider ignores it. Race the
// whole operation (including model lookup), while observing late rejections.
function withAbort(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function streamCorrection(ctx, current, text, effort, signal, language) {
  signal.throwIfAborted();
  const options = {
    provider: current.provider,
    model: current.model,
    // Reasoning shares the output budget: 1024 tokens can exhaust on thoughts
    // alone even for a short draft, particularly on provider-pinned efforts.
    maxTokens: 8192,
    system: buildSystemPrompt(language),
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    signal,
  };
  if (effort !== undefined) {
    options.reasoningEffort = effort;
  }
  // Temperature is intentionally omitted so providers use their default, avoiding
  // failures on reasoning models or gateways that reject custom sampling temperatures.

  let corrected = '';
  let finished = false;
  for await (const chunk of ctx.llm.stream(options)) {
    signal.throwIfAborted();
    if (chunk.type === 'text-delta') corrected += chunk.text;
    if (chunk.type === 'finish') {
      finished = true;
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        const failure = chunk.reason.failure;
        const err = new Error(failure?.message ?? (chunk.reason.kind === 'aborted' ? 'Correction canceled.' : 'Correction failed; draft preserved.'));
        err.code = failure?.code;
        err.status = failure?.status;
        err.providerRetryAfterMs = failure?.providerRetryAfterMs;
        throw err;
      }
      if (chunk.reason.kind !== 'stop') throw new Error('Incomplete correction; draft preserved.');
    }
  }
  signal?.throwIfAborted();
  if (!finished || !corrected.trim()) throw new Error('The model did not return a complete correction.');
  return corrected;
}

export function apply(ctx, config = {}) {
  if (config.model !== undefined && (typeof config.model !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(config.model))) {
    throw new Error('model must use provider/model format.');
  }
  if (config.language !== undefined && (typeof config.language !== 'string' || !config.language.trim() || config.language.length > 80 || /[\r\n\0]/.test(config.language))) {
    throw new Error('language must be nonempty text up to 80 characters on one line.');
  }
  let busy = false;
  let disposed = false;
  let activeAbort;
  const selectModel = (current) => {
    const slash = config.model?.indexOf('/');
    return slash !== undefined
      ? { provider: config.model.slice(0, slash), model: config.model.slice(slash + 1) }
      : current;
  };
  const bridge = {
    describe(current) {
      return {
        model: selectModel(current)?.model ?? 'Session model',
        language: languageLabel(config.language),
      };
    },
    async fix(text, current, signal, onProgress) {
      signal?.throwIfAborted();
      if (disposed) throw new Error('Grammar fixer unloaded; draft preserved.');
      if (busy) throw new Error('A correction is already in progress.');
      if (!text.trim() || text.trimStart().startsWith('/')) return text;
      busy = true;
      const abort = new AbortController();
      activeAbort = abort;
      const timer = setTimeout(() => abort.abort(new DOMException('Correction timed out; draft preserved. Try again.', 'TimeoutError')), 120_000);
      timer.unref?.();
      try {
        const selected = selectModel(current);
        if (!selected?.provider || !selected?.model) throw new Error('No model available for correction. Select a model first.');
        if (!ctx.llm?.stream) throw new Error('Grammar fixer has no LLM service.');
        const combinedSignal = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
        onProgress?.('Correcting grammar…', bridge.describe(current));
        return await withAbort(async () => {
          const candidates = await resolveCandidateEfforts(ctx, selected, combinedSignal);
          combinedSignal.throwIfAborted();
          let lastError;
          for (const effort of candidates) {
            try {
              return await streamCorrection(ctx, selected, text, effort, combinedSignal, config.language);
            } catch (error) {
              lastError = error;
              combinedSignal.throwIfAborted();
              if (!isUnsupportedEffortError(error)) throw error;
            }
          }
          throw lastError;
        }, combinedSignal);
      } finally {
        clearTimeout(timer);
        if (activeAbort === abort) activeAbort = undefined;
        busy = false;
      }
    },
  };
  globalThis[bridgeKey] = bridge;
  ctx.effect(() => () => {
    disposed = true;
    activeAbort?.abort(new DOMException('Grammar fixer unloaded; draft preserved.', 'AbortError'));
    if (globalThis[bridgeKey] === bridge) delete globalThis[bridgeKey];
  });
}
