# Companion: discovery of real sessions and open-writer evidence

## Updated objective
Validate the concept before porting to Kotlin/Compose/Material 3 exclusively Android 14 / API 34. No new animation refinements. Fix discovery/listing and diagnostics for sessions the user sees open in terminals/TUI.

## Investigate and implement
1. Compare without private payloads the public root/encoding of companion and TUI persistence, the filters/ordering/pagination of the `session` tool, and active bridges. Identify the real cause of missing sessions; do not infer profiles are isolated by name alone.
2. Inspect the native origin of the TUI `held by pid` label and available read APIs. Add read-only evidence of open writer/lock when verifiable, distinct from live agent, waiting, history, and send capability. Never test via open(write), acquire/take over locks, or convert/re-record logs.
3. Fix listing/filters/pagination and context returned to the LLM according to diagnosis; preserve companion restricted API, bounded previews, no auto-approval. Blocked sessions without controllable bridge do not receive `send=true`; native allowed-once remains mandatory and unknown result is never automatically repeated.
4. Test cross-profile, sessions held by other PIDs, stale locks / PID reuse, idle sessions, pages beyond limit, and absent bridge. Compare expected IDs with runtime data without printing history/credentials. Modify only custom files; do not edit installed DSH runtime or restart user terminals.
5. If updating the companion backend is necessary, validate tests beforehand and restart only its dedicated service, explaining effect on connections; preserve Web 443/3080, TUI, and published frontend 8443/3082. Document concrete limitations and proofs.

## Out of scope
Kotlin port in this phase, new animations, writer takeover, policy/profile/model changes, test calls/messages to real sessions, confirmation auto-answer, commit/push.

## Acceptance
Tool lists relevant sessions with pagination and clear evidence. `open writer` is not confused with `accessible agent` or `frozen`; dispatch uses only confirmed agent/bridge following human approval. Regressions pass and existing publication/concept remain healthy.
