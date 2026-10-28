# Companion: Reuse TUI Maid in Native Loaders

## Request and Identified Source
The owner requested reusing the maid companion character from the DSH-TUI sidebar in loading responses and app loaders, via GIF or equivalent. Read-only source located: `frontend/dsh-tui/assets/whaleGirl/img/{thinking,typing}/*.png` and `timings.json`. README identifies it as a user-provided GIF package, not official; 301×288 RGBA PNGs preserve alpha and original frame delays. First thinking frame inspected confirms blue-haired maid character.

## Implementation
- Reuse original PNG frames and timings in APK local assets; do not invent animations, download external assets, or alter TUI/HA. Document personal-use origin, do not claim official licensing.
- Create small `MaidLoader` composable with Thinking/Typing moods, stable slot ≈ 56dp, transparent over blue/plum palette with native pixel rendering. Real loading = thinking, real streaming = typing; queued/awaiting may show static/idle state without simulating model execution.
- Load/decode off main thread when needed, bounded dimensions / preloading / cache; bundled PNGs decoupled from `read_image` attachment pipeline. Do not elevate global/media limits or perform external fetching.
- Animate strictly while visible/active and lifecycle RESUMED; reduced motion / zero scale shows static frame; stop clocks upon hiding/dispose. No timer fabricating turn state; ticker solely animates art for already-confirmed state.
- Integrate into real catalog/login loading and Task 70 response line; redundant spinner eliminated, contextual stop retains 48dp target; do not load mascot on every history line or permanent icons.

## Validation
Deterministic tests for frame-at / durations / sampling / dimensions / slot / images, started/stopped lifecycle and reduced motion, synthetic Compose Android 34 snapshots of catalog loading and awaiting/streaming. Full build / lint / protoc / JVM / Compose following integration. No private screenshots / real turns / installation while owner uses app.

## Acceptance Criteria
The same maid appears in loaders and native responses with original timings, alpha, and stable dimensions; animates only real/visible state, static frame under reduced motion, no background clocks. Origin and bounded resource consumption documented, APK 4 / evidence integrated. Continues in parallel with Task 70 UI and Task 72r2 native workspace-write sandbox / approved Bash; no commit/push.
