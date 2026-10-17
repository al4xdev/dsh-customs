# Companion: Minimalist UX Following Owner Real Testing

## Request and Context
The owner confirmed successful login on APK 0.3 and tested real turns. Tailscale was initially off on the phone; after reconnecting, login succeeded. Active goal and tasks 67/68 preserve rendering, ownership, UNKNOWN, and admitted images. Do not interrupt or capture private conversations while he is testing.

## Requested Changes
1. Remove permanent button "Cancel turn (keep queue)". Show a minimalist stop button only inline with the response actually waiting/streaming; use existing cancellation, with a latch for one explicit request per turn and without retry. Retain UNKNOWN/SENDING and queue exactly matching current contracts.
2. Sent message appears with subtle animation; create response indicator upon real admission and display deltas/tokens from existing stream, without inventing completion, echoing prompt, or simulating text. Prefer public projections/events for turn state. Immediate reduced motion / zero scale, stable keys and anchors.
3. Remove permanent "Copy text" button and "View recorded usage". Copying moved to native context menu via long-press / text selection. Code/JSON must also maintain safe copy option without redundant buttons where applicable.
4. Replace "Expand tool" with a discreet icon featuring accessible contentDescription and expanded state; preserve RAM folds and content limits.
5. Chat screen with back arrow, compact title, and no New/Logout. Those actions belong to the catalog.
6. Catalog without duplicated header/bar and without "Refresh conversations" button; refresh via pull-to-refresh at the top. Single title section, + icon to create, and compact exit, maintaining 48dp hit targets without altering credentials/callbacks.

## Execution and Responsibilities
- Investigate public agent/assistant state and reducer before adding indicator/stop; do not use generic catalog busy state as "model thinking". Introduce testable presentation models only if necessary, with generation/selection in state and cancel-once latch.
- Rich render / context menu / folds in dedicated files; screen / catalog / composer in separate files to enable independent work.
- Update synthetic fixtures and assertions for icons / contentDescription, context menu, absence of redundant controls, pull-to-refresh, streaming, stop-once, and UNKNOWN protection. No real PC actions for testing.
- Compile JVM / protocol / strict lint / APK / test APK; validate on dedicated Android 34 emulator. Capture only fixture UI. Increment versionCode to 4 / versionName to 0.4.0-refined to distinguish update.
- Physical update only after verified safe state or owner confirmation: he is currently testing real turns, so no force-stop / instrumentation / installation over app in use. Preserve UID 10318, signature, and vault; Work 10 profile intact.

## Acceptance Criteria
Minimalist UI matching request, existing real streaming without duplication, contextual stop available only when there is an active/waiting response confirmed and protected against double-tap/retry. History, explicit approvals, parser/media bounds, ownership, and UNKNOWN remain intact. Tests/lint passing and synthetic captures inspected. Safe delivery/installation and return to real Main when authorized, with honest limits and evidence.

## Out of Scope
No HA deploy, Tailscale / DNS / publication / services / profiles / TTL / SDK changes, takeover of writers, real test model/grant, private screen capture, persistence/replay of intents, commit, or push.
