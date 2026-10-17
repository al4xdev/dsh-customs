# session_create with Real dsh-tui Target

## Fix
The tool remains exposed only in Companion, but must not use ctx.agents.create from the Companion host. Extend the private bridge to prepare and create in an already open dsh-tui host. Do not create another profile spoofing name/preset; do not open worker/TUI/terminal automatically.

## Contract and Security
- New profile-aware public path, keeping legacy implementation internal/tested without public fallback to Companion.
- Fixed destination dsh-tui / standard preset, effective target model validated without saving defaults. Reuse current cwd/project boundaries and caller proof; do not allow arbitrary cwd.
- Read-only discovery of compatible hosts. Exact selection by host ID when more than one exists; no silent first-PID picking. Without an updated host / sufficient public services => explicit error without creation.
- Read-only prepare-create captures identity/runtime/preset/model/policies/path facts; allowed-once human approval shows REAL target and policies. dsh-tui currently uses danger-full-access/never: do not hide this or change to workspace-write silently. Creation approval remains in Companion even if target policy is never.
- Dedicated MAC grant for creation, tied to bridge/process/preparation/cwd/model/preset/policy/IDs/task/TTL; do not reuse send grant without signing the new fields. Consume once, reserve before side-effects, and maintain journal/unknown; no automatic retry after disconnection.
- Agent handle created and retained by root host dsh-tui, independent of caller/tab. Do not shift focus. Default empty does not send prompt/draft, does not execute model, and does not arm goal. Submit admits only approved literal and preserves controls. ACK of creation/admission is not completed execution.
- Host lifecycle closes its own handles; Companion cancellation after admission does not kill the new session.

## Implementation and Validation
Separate bridge creation module, client/contract, and owner controller. Preserve existing list/inspect/send/resume paths. Tests for grants/tampering/replay/drift/wrong profile/ambiguous host/empty/submit/owner lifetime/partial errors, plus SDK fixture with synthetic dsh-tui profile and network-free adapter. Update guides removing old limitation only after verified fix. Validate alongside session/session-create regressions and skills.

## Activation
Plugin files updated without forced restart. TUI hosts already loaded with old bridge will need to reload; the tool must detect missing capability and explain. No real creation/sending will be used for testing. Skills have separate plan 128.
