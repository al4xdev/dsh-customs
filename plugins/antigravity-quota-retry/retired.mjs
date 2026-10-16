/** Compatibility marker only: the historical fork must not create another owner. */
export const name = 'antigravity-quota-retry-retired';
export const inject = [];

export function apply(ctx, config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length) {
    throw new Error('antigravity-quota-retry is retired; configure the shared llmResilience policy instead.');
  }
  const shared = ctx.get?.('llmResilience');
  if (shared?.recoveryVersion !== 2 || typeof shared.plan !== 'function' || typeof shared.wait !== 'function') {
    throw new Error('antigravity-quota-retry is retired; shared llmResilience recovery contract2 is required.');
  }
  // Existing shared recovery already owns classification admission, budget,
  // warnings and cancellable waits. Deliberately register no hook or projection.
}
