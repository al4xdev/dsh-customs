# Google Search in Antigravity Fork with Flash low

## Request
Add search to the existing plugin using its OAuth and `gemini-3.8-flash-low`.

## Implementation
1. Check fork state and run a controlled probe against the Cloud Code Assist endpoint with native Google Search, without exposing tokens or altering the profile.
2. Add an opt-in `ctx.web` provider to the fork that reuses the credential manager, configures the requested model, requests `googleSearch`, and normalizes text and sources from `groundingMetadata`.
3. Implement tests for payload, OAuth, cancellation, errors, SSE, and metadata, rejecting text without search evidence. Document options and build.
4. Run tests/build and a real probe through the provider. Enable in the dsh-tui profile while keeping web_fetch and disabling only DeepSeek search strictly if real search is proven. If the backend does not support it, deliver tested opt-in code without enabling, reporting the concrete limitation.

## Security and validation
Do not silently switch models, do not treat an in-memory response as a search, do not log credentials, limit timeouts/volume, and do not modify installed DSH dependencies. Use a goal to track until completion and record real evidence.
