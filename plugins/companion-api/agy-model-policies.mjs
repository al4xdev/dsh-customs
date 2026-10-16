// Companion-only correction from reviewed AGY descriptors; not vendor capacity proof.
// Scope compaction only. Do not use these identities to filter the native catalog.
export const reviewedAGYModelPolicies = Object.freeze([
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
  'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
  'gemini-3.5-flash-high', 'gemini-3.5-flash-medium', 'gemini-3.5-flash-low',
  'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
  'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
].map(model => Object.freeze({ provider: 'google-antigravity', model,
  headroomTokens: 16384, maxTokens: 16384, thresholdRatio: 0.8, retainRatio: 0.16 })));
