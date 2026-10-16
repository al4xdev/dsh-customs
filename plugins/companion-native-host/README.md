# Companion native host

Default `enabled !== true` returns disabled before context reads, frozen entry imports, leases, listeners or files. Deployment is a separate owner-approved Companion operation; tests do not authorize runtime/profile/SDK changes. Frozen NativeGoals and GoalPush implementations remain unchanged.

## Public composition and authority

The installed SDK rejects root-realm service leaks from standing presets. Isolating those services instead hides them from the frozen descriptors' root Gateway `invocation.kind:'direct'` receivers. The adapter therefore owns a HOST-plane sibling fiber carrying the **genuine retained Companion preset key**.

Public `agentPresets.acquireScope('companion')` returns `{key,[Symbol.asyncDispose]()}`. Its exact key must match the real `livePresetMounts(ctx.root.fiber)` Companion mount, filtered to the current root. Public `createScope(hostCtx, lease.key)` creates the host-owned service fiber; actual native agents join that standing key through the real registry. No fabricated key, copied goal state, claim-based ownership or second `/api` interceptor is used.

Every Remote operation obtains a fresh actual lease and compares its key before delegating to the unchanged native operation, codecs, actual invocation Peer and HUMAN/CAS checks. No await separates the final key comparison from the native synchronous operation. Root/profile identity, native service identities and operator lifetime must remain stable.

## Startup lifecycle

- `pending`: startup has not committed, or the first actual preset acquisition is unavailable. **Before successful startup there is no NativeGoals/GoalPush receiver, scope or retained lease.** Early authenticated Gateway calls are unavailable, not successful reads/controls; `agent/created` does not attempt acquisition.
- `staged`: the genuine scope/services have been installed but fresh commit revalidation is incomplete. All operations and host-only `ownsSession` deny.
- `ready`: successful startup plus actual current-lease/profile/service revalidation. Without a real owned root, reads honestly refuse `nativeGoals/not-live-owned` rather than inventing a projection or idle state.
- `stale`: permanent lifecycle failure; no silent rearm/remount.
- `closed`: disposed; callbacks, sources, host scope and retained leases are released.

Preferred successful-startup capability: PUBLIC `ctx.get('appReady').onReady(callback)`. Only successful startup triggers first acquisition. Neither first-lease work nor an already-committed callback task is awaited by the host row initializer. A real postcommit `agent/created` may join the same finite startup task; a precommit event must not start it.

**Why this ordering matters:** public registry `diagnostic()` explicitly warns against calls inside a Host row's own activation. If any preset row is temporarily pending, `acquireScope → retain → diagnostic` awaits the root `loader.await()`. Awaiting acquisition from that same host initializer deadlocks even after every preset row later becomes active. Initializer return, not a made-up key or weakened diagnostic, breaks this cycle.

When AppReady is absent, ONE owned Promise continuation awaits PUBLIC `loader.await()` and PUBLIC `dsh-app-boot.auditStartupEntries(ctx.root,...)` before commit. Loader settlement alone does not reject required startup failures. The initializer/teardown never await their own Loader settlement. There are no runtime timers, polling/retry loops, private SDK hooks or invented native readiness events. Without a supported successful-startup path, the adapter stays pending without receivers.

`startupCommitted` is set synchronously BEFORE async acquisition/revalidation. ANY subsequent public Loader entry/context/config/partial-dispose/volatile-update mutation conservatively latches stale, even during that async handshake. Initial precommit rows are not mistaken for runtime HMR. A fresh reviewed reload is required after the latch. Arbitrary trusted registry unregister bypassing Loader is detected on the next guarded RPC; the SDK has no dedicated synchronous public generation-change event. Do not perform out-of-Loader preset mutations with this host active, particularly with push enabled.

The adapter creates no agent, goal, user message, session load, round driver or model.

## Push remains separate and off

NativeGoals does not require GoalPush. The GoalPush entry/service/store/timer is not loaded before successful startup or unless `push.enabled === true`, complete public project/app/sender/package config validates, and an absolute explicit private service-account path is supplied. Partial/absent push configuration creates no push store or namespace. Complete configuration delegates validation/readiness to the unchanged frozen implementation; the host itself reads no credentials or tokens and performs no OAuth/network request.

The frozen receipts, persisted auth epochs, private outbox and exact FCM envelope remain documented in `plugins/companion-push/README.md`. Missing push methods mean unavailable/unconfigured, never successful registration.

## Configuration boundary

Keep NativeGoals/GoalPush service entries OUT of the preset plugin list. Use one host row with `config:{enabled:true}` after the real Connection, Typert/Gateway, native Agent/Goal/projection services and Companion declaration. Keep the actual `@deepseek-ai/dsh-tool-todo` row inside Companion with the intended existing policy; missing native TODO projection fails closed, without inventing a standing list. A host-last row is not a substitute for successful startup.

Leave push absent unless separately authorized. Credential/cloud/account/login/phone changes are outside this adapter.

The host's own Loader row is compared exactly, except that `name` is compared as the module the Loader imports (absolute path, `file:` URL or profile-relative path of the same file are equal). SDK 0.2.0-rc.2's ConfigEditor (the app's model picker, Settings) reconciles the profile layer with raw paths (the HMR watcher may re-anchor them to file URLs afterwards); the Loader never restarts a row for that, so a raw comparison latched the running assembly stale until a service restart. A row naming a different module, or any other changed field, still latches stale (`lifecycle.test.mjs`, "in-profile host").

## Verification

`node --test plugins/companion-native-host/host.test.mjs plugins/companion-native-host/full-preset.test.mjs`

Fourteen host tests cover disabled no-touch behavior, genuine retained native scope after startup and before agents, precommit absence/no effects, native HUMAN pause/resume CAS, foreign/direct/stale rejection, actual Loader HMR, profile/generation drift, the commit-race fence, configured push isolation and root cancellation/release. Auth is authored memory; RSA material is throwaway, never an owner/cloud key. Models/round drivers and external requests remain zero.

Two full-preset cold-start regressions mount all twelve actual Companion preset implementations plus the real isolated compaction group. A public initial dependency temporarily holds the actual TODO row pending; an early real agent event cannot reintroduce acquisition. Both AppReady and public Loader-audit fallback must return the host initializer, finish native startup, preserve ordinary authenticated RPC, and pass actual native catalog/read/HUMAN pause with zero rounds. Unused host support capabilities are explicit DENY-only fixtures, not substitutes for native leases/scopes/agents/goals/Peers/codecs. Native persistence/files operate only in the authored `.dumps/task104-*` sandbox.

Historical Task101 FREEZE1/FREEZE2 artifacts remain archived. Their old declarative helpers assume precommit staged receivers and must be adapted to the new pending/no-receiver contract before reuse; do not report an old 28-test result as validation of this lifecycle fix. Task104's copied-source proofs distinguish offline authored-goal HUMAN control from separately owner-executed deployed empty/native-read/follow checks. In-memory native RPC is not Android/FCM E2E proof.

Public SDK references: registry `lib/index.js:547–565,639–658,772–787`; registry `lib/types/mount.d.ts:7–27,45–56`; public AppReady `dsh-cmdline/lib/types/index.d.ts:40–57`; startup audit `dsh-app-boot/lib/index.js:4009–4019,4083–4086`; Loader events `cordis-plugin-loader/lib/types/index.d.ts:18–36`. No SDK installation edits are required.
