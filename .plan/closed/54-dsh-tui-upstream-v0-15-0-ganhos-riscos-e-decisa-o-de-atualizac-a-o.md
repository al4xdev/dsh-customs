# dsh-tui upstream v0.15.0 — gains, risks, and update decision

## 1. Nature of this document

Investigation report and owner decision, not authorization to update, install, compile, merge, or publish. The update is independent of the Favorites implementation. The request for this session is planning only.

Investigation on 2026-10-13 by a dedicated subagent, in parallel with feature mapping. Evidence: Git, manifests, release notes, and code diffs; no test merge, benchmarks, build, or smoke test of the new version was executed.

## 2. What is actually behind upstream

| Item | Verified result |
|---|---|
| Fork / origin | https://github.com/al4xdev/dsh-TUI.git |
| Real upstream | https://github.com/ccch1mneyyy/dsh-TUI.git |
| Local branch | `custom` |
| Local HEAD | `ebea5d738481bbc7c35006410ad9ce1a998dc883` |
| Local package version | `0.14.0` |
| Common base | `c2eee95218d1decfce138f7d31ef7099cc391d00` |
| Default upstream branch | `main` |
| Consulted upstream HEAD | `18e4a206afc367f055a2b3379bb221abcbb5d99e` |
| Upstream version | `0.15.0` |
| Divergence | 5 local-only commits / 94 upstream-only commits |
| Upstream patches | 84 non-merge + 10 merges; the 84 are not patch-equivalent to local ones |
| Aggregate size base → upstream | 562 files; +37,280 / -5,985 lines |
| Overlap with local changes | 19 files; overlap does NOT mean 19 proven textual conflicts |

Local HEAD has committer date 2026-10-13T14:14:45-03:00; upstream HEAD 2026-10-13T10:04:24-04:00. These dates do not represent the installation date. The 94 commits include documentation, tests, merges, release, and revert; they are not 94 separate features.

### Relevant discovery during fetch

The `upstream` refspec was restricted to the `v0.14.0` tag. A standard fetch would not update `upstream/main`. Only the following was run:

```text
git fetch --no-tags upstream +refs/heads/main:refs/remotes/upstream/main
```

This updated investigation references without modifying the configured refspec, branch, index, or working tree files. Final subagent status: clean tree, `custom...origin/custom`.

## 3. Most relevant gains for this use

### A. Session manager: less waiting and more predictable selection

