# DSH Custom Plugins

This directory contains modular extensions for the DeepSeek Harness (DSH) runtime. Plugins are activated into profiles via `activation.json` and `tools/activate.mjs`.

## Plugin Dependency & Coupling Matrix

| Plugin | Category | External Prerequisites | TUI / Companion Required? | Description |
| --- | --- | --- | --- | --- |
| **`apply-patch`** | Standalone | None | No (TUI renders diff card if present) | Multi-file patch tool implementing Codex diff format. |
| **`workspace-context`**| Standalone | Git | No | Injects verified workspace paths and git root to prompt. |
| **`clipboard`** | Standalone | `wl-copy` / `xclip` / pbcopy | No | Verification and access for desktop system clipboard. |
| **`trash`** | Standalone | None | No | Safe recoverable file removal to `/tmp/alex-dsh-trash-*`. |
| **`list`** | Standalone | None | No | Bounded directory listing tool with depth and limit controls. |
| **`shell-reconsider`** | Standalone | None | No | Steers agent away from raw shell cat/find/ls to native tools. |
| **`managed-plans`** | Standalone | None | Optional TUI widget (`tui.mjs`) | Multi-step task and decision artifact manager (.plan). |
| **`peak-gate`** | Scheduling | DeepSeek official route | No | Holds LLM requests until DeepSeek's off-peak price window opens. |
| **`codex-transient-close`** | Resilience | None | No | Classifies transient errors across 10 supported Pi APIs. |
| **`llm-resilience`** | Resilience | None | No | Centralized retry scheduler with exponential backoff. |
| **`agent-self-heal`** | Resilience | None | No | Durable recovery orchestrator across failure chains. |
| **`grammar-fix`** | Hybrid | LLM provider endpoint | Yes (`dsh-tui` only) | Draft grammar correction via `Ctrl+G` shortcut. |
| **`browser`** | External tool | Playwright browsers | No | Isolated Page-bound Chromium automation and screenshots. |
| **`research`** | External tool | Internet (optional Context7) | No | Multi-source parallel web, HN, code and Reddit search. |
| **`music`** | External tool | `kiosktunes-mcp` repo + `uv` | No | Local media player integration and MCP audio bridge. |
| **`session`** | Companion | DSH Session JSONL | Used with Companion bridge | Reader and navigation engine for past session transcripts. |
| **`session-create`** | Companion | DSH Host | Used with Companion | Native tool to create and bootstrap fresh DSH sessions. |
| **`companion-transport`**| Companion | HTTP/1 / WebSocket | Yes (Companion backend) | Wire budget guards, origin verification, and framing. |
| **`companion-download`** | Companion | Protected WebServer | Yes (Companion backend) | Secure signed file delivery between host and mobile app. |
| **`companion-api`** | Companion | Local inference server | Yes (Companion backend) | Serves model catalogs and active session state to mobile. |
| **`companion-workspace`**| Companion | Android app | Yes (Companion profile) | Session workspace boundary policy for mobile client. |

---

## Current Delivery Overview

Plans 1–4 are implemented as reversible local plugins; Plan 5 remains experimental and is tracked in the managed `.plan/` browser artifacts. No installed DSH core package is modified. Native `read`, `edit`, and `write` remain enabled. Which plugin is active in which profile is declared in `activation.json` — see Activation below.

