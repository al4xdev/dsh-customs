import { buildSystemPrompt } from './prompt.mjs';

export const name = 'grammar-fix';
export const inject = ['llm'];
export const bridgeKey = Symbol.for('alex.dsh.grammar-fix');

function isUnsupportedEffortError(error) {
  const code = error?.code;
  const message = error?.message ?? '';
  return code === 'UNSUPPORTED_REASONING_EFFORT' || /does not support reasoning effort/i.test(message);
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
    // If metadata resolution fails, try off -> low -> omitted.
    return ['off', 'low', undefined];
  }
}

async function streamCorrection(ctx, current, text, effort, signal) {
  const options = {
    provider: current.provider,
    model: current.model,
    maxTokens: Math.min(8192, Math.max(1024, text.length * 2)),
    system: buildSystemPrompt(),
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
    if (chunk.type === 'text-delta') corrected += chunk.text;
    if (chunk.type === 'finish') {
      finished = true;
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        const failure = chunk.reason.failure;
        const err = new Error(failure?.message ?? 'Correction canceled.');
        err.code = failure?.code;
        throw err;
      }
      if (chunk.reason.kind !== 'stop') throw new Error('Incomplete correction; draft preserved.');
    }
  }
  signal?.throwIfAborted();
  if (!finished || !corrected.trim()) throw new Error('The model did not return a complete correction.');
  return corrected;
}

export function apply(ctx) {
  let busy = false;
  const bridge = {
    async fix(text, current, signal, onProgress) {
      if (busy) throw new Error('A correction is already in progress.');
      if (!text.trim() || text.startsWith('/')) return text;
      busy = true;
      onProgress?.('Correcting grammar…');
      try {
        // Own deadline so a stalled provider cannot hold the draft editor forever.
        const signals = [AbortSignal.timeout(120_000)];
        if (signal) signals.push(signal);
        const combinedSignal = AbortSignal.any(signals);

        const candidates = await resolveCandidateEfforts(ctx, current, combinedSignal);
        let lastError;
        for (const effort of candidates) {
          try {
            return await streamCorrection(ctx, current, text, effort, combinedSignal);
          } catch (error) {
            lastError = error;
            if (combinedSignal.aborted || !isUnsupportedEffortError(error)) {
              throw error;
            }
          }
        }
        throw lastError;
      } finally {
        busy = false;
      }
    },
  };
  globalThis[bridgeKey] = bridge;
  ctx.effect(() => () => { if (globalThis[bridgeKey] === bridge) delete globalThis[bridgeKey]; });
}
