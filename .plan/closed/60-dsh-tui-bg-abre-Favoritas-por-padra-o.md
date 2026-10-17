# /bg opens Favorites by default

## Request
Small complementary adjustment to completed plan 55: owner wants to navigate directly to Favorites via `/bg`, without pressing Tab. Prepare within the same checkout, without a new installation, modifying PATH/profile, restarting sessions, or updating upstream.

## Scope
- In DSH, `/bg` and its alias `/background` open the Favorites view after the existing background transition completes successfully.
- `/resume`, `/agentview`, `/home`, the sessions button, and left arrow with empty prompt maintain their normal entry point. Other backends retain only a single view.
- Esc preserves returning to the previous session; pinning, Tab, sorting, filter, arrow keys/Enter, and background runtime remain unchanged.
- No persisted preference, no remembering the last tab, no automatically moving sessions to favorites. Empty Favorites retains the current message and card.

## Minimal implementation
1. In Chat, represent opening the supervisor alongside its initial view, keeping the existing boolean setter with an optional view argument (defaulting to sessions). Every standard opening remains explicitly normal by construction; only the bg/background command paths request favorites. The route shared with the arrow key receives an optional argument to avoid inadvertently changing that shortcut.
2. Pass optional `initialView` to SessionSupervisor and the hook; initialize to favorites only when requested and backend is DSH, keeping sessions as default and not reacting to prop changes after mount.
3. Add regression tests: default DSH mount, requested Favorites mount, non-DSH ignores favorite initial view; real Chat `/bg` + alias integration, handoff/error/Esc, and normal `/resume` after exiting Favorites. Preserve the previous suite.
4. Correct bilingual notes that currently state `/bg` never opens Favorites automatically; synchronize guide using the existing script.

## Validation and delivery
- Read contributing/ADAPTER and script headers before editing/running.
- TypeScript and existing build/gates, supervisor/Chat/background and backend regressions, mandatory questions/layout/toolcards checks due to touching Chat, guide, and diff check.
- Only checkout files and existing generated artifacts; no dependencies/installations/PATH changes, commit/push, or restarting processes.
- Build regenerates lib in the checkout already linked to the profile; notify when the version is ready for a new instance, do not restart the instance the owner is using.
- Use active goal to guide execution and complete it only after verifying preparation.
