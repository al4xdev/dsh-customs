# Companion push — UNUSED, disabled by default

Task101r1 backend proposal only. Nothing imports, mounts, configures or hot-reloads this directory in the current runtime. Plugin99 and its mock sink are unchanged. No dependency, SDK, service, phone, cloud or watched-source modification is required to run these Node tests.

`index.mjs` is an **additive public TypertRemoteService contribution** to the existing authenticated Gateway, namespace `goalPush`, service `companionGoalPush`. It must eventually be mounted only in the actual Companion native scope, alongside the separate unused `companionNativeGoals` service. It does not intercept/replace `/api`, add an HTTP listener, or export model tools. The native Connection has only one `/api` interceptor; registering another would break the existing Gateway. Parent must validate the eventual composition after the stop gate; these tests do not claim deployed composition or authenticated network E2E.

## Authority and dependencies

`createGoalPush(ctx, {scopeOf, scopeChainOf, foldGoal, identityOf, ownsSession, now?, sender?}, config)` is the isolated factory. Public SDK service identities are compared using the optional tracing-identity helper; this never unwraps a service to invoke a private method. `ownsSession(sessionId, peer)` **must synchronously return exactly true** for a current native-owned Companion root. The supplied integration delegates to A's host-only `ctx.companionNativeGoals.ownsSession(sessionId, peer)`. Missing resolver, unavailable store/sender/configuration or wrong context fails closed. No cold-session loader, global index, session body or caller-provided ownership claims are consulted.

Each remote method requires a real `this.ctx.invocation`, exact service/namespace/method, and `invocation.peer === this.ctx.connection.operator`. The factory independently checks this same captured operator, non-disposed peer context, captured profile object/name/directory, connection/service identity and native scope. A direct service call without an invocation is refused. In-process public Gateway invocation remains part of the trusted host boundary; JSON fields cannot manufacture its Peer. This does not add an independent device attestation or multi-user auth system.

`ownerScopeId` is SHA256 of a domain-separated UUID persisted in this profile's private store. It is a stable opaque **profile binding**, not an invented public SDK account/operator identifier. Operator authority comes exclusively from the native invocation and exact Peer check. Every requested session must pass the injected resolver, and ownership is rechecked immediately before send. Native ad-hoc `createScope` is not automatically inherited by subsequently created agents; Parent must prove actual configured scope ancestry, not loosen the fence.

## Wire contract (coordinated with Parent / Android C)

Native RPC path `/api/goalPush/register`, `/api/goalPush/unregister`, `/api/goalPush/status`; use the existing Connection request envelope and native RPC correlation. Method arguments are exactly `{args:{request:{...}}}` (the Connection carrier may surround these with its own RPC correlation envelope). The factory dispatch returns `{ok:true,value}` or a redacted `{ok:false,error:{code,message,details:{}}}`; the public service returns `value` or throws the native shared `RemoteError`, leaving the Gateway to encode it.

Register request, **exact seven fields**:

```text
{version:1, deviceId:UUIDv4, token:string(16..4096 FCM characters),
 tokenDigest:SHA256(token), configDigest:SHA256(projectId|appId|senderId|androidPackage),
 authGeneration:nonnegative JS-safe integer, sessionIds:distinct native IDs[1..256]}
```

The server recomputes tokenDigest, compares configDigest to its **configured** public configuration and verifies every session. It accepts no client project/sender/package, role, user, profile, origin, source or owner claim. A single foreign/unknown session rejects the request rather than expanding authority.

Receipt, **exact twelve fields**, returned only over authenticated native RPC:

```text
{version:1, registrationId:UUIDv4, bindingId:UUIDv4, profile:'companion',
 ownerScopeId:SHA256, authGeneration, deviceId, tokenDigest, configDigest,
 expiresAt:epochMilliseconds, issuedAt:epochMilliseconds, sessionIds:verified native IDs[]}
```

