# Native grammar fixer for DSH TUI

Behaviour port of the Pi extension `pi-grammar-fix`
(https://github.com/al4xdev/pi-grammar-fix), not of its harness. The DSH TUI
adds a local animated proofreading trail while the request runs; credentials
and provider lookup come from the DSH `llm` service.

- `Ctrl+G`: correct the draft without submitting it or opening an external editor.
- `Esc` or `Ctrl+C` during correction: cancel and preserve the draft.
- Undo restores the previous text.
- `Ctrl+Shift+G`: open the external editor in terminals that distinguish this shortcut.

The `alex-grammar-fix` entry in `plugins/activation.json` pins
`google-antigravity/gemini-3.8-flash-low` and `Brazilian Portuguese (pt-BR)`.
Change `config.model` to another `provider/model-id` or `config.language` to a
language name or code (`pt`, `pt-BR`, `pt-PT`, `en`, etc.) to choose another
route or output language. Model IDs may contain `/`, for example
`llamacpp-local/org/model`. The settings are part
of the native per-plugin Cordis configuration, not runtime preferences. If
`language` is unset or `auto`, the model preserves the draft's original language. The
separate request uses minimal reasoning (preferring off, falling back to low or
the model default when unsupported) and default temperature. It is not added to
the agent conversation history. Technical terms remain untouched.

This TUI version does not expose a public draft replacement API. `install.mjs`
adapts `PromptInput.js`, the launch screen (`Launchpad.js`), and its wiring in
`Chat.js`, preserving undo and guarding against results from another session.
Original files are backed up alongside them with the `.grammar-fix.bak` suffix.
After updating the TUI, run `node plugins/grammar-fix/install.mjs` from the
repository root. The installer rejects versions whose structure has changed.

`activation.json` scopes this plugin to the `dsh-tui` profile only, because the
bridge is only useful to the TUI draft editor.

Nothing is submitted automatically: review the correction before pressing Enter.

## Regression routine

From the repository root:

```fish
npm run test:grammar
npm run test:grammar:live
```

The first command is deterministic and uses no credentials or network. It checks
configuration, supported reasoning fallback, incomplete/error responses, busy,
cancellation, timeout, and plugin disposal. The live command is opt-in: it makes
nine live fixtures (three per provider), using installed DSH modules and existing
credentials. Reasoning-effort fallback may issue additional model requests, and
local-model discovery also calls the server's models endpoint. Nine fixtures are
not a nine-request budget. OAuth refresh may update the normal DSH credential store.
If the modern Codex record is absent, the runner reads the existing OAuth from
`<DSH_HOME>/dsh-auth/credentials.json` into memory only. This compatibility path
never migrates, refreshes, or writes the GPT grant. It rejects expired credentials
or grants within five minutes of expiry (`LEGACY_CODEX_EXPIRED`); refresh those
through your normal DSH login before rerunning. Existing modern records win.
It does not submit a draft or add anything to the agent conversation.

Default routes:
- GPT: `openai-codex/gpt-6-sol` (available in the installed Codex catalog).
  The session's `gpt-6.1-sol` alias is not assumed to be accepted by that provider.
- Gemini Flash: `google-antigravity/gemini-3.8-flash-low`.
- Local: the single model currently advertised by `http://127.0.0.1:8080/v1/models`,
  via `llamacpp-local`. Start your existing server before testing; the runner
  never starts or reconfigures it.

Override with fish-compatible environment assignments:

```fish
env GRAMMAR_GPT_MODEL=openai-codex/gpt-6-sol GRAMMAR_GEMINI_MODEL=google-antigravity/gemini-3.8-flash-low GRAMMAR_LOCAL_MODEL=llamacpp-local/Ternary-Bonsai-2-27B-PQ2_0 npm run test:grammar:live
```

`DSH_HOME`, `GRAMMAR_PROFILE` (default `dsh-tui`), and `LLAMACPP_BASE_URL` can
also be overridden. The chosen profile must resolve the three provider plugins.
This small runner supports the existing Codex OAuth GPT route; it is not a generic
provider configuration loader. Models containing `/` retain their complete ID.

Acceptance: all nine checks pass. Fixtures require correction of simple Portuguese
and English errors, preservation of English under `auto`, and unchanged commands,
paths, URLs, quoted identifiers, and line structure. Checks deliberately use strict
expected text; inspect failed fixture outputs rather than silently accepting a
provider that responds but does not obey the grammar contract. This is a smoke
matrix, not a guarantee of correction quality for every possible draft.

Reports with synthetic input/output are saved under gitignored `.dumps/grammar/`;
no credentials or raw provider errors are recorded. Any setup, transport, or
quality failure makes the command exit nonzero. The default plugin route remains
unchanged. Restart DSH to reload changes to the plugin module.

### Verified matrix (2026-10-12)

- 22 deterministic tests plus the existing configuration check: passed.
- GPT `gpt-6-sol`: 3/3 live fixtures passed.
- Gemini Flash `gemini-3.8-flash-low`: 3/3 live fixtures passed.
- Local `Ternary-Bonsai-2-27B-PQ2_0`: 3/3 live fixtures passed.
- Evidence: `.dumps/grammar/1791822669083.json` (local only).

The local template rejects `off` as HTTP 500 with a specific reasoning-effort
mismatch. The bridge recognizes that message and retries `low`; arbitrary server
errors still fail immediately. The Portuguese fixture uses an explicit count
(`Os dois…`) to avoid accepting a correction that silently changes plurality.
