# dsh-tui — Ctrl+P and global Favorites tab in session manager

## 1. Request, scope, and authorization

Future implementation in personal fork `frontend/dsh-tui`, limited to the **three behaviors confirmed by the user**:

1. **Ctrl+P:** pin/unpin the session currently selected in the manager.
2. **Tab:** toggle the current view and **Favorites**, replacing external sources in this navigation.
3. **Favorites:** gather pinned DSH sessions across all projects, showing current states and indicators.

**Arrow keys, Enter, and `/bg` already work and will not be redesigned.** No new search, server, backend refactoring, new preference, or hidden fourth feature.

This session was authorized for investigation and planning, not implementation. The plan remains in the backlog; do not build, install, update upstream, commit, or publish now. Future execution requires a specific request/approval.

## 2. Base, installation, and separate upstream decision

- Repo: `/home/alex/git/my/dsh-customs/frontend/dsh-tui`.
- Mapped base: branch `custom`, HEAD `ebea5d738481bbc7c35006410ad9ce1a998dc883`, package `0.14.0`.
- Fish executes `~/.local/share/dsh-cli/local-model-launch.mjs` → profile `dsh-tui`.
- `~/.dsh/profiles/dsh-tui/package.json` links the TUI package to this checkout. Compiling here regenerates artifacts in the linked installation; do not do this casually while sessions are open.
- Pin store, global catalog, status, resume, and stop already exist: **updating is not necessary to implement Favorites**.
- **Plan 54**, in `para-o-dono`, contains the comparison with upstream v0.15.0: 94 missing commits, five local patches, gains, risks, and decision.
- Full inventory with links: `.dumps/tasks/dsh-tui-upstream-20261013-inventory.md`.
- If the owner chooses to update, integrate it as a separate task before Favorites and remap the plan: v0.15 changes focus, cache, host, and the same hooks. Do not embed this upgrade in this localized change.
- Without an upgrade decision, the baseline is the current fork. Revalidate Git status/HEAD before editing, as other tasks may work in the workspace.

## 3. Visible contract

### Current screen

Preserve the screen from the mockup: project rail, sessions of the selected workspace, New session card, existing filter, and current shortcuts. External Claude/Codex sources are removed only from this navigation; in the DSH channel two views will exist:

```text
DSH | Favorites
```

The package includes official en/zh languages; use translated labels. Both options exist even without external sources or data. Under extreme width constraints, maintain existing folding/overflow and keep active tab visible; Tab does not depend on mouse.

### Global Favorites

- Same list/rendering; set comes from eligible pins across **all cwds/projects of the DSH catalog for this channel**.
- Selected workspace does NOT filter this view. Rail continues with its current contract and determines the destination of New session, not the favorites filter.
- List title displays **Favorites · all projects**, not the rail's project.
- Reuse existing star, status, spinner, current, and occupancy. No invented remote state or new sorting priority.
- Show abbreviated cwd/project on the existing facts line, without adding a third line: user is migrating to TTY, where hover is unavailable to distinguish identical titles.
- Rail and New session card remain. The card explicitly names the selected workspace and retains current Enter/Ctrl+N actions.
- Dedicated empty state for favorites, indicating how to pin via Ctrl+P; loading and search without matches retain their respective messages and precedence.

### Search, view switching, and `/bg`

- No new search box, filter, or command. Reuse existing filter and its predicate.
- Switching views clears query/notice/menus matching current `switchTab`.
- Each mount begins on DSH/current screen, as today; do not persist active tab or make `/bg` open Favorites automatically.
- `/bg`, `/resume`, `/home`, and `/agentview` continue opening the same supervisor; pinning or Tab never starts, terminates, or opens a session as a side effect.

## 4. Verified source map

Paths relative to the package; line numbers refer to the current base and must be remapped if an upgrade occurs.