Lease is at most 24h. Exact device/token/config/generation/session-set replay returns the same unexpired receipt. **Any token rotation, changed session set, expired lease renewal, or re-registration after logout requires a strictly greater persisted client authGeneration.** Old authenticated requests cannot resurrect a revoked/rotated binding. Session order is irrelevant. Persist/increment the JS-safe client epoch across process restarts; do not reset it to zero on each app launch. A higher epoch without changed token is allowed to mint a new binding.

Unregister request exactly `{version:1,deviceId,registrationId,authGeneration}`; generation must match the current binding, so an old request cannot revoke its replacement. Response `{version:1,unregistered:true}`. The token is erased, pending deliveries revoked and the device generation tombstone retained. Unknown/stale unregister is refused; clients should still clear their local receipt immediately on logout.

Status request exactly `{version:1,deviceId,authGeneration}`. Response `{version:1,profile:'companion',enabled,configured,registrationReady,reason,receipt}`. Receipt is null unless generation, active lease, server config and live ownership still match. This is a real computed readiness state, not a permanent hardcoded false.

FCM **data-only** envelope: the seven original99 minimal native fields `version,eventId,goalId,revision,sessionId,phase,timestamp`, plus `bindingId,deviceId,ownerScopeId,registrationId,authGeneration,configDigest,tokenDigest`: exactly **14 strings**. No notification/title/body, objective, path, transcript, token, topic or account data. Android must validate all seven metadata fields against its authenticated locally stored receipt, then validate the original seven-field completion and the receipt's session subset. The receipt itself must never be accepted from FCM, extras or arbitrary URLs.

## Native completion and delivery semantics

Only public `goal/changed` after the genuine native GoalService durable mutation is observed. Exact current native reference, agent identity, root/session/header, preset, non-seeded/non-subagent origin and scope are required. The final committed `goal/change` must be a complete transition whose strict public `foldGoal` replay proves both the prior nonterminal revision and exact next terminal snapshot. No shadow goal, text matching, model callback, reimplemented GoalService or mutation is introduced.

`eventId = SHA256(JSON.stringify(['companion',sessionId,goalId,completionRevision]))`. The seven-field payload is stored without the goal objective. A completion failure is caught and can never undo the native goal. Zero-recipient events are also recorded, so registering later is not permission to replay historic completions.

Each event/target tracks its own binding, attempts and FCM acceptance. Attempts are persisted **before** external I/O, max three; exponential retry eligibility, one local flush at a time, at most32 targets per flush, sender timeout10s (bounded to30s maximum). The optional enabled plugin checks the outbox every5s; exhausted/delivered/revoked rows cause no sender calls. Rotation/logout/expiry/config mismatch/lost ownership revoke pending targets. A 401 refreshes cached OAuth; 429/5xx can retry within the same bounded ledger; explicit FCM UNREGISTERED erases the corresponding active token.

`delivered` in the backend ledger means **FCM HTTP acceptance**, not Android receipt/display/tap acknowledgement. A crash or ambiguous timeout after remote acceptance can repeat that event up to the persisted attempt cap; Android's persistent event dedup is required. Exactly-once network delivery is impossible and is not claimed. No real push was sent.

## Private persistence and recovery

Only `<real companion profile dir>/companion-push/`: directory0700, state/lock/temp files0600, owned by current UID; canonical profile path, no symlink leaf, bounded regular files, no extra hardlinks. Atomic same-directory rename plus file/directory fsync. Tokens are plaintext only inside this private0600 runtime file: there is no pretend encryption whose key sits beside the ciphertext; rely on the private OS account/filesystem and optional full-disk encryption. Tokens, private keys, bearer tokens, upstream bodies and private error paths are never logged or returned in errors.

Limits:32 lifetime device identities (revocation tombstones count),256 lifetime event identities,2MiB state. **No eviction forgets delivered IDs or generations**. Capacity/corruption/permissions/competing-writer failures close delivery rather than replay old events. These conservative limits require future deliberate archival/epoch migration design; do not casually delete the ledger to regain capacity.