- `apply_patch` / `apply_patch_undo`: contextual multi-file text changes, observed-version guards, per-file recovery receipts. This is an independent JavaScript adapter of the official Codex format, not the official Rust implementation. Exact matching is deliberately stricter. The TUI renders it as a native diff card (`presentCall`/`presentResult`/`presentationMeta`); the model still receives the untouched receipt text. See `apply-patch/REFERENCE.md`.
- Workspace context: absolute cwd, Git worktree root and relative directory, plus compact machine facts through the native prompt registry. See `workspace-context/README.md` for logical/canonical paths and the small unavoidable overlap with the preset cwd line.
- `clipboard_copy`: text via stdin to the local clipboard; empty text clears it. Plumbing is hidden from the model.
- `trash`: recoverable removal to private `/tmp/alex-dsh-trash-*` entries, protected broad paths, per-item batch results, cross-device copy/verify/remove fallback. No permanent-delete tool.
- `list`: bounded directory listing with `depth` (default `1`, immediate entries only), `limit`, and hidden entries included by default (opt out with `hidden: false`). Directories-first deterministic ordering, symlink-loop protection, a truncation signal, and the same `file_path`/`<path>/<type>/<content>` envelope as `read`.
- `shell-reconsider`: denies read/list/search commands (`cat`, `head`, `ls`, `find`, `grep`, `rg`) in favor of native tools; these denials cannot be reconsidered. Destructive and oversized compound commands can request a single-use permit tied to all bash arguments, steering toward the native `trash` tool. Ordinary build and test commands pass through untouched. See `shell-reconsider/README.md`.
- `grammar-fix`: `Ctrl+G` corrects the TUI draft through the configured route and output language in a separate request; without overrides it uses the session model and preserves the draft's language. It negotiates minimal supported reasoning and leaves temperature at the provider default. Technical terms should remain untouched; review before submitting. Declared with `"profiles": ["dsh-tui"]`, so it loads in no other profile. Behaviour port of Alex's Pi extension, not of its harness. See `grammar-fix/README.md`.
- `llm-resilience`: one provider-independent policy and cancellable exponential scheduler for main and auxiliary requests, including compaction (controller6, contract 3): no retry count limit by default, the first ten waits from7.03125s to60min (retry9=30min) and then 60min indefinitely; explicit finite caps and opt-outs are honored, and typed provider minima are waited up to 24h. A recovery chain gets one short `harness warning:` (a new one only when the code changes). Native/old-fork retry engines must not run alongside it. Declared in all five profiles, including isolated Companion. See `llm-resilience/README.md`.
- `codex-transient-close`: despite the historical name, this is now the generic typed-failure bridge for the ten supported pi-ai APIs, retaining legacy Codex observer compatibility. It classifies structured facts, owns no timer/counter, and never makes opaque errors transient merely from remote prose. See `codex-transient-close/README.md`.
- `agent-self-heal`: the single durable main-recovery owner (owner7), with one safe warning per failure chain and the same shared policy—not technical retries followed by semantic retries. Owner7 writes audit payload v2/policy 3 (v1 stays readable; rollback to owner6 after that is not a safe downgrade), keeps legacy spent budgets and finite pinned caps, logs every refusal with a fixed reason, and wakes a pending backoff on a live human message. Native UI events mirror the same reservations under the v4 session rules. Completed local tools are not replayed. Declared in all five profiles alongside immutable controller6; owner6/controller5 are the retained rollback pair. See `agent-self-heal/README.md`.
- `research`: parallel discovery, mandatory bounded reads, local evidence in `.dumps/research`, selective inspection and cumulative continuation budgets. Source failures are reported without discarding other results. HN and MCP code/docs connectors; Reddit uses an official read-only OAuth connector (owner credentials required), while X remains web-index. Concurrent runs share at most two workers per backend in each DSH process; Reddit morechildren stays serial. Declared for all five profiles; selective activation suppresses `web_search` while preserving its backend and `web_fetch`. See `research/README.md`; `npm run research:check` / `npm run research:activate` avoid syncing unrelated plugin drift.
- `project-mcp`: reads only `<project>/.agents/mcp.json` at agent creation and mounts the native DSH MCP client in that Agent's scope. Discovery is project-local; relative working directories resolve against the project root, but explicit outside working directories are permitted. There is no global server inventory or custom transport. Configuration is executable, not sandboxed or filesystem-contained. See `project-mcp/README.md`.
- `managed-plans`: project Markdown artifacts, review, immutable history and a browser — **not native Plan mode**. Tools never select a permission preset or activate `planMode`; any session in the same workspace can close approved work with exact revision/evidence. Own project preference `.agents/config.json` → `dshCustoms.managedPlans.autoApprove` controls automatic approval of new staged revisions, shared across sessions and retained on restart. `/plan auto on|off|status` changes/checks that project preference; plugin `autonomousByDefault` is only the fallback. `O` picks a destination, including save-only `blocked`; returning Closed to Tasks requires a fresh approval. Human Tasks approval can resume the approving session's current paused/blocked goal, with exact-revision guards; autoApprove does not. See `managed-plans/README.md` for backup, scope, trust and the distinction from native Auto permissions/goal continuation.
- `peak-gate`: DeepSeek charges double inside peak hours (`01:00-04:00` and `06:00-10:00` UTC, Mon-Fri, excluding Chinese holidays), so this middleware holds `deepseek-official` requests until the window ends instead of letting a run pay the peak price. `mode: wait` holds (cancellable, recomputed every `waitSliceMs`), `refuse` fails fast with the resume clock time, and `DSH_PEAK_GATE=off` bypasses it. `plugins/wait/schedule.mjs` is the single schedule source, also exposed to the model as `wait { untilOffPeak: true }` / `{ until: "HH:MM" }` and to the terminal as `npm run peak:plan`. Chinese holidays are configuration data, not an API; while empty the gate over-triggers (idle time, never overpayment). Not declared for isolated Companion. See `peak-gate/README.md`.

## Activation

Activation is generated from `plugins/activation.json`; see the repository root
`README.md` for the model and the rationale.

```sh
node tools/activate.mjs          # report drift only
node tools/activate.mjs --write  # apply
```

The bootstrap reconciles the contiguous managed `alex-*` run in each
`~/.dsh/profiles/*/cordis.patch.yml`. When a root profile selects the global
resilience controller, it also applies the reviewed targeted migration: disable
native retry, remove the old quota-retry fork and duplicate policy baselines,
and preserve explicit supported overrides. Unrelated config/comments survive.
Ambiguous/custom retry engines refuse before queued writes. This is idempotent
and resolves paths against this repo, but is not multi-file atomic. Inspect
reported drift before `--write`; that command also syncs unrelated managed plugins.