| Source | Responsibility / change |
|---|---|
| `src/screens/SessionSupervisor.tsx:104–225` | Hook consumption, source/tab state, `useForeignSessions`, tab switching. Replace sources with two views. |
| `SessionSupervisor.tsx:227–453` | Modals and keyboard. Add local pin and adapt Tab without altering arrow keys/Enter/Esc/N/L/X. |
| `SessionSupervisor.tsx:505–600,875–904` | Header/budgets/SourceTabs/overflow/foreign panes. Reuse tabs, remove source consumption only from this surface. |
| `SessionSupervisor.tsx:680–785` | Title/filter/card/rows/empty/callbacks. Global title and cwd context only in Favorites. |
| `src/screens/sessionSupervisor/useSessionSupervisor.ts:109–125,343–409` | Backend, cache, and single global listing, partial/enrichment/generation guards. Preserve contracts. |
| `useSessionSupervisor.ts:184–196` | Eligible global `listedSessions`; correct base for Favorites. |
| `useSessionSupervisor.ts:215–247,470–496` | Rail, groups by cwd, and current `visibleSessions` by selected.path. Change derivation base depending on view. |
| `useSessionSupervisor.ts:289–296,505–538,756–770` | Pins, focus by ID, indices/card0, movement, and session under cursor. Single collection for render and actions. |
| `useSessionSupervisor.ts:577–584` | Pin persistence and failure notice. Reuse. |
| `useSessionSupervisor.ts:643–662,709–724` | Entry/occupancy and dedicated/background stop. Reuse without bypass. |
| `src/sessionPins.ts:129–201` | DSH namespace, lock, read under lock, atomic write. No new schema. |
| `src/components/sessions/SessionListRow.tsx:125–153,173–226` | State/star/two lines/facts. Optional context prop only in Favorites. |
| `src/sessions/format.ts:248–265` | `formatProject(cwd, home)`: HOME→~, unknown cwd, and normalization. Path verified directly; reuse. |
| `src/components/sessions/SourceTabs.tsx:48–58,69–113` | Generic tabs/active-never-fold/overflow. Reuse without redesign. |
| `src/screens/sessionSupervisor/model.ts:29,33,122–131` | Rail at 84 columns, two lines, and existing search. Do not alter geometry/predicate. View type can live here. |
| `src/screens/Chat.tsx:4243–4247,5061–5066,5864–5929` | Supervisor keyboard scope and context Ctrl+P in Chat. Preserve global action. |
| `src/utils/keymap.ts:231` | `contextPanel` default Ctrl+P. Do not remap. |
| `scripts/verify-session-supervisor.tsx` | Real in-memory terminal/fake channel; replace source tab expectations in lines 1687–1932. |

No new dependency, Harness API, Cordis service, or vendor UI import is required. Follow `AGENTS.md`, `docs/contributing.md`, and `ADAPTER.md`; edit sources, never `lib/` manually.

## 5. Future implementation steps

### A — Preparation and baseline

1. Read instructions and current files, verify HEAD/status, and preexisting diffs.
2. Confirm the choice between current fork and separate upgrade; do not overwrite parallel work or the managed-plan/grammar/retry patches.
3. Anchor execution in a dedicated/reused goal and track steps/acceptance. The goal of this session is planning and completes with artifacts.
4. Coordinate build/activation of the linked checkout to avoid affecting open sessions. Do not terminate user TUI/processes automatically.

### B — One view, one derived list

1. Introduce explicit type `sessions | favorites`, with a single source of truth in model/hook exposed to the screen. Do not maintain a tab in the component that diverges from the hook's collection.
2. Default `sessions`; Favorites only when `dshBackend` is true.
3. Derive the base BEFORE the guard `selected === undefined`:

```text
sessions  → selected ? groupedEntries[selected.path] : []
favorites → listedSessions.filter(session => pins.has(session.id))
```

4. Apply the existing predicate, copying, and identical sorting (live first + updatedAt descending) to both; include dependencies view/pins/listedSessions/query/pulse.
5. Render, `sessionAt`, `sessionIndex`, `focusedSession`, Enter/Ctrl+X, and scroll must use this same `visibleSessions`. Never filter solely in JSX.
6. Preserve single global enumeration, channel/source-scoped cache, snapshot, partial/enrichment, and generation guards. Do not query per favorite or per project.
7. Do not prune missing pins based on partial cache or transfer pins to new fork/model/session IDs.

### C — Ctrl+P reuses star pinning

