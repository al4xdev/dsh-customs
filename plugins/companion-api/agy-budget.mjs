// Invoke only within the Companion source/preset guard, never as a routing hook.
import { reviewedAGYModelPolicies } from './agy-model-policies.mjs';
export const AGY_PROVIDER = 'google-antigravity';
// Both reviewed AGY descriptor factories declare this cap; not vendor/inference proof.
export const AGY_OUTPUT_CAP = 65536;
const unavailable = () => Object.assign(new Error('model-unavailable'), { code: 'model-unavailable' });

/** Preserve every request field except maxTokens; never resolve credentials or choose a route. */
export async function assertAGYBudget(choice, llm, signal, guard) {
  if (choice?.provider !== AGY_PROVIDER) return choice;
  try {
    if (typeof guard !== 'function') throw unavailable();
    const check = () => { signal?.throwIfAborted(); guard(); };
    const original = { ...choice };
    const proposed = { ...original, maxTokens: AGY_OUTPUT_CAP };
    const route = { provider: choice.provider, model: choice.model, reasoningEffort: choice.reasoningEffort };
    const sameChoice = () => {
      check();
      if (Object.keys(original).some(key => choice[key] !== original[key]) ||
          Object.keys(choice).some(key => !(key in original))) throw unavailable();
    };
    const validInfo = info => {
      if (info?.provider !== route.provider || info.id !== route.model ||
          !Number.isSafeInteger(info.context?.contextWindow) || info.context.contextWindow <= AGY_OUTPUT_CAP ||
          (info.defaultMaxTokens !== undefined && info.defaultMaxTokens !== AGY_OUTPUT_CAP)) throw unavailable();
      // An unreviewed 131k route with 65k output/default headroom leaves zero
      // pressure. Reject BEFORE saving an intent/request header that cannot advance.
      const policy = reviewedAGYModelPolicies.find(row => row.model === route.model) ??
        { headroomTokens: 65536, thresholdRatio: 0.8, retainRatio: 0.16 };
      const messages = info.context.contextWindow - AGY_OUTPUT_CAP;
      const pressure = messages - policy.headroomTokens;
      const threshold = Math.floor(Math.min(info.context.contextWindow * policy.thresholdRatio, pressure));
      if (pressure <= 0 || Math.floor(messages * policy.retainRatio) >= threshold) throw unavailable();
    };
    sameChoice();
    const before = await llm.resolveModelInfo(route.provider, route.model, signal); sameChoice(); validInfo(before);
    const resolved = await llm.resolveCallConfig(proposed, signal); sameChoice();
    if (!resolved || resolved.provider !== route.provider || resolved.model !== route.model ||
        resolved.reasoningEffort !== route.reasoningEffort || resolved.maxTokens !== AGY_OUTPUT_CAP ||
        Object.keys(proposed).some(key => resolved[key] !== proposed[key]) ||
        Object.keys(resolved).some(key => !(key in proposed))) throw unavailable();
    const after = await llm.resolveModelInfo(route.provider, route.model, signal); sameChoice(); validInfo(after);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw unavailable();
    // This checks reviewed/default admission, not actual effective configuration.
    // Publication must separately install/verify the scoped native policies.
    return resolved;
  } catch { throw unavailable(); }
}
