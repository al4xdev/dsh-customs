# Performance collection during real usage

Direct request: start ADB FPS/performance logging while the owner uses Companion, to identify bottlenecks and address them afterward.

- Verify authorized phone and Companion process, without reading interface/conversations.
- Start a bounded collection of approximately 120s of package `gfxinfo framestats` and rendering counters in the background; collect only numeric metrics / known categories, without raw logcat, screen capture, UI hierarchy, messages, or payloads. Reset only gfxinfo counters at start, never process/data.
- Deduplicate circular buffer frames, preserve deadline/vsync/CPU/GPU when exposed; sample with low overhead and record limitations. Real usage and variable refresh rates do not permit dividing frames by capture duration and calling it FPS.
- Save sanitized results under `.dumps/tasks`, analyze percentiles/jank and UI/render/GPU indicators, without claiming unverified exact root causes. If needed, propose a subsequent specific Perfetto trace, do not collect broad traces or private data automatically.
- Do not restart/force-stop app/backend/model, do not execute taps/sends/grants or install builds during capture. Code fixes remain deferred to a later phase per request.
