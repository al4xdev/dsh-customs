import { resolveHost } from '../common.mjs';
import { createController } from './controller.mjs';
import { resolveConfig, RECOVERY_CODES, MAX_RETRIES, MAX_DELAY_MS } from './policy.mjs';
import { installMainDriver } from './main-driver.mjs';
import { installAuxDriver } from './aux-driver.mjs';
const { default: z } = await import(resolveHost('@deepseek-ai/schemastery'));

export const name = 'alex-llm-resilience';
export const inject = ['llm', 'agents', 'sessionProjections'];
const positiveDelay = () => z.number().min(1).max(MAX_DELAY_MS);
const patch = () => z.object({
  maxRetries: z.natural().max(MAX_RETRIES),
  initialDelayMs: positiveDelay(), maxDelayMs: positiveDelay(),
  jitterRatio: z.number().min(0).max(1),
  retryableCodes: z.array(z.union(RECOVERY_CODES.map(code => z.const(code)))).default(undefined),
});
// Schemastery arrays otherwise default to [] even without an explicit default.
// Preserve absence: only the central resolver may supply policy/purpose lists;
// an operator's explicit [] must still disable that selection.
export const Config = z.transform(z.object({
  policy: patch(), providers: z.dict(patch()),
  auxiliary: z.object({ maxBufferBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER), maxChunks: z.natural().min(1).max(Number.MAX_SAFE_INTEGER), replaySafePurposes: z.array(z.string().min(1)).default(undefined) }),
  selfHeal: z.object({ maxCycles: z.natural().max(MAX_RETRIES), initialDelayMs: positiveDelay(), maxDelayMs: positiveDelay(), jitterRatio: z.number().min(0).max(1) }),
}), value => { resolveConfig(value); return value; });

export function apply(ctx, config = {}, internals = {}) {
  const controller = createController(config, internals);
  ctx.effect(() => () => controller.dispose(), 'llm-resilience: abort and drain shared waits');
  installMainDriver(ctx, controller);
  installAuxDriver(ctx, controller);
  // Required consumers may start synchronously when the service is published.
  // The accounting projections must already exist before they can admit work.
  ctx.provide('llmResilience', controller);
  // The old controller also provided llmResilience. A new capability name keeps
  // v4 consumers waiting during warm HMR instead of binding to that old owner.
  ctx.provide('llmRecovery', controller);
  // A history-aware owner must not attach to an earlier accounting-v1 service
  // during replacement. All three names refer to this one controller.
  ctx.provide('llmRecoveryHistory', controller);
}

export { createController };