- To deactivate one plugin, drop its row from `activation.json` and re-run with
  `--write`. To deactivate everything, empty the `plugins` list.
- To skip a profile, remove it from `profiles`; `--profile NAME` targets one
  profile in a single run.
- `plugins/cordis.patch.yml` is an optional `--patch` overlay for an unextended
  profile. It is generated from the same manifest — do not maintain it by hand.
  Do not add it again to a persistently enabled profile.
- Test-only policy overlays must not be added to normal profiles.

The former `tests/` directory was removed by the owner and was not reconstructed.
The original automated-suite results recorded below are historical evidence,
not a present-day full-suite claim.

## Current LTS contract checks

Run `npm run test:lts:contracts` from the repository root for the small suites
maintained beside the six reviewed plugins: apply-patch, list, grammar-fix,
trash, clipboard and workspace-context. Individual commands include
`test:trash`, `test:clipboard` and `test:workspace-context`.

These checks require the local DSH modules used by the plugins; they introduce
no new dependencies. They make no model calls, do not touch the real clipboard
and do not remove or move user files. Clipboard uses a fake executable; trash
checks are read-only. Generated process/Git fixtures stay under gitignored
`.dumps/`. Each plugin documents the boundary between contract checks and actual
filesystem, compositor or recovery integration. This is not certification of the
whole harness: managed-plans, project-mcp and the other plugins are not included.
The separate `test:grammar:live` command remains opt-in and uses real providers.

See [trash](trash/README.md), [clipboard](clipboard/README.md) and
[workspace-context](workspace-context/README.md) for their focused routines and
limits. The production code of these three plugins was unchanged by this review.

## Historical verification

The initial delivery passed 66 automated cases and a separate web-dispatcher/real-clipboard probe; that is historical evidence, not a present-day full-suite claim after the directory's deletion.

Follow-up validation used actual runtime probes, real model-led code changes, and finally this chat's native read/apply_patch/undo calls. Headless and tui services passed; dsh-tui also rendered its actual terminal UI. Plain tui has no frontend configured. Git discovery now uses bounded Git itself rather than a repository heuristic. The clipboard exit/close bug found during comparison was fixed in production.

Current evidence and explicit limitations: `.plan/closed/08-dsh-acceptance-followup.md`, `.dumps/profile-validation/`, `.dumps/workspace-validation/`, and `.dumps/sol-tool-comparison/`. A local-model run passed before reboot; the repeat failed and is recorded, not hidden. Per the owner's correction, no further local-model calls were made. Cwd persona duplication was evaluated and retained to preserve user-authored content.

## Important limits

- No multi-file atomicity and no automatic rollback. Receipts identify partial and uncertain states. Undo refuses newer versions and recreated originals; automated undo requires the same session/runtime.
- `/tmp` recovery is temporary, not backup: reboot or cleanup can erase receipts and recovered files.
- Cross-device trash does a verified copy before removing the source. It cannot eliminate races from uncooperative external writers; source removal can partially fail. Recovery metadata reports this rather than claiming an atomic move. Consult returned metadata for preserved and unsupported attributes.
- Removal snapshots and revalidates ancestor identities/types/canonical paths before destructive boundaries; regression tests cover unchanged-inode parent-to-symlink swaps, including EXDEV source removal under workspace-write. Expected-version rechecks reject already-changed sources. Operations still use paths, not pinned directory handles: the remaining check-to-syscall window is not atomic or hardened against a precisely timed hostile writer. No race-free sandbox guarantee is claimed.
- Shell/MCP mutations bypass observation interception. Their changes invalidate the next guarded file mutation, but there is no global write interception.
- Read-only denies mutation. Workspace-write is limited to the runtime's writable roots; full access permits wider targets subject to trash protections. No custom escalation is supplied.

## Guidance migration and practical comparison

After activation, `~/.dsh/AGENTS.md` was migrated: machine facts moved to the native context, clipboard plumbing removed, and proactive copying/recoverable removal now reference `clipboard_copy`/`trash`. Behavioral instructions, comment style, goals and `.plan`/`.dumps` conventions remain. Legacy instances lacking tools retain explicit fallback guidance rather than a false claim that tools are always available.

The now-deleted `tests/patch-ergonomics.test.mjs` originally compared an identical title/config update across two files through actual DSH services. With two prerequisite reads: literal per-setting `edit` uses 5 total calls, `apply_patch` uses 3, and full `write` uses 4; exact final text matches in all cases. This is a dispatcher-level practical comparison, not a model/token-cost benchmark. Native tools stay enabled as originally agreed; no decision to disable them was inferred. Plans 6 and 7 remain separate and were not silently implemented.
