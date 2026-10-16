import { resolveHost } from '../common.mjs';
import { recoveryAccountingProjection } from './recovery-accounting.mjs';
const { z } = await import(resolveHost('zod'));
export const retryStateKey = (provider, policyKey) => JSON.stringify([provider, policyKey]);
// Keep the native v1 ledger solely for history/UI. The contextual owner is the
// only component allowed to reserve, wait and return a main-agent retry.
export const llmRetryProjection = {
  key: 'llmRetry', stateVersion: 1,
  stateSchema: z.record(z.string(), z.object({ retry: z.number().int().nonnegative(), retryId: z.string() })),
  init: () => ({}),
  apply(state, event) {
    if (event.type === 'step/start' || event.type === 'turn/end') return {};
    if (event.type !== 'llm/retry') return state;
    const key = retryStateKey(event.data.provider, event.data.policyKey), entry = state[key];
    if (entry?.retry === event.data.retry && entry.retryId === event.data.retryId) return state;
    return { ...state, [key]: { retry: event.data.retry, retryId: event.data.retryId } };
  },
};
export function installMainDriver(ctx) {
  const native = ctx.sessionProjections.register(llmRetryProjection);
  const accounting = ctx.sessionProjections.register(recoveryAccountingProjection);
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true; accounting?.(); native?.();
  };
  ctx.effect(() => cleanup, 'llm-resilience: unregister native retry mirrors/accounting');
  return cleanup;
}