1. Insert handler after modal layers; use the `isMod` pattern already adopted by other Ctrl/Cmd keys, ensuring Linux Ctrl+P via byte `\u0010`.
2. Act only in DSH + list pane + real `focusedSession`. Do not use raw `focusSessionId`: filter/unpin could hide it, and index has a fallback.
3. Rail, card0, empty, and zero matches: consume as no-op; do not save invisible/undefined ID or insert `p` into the query.
4. Reuse `persistPin` → `setSessionPinned`, which rereads under lock and modifies only the targeted ID. Do not overwrite the entire stale set.
5. Mouse star and keyboard share the same path; clicking the star does not open the session.
6. JSON/lock/permission: existing notice, no visual/focus changes on failure. Test double toggle in the same batch; if closure adjustment is needed, limit to shared toggle logic.

### D — Tab swaps sources for views

1. DSH/Favorites always available on DSH channel, independent of foreign sources or facades; Tab/Shift+Tab cycle the pair, clicking is equivalent.
2. Remove from supervisor only: call to `useForeignSessions`, disappeared source effect, `foreignKey`, and unused `ForeignSessionPanes`. Old effect must not reset Favorites simply because it is not an external source.
3. Reuse `SourceTabs`, widths/folding/overflow; do not delete parsing/facade/migrate/backends modules to clean up tree.
4. `/migrate` and migration CLI remain functional. Non-DSH supervisor retains single view and dedicated namespace; do not list DSH under Claude/Codex channels.
5. Clear query/notice/menus as today; do not call `activateList` indiscriminately, as it resets focus to current/card.
6. New pin and view switching do not operate behind an active ApprovalPanel. Guard the common switching flow, including click/overflow, not just keypress. Do not refactor broadcast/ownership of all legacy approval keys.

### E — Readable global view and safe actions

1. Reuse `SessionListRow`, `liveStateOf`, `holderOf`, spinner/current, and `openSession`/`stopSession`.
2. Optional prop `workspaceLabel` only in Favorites; calculate on screen with `src/sessions/format.ts:formatProject`. Normal row without prop retains current text/styling.
3. Insert cwd early in facts row, with compact budget/display-cell truncation to preserve timestamp room. Not basename alone: distinct directories may share identical names. Do not add a third line.
4. Global title; card and Ctrl+N explicitly name/target the selected workspace. Selecting a workspace does not filter favorites, but preserves current rail focus reset.
5. Working/live retain current global view of eligible catalog; total continues tracking visible rows. No new counter/state/sorting.
6. **Row context menu:** `SessionSupervisor.tsx:767–773` uses rail's `selected`, not session's cwd. Favorite B with rail A could offer rename/remove of A. Minimal solution: disable only `onContextMenu` of rows in Favorites, keeping rail menu. Do not introduce switchWorkspace based on favorite cwd.
7. Distinct empty state for favorites compared to loading/no-match, with Ctrl+P instructions.

### F — Focus, Enter, and background remain unchanged

1. Maintain focus by ID, derived index/card0, arrow keys/Enter/Esc, and scroll window.
2. Repair stale ID only after successful unpin of focused favorite that departed the list: focus first remaining row, consistent with current fallback. Do not move focus on failure, regular pin, or toggle of another row.
3. Last favorite removed: keep New session card visible/focused per existing contract, explicitly labeled with the project. Pin/Tab do NOT create/open automatically; Enter on the card continues its clearly displayed existing behavior.
4. No parallel cursors, preferences, or special tab restoration. Selecting rail continues to potentially reset focus.
5. Entry is via `openSession` → `resumeTo(id)`, not raw callback or selected.path; do not add another working gate to DSH.
6. Do not modify `/bg`, `/resume`, `/home`, `/agentview`, drafts, IDs, compaction, or mount ledger. Backgrounded session continues working.

## 6. Documented invariants and limitations

### Runtime and occupancy

- Pin does not start/terminate/claim ownership of a session and does not alter cwd.
- Another PID remains blocked from entry; visual pulse can lag by 2s; adapter reservation is authoritative.
- Working/needs-input states are known for agents in the current runtime; external occupancy does not authorize inferring remote status.
- Stop continues targeting only owned background sessions, never current or external PIDs.

