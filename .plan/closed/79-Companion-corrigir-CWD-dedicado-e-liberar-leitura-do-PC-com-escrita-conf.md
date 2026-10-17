# Companion — broad read access, writes confined to dedicated project

## Direct request
In parallel with redesign task 78, owner requested lifting read restrictions outside the workspace, investigating why the agent appears to start in `dsh-customs`, and using the dedicated project directory with unconstrained writes confined strictly inside it.

## Scope
- Audit profile/launcher/controller code and installed configurations inspecting only public CWD/policy/tools fields; no private credentials/env/argv/history. Distinguish backend process/repository working directory from the effective session/agent/tools cwd. Existing dedicated workspace: `/home/alex/git/my/dsh-companion-workspace`; do not move/rename directories or rewrite legacy sessions automatically.
- Fix creation of NEW conversations to use dedicated CWD consistently across header/provenance/Agent/tool execution. Use real public SDK/Gateway contracts rather than relying solely on a fake controller with assumed signatures. Validate in an isolated native fixture against effective composition.
- Read/list/image tools can observe host paths outside the workspace per owner's task. Do not access real secrets/private data to prove this: synthetic files outside/inside workspace in an isolated fixture are sufficient.
- Write/edit/create/exec remain confined via native `workspace-write` sandbox to the dedicated project; allow normal use of subfolders/files without artificial allowlists. Preexisting native technical temporary area remains technical, not broad permission over personal files. Symlink/traversal attacks must not expand write scope.
- Maintain ASK allowed-once for each literal Bash command + cwd and other escalation/unknown guards; broad read access does not mean auto-approving commands, network access, or global changes. Model/global profile/OAuth/SDK/TUI/HA are not modified.
- Isolated real Node/public SDK tests for signature/CWD, reads outside, writes permitted inside/rejected outside, symlink/cancellation/ASK guards. Document source vs installed state. No activation/hot-reload/restart of backend or installed profile while owner is actively using it: establish safe condition with no pending send/approval/draft prior to activation.

## Coordination
Separate files from Android 78 work for parallel execution. If Android is sending the wrong CWD, report to integrator for minimal coordinated change and new build; do not edit Android files simultaneously. Do not use or publish private screenshot content.
