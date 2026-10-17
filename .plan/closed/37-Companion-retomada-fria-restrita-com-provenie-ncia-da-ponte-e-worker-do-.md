# Companion — restricted and verifiable cold resume

## Continuation of task 35
The companion is already functioning with a single tool, real reading, Unix bridge, native confirmation, and separate Tailscale. `resume` still returns unavailable. This task implements only verifiable resume, keeping the current goal until validating the whole set and reporting limitations of legacy sessions / TUI.

## Authorized semantics
Resume a cold session in the same source profile PROVEN by the bridge, using the current configuration of that profile, without promising immutable historical reconstruction. Confirmation displays target, cwd, profile, preset, effective model/policies, and explicit warning of current configuration. Any drift after confirmation requires rejection/reconfirmation. Without provenance, unproven model/preset/policy, pending inbox, existing writer, or incompatible composition: `resume_unavailable`, without companion fallback, fork, or takeover. Do not guess legacy profile by project.

## Changes
1. `provenance.mjs`: host-side capture by bridge of real agents, exclusively when idle; official flush, log/revision/seq snapshots, public profileContext, cwd, selected preset, effective model and policy, fingerprints of profile/bundles/overlays/preset documents and tool catalog. Private HMAC MAC, atomic publication 0600; do not include credentials, secret environments, or complete transcript. Checkpoint proves observed origin and integrity, not immutable history. If services/metadata are missing, do not fabricate checkpoint.
2. Bridge schedules capture without altering agent/prompt/tools and drains capture on teardown, preserving current controls and identity. Live targets use send, not another worker. No legacy TUI injection records used as proof.
3. `resume-preflight.mjs`/`resume-client.mjs`: verify signature, target/revision/prefix, current configuration, origin/cwd/CLI and compatibility, absence of pending inbox/execution. Grant expires and binds approved requestId/target/text/fingerprint. Prepare private request/overlay in companion storage, never in projects or `.dumps` for production. Spawn Node/DSH CLI directly, without shell and without tokens / sensitive text in arguments. Durable dedup ledger with launched/admitted/unknown; no ambiguous automatic retries.
4. `resume-worker.mjs`: bootstrap original profile and overlay RESTRICTED to disabling proven interactive/one-shot entrypoints and inserting runner. Admit only known composition without declarative autostart agents. Validate root/current fingerprint and catalog/policies before opening writer. Use strict `agents.resume` and `agentPresets.resolve/mount` when preset exists, never TUI helper composePreset that performs fallback. Preserve cwd / effective model / preset / policies; revalidate under lock, enqueue literal next-turn with unique ID after setup; no `goal.resume`. Resuming API may append housekeeping of interruptedTurnClosers: execution must record this possibility after consent and not call setup-failure an absolute effect:none. Official writer exclusivity rejects concurrency. ACK is admission, not completion. Terminate only own worker and its handles; do not kill existing processes.
5. Integrate `session.resume` via native confirmation `allowed-once`, literal content, and exact target; update help/capabilities/README. Do not add other tools to companion or TUI.

## Initial scope and gates
Implement and validate first headless / non-UI origins with full proven composition. TUI will only be supported if removing UI does not change tool catalog / policies or necessary hooks. If there is a discrepancy, return unavailable; do not rebuild tools ad hoc or edit the frontend fork in this task. Legacy sessions without checkpoint remain queryable but not resumable by companion. Historical config changes are not silently accepted: reject without verifiable current fingerprint; warning and confirmation never waive proof of current policies/catalog.

## Tests
- Unit: altered/expired checkpoint, IDs/paths, fingerprint/cwd drift, absent services, pending inbox, grants/replays/dedup, and unknown-after-launch.
- Synthetic runtime: create session in dedicated test profile, ask simple question via existing LLM Codex gpt-6-sol low, capture provenance, terminate original, request resume in companion and confirm only that synthetic operation; verify same session/cwd/preset/model/policies, textual marker, and no duplicate worker.
- Live writer and two concurrent resumes must reject/serialize without takeover. Without confirmation and with rejection, zero resumes; drift and incompatible catalog do not execute message.
- Re-run task 35 suite and test integration with real companion profile. Keep Web 443 and Tailscale 8443 separate; do not restart user TUIs. Consent test helpers only for exact synthetic IDs and removed before delivery.
- Local evidence in `.dumps/tasks/session-companion`; do not claim Android/APK test without real device.

## Conclusion
Code/tests/documentation with safe resume of at least verifiable origins and explicit limitations, real synthetic smoke, and enforced confirmation. Close 35/36 only with specific evidence of implemented capabilities; goal not completed before validation and honest reporting of limits. No commit/push, runtime upgrade, lock removal, reboot, or modification of existing Web.
