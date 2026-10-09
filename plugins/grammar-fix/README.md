# Native grammar fixer for DSH TUI

Behaviour port of the Pi extension `pi-grammar-fix`
(https://github.com/al4xdev/pi-grammar-fix), not of its harness. Only the
correction itself was carried over: no language table, no model picker, no
config file, no spinner. Model, credentials, and provider lookup come from the
DSH `llm` service.

- `Ctrl+G`: correct the draft without submitting it or opening an external editor.
- `Esc` or `Ctrl+C` during correction: cancel and preserve the draft.
- Undo restores the previous text.
- `Ctrl+Shift+G`: open the external editor in terminals that distinguish this shortcut.

Corrections run on the current session model in a separate request with reasoning
disabled and temperature 0. They are not added to the agent conversation history.
The request preserves the original language and leaves technical terms untouched.

This TUI version does not expose a public draft replacement API. `install.mjs`
adapts `PromptInput.js`, the launch screen (`Launchpad.js`), and its wiring in
`Chat.js`, preserving undo and guarding against results from another session.
Original files are backed up alongside them with the `.grammar-fix.bak` suffix.
After updating the TUI, run `node plugins/grammar-fix/install.mjs` from the
repository root. The installer rejects versions whose structure has changed.

`activation.json` scopes this plugin to the `dsh-tui` profile only, because the
bridge is only useful to the TUI draft editor.

Nothing is submitted automatically: review the correction before pressing Enter.
