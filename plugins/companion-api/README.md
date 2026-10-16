# Companion catalog and management Host API

Host-only contribution for the **existing companion backend**. Catalog/model reads remain metadata-only. Explicit management adds a profile-default model change and recoverable native JSONL deletion. No frontend daemon, custom HTTP listener, private interceptor, model tool, prompt contribution, credentials copy or agent activation is introduced.

## Mounting and ownership

Mount `index.mjs` only in the companion profile's Host composition, not inside an Agent preset. `apply` and the service constructor check the launcher-provided public `ctx.get('profileContext').name === 'companion'` **before** registration. A `config.profile` assertion is not authority. Every invocation rechecks the actual profile.

The installed CLI publishes `profileContext` using `hostCtx.provide('profileContext', profileContext)` in `@deepseek-ai/dsh/lib/profile-boot-BZ2ZjNWi.js`; its public type is exported by `@deepseek-ai/dsh-app-boot` (`lib/types/profile-context.d.ts`). `ctx.sessionPersistence` is the current backend's service. No constructor accepts a filesystem root, alternate backend or destination URL.

The service binds public `TypertRemoteService` to Cordis key `companionCatalog`, namespace `companion`, and registers strict direct `InvocationDescriptor` contracts through public `ctx.typert.register`. Its fiber owns the contribution. Disposal withdraws definitions; the native Gateway forbids SRC fallback after withdrawal. No decorators, private reflection mutations, agent/session lookups or `RemoteScope` are used.

Profile wiring/deployment is intentionally not performed by this directory.

## RPC contract

All five endpoints are authenticated native Connection RPC POSTs:

- `/api/companion/listChats`
- `/api/companion/detail`
- `/api/companion/deleteChat`
- `/api/companion/modelCatalog`
- `/api/companion/selectDefaultModel`

Example request (the correlation ID is an ordinary client-generated ID):

```json
{
  "type": "client-request",
  "rpcId": "catalog-1",
  "method": "companion/listChats",
  "payload": { "args": { "request": { "limit": 50 } } }
}
```

`listChats` request: `{ limit?: integer 1..100, cursor?: opaque string <=2048 characters }`. Default limit: 50. Result:

```json
{ "profile": "companion", "chats": [{ "id": "chat-id", "createdAt": 123 }], "nextCursor": null }
```

`detail` request: `{ id: native-session-id }`. Result:

```json
{ "profile": "companion", "chat": { "id": "chat-id", "createdAt": 123 } }
```

Native Connection wraps successful values as `{ type: 'server-response', rpcId, result: { ok: true, value } }`; failures use `{ ok: false, error: { code, message, details } }`. Requests must contain the `request` JSON wire parameter. Unexpected request fields are rejected, including root/backend/preset/cwd/model/config input. Native Gateway schema failures use `gateway/input-invalid` or `gateway/arguments-invalid`; catalog refusals use stable `companion/*` codes with fixed messages and no private metadata.

Chat metadata allows **only** `id`, optional `title`, `createdAt`, `updatedAt`. Epoch timestamps must be nonnegative safe integers. Invalid optional metadata is omitted. The current catalog emits only header ID and valid header creation time: no private projection/config fields are inspected. The pure `companionMetadata(snapshot, hints)` helper can admit explicitly supplied scalar display hints in a later integration, but hints never establish membership. Every method explicitly validates its output: native Gateway invocation does not itself run output parsing.

## Explicit management

`deleteChat` accepts exactly `{id, createdAt, confirmation: 'delete-companion-chat'}`. It verifies native companion membership and the immutable creation identity twice. The supported public JSONL backend provides its root, current-log resolver and exclusive write lease; generic persistence has no delete operation. Pending sessions and actual native writer contention are refused. Other lease failures do not pretend a writer is active.

Under that lease, the entire canonical native session directory moves outside the corpus into `~/.dsh/session-companion/deleted/<id>-<random-uuid>`. The lock inode moves with it; source/archive parents are synced before success. No Agent is disposed or taken over. This is recoverable server trash, not local hiding, secure erasure, attachment deletion or a public restore API. Success is exactly `{profile:'companion', id, deleted:true, recoverable:true}`; filesystem paths never enter the DTO or error face. After a rename attempt or uncertain cleanup, `companion/delete-unconfirmed` forbids interpreting failure as proof nothing happened. Never automatically replay it.