An exclusive lifetime writer lock deliberately remains after a process crash. Recovery is manual: stop the actual Companion profile, verify no sender process remains, inspect private state locally without sharing tokens, preserve a private backup and review only the stale lock before unlocking. Never remove state to bypass dedup or a live writer lock. The constructor does not auto-reclaim locks.

## Tomorrow — owner-present setup only

1. Parent completes the stop gate and proves the additive unused NativeGoals/GoalPush public Gateway composition against the actual Companion profile scope; preserve other API methods and plugin99. Nothing is activated by this proposal.
2. With the owner, log in to their chosen Firebase/Google account. Choose/create a **separate Companion** project and register Android package `dev.alex.dsh.companion`. No Casa identifiers, keys, tokens, topics or configuration may be copied. Obtain only the Companion public project ID, Android app ID and sender number; Analytics/Crashlytics/Firestore/Functions are unnecessary.
3. Supply the matching public configuration to Android's prepared build seam and the server's `publicConfig`. The digest is UTF-8 SHA256 of `projectId|appId|senderId|dev.alex.dsh.companion`.
4. With explicit owner approval, provision the Companion-only sender identity with minimum `roles/firebasecloudmessaging.admin`; keep its service-account JSON **outside this repository** and0600, owned by the runtime account. No key/ADC/env/metadata discovery is attempted automatically.
5. Only then enable this proposed plugin with `{enabled:true,publicConfig:{projectId,appId,senderId,androidPackage:'dev.alex.dsh.companion'},serviceAccountFile:'/absolute/private/outside-repository.json'}` in the real scoped configuration. Default is disabled/unconfigured. A missing/invalid credential file reports not-ready without exposing its contents.
6. Sign in via the existing authenticated Companion connection, opt into Android notifications, obtain FCM token and persist a monotonically increasing auth epoch. Register only verified native session IDs, accept/store only the matching pending authenticated receipt; unregister/clear on logout and rotate binding/epoch on token or subscription changes.
7. Run a fresh authorized native-goal completion and verify real FCM acceptance, receipt-bound Android handling, dedup, notification permission denial and safe tap/backstack. **Real E2E remains pending** until owner configuration and actual device delivery; this suite proves only local authored fixtures.

## Verification / provenance

`node --test plugins/companion-push/*.test.mjs`

Uses Node builtins, public installed SDK modules and new authored fixtures only. All sender transport/auth is injected; a throwaway locally generated synthetic RSA key tests JWT signing and never represents a cloud account/key. The native fixture boots an isolated SDK app under `.dumps/task101-push-backend-*`, installs a no-model adapter, and proves an actual native agent-owned completion source; it does not mount production or claim full authenticated HTTP composition.

Public SDK authority inspected (installed snapshot):
- `@deepseek-ai/dsh-client-connection/lib/index.js:519–543`: public OperatorPeer owns its native scope; `585–593`: Host/Origin fence plus existing browser authentication admit exactly that operator; `658–670`: single shared interceptor restriction.
- `@deepseek-ai/dsh-api-gateway/lib/types/index.js:491–515`: public Gateway constructs actual invocation Peer and binds `this.ctx.invocation` to the service view.
- `@deepseek-ai/dsh-typert-protocol/lib/index.js:159–181`: public TypertRemoteService and invocation accessor.
- `@deepseek-ai/dsh-goal/lib/index.js:857–877`: native append/commit before public goal/changed; public fold strictly validates completion transitions.

The ha_app notification architecture was consulted **source-only**, via the required infrastructure skill: observer→private registrations/outbox→cached OAuth JWT→FCM HTTPv1→Android-native rendering, with bounded retries. No HA/Samba/cloud operation or credential/config file was accessed. Companion does not copy its deployment identity, recipient/topic identifiers, payload, endpoints or legacy behavior.
