# handoff

State of the harness as of 2026-11-13, for whoever picks this up next. The long
version of the Claude Code analysis is in
`docs/handoffs/2026-11-13-claude-request-architecture.md`; this file is the index.

## Where things stand

| area | state |
| --- | --- |
| Shell policy | Open. `shell-reconsider` retired — nothing is denied in the shell any more. |
| Tool surface | `standard` is bash-first: `read` (text and images, `plugins/fs-tools`), `write`, `edit`, bash. No `glob`, `grep`, `list`, `read_image`, `apply_patch`, `subagent_fork`, `workflow`. 31 tools. |
| Context | `plugins/tool-result-clearing` replaces the stock pruner: old tool output leaves the prompt before any summary. |
| Presets | Only `standard`. `ptc`, `cordis` and `liangshen` are gone from the profile, not just disabled. |
| Echo checks | `npm run prompt:audit` → both profiles OK. `npm run research:check` → no drift. `npm run test:research` → 98 pass. |

## What changed today, and why it matters later

1. **The guard went from style to safety, then went away.** It used to deny `cat`/`ls`/`grep`
   and calls carrying more than six operations. Those were cosmetic (`sed`/`awk`/`python`
   passed) and the ceiling counted what it could not see, so it moved work into Python
   instead of reducing it. Measured: 73.5% of the reference Claude Code session would have
   been denied. The owner then retired the plugin wholesale — a strong harness only
   compensates for weak models.
2. **`research-activation` was refilling the profile.** It declared `standard`, `ptc`,
   `cordis` and `liangshen` for `dsh-tui` on every run, so deleting the ghost presets by
   hand was undone by the next `npm run research:activate`, and the pair of presets it
   re-created produced `duplicate entry id: tool-plugin-manager`. It now declares only
   `standard`.
3. **The `preset-standard` row inside `- insert:` is what defines the preset.** A top-level
   `- id: preset-standard` only patches it. Delete the insert and the composition dies with
   `Unknown agent preset: standard`.
4. **`cordis.yml` is generated.** It briefly grew to the full 700-line resolved composition
   and then normalised back to `[]` on its own; leave it alone and keep it `[]`.

## Tools you will want

```fish
npm run proxy:anthropic    # records the exact Anthropic request; works on a spent plan
npm run prompt:audit       # composes both profiles offline; baseline diff needs an explicit OK
npm run research:check     # research activation drift
npm run test:lts:contracts # plugin contracts
```

The proxy needs `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` in the environment of the
client. Captures land in `.dumps/anthropic/` with credentials redacted.

## Open

- The summarisation prompt of `dsh-compaction-basic` has not been rewritten yet. The
  Claude Code compaction request is captured and analysed: nine required sections, an
  `<analysis>` scratchpad, and an anti-fabrication clause about never reading
  assistant-authored text as user approval. `docs/handoffs/` has the details.
- `AGENTS.md` (the owner's, in dotfiles) now says the shell is the normal way to look at
  things. Anything here that still implies the native tools are mandatory is stale.
- The dotfiles repository is the home directory itself (`git -C ~/git/my/dotfiles`,
  root `/home/alex`, branch `root`); pathspecs need `:/.path` form from outside it.
