// STAGING ONLY: public metadata and pressure arithmetic, not a request hook or mutation API.
export const BONSAI_ID = 'Ternary-Bonsai-2-27B-PQ2_0';
export const GEMMA_ID = '/home/alex/.cache/huggingface/hub/models--EZForever--gemma-4-26B-A4B-it-qat-uncensored-heretic-UDmerge-GGUF/snapshots/9567a9ca99f1ee12c9d43082c7351f24b4feef63/gemma-4-26B-A4B-it-qat-uncensored-heretic-UDmerge-Q4_K_XXL.gguf';
export const localModels = Object.freeze([
  Object.freeze({ id: BONSAI_ID, name: 'Bonsai 2 27B (QW)', contextWindow: 131072, maxTokens: 32768,
    input: ['text', 'image'], reasoningEfforts: { off: 'none', medium: 'medium', high: 'xhigh', xhigh: 'xhigh' },
    compat: { supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: false } }),
  Object.freeze({ id: GEMMA_ID, name: 'Gemma 4 26B Local (Q4_K_XXL)', contextWindow: 65536, maxTokens: 32768,
    input: ['text', 'image'], reasoningEfforts: false,
    compat: { supportsReasoningEffort: false, requiresReasoningContentOnAssistantMessages: false } }),
]);
export const modelProvenance = Object.freeze({
  [BONSAI_ID]: Object.freeze({ source: 'launcher-cached', onlineVerified: false }),
  [GEMMA_ID]: Object.freeze({ source: 'local-server-properties', observedAt: '2026-10-15T17:37:53.472Z', onlineVerified: false }),
});

/** A pressure threshold is not a physical model limit. Reject unsupported budgets rather than clamp silently. */
export function pressureFacts({ contextWindow, reservedCompletionTokens, headroomTokens, thresholdRatio = 0.8, retainRatio = 0.16, summaryMaxTokens }) {
  for (const [key, value] of Object.entries({ contextWindow, reservedCompletionTokens, headroomTokens, summaryMaxTokens })) {
    if (!Number.isSafeInteger(value) || value < (key === 'reservedCompletionTokens' ? 0 : 1)) throw new TypeError(`invalid-${key}`);
  }
  if (!(thresholdRatio > 0 && thresholdRatio <= 1) || !(retainRatio > 0 && retainRatio < thresholdRatio)) throw new TypeError('invalid-ratios');
  const messageBudgetTokens = contextWindow - reservedCompletionTokens;
  const pressureBudgetTokens = messageBudgetTokens - headroomTokens;
  const thresholdTokens = Math.floor(Math.min(contextWindow * thresholdRatio, pressureBudgetTokens));
  const retainTokens = Math.floor(messageBudgetTokens * retainRatio);
  if (pressureBudgetTokens <= 0 || retainTokens >= thresholdTokens) throw new RangeError('unsupported-pressure-budget');
  return { contextWindow, reservedCompletionTokens, headroomTokens, summaryMaxTokens, thresholdRatio, thresholdTokens, retainTokens };
}

/** Candidate policy: matches existing Bonsai launcher; Gemma is an explicit new correction, not a claim of TUI equivalence. */
export const localModelPolicies = Object.freeze(localModels.map(model => Object.freeze({
  provider: 'strata-local', model: model.id, headroomTokens: 16384, maxTokens: 16384,
})));

/** Config fragments only. The caller must preserve all existing row config and provider entries under a reviewed CAS. */
export const localProviderFragment = Object.freeze({
  displayName: 'Local server', api: 'openai-completions', baseURL: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'STRATA_API_KEY',
  compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' },
  models: localModels,
});

// Timestamped provider metadata is separate from SDK configured/advisory listModels.
// Cached Bonsai must not be enabled against a single-model Gemma endpoint.
export const localServerObservation = Object.freeze({
  observedAt: '2026-10-15T17:40:54.531Z', endpoint: 'http://127.0.0.1:8080/v1', advertisedModelIds: Object.freeze([GEMMA_ID]),
  contextWindow: 65536, onlineVerified: false,
});
export function localInventoryStates(advertisedModelIds) {
  if (!Array.isArray(advertisedModelIds) || advertisedModelIds.some(id => typeof id !== 'string')) throw new TypeError('invalid-model-identities');
  const advertised = new Set(advertisedModelIds);
  return localModels.map(model => ({ provider: 'strata-local', model: model.id,
    state: advertised.has(model.id) ? 'advertised' : 'configured-unavailable',
    reason: advertised.has(model.id) ? null : 'model-not-advertised', onlineVerified: false }));
}
/** V1 may show both configured models with notes; choice admission separately rejects unloaded identities. */
export function v1LocalCatalogNotes(advertisedModelIds) {
  return localInventoryStates(advertisedModelIds).map(row => ({
    id: row.model,
    name: localModels.find(model => model.id === row.model).name,
    description: row.state === 'advertised'
      ? 'Configured local model; advertised by server metadata. Inference availability is not verified.'
      : 'Configured local model; not advertised by this server. Selection returns unavailable. No automatic loading.',
  }));
}
export function assertLocalAdvertisedModel(requestedModel, advertisedModelIds) {
  if (!localInventoryStates(advertisedModelIds).some(row => row.model === requestedModel && row.state === 'advertised')) {
    throw new Error('local-model-not-advertised');
  }
  // This is only an observation check, not an atomic server/model lease or a routing implementation.
}

/** Read one exact advertised model using only documented registry metadata methods; no auth/stream/inference. */
export async function publicModelFacts(llm, provider, model) {
  const registered = llm.listProviders().some(entry => entry.id === provider);
  if (!registered) return { provider, model, state: 'route-absent', onlineVerified: false };
  let listed;
  try { listed = await llm.listModels(provider); }
  catch { return { provider, model, state: 'catalog-unavailable', onlineVerified: false }; }
  if (!listed.some(entry => entry.id === model)) return { provider, model, state: 'not-advertised', onlineVerified: false };
  let info;
  try { info = await llm.resolveModelInfo(provider, model); }
  catch { return { provider, model, state: 'metadata-unavailable', onlineVerified: false }; }
  return { provider, model, state: 'advertised', onlineVerified: false,
    ...(Number.isSafeInteger(info.context?.contextWindow) && info.context.contextWindow > 0 ? { contextWindow: info.context.contextWindow } : {}),
    ...(Number.isSafeInteger(info.defaultMaxTokens) && info.defaultMaxTokens > 0 ? { defaultMaxTokens: info.defaultMaxTokens } : {}) };
}
