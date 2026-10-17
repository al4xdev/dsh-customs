# Simple Grammar: Fixes and Regression Across Three Providers

## Objective
Review the grammar-fix plugin, preserve existing changes, and maintain a small implementation, with reproducible tests on GPT, Gemini Flash, and local model. Use active goal to guide execution through verification.

## Scope
- Fix language configuration: `auto` preserves the original and supported codes turn into unambiguous names in the prompt.
- Accept model IDs with internal slashes (common in local models), keeping `provider/model` format.
- Ensure cancellation on plugin disposal, cleanup of listeners/busy, and rejection of empty, incomplete, or errored streams; remove dead code.
- Keep reasoning fallback strictly limited to the specific incompatible effort error, without adding generic retry or altering visual integration.
- Add deterministic bridge tests and an opt-in real routine that uses LLM service and credentials from installed profile, without copying secrets, altering default route, or sending private content.
- Test Portuguese, English/auto, and preservation of technical tokens across the three available models; save temporary reports in `.dumps/` and document commands and limitations.

## Criteria
Unit tests passing, cancellation allowing subsequent correction, no partial results applied, and three real routes with verifiable results. If provider is unavailable, record the failure without claiming approval. Do not implement visual redesign of plan 15 in this task or close that plan. No commit/push.