`modelCatalog` accepts `{limit?:1..64, cursor?:opaque}` and returns the actual public native model inventory, configured current selection, routable providers, writability, unavailable-provider count and continuation. Pages are limited to64KiB, inventories to4096models/128providers/16efforts; no silent truncation or credential/error payloads. Cursors reject inventory drift. Optional capabilities do not gate ordinary chat catalog startup.

`selectDefaultModel` accepts `{provider,model,reasoningEffort?,expectedCurrent:{provider,model,reasoningEffort?}}`. It validates advertised routing/effort, serializes this adapter's writes, checks expected current, awaits public `agentDefaultModel.saveSelection`, and verifies `currentSelection` afterward. Missing/nonwritable public config support refuses rather than claiming a no-op succeeded. This changes **the companion profile default for unconfigured Agents**, not the currently selected model of conversations which already have one; it never invokes `session/selectModel` or resumes a session. The expected-current check is not atomic CAS against unrelated native writers. A missing receipt/save uncertainty is not safe to replay.

## Membership and pagination

Only immutable persisted headers with exact `agentPreset === 'companion'` establish membership. Detail requires the stat header ID to match the requested ID exactly; absent/foreign/mismatched records all fail closed before any chat operation. List does not infer membership from names, titles or native `SessionSummary` (which lacks `agentPreset`). Duplicate claims for a companion ID, including a competing foreign claim, refuse the catalog rather than choosing a path.

The current Host persistence service observes its own newly created, not-yet-materialized native sessions through `list`/`stat`; no disk-only independent reader or create-response membership cache is needed.

Creation time descending, then ID ascending, defines stable ordering. Follow `nextCursor` until null with the same limit to enumerate all rows. Cursors are HMAC-signed with a private per-instance in-memory key and bind offset, limit and the ordered membership/creation fingerprint. Activity/title changes do not invalidate them; membership/creation changes produce `companion/cursor-stale`. Cross-instance replay, tampering and limit changes fail closed. Restart/disposal invalidates old cursors.

Limits: 4096 input snapshots, 100 rows per page, **32 KiB UTF-8 business DTO**. Native RPC framing adds its own envelope. A trusted direct `createCatalog(persistence, { maxBytes })` test seam may lower the DTO budget to 1 KiB, never raise it. Budget splitting always preserves continuation and progress for header-only rows; later title enrichment must preserve that invariant. The native HTTP carrier's existing global request-body cap is unchanged.

## Security boundary

Physical `/api` and `/api/remote.mux` admission belongs to installed native Connection/Gateway: trusted Host, same-origin browser markers and authority-bound authenticated cookie. No alternate bearer authentication, CORS relaxation or independent auth middleware is introduced. Native clients must privately exchange the legitimate startup login URL for a cookie and retain its authority; never log URL tokens or cookies.

This is a **product catalog boundary**, not multi-tenant authorization. Other native `/api/session/*` endpoints remain available to the admitted OS operator. A native UI must verify `detail` before retaining/restoring/deep-linking a chat ID and before using ordinary native chat contracts. A verified header is neither liveness evidence nor permission for session intervention; foreign-session control remains subject to existing native policies and approvals.

## Validation

```fish
node --test plugins/companion-api/*.test.mjs
frontend/mobile-companion/node_modules/.bin/eslint --config frontend/mobile-companion/eslint.config.mjs plugins/companion-api/*.mjs --max-warnings=0
```

Tests use isolated metadata, public Cordis/Gateway services and synthetic native JSONL sessions under `.dumps/session-tests`. They verify strict inputs/outputs, membership, complete bounded pagination, cursor drift, native held-writer refusal, actual archive disappearance from native stat/list, sanitized filesystem error responses and uncertain post-move cleanup. Model writes use fixtures only: no actual default switch, OAuth change, real session removal or LLM call. End-to-end live authenticated deployment/phone acceptance remains a separate owner-authorized step.