- [01b9af00](https://github.com/ccch1mneyyy/dsh-TUI/commit/01b9af00): opens in the current cwd list and focuses the most recent session by `updatedAt`, even when an older live/pinned session appears above it in ordering.
- [70909910](https://github.com/ccch1mneyyy/dsh-TUI/commit/70909910): preserves selection on list activate/hover; native cursor tracks filter, list, and rail.
- [6d4c1435](https://github.com/ccch1mneyyy/dsh-TUI/commit/6d4c1435), [95a7891d](https://github.com/ccch1mneyyy/dsh-TUI/commit/95a7891d), [6ff1809f](https://github.com/ccch1mneyyy/dsh-TUI/commit/6ff1809f): listing prefetching, sharing of pending scan and initial snapshot between backends. `SessionCatalog.list` now accepts `onPartial` and `snapshotKey`; rename/delete invalidates pending scan and updates snapshot.
- Structural gain confirmed in code, not a real latency measurement on this machine.
- These changes directly affect `SessionSupervisor`, its hook, focus, and cache: if an update happens, performing it before implementing Favorites reduces rework.

### B. Switch model without creating another session/fork

- [16b60dff](https://github.com/ccch1mneyyy/dsh-TUI/commit/16b60dff): `/model` uses `ModelSelectionRef` per agent and does not create/fork another Agent. Retains session ID, favorites, and transcript.
- Rejects older hosts below `0.1.2-alpha.3` when the inheritance contract is unsupported; does not promise silent operation on arbitrary DSH versions.
- Model UI + effort: [26a68a34](https://github.com/ccch1mneyyy/dsh-TUI/commit/26a68a34), [75bf6f1a](https://github.com/ccch1mneyyy/dsh-TUI/commit/75bf6f1a).
- New backend commands: [42866fc1](https://github.com/ccch1mneyyy/dsh-TUI/commit/42866fc1), `/dsh`, `/claude`, `/codex`. Lower value for users who already migrated fully to DSH.

### C. Streaming, scroll, and caret

- [e67946ba](https://github.com/ccch1mneyyy/dsh-TUI/commit/e67946ba): keeps measured line height monotonically non-decreasing during streaming until remeasured, preventing collapse and scroll jumps when leaving the window.
- Series `dfbee683`, `76721426`, `b6c1ce3b`, `6a344477` to `ad13b201`: native caret, handoff, retained selection, and Escape priority for overlays. May improve keyboard/TTY usage, but the series is tightly coupled; do not treat an isolated cursor cherry-pick as safe.
- [c8be75b1](https://github.com/ccch1mneyyy/dsh-TUI/commit/c8be75b1): fixes image probe after kernel change.
- [76c2a26b](https://github.com/ccch1mneyyy/dsh-TUI/commit/76c2a26b): HiDPI fitting and Kitty canvas budget, minimally relevant for pure Linux console.

### D. More consistent context measurement

- [bc3a4b12](https://github.com/ccch1mneyyy/dsh-TUI/commit/bc3a4b12): uses meter's `contextBreakdown` for system/tool schema and apportions `messageTokens` by transcript estimates. Bar and hover use coherent shares and integers summing to the measured occupancy.
- `StatusLine` shows `starting <backend>` before ready.
- This does not imply proven reduction in tokens, RAM, or VRAM.

### E. Persisted permission and default retry

- [461b1af6](https://github.com/ccch1mneyyy/dsh-TUI/commit/461b1af6): `/permission` persistence and standard 5-attempt retry, including `STREAM_CLOSED`, via official Harness configuration; respects explicit `retryPolicy`.
- May be an upstream gain, but in this fork it is primarily a reconciliation point: local commit `ebea5d73` already introduced provider-owned policy and preserves Harness defaults when omitted.
- Do not inadvertently replace local policy with a fixed upstream policy.

## 4. What did NOT come ready out of the box

- `src/sessionPins.ts` is identical to base `0.14.0`: same file `~/.dsh-tui/session-pins.json`, locking, atomic write, and isolation from other backends.
- Did not include the global favorites tab or the requested combination of Ctrl+P + Tab.
- No evidence that updating turns TUI into a thin client or eliminates per-instance consumption.
- No RAM/VRAM savings were measured.

## 5. Costs and changes requiring attention

### Host, entry, and configurations

- [0d93cab3](https://github.com/ccch1mneyyy/dsh-TUI/commit/0d93cab3): dedicated host/composition root; in-process DSH; lighter profiles for Claude/Codex.
- [53b30129](https://github.com/ccch1mneyyy/dsh-TUI/commit/53b30129): migration/adoption adjustments for this host.
- `/settings` migrates from `settings.yaml`/profile to `~/.dsh-tui/settings.json`; documented escape hatch `DSH_TUI_HOST_ENTRY=0`.
- [d708cb88](https://github.com/ccch1mneyyy/dsh-TUI/commit/d708cb88): persisted preferences take precedence over deployment defaults for model/preset/effort/kernel; explicit env remains highest priority.
- `/plugin` replaces `/plugins`, with temporary alias for one release.
- `--resume`, `-c`, `--continue` now fail with non-zero exit when there is no valid session for the chosen backend, instead of silently starting another.

### Contracts and dependencies

- [bc890963](https://github.com/ccch1mneyyy/dsh-TUI/commit/bc890963): backend registry/manifests.
- [6c7cd863](https://github.com/ccch1mneyyy/dsh-TUI/commit/6c7cd863): installation recipes.
- [e3c371ed](https://github.com/ccch1mneyyy/dsh-TUI/commit/e3c371ed), [1d832df3](https://github.com/ccch1mneyyy/dsh-TUI/commit/1d832df3): greater isolation of Claude/Codex from UI and host.
- `BackendHost` gains dataDir, locale, and appVersion; `sessionPrefs(host)` and `SessionCatalog` change; channel core consumes neutral `ChannelHost` rather than Cordis Context.
- Backend contribution manifest `v1alpha1` is frozen; do not interpret this as an automatic end-to-end picker for arbitrary third-party backends.
- Upstream validated line remains DSH `0.2.0-rc.2`; Node `^22.19 || >=24` and pnpm 11 are not bumped in this comparison.
- Optional/dev peers and probes appear for boot/cmdline/proxy/launch/plugin-manager APIs, `zod ^4.4.3`, `backends.generated.ts` generation, and new gates.
- Additional check by the main agent: the manifest of the installed CLI at `/home/alex/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh/package.json` reports `0.2.0-rc.2`. This is consistent with the validated line, but does not substitute for smoke testing of effectively resolved APIs/plugins.
- Fish executes `local-model-launch.mjs` → DSH profile `dsh-tui`; the profile links the package in this checkout. Do not assume the new standalone entry point will be used automatically just because it exists upstream.
- Updating sources without compiling does not update `lib/`; rebuilding in a linked checkout in active use warrants coordination to avoid affecting open sessions.

### Privacy

- [61677067](https://github.com/ccch1mneyyy/dsh-TUI/commit/61677067): removes privacy overrides from `cordis.patch.yml`; config overrides 8 → 6. `session-telemetry-otel`, `plugin-package-inventory-deepseek`, and `session-log-deepseek` inherit official defaults.
- Session metadata/inventory may be sent to baseURL per official defaults. Feedback remains conditional on explicit feedback.
- `DSH_TELEMETRY_MODE` alone does not control session-log/inventory. Decide on and preserve local overrides explicitly before promoting an update.

## 6. The five local commits that must survive

| Commit | Local intent |
|---|---|
| `fe25d475` | External plan command and Markdown source |
| `a2feaeab` | Grammar bridge via Ctrl+G |
| `3b165878` | Grammar presentation and editor shortcuts |
| `c4f04010` | managed-plan / native-plan separation |
| `ebea5d73` | Provider-owned retry policy |

Areas with changes on both sides: README/README_ZH, package, Chat, PromptInput, Launchpad, ui, i18n, tips, plugin/index/oauth profiles, completion/extensions/state/mode-permission-actions, and policy/UI tests.

Concrete risks:
1. Permission persistence and upstream `/plan` may reintroduce native-plan mode into the workflow deliberately separated by the fork.
2. Caret/startup drafts could intercept Ctrl+G or break grammar fix application in the editor.
3. Fixed upstream OAuth policy may overwrite local provider-owned semantics.
4. Entry point/host and settings migration could alter profile resolution, defaults, and credentials/config.

No merge was simulated; file overlap indicates review risk, not unavoidable conflicts.

## 7. Recommendation to owner

**The update is worth evaluating, particularly for `/resume`, focus/scroll, and `/model` retaining the ID. It is not worth replacing the fork with pure upstream or running pull/rebuild directly on the active installation.**

Options:

### A — Deliver Favorites on the current fork first

- Lowest immediate risk; no dependency on the new version for this feature.
- Favorites plan uses base `ebea5d73`, existing pin store, and localized changes.
- Cost: future v0.15 integration will need to reconcile the same list/focus hooks again.

### B — Integrate v0.15 with the five local patches, then Favorites

- Better order if there is already intent to update: avoids building features on focus/cache code that will be replaced.
- Requires a separate approved task, isolated integration checkout, explicit resolution of managed-plan/grammar/retry/privacy/settings, and real build + smoke testing of fish/profile entry point.
- Not part of the simple Favorites task and not authorized by this report.

### C — Selective cherry-picks

- Only for demonstrably independent small fixes, e.g. evaluating CJK emphasis `52f4f50b`.
- Do not cherry-pick a partial bundle of cursor, cache, or host changes without closing dependencies. `0d629068` requires evaluating collisions with local `/plan`.

**Decision requested:** keep current base for Favorites, or open a separate v0.15 integration task first? Without this decision, the Favorites plan remains anchored to the current fork; no automatic update.

## 8. Minimum criteria for an eventual update

- Preserve and test the five local patches and desired privacy overrides.
- Validate imports/runtime realpath/peers in installed DSH rc.2 and linked fish launcher/profile.
- Validate settings migration and env/defaults precedence without exposing credentials.
- Validate fail-closed resume, stable `/model`, `/permission`, managed plans, Ctrl+G/grammar, OAuth/retry, `/bg`, status, and drafts.
- Build/gates/packaging and focused regression tests; inline/fullscreen, keyboard, and TTY.
- Promote only after evidence; do not terminate user sessions or commit/push/publish without a specific request.

## 9. Limitations of evidence

Static comparison of available commits on 2026-10-13. Does not prove measured performance gains, absence of regressions, or complete build/runtime compatibility. Revalidate HEADs and tree before a future integration. The goal of this session completes upon delivering plan + report, not upon implementation or updating.
