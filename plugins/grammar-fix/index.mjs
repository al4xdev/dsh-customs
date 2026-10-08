import { buildSystemPrompt } from './prompt.mjs';

export const name = 'grammar-fix';
export const inject = ['llm'];
export const bridgeKey = Symbol.for('alex.dsh.grammar-fix');

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
        const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
        let corrected = '';
        let finished = false;
        for await (const chunk of ctx.llm.stream({
          provider: current.provider, model: current.model, reasoningEffort: 'off', temperature: 0,
          maxTokens: Math.min(8192, Math.max(1024, text.length * 2)),
          system: buildSystemPrompt(),
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
          signal: combinedSignal,
        })) {
          if (chunk.type === 'text-delta') corrected += chunk.text;
          if (chunk.type === 'finish') {
            finished = true;
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') throw new Error(chunk.reason.failure?.message ?? 'Correction canceled.');
            if (chunk.reason.kind !== 'stop') throw new Error('Incomplete correction; draft preserved.');
          }
        }
        combinedSignal.throwIfAborted();
        if (!finished || !corrected.trim()) throw new Error('The model did not return a complete correction.');
        return corrected;
      } finally {
        busy = false;
      }
    },
  };
  globalThis[bridgeKey] = bridge;
  ctx.effect(() => () => { if (globalThis[bridgeKey] === bridge) delete globalThis[bridgeKey]; });
}
