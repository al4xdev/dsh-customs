# Plan 3 — clipboard_copy tool

## Objective

Add a machine-local `clipboard_copy` tool that accepts text and places it on Alex's Wayland clipboard. Hide clipboard plumbing from model context. Implementation was subsequently authorized and delivered as a local plugin; the parent reproduced a real clipboard round trip through the separate DSH instance. Persistent activation in web/headless/tui/dsh-tui and AGENTS.md migration are implemented; clipboard plumbing is hidden and proactive copying remains instructed. See `plugins/README.md`.

## Contract

- Input: `text`, a string copied verbatim, including Unicode and newlines.
- Resolve the local Wayland session and invoke wl-copy internally, without shell interpolation of user text.
- Return a concise English success or actionable error message. Never report success when copying failed.
- Define empty-string behavior explicitly, preferably clearing the clipboard.
- Do not echo clipboard contents in the response or add unnecessary sensitive-content logging.
- Handle wl-copy's clipboard-serving process lifecycle without leaving the tool call waiting indefinitely; confirm clipboard availability after the tool returns.
- Clipboard reading is outside this plan.

## Integration

- Create a separate tool using the harness extension/profile mechanism; preserve standard tools.
- Keep the instruction to proactively copy paste-ready output in AGENTS.md, referencing `clipboard_copy`.
- Remove redundant Wayland variables, utility listings and clipboard shell recipes from model context/AGENTS.md only once the tool works (coordinate with Plan 2).
- Target this machine; do not build a cross-platform clipboard abstraction.

## Future steps and validation

1. Inspect harness extension registration and the actual local Wayland setup.
2. Implement text transfer via stdin, with bounded execution and clear failures.
3. Test Unicode, multiline text, quotes, shell-looking text, empty input, unavailable session and missing executable.
4. Verify pasted content matches exactly and survives return from the call.
5. Activate in the intended profile and update redundant instructions.

## Completion criteria

A fresh session can copy using one tool call, without knowing Wayland details. Failures are explicit, text is unchanged, and the proactive-copy behavior remains instructed.