### Catalog/cwd

- Same eligibility: promptless, subagent, and hidden ancestors from current fork remain excluded, even if pinned.
- Unregistered/historical directories can appear in Favorites without modifying the registry.
- Resume uses registered ID/cwd, never rail workspace.
- Preexisting gap: header without cwd may fall back to current cwd, and resume lacks directory validation present at creation. Do not resolve backend within this scope or claim nonexistent protection.

### Store

- DSH remains in `~/.dsh-tui/session-pins.json`; backend stores isolated; no migration/schema/new preference.
- Orphan IDs tolerated, never pruned based on partial/cache reads.
- External pins are not synchronized in real time with an open screen today: read on mount and local mutations. Do not add polling/sync as a fourth feature.
- Strict write under lock preserves malformed JSON/concurrent mutations. Do not bypass errors with full overwrite.

### UI

- Global context Ctrl+P remains intact outside supervisor.
- Narrow hidden rail while pane still targets rail is preexisting; do not attempt fixing entire narrow navigation here.
- Approval has preexisting multiple-listeners issue: protect only new Tab/pin/tab-click operations without altering other controls in this task.

## 7. Regression matrix

### Shortcut/store

- Ctrl+P pins/unpins the same ID under `❯`, without resume/new/stop and without query pollution.
- No-op on rail/card/empty/no-match; modals/approval retain priority.
- Mouse star equivalent and does not open; double toggle in same batch returns to initial state.
- Restart/remount preserves pins but not active tab.
- Lock busy/corrupted JSON/write failure: notice shown and bytes/row/focus preserved.

### Views/global

- Tab/Shift+Tab/clicks on pair function even without data/facades/source files.
- External probe/scan/import never invoked when mounting/switching this screen.
- A+B+unregistered cwd appear together, with A/B selected, without selected, and empty/rejected registry.
- Current view continues filtering by selected.cwd; eligibility/orphan pins/current status maintained.
- Existing query and clear/reset/Esc maintain contract; loading/no-match/empty properly distinguished.

### Focus/actions

- Unpin first/middle/last/only row; real visible ID tracked, Enter never opens a removed ID.
- Card0 explicitly labeled New session; creation only via existing action, never side effect of pin/Tab.
- Re-sort/pulse/enrichment/partial/refresh/superseded response do not desynchronize render/Enter/stop.
- Favorite B with rail A opens B by ID; row context menu does not operate on A.
- Occupied state blocks Enter/click; current session not stoppable; owned stop targets correct ID.
- Tab/click guarded by approval; mouse/keyboard maintain consistency.

### Status/cache/bg/Chat

- States working/needs-input/idle/completed/failed/stopped/current/occupied maintain glyphs/color/spinner.
- Pulse does not trigger re-enumeration; first-paint cache, failed refresh, and generation guards preserved.
- `/bg` continues working/opening supervisor without auto-favoriting or changing defaults.
- Ctrl+P outside supervisor maintains context; drafts/caret/images preserved before/after Esc.
- External browse namespace/backend remains valid.

### TTY/layout

- Inline/fullscreen; 120/84/83/60 columns; short terminal, resize, and >viewport.
- Active-never-fold, overflow, and Tab/Ctrl+P hints even with active query.
- Identical titles across distinct cwds, HOME, empty cwd, long path, CJK/emoji; without hover.
- Real TTY test: pin, Tab, observe needs-input, enter, bg, exit, clean exit/terminal restoration.

## 8. Future validation — commands and limits

No tests or builds were run during this investigation. Commands executed in package directory using compatible pnpm/Node:

```fish
pnpm build
pnpm verify:session-supervisor
node scripts/verify-session-browser.mjs
node scripts/verify-keymap.mjs
node --import tsx/esm scripts/verify-ctrl-t-scope.tsx
pnpm verify:i18n
node scripts/build-guide.mjs
node scripts/verify-guide.mjs
pnpm verify:fixed-window
pnpm verify:package
```

