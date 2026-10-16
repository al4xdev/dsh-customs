# AGENTS.md — dsh-customs

## Prompt audit: run it after every harness change

After updating DSH, the TUI fork, any other fork, plugins or presets, after a profile
change, or after reinstalling the runtime (`tools/clean-install/host.mjs`, `install.mjs`),
run:

```sh
npm run prompt:audit
```

It composes, offline (no network, credentials or model calls), the first model request
of a fresh `dsh-tui` and `companion` session and checks the harness text against
`tools/prompt-audit/baseline/<profile>.txt`. Then:

- **Denylist hit** (`DENYLISTED "<phrase>" in <place>`) is a regression. Fix it at its
  source; the output names the place and the known fix:
  - `playful`, `[Status line]`: profile row `working-activity`, config `narrate: false`
    (restate `publish` and `publishIntervalMs`: a config patch replaces the whole block).
  - `powered by DeepSeek Harness`, `You are an AI agent`: profile row `system-prompt`,
    `includeHarnessIdentity: false`.
  - `coding agent powered by`, `You are a coding agent`: every preset `persona` row
    `prefix: ''`, and `system-prompt` `personaPrefix: ''`.
  - `Use them as guidance`, `do not override system, developer`: reapply the hash-guarded
    SDK patch, `node tools/clean-install/agent-instructions.mjs --apply ~/.local/share/dsh-cli`
    (a new SDK build needs newly reviewed hashes in that file).

  Profiles in `~/.dsh/profiles/` belong to the owner's dotfiles: propose the profile
  change to the owner instead of editing it unasked.
- **Baseline diff** means the model now receives different harness text. Review the diff
  line by line and tell the owner what changed and where it comes from. Accept it with
  `node tools/prompt-audit/audit.mjs --profile <name> --update` only after the owner
  explicitly says yes, and commit the baseline together with the change that caused it.
  The current text is in `.dumps/prompt-audit/<profile>.current.txt`; `--full` adds raw
  tool schemas there for local review. Owner files are reduced to `<instructions: <path>>`
  and `<owner skills: <root>>` placeholders, so editing them never moves the baseline; a
  diff confined to those lines means an owner file or skill root was added or removed:
  say that, and still let the owner accept it.
- **Never** make the audit pass by weakening the denylist, adding a normalization that
  hides a real change, or updating a baseline without that OK. `npm run test:prompt-audit`
  tests the tool itself.
- **Never** audit by booting or dumping a real profile, including
  `dsh --profile <name> --dump-config`: dsh rewrites the profile's `cordis.yml` and
  live-reloading profiles (the lab Companion, running TUIs) react. Companion then shows
  "Estado do serviço desatualizado" until its service restarts. The audit boots a copy
  under `/tmp`.
- The `companion` profile names lab-only `/home/alex/...` paths. On a machine without
  them (the audit prints a note), its composition lacks the Companion instructions file
  and workspace skills, so a companion diff there or on the lab can be a machine
  difference: say so to the owner rather than updating the baseline.
