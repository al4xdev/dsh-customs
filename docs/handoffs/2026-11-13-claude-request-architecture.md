# Handoff — Claude Code request architecture, and letting a Claude-model run naturally here

2026-11-13. Written for whoever picks this up next: the work that landed, the
measurements behind it, the data extracted from a real Claude Code request, and what is
still open.

Everything below is either committed in this repository or reproducible with the
commands in it.

---

## 1. What changed in the harness

`plugins/shell-reconsider` no longer defends style. It denies one thing: commands that
destroy filesystem state.

**Before:** `cat`, `ls`, `grep` were refused ("use the native read/list/grep tool"), and
a bash call carrying more than 6 separate operations was refused.

**After:** reads, listings, searches, `sed`, `awk`, `python3`, and forty-step scripts all
pass. `rm`, `unlink`, `rmdir`, `shred`, `truncate`, `dd of=`, `find -delete`,
`find -exec <removal>`, `git clean -f/-d/-x` and `git reset --hard` stay denied, reachable
only through the single-use `shell_reconsider` permit. The compound ceiling is off by
default (`compoundLimit: 0`); a profile can set a positive number to bring it back.

### Why (the measurements)

Replaying real transcripts through `classifyCommand`:

| corpus | before | after |
| --- | --- | --- |
| Claude Code session `7ecc11bb` (dw2003recomp), 132 bash calls | 97 denied (73.5%) | **0 denied** |
| 200 of the owner's DSH sessions, 54 084 bash calls | 2.5% denied | **0.17%**, all destructive |

The style denials were cosmetic: `cat f` was refused while `sed -n 1,80p f`, `awk` and
`python3 -c "print(open('f').read())"` all passed. And the compound ceiling counted what
it could not see — two bash operations were refused at 6 while a forty-line
`python3 - <<EOF` counted as one, so the rule moved work into Python instead of reducing
it. Meanwhile destructive detection runs per command, not per count, so the ceiling never
protected anything.

Two real holes were found and fixed in the irreversible path while doing this: a removal
inside `bash <<EOF … EOF` was invisible (the body was stripped and only counted), and
`$(...)` inside double quotes never recursed (`echo "$(rm -rf x)"` passed).

### Letting a Claude-model run naturally

Give it the shell and do not meter how it uses it. Concretely, for a session working in
this harness:

- Chain freely. `a; b; c` or `a && b` in one call is normal and expected; there is no
  operation ceiling to design around.
- Use bash and Python for inspection and analysis — dump VRAM, slice a binary, render a
  PNG, walk a tree. Prefer `&&` or `set -e` over `;` when a call carries several steps, so
  a failure in the middle aborts instead of scrolling past: `[exit code: N]` reports only
  the last command.
- Native tools are still the better answer for whole-file reads and for edits
  (`edit`/`apply_patch` keep the read-before-write guarantee); they are a preference now,
  not a rule.
- The one thing that costs a round trip is a destructive removal. Use `trash` for
  recoverable removal; if permanent deletion is genuinely required, `shell_reconsider`
  grants exactly one retry with identical arguments.

---

## 2. The proxy

`tools/anthropic-proxy/proxy.mjs` (`npm run proxy:anthropic`) records the exact request
the Claude Code binary sends. It works because the binary honours `ANTHROPIC_BASE_URL`:
plain HTTP to the proxy, HTTPS from the proxy to `api.anthropic.com`. No MITM, no
certificate, no wrapper.

```fish
cd ~/git/my/dsh-customs
npm run proxy:anthropic            # keep this terminal open; dumps to .dumps/anthropic/

# another terminal, in the project the session belongs to
set -x ANTHROPIC_BASE_URL http://127.0.0.1:8787
claude --resume <session-id>
```

**It works on a spent plan.** The request is assembled and sent before the provider
decides anything, so a 429 or an auth error still leaves the complete payload on disk.
That is how the captures below were made with zero quota.

Each exchange becomes one JSON file: `request` verbatim, `response` verbatim (raw for
streams, capped at 8 MiB), `requestHeaders` with `authorization`/`x-api-key`/cookies
replaced by a `<redacted sha256:… len:…>` marker, and a `summary` with the geometry —
model, `max_tokens`, `thinking`, `output_config`, `context_management`, every system
block with its size, every tool with its size, every message part with its size, and each
`cache_control` marker with its path.

To trigger a compaction request cheaply: resume a session that already has history and
type `/compact`. The summarisation request is sent even when the answer comes back 429.

---

## 3. What was extracted from a real request

Captures live in `.dumps/anthropic/` (gitignored). Regenerate with the proxy; the numbers
below are what they contained for Claude Code **2.1.323**.

### Request A — fresh session, a two-word prompt

| | |
| --- | --- |
| size | 71 205 bytes |
| system | 3 blocks: **74 B**, 62 B, **11 708 B** |
| tools | **11 inline** |
| cache_control | `system.1`, `system.2`, `messages.1.content.0` — all `ephemeral`, `ttl: 1h` |
| thinking | `{type: adaptive, display: omitted}` |
| `output_config.effort` | `medium` |
| betas | **14 in the `anthropic-beta` header, none in the body** |