- Replace source-tab integration expectations in `verify-session-supervisor.tsx:1687–1932`; maintain snapshot/cache/backend sections and residual utility tests still in use.
- Store tests already in `verify-session-browser.mjs:62–88`; expand UI without parallel store.
- Script fixes language pre-import; use `settled`/`settle`, no arbitrary new sleeps without tags.
- No root `test`/`lint`: those scripts do not exist. Build compiles + runs gates, does not equate to full test suite.

The contextual prop affects a shared component; also run the three CI regression tests required for shared rendering/Chat when touching this surface:

```fish
env DSH_TUI_LANG=zh node --import tsx/esm scripts/repro-askpanel.tsx
env DSH_TUI_LANG=zh node --import tsx/esm scripts/verify-askpanel-layout.tsx
env DSH_TUI_LANG=zh node --import tsx/esm scripts/repro-toolcards.tsx
```

- Shared backend if affected: `node --import tsx/esm scripts/verify-backend-chat.tsx` and `node --import tsx/esm scripts/verify-session-archive.tsx`.
- Chat/drafts integration if touched: `pnpm verify:composer-draft-handoff`.
- Involuntary modification of migrate/facade: review scope and run focused migrate-browse/migrate-command, do not delete coverage.
- Prior to eventual integration/merge/publication, follow current CI groups and contract as a separate task; do not execute diagnostic scripts indiscriminately.
- Record actual results and declare unexecuted tests/manual TTY; do not turn strategy into a claim of validation.

## 9. Docs, i18n, and guide

1. `src/i18n.ts`: labels/scope/empty/hints for Ctrl+P/Tab in zh/en; hints also with query; correct placeholders.
2. `README.md` + `README_ZH.md`: contextual Ctrl+P and global views/favorites; remove promise of import via source tabs from this screen, keep `/migrate`.
3. `docs/interaction{,.en}.md`: table and source strip; remove Ctrl+P from 'deliberately removed' list; preserve arrow keys/Enter/bg descriptions.
4. `docs/user-guide{,.en}.md`: manager, scope, and shortcuts.
5. `docs/migrate{,.en}.md`: sources removed from this navigation, /migrate/CLI remain.
6. `docs/foreign-session-tabs-design.md`: historical/superseded UI in fork; do not state services/parsing were deleted.
7. Screen/hook/row/script comments: pinning does not imply pinned-first sorting, ordering remains live + recency.
8. Guide generated from docs with build-guide/verify-guide; do not edit generated copies.
9. No change in keymap/context panel, managed/native plan, grammar, retry, or `/bg` description.

## 10. Acceptance and delivery of future execution

- [ ] Ctrl+P only in supervisor/list, same store as star, safe persistence and failure handling.
- [ ] Tab toggles two views without external sources on this screen.
- [ ] Eligible global DSH Favorites with readable cwd and current status.
- [ ] Arrow keys/Enter/bg/rail/card/filter preserved; pin/Tab without automatic creation/opening.
- [ ] Focus/refresh/unpin do not direct actions to the wrong ID.
- [ ] Occupancy/current stop/approval for new operations maintained; context menu does not point to wrong workspace.
- [ ] `/migrate`, other backends, and namespaces intact outside removed navigation.
- [ ] No new server/dependency/persistence/preference/sync/pin cleanup.
- [ ] Applicable gates/regressions/manual testing with evidence and coherent zh/en docs/guide.
- [ ] No fish/profile/upstream upgrades, terminating user sessions, commits/pushes, or hidden scope publications.

## 11. Effort and planning conclusion

Small, localized logic: screen, hook, and one presentation prop. Main effort: focus/modal/cache regressions and documentation. Relative estimate **small to medium** on this base; v0.15 upgrade is separate and higher risk. Do not promise fixed deadlines without gates on the chosen base.

Investigation conducted with five subagents: UI/keyboard, runtime/store, tests/docs, adversarial review, and upstream in parallel. No code/build/test/merge changes took place. Only fetching upstream refs and authoring planning documents. Goal for this session ends with plan + report/inventory; backlog was not executed.

Revision 2: verified and corrected helper path `formatProject` to `src/sessions/format.ts` and linked complete upstream inventory; scope of the three behaviors remains identical.
