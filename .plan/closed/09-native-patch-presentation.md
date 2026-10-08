# Native apply_patch presentation

The owner asked for the TUI patch display to look like native write instead of a raw recovery-receipt JSON block.

Inspection confirmed that @deepseek-ai/dsh-tool-fs uses supported output.presentationMeta, presentCall and presentResult hooks to return card: diff with path/oldText/newText entries. The apply_patch plugin currently registers only stringOutput, so it does not supply that presentation contract.

Next scoped change: implement these native hooks for apply_patch (and a compact undo summary), retain full recovery receipt semantics for the model/recovery, and render only confirmed changes as applied diffs. Show partial/uncertain outcomes explicitly; do not label a proposed patch as successfully applied. Persist presentation metadata for replay where supported. Do not modify installed core or fork the TUI renderer. Validate with one actual harness/TUI operation, without new mock suites or local-model calls.

Status: done and owner-validated in the TUI. Implementation in `plugins/apply-patch/presentation.mjs` + `index.mjs` (presentCall/presentResult/presentationMeta for both tools, compact undo summary, partial/uncertain never shown as applied diffs, receipt text unchanged for the model, no core/TUI changes). Evidence: a real `apply_patch` Add through the running TUI rendered the native card `Applied patch · 1 file (1 added)` with `+` diff lines instead of receipt JSON.