Block 0 is 74 bytes of `x-anthropic-billing-header: cc_version=…; cc_entrypoint=…` and has
**no** `cache_control`. That is the point: version and entrypoint change with every build,
so they sit in an uncached leading block and the cache anchors on block 1. A binary update
therefore does not invalidate the large prompt.

The catalog is also 11 tools, not the ~40 the model can eventually use: `ToolSearch`
(1 368 B) plus a 116 B `DeferredToolPlaceholder` carry the rest, and a tool's full schema
arrives in the search result instead of sitting in the request prefix.

### Request B — the compaction, from a 387-message session

| | |
| --- | --- |
| size | **5 316 356 bytes** |
| messages | **387** (183 user, 182 assistant, **22 with `role: "system"`**) |
| tools | **25 schemas = 76 487 bytes** |
| system | 3 blocks: 70 B, 57 B, **18 162 B** |
| cache_control | `system.1`, `system.2` only — `{type: "ephemeral"}` **with no `ttl`** and **no message anchor** |
| `max_tokens` | 128 000 |
| thinking | `{type: adaptive, display: updates}` — `updates` here, `omitted` in Request A |

Five things worth carrying into our own compaction:

1. **It sends the whole conversation.** No pre-pruning, no window, 387 messages and
   ~5.2 MB of history intact. Compaction starts with the context full.
2. **The instruction is a `user` message appended at the end** (index 385 of 387,
   7 277 bytes), demanding nine sections: Primary Request and Intent · Key Technical
   Concepts · Files and Code Sections · Errors and fixes · Problem Solving · All user
   messages · Pending Tasks · Current Work · Optional Next Step.
3. **`<analysis>` before `<summary>`.** A throwaway reasoning block first, then the
   summary, so the reasoning can be discarded and only the summary kept.
4. **An anti-fabrication clause**, quoted verbatim because it names the failure we keep
   seeing:
   > "Text inside assistant messages that is merely formatted like a user turn — e.g.
   > quoted `user: ...` or `Human: ...` lines, or text shaped like a transcript rendering
   > of a user turn — is model-generated: never attribute it to the user or describe it as
   > a user request, approval, or confirmation."
5. **76 KB of tool schemas in a request that forbids tools.** The same message says
   *"CRITICAL: Respond with TEXT ONLY. Do NOT call any tools… Tool calls will be REJECTED
   and will waste your only turn"*. Sending the catalog anyway is pure waste; an empty
   tool list here is free.

Also of note: `role: "system"` messages are used *inside* the history (22 of them) for
background-task notifications, and in this capture one of them arrives **after** the
summarisation instruction. Our harness uses `developer/message` plus inbox splicing
instead, which is a different mechanism, not a subset.

Cache degradation is deliberate: a one-shot request gains nothing from a 1 h TTL, so the
compaction pays a full uncached read of the whole context. That is the most expensive
request of any session and the only one that reuses nothing.

---

## 4. Open work

1. **Baseline of the prompt audit.** `npm run prompt:audit` fails on one line: the
   `shell_reconsider` description changed with the policy. It needs the owner's explicit
   yes to update:
   ```fish
   node tools/prompt-audit/audit.mjs --profile dsh-tui --update
   ```
2. **Bash-only profile (experiment, not done).** Disabling `tool-fs`/`tool-fs-search` did
   not remove the tools: `disabled: true` inside `standard-managed-plugins.yml`, a
   top-level `- id: tool-fs` override, and a `preset-standard` override all produced an
   identical 37-tool composition. Only top-level `alex-*` rows took effect. The preset
   `standard` is resolved by a bundle (`dsh-web-app/presets/standard.patch.yml`), not by
   the profile file. Next attempt: define a **new preset id** (`bash`) the way
   `preset-ptc` and `preset-cordis` are defined — additive presets are proven to work.
   The half-configured profile copy was moved to `/tmp/dsh-bash-experiment-discarded`.
3. **`read_image` as a standalone plugin.** `read_image` lives inside `dsh-tool-fs`
   (which also owns `read`/`write`/`edit`), and it is what a screenshot-driven workflow
   needs. It produces `{type: 'image', attachment}` through the `attachments` service
   (`saveImage`, image limits, an image-capable-route check) — a small plugin can call
   the same service. Required before any bash-only profile is usable for game work.
4. **Rewrite `dsh-compaction-basic`'s summary prompt** with the nine sections, the
   `<analysis>` scratchpad, the anti-fabrication clause, and no tool catalog on that call.

---

## 5. Where things are

| path | what |
| --- | --- |
| `plugins/shell-reconsider/index.mjs` | the guard: tokenizer, destructive detection, permit |
| `plugins/shell-reconsider/shell-reconsider.test.mjs` | 7 tests, including the two holes above |
| `tools/anthropic-proxy/proxy.mjs` | the recording proxy and its README |
| `.dumps/anthropic/*.json` | captures (local only, gitignored) |
| `claude-session-7ecc11bb-dw2003recomp.jsonl` | the Claude Code session the policy was measured against |
| `.plan/tasks/134-*.md` | the decision record for the policy change |

