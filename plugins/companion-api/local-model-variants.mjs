import { localModels, localModelPolicies } from './local-model-descriptors.mjs';

// Distinct served weights get distinct picker entries, never an alias substitution.
// The older EZForever variant stays configured and may correctly be unavailable.
// Server-reported model ID (see local-model-descriptors.mjs): a literal, not a path to open.
export const GEMMA_STYLETUNE_ID = '/home/alex/.cache/huggingface/hub/models--mradermacher--Gemma-4-26B-A4B-StyleTune-QK-Heretic-i1-GGUF/snapshots/d131c22eece6cfba43634a97f309ecd25d5affe2/Gemma-4-26B-A4B-StyleTune-QK-Heretic.i1-IQ4_XS.gguf';
export const supportedLocalModels = Object.freeze([...localModels, Object.freeze({
  id: GEMMA_STYLETUNE_ID, name: 'Gemma 4 26B StyleTune (IQ4_XS)', contextWindow: 65536, maxTokens: 32768,
  // Vision admission is not attested for this deployment; don't infer it from the family name.
  input: Object.freeze(['text']), reasoningEfforts: false,
  compat: Object.freeze({ supportsReasoningEffort: false, requiresReasoningContentOnAssistantMessages: false }),
})]);
export const supportedLocalModelPolicies = Object.freeze([...localModelPolicies, Object.freeze({
  provider: 'strata-local', model: GEMMA_STYLETUNE_ID, headroomTokens: 16384, maxTokens: 16384,
})]);
export function assertSupportedLocalAdvertisedModel(requested, advertisedIds) {
  if (!supportedLocalModels.some(model => model.id === requested) || !advertisedIds.includes(requested)) {
    throw new Error('local-model-not-advertised');
  }
}