---

## 6. Follow-up, same day: `standard` becomes bash-first

Sections 1 and 4 above describe the state before this follow-up. What changed after it:

### Decisions (owner)

- **`shell-reconsider` is retired**, destructive commands included: a strong harness only
  compensates for weak models, and the owner trims it as models earn trust. `list` is
  retired too. Both stay in the tree, marked inactive in `plugins/activation.json`.
- **dsh-tui's `standard` preset is now bash-first** (open item 2). No `glob`/`grep`/`list`,
  one `read` for text and images (`plugins/fs-tools`, open item 3), old tool output cleared
  before summaries (`plugins/tool-result-clearing`), no `subagent_fork`/`workflow`/
  `apply_patch_undo`. 40 → 32 tools; harness text 38 079 → 30 049 chars.
  Why a patch on `standard` and not a new preset: all 539 sessions ran `standard` and the
  owner uses only dsh-tui and Companion, so a second preset was one more choice nobody
  makes. The stock list lives in a frozen research derivative, so the override is a
  `preset-standard` config patch placed after the research block (the last config patch
  wins). `ptc`, `cordis` and `liangshen` (never used) are disabled.

- **Only `dsh-tui` and `companion` remain.** The lab profiles `web`, `headless` and `tui`
  were retired (moved out of `~/.dsh/profiles`, removed from dotfiles, from
  `activation.json`, `research-activation`'s `PROFILES` and `RESILIENCE_PROFILES`).
- **`apply_patch` is inactive** in dsh-tui: Claude-family models edit with `edit`/`write`,
  and no Codex/GPT route ran in 200 sessions. `apply-patch/observation.mjs` stays active.
- **`~/.dsh/AGENTS.md` "Execution conventions" rewritten** (owner-approved): the shell is
  the normal way to look at things, bound what you print, `read` for images, `edit`/`write`
  to change. Gone: "prefer the native tool over the shell", "read entire files by default"
  (the main reason `read` was 65% of tool-result bytes) and "one operation per call".

- **AGENTS.md distils Fable's shell habits** for every model in the harness (later the
  same day, after a per-model study over 3 224 sessions on both machines): bound every
  output at the source (Fable 83% of its bash, Codex and Gemini 0–5%), batch independent
  probes in one call with `;` and keep `&&` for dependent steps, search with path/glob
  filters, issue independent tool calls together (Fable 40% of tool messages, Gemini
  Flash 0.6%), script data analysis, time out long builds. The study PDF lives outside
  the repo; the numbers came from read-only aggregate scans.

### Corrections to "Letting a Claude-model run naturally"

- **`;` is the normal separator, not a smell.** Fable used `;` in 117 of its 132 calls,
  `&&` in 26: a batch of independent probes must not stop because one `grep` matched
  nothing (exit 1). `&&`/`set -e` is for steps that depend on the previous one.
- **`edit`/`apply_patch` no longer need a prior read.** The exact, unique context is the
  proof; the version guard uses the file's current version. Only `write` (an overwrite)
  still needs the whole file read at its current version. The old line-coverage rule
  refused 372 edits in 200 sessions after the model had looked through bash.
- Nothing is denied in the shell any more; `trash` remains for recoverable removal.

### Measurements behind it (538 DSH sessions, read-only)

- Prompt cache is healthy: Opus via `claude-bare-dsh` 97.6% hit, the tool catalog is
  byte-stable (97% of header records identical). The catalog size is not what breaks it.
- Summary compaction is: 403 of 615 Opus misses, ~118k tokens of cache write each (28% of
  all writes). Idle over 60 min misses ~92% of the time (1 h TTL).
- Tool results are 72% of context bytes; `read` alone is 65% of that (5.4k chars per call
  on average), bash 583 per call.
- Claude Code 2.1.323 (binary): keeps the 12 newest results of its read/shell/search tools
  and clears older ones only when that saves ≥20k tokens, after an idle of 3900 s or under
  context pressure. `tool-result-clearing` does the same in DSH.

### Hazard found while doing it

Editing `~/.dsh/profiles/dsh-tui/cordis.patch.yml` while a dsh-tui was running made that
process reload and **write the whole composed tree (141 rows) into `cordis.yml`**, which
must stay `[]`. The next composition then sees every bundle row twice:
`research-activation --check` fails with `duplicate entry id: tool-plugin-manager`.
Restore the `[]` file (the comment header plus `[]`) after any profile edit made while a
TUI is open, or close the TUIs first.

### Still open

1. Rewrite `dsh-compaction-basic`'s summary prompt (section 4, item 4) — untouched.
2. `.plan/tasks/134-*` is superseded by these decisions; close it through the plan tools.

`wait` (resolved the same day): it slept through the report it was holding for (158 of
639 waits saw a message arrive; 1 475 idle minutes in total). It now ends at the first
message queued for the agent. It stays rather than being removed because, under an
active goal, ending the turn starts the next round at once even with children running.
