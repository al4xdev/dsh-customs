# Task 5 — Page-bound DSH Browser with stable Playwright

## 0. Status, authorization, and reading this document

This revision 4 fully replaces revision 3, preserving its contracts, rules, limits, and detailed matrix, with the backend change explicitly approved by the owner after the G3 spike. The owner selected via `ask_user_question` the option **“Playwright estável direto (Recommended)”** (Direct stable Playwright) after reproducing mutation on the wrong page by the upstream MCP. It is neither a silent fallback nor a change authorized by a subagent.

The owner authorized implementation and, upon completion of validation, activation across **all managed profiles: `dsh-tui`, `headless`, `web`, and `tui`**. They also instructed to recoverably remove **only the old `playwright` skill at the end**, **without creating a replacement skill or any new skill**. The `playwright-mobile-media` skill and others must not be removed. In this editorial sub-step only the plan artifact is revised; execution remains coordinated by the parent session.

This document defines architecture, public contracts, ownership, security, modules, and acceptance. Examples remain proposed API until implementation/validation. Evidence from the alpha spike does not prove execution on stable Playwright: repeat the necessary gates. Explicit gates do not authorize improvising another architecture.

During execution: reuse the active parent goal, update it to this exact revision after approval, record todos per phase, gather evidence, and only close the task when definition of done criteria are demonstrated. Any material change to architecture/core, privilege escalation, or removal of requirements returns to the owner.

## 1. Objective and main decisions

Browser is a capability maintained by the DSH environment, reusable across projects/models. Agents should not install Playwright, write ad hoc scripts, or scatter profiles, screenshots, and videos across the product just to browse.

Decisions approved/proposed within the authorized scope:

1. **ONE native `browser` tool**, with `operation` as a hierarchical path and `args` validated per operation. Logical tree navigable through the tool itself (`help`, `describe`, `capabilities`), without depending on provider-specific discovery.
2. Registration of the root in the profile/root registry of DSH, **not a separate contribution within each Agent**. The root is inherited by agents, so child allowlists can genuinely exclude it. State and authority remain per-Agent, never global per cwd.
3. Native gateway → private official **MCP SDK v2 client** → worker with official **MCP SDK v2 server and an internal root** → **direct stable Playwright `1.64.0`**, with owned Browser/BrowserContext/Page. No additional leaf registered in ToolRuntime/model. Other DSH tools remain native and unchanged.
4. Every effect, observation, and capture receives a **concrete public Page bound to owner/session/document**, not currentTab, title, URL, or tab index. **ZERO embedding of `@playwright/mcp`, ZERO SDK1/InMemory pair, ZERO RCE/free-form code templates, ZERO private exports** in the production implementation of this revision.
5. Screenshots, mobile/touch, and video are part of the delivery. Extras have explicit catalog/availability; there is no promise of supporting every possible request in advance.
6. No `run_code_unsafe`, shell, flags, `_meta`, init scripts, or unconstrained CDP methods in the initial API. No insecure fallback to fulfill a missing capability.
7. Lazy browser: `help`/`describe`/local status do not launch browser or install anything. A worker may exist for an active session; a coding session with no usage does not start worker/browser.
8. Reproducible installation and controlled artifacts, outside trackable product files.
9. Baseline observation uses **public `Locator.ariaSnapshot()` in YAML** plus custom targets/ref registry. Refs are only issued when they can be uniquely bound via public APIs to a role/name locator or ElementHandle on the correct Page/document; no refs fabricated by parser or dependency on `_snapshotForAI`.
10. Guidance is contained within the tool itself/help/describe, native prompt, and plugin README. **Do not create a new skill**. Remove only the old `playwright` skill recoverably as the final step after validated/activated integration.

Do not confuse tool count with total cost: a single root reduces schemas sent, but discovery and responses also cost tokens. Measure within the same flow before claiming savings.

## 2. Evidence and corrections relative to the previous plan

### 2.1 Observed DSH

Packages resolved via realpath of the active installation; observed npx path does **not** become a dependency or hardcoded path. Observed `dsh-tools`: `0.2.0-rc.2`.

- `dsh-tools`: native registration, scopes, guards, pre/post-execute, canonical output, `native`/`ptc`/`both` modes, and `presentAs` per Agent/scope.
- Restriction filters **inherited** contributions, not those registered in the scope itself. Therefore, registering browser again on the child can bypass its allowlist. The global inherited root avoids this composition failure; stateful operations still require a valid `exec.agent`.
- Standard MCP bridge registers discovered tools individually. Setting up flat Playwright and adding a facade does not hide leaves or reduce their cost. The r4 implementation does not mount upstream Playwright MCP.
- `ToolSchema.deferLoading` and `toolUpdate` metadata exist, but observed pi-ai rejects deferred loading; routes without support remove the flag and make tools immediate. It is not a portable solution, nor proof of a native tree/search API.
- PTC exposes `run_code` + generated tool SDK. It operates per whole Agent, not a solution to hide only browser while keeping the rest native. Do not enable PTC globally in this task.
- DSH JSON Schema has a strict subset: `type`, `properties`, `required`, boolean `additionalProperties`, `items`, `enum`, `const`, `oneOf`. Do not assume `pattern`, limits, `$ref`, or `anyOf` in the wire schema. `defineTool` validates in the body, after the pre-hook: per-operation validation must also take place **before the policy decision**.
- Native success contains `value`; native failure does not promise `value`. Do not turn deny/abort into JSON success `{ok:false}` merely to uniformize envelopes.
- Public attachment APIs provide `saveImages`, `saveImage`, reading, and serializable references; `llm.resolveModelInfo` allows checking image support on the current route model. Native render can emit `{type:'image', attachment:ref}`. Do not copy private helpers from the MCP bridge.

### 2.2 Selected versions and MCP history

| Component | Decision / evidence |
| --- | --- |
| **Stable Playwright** | **`1.64.0` selected by owner for direct backend**, with compatible core/browsers/encoder; runtime of this combination still needs validation |
| **MCP SDK v2** | client/server/core `2.3.1`, private host↔worker boundary; handshake/stdin/stdout/cancellation still require real proof |
| Historical `@playwright/mcp` | `0.0.83`, gitHead `f183dad4a52965583e3cc1d59b88cdc279e2e57d`; used only in rejected spike and historical references, not a production r4 dependency |
| Historical `@playwright/cli` | `0.1.22`, possible external ergonomic benchmark, not an execution route |
| Historical MCP/CLI dependency | `1.64.0-alpha-1790635538000`, core gitHead `e8149b8257d32dcf8f72573ecc43e72439da7080`; not a transitive override/pin for the new implementation |
| Historical MCP SDK v1 | `@modelcontextprotocol/sdk` `1.32.1`; in-memory pair tested in spike, **do not integrate into production r4** |

Effective Node: 20+ for selected stable Playwright / SDK v2. New production graph uses direct stable pin, not wrapper alpha override. Historical scratch retains its own pins/lock for reproduction; do not alter the spike to pretend it tested stable.

Historical findings that remain useful for contract design, not authorization to reuse rejected backend:

- `createConnection(config, contextGetter)` was a public export of the investigated MCP version; its use is **removed from the r4 architecture**. Do not import `coreBundle`, `BrowserBackend`, `Tab`, or other internals.
- Supplied context required `isolated:false` in the alpha implementation; real isolation came from owned/incognito `browser.newContext()`. In r4, create this public context directly, without wrapper flag/selector.
- MCP screenshot with explicit filename could fail to include an image block. In r4, produce buffer/file via public Page.screenshot and deliberately project via DSH attachment.
- Upstream `--output-dir` did not control all filenames. Paths and quotas remain custom responsibility; eviction after the effect is not a hard quota.
- MCP video was context-wide, not per-tab. R4 does not use that tool; any extra context-wide capture requires custom implementation, explicit scope, and per-Page artifacts.
- Public API `page.screencast.start({path})` genuinely saves WebM video, since 1.59; `fps` since 1.64. Frame stream without file is not video delivery; Screencast with validated file is.
- `recordVideo` requires context configuration and closure to flush; do not simulate start/stop by silently recreating context.
- MCP trace produced live artifacts, not necessarily ZIP. R4 uses public `context.tracing.stop({path})` for ZIP; no automatic live upstream adapter.
- Public touchscreen provides tap. Swipe is not mouse drag/wheel or synthetic dispatch. Chromium adapter via closed CDP must prove trusted events and scroll/gesture effect; WebKit/Firefox do not inherit this capability.
- Upstream caps were not a security barrier: core included `browser_run_code_unsafe`. R4 does not load upstream catalog; WebMCP/page-provided tools remain forbidden as an authority source.

### 2.3 Executed spike, blocker, and owner decision

Ignored scratch: `.dumps/tasks/task05-backend-spike/`. Complete evidence in `RESULT.md`, `output/report.json`, `output/selection-race.json`, `probe.mjs`, `selection-race.mjs`, `run-history.json`, and image/video/trace artifacts.

In the historical alpha graph, G2 passed: public factory, matched SDK1 pair, lazy listTools, and an owned incognito context. G5 passed in local fixture: screenshot bytes, trusted touch/CDP swipe, public same-context video/trace; measured final WebM 392×852, 25 fps, 2.28 s, inspected frames with count 0→1→2, and valid ZIP CRC. This is historical evidence, not conclusion of stable/DSH gates.

**G3 failed in a reproduced manner:** closing selected Page after request acceptance and before upstream dispatcher, using public Transport.onmessage callback in test, caused `browser_click` to respond `isError:false` and increment the counter of **another surviving Page**. `selectedClosedBeforeDispatch:true`, `survivorCount:1`, `unexpectedOtherPageEffect:true`; expected 0 assertion failed. The pages had identical URL/title; sequential tests with popup/close/reindex had passed and were insufficient. Call locks do not block lifecycle events, and upstream currentTab provides no public binding to the expected Page.

The owner was consulted after this evidence and approved **“Playwright estável direto (Recommended)”** (Direct stable Playwright). Preserve r3 and scratch as history; r4 eliminates currentTab/SDK1/embed, does not reclassify the failure as a pass, and does not silently execute a different architecture.

## 3. Component and boundary design

```text
Model / Agent (native; PTC only if already selected by owner)
  |
  | ONE browser {operation, path?, sessionId?, pageId?, args, catalogRevision?}
  v
DSH ToolRuntime — inherited root, filter per Agent, log/callId, and cancellation
  |
  +-> pre-execute / guard browser
  |     bounds -> manifest -> schema leaf -> effects -> policy/ask/deny
  |
  v
Native Gateway
  +-> local meta-ops: help / describe / capabilities
  +-> broker per exec.agent: owner, generation, quota, lifecycle
  +-> host FS/policy: upload staging and artifact export
  +-> native projection: text + attachment refs + native error
  |
  | private official MCP SDK v2 client, stdio, no shell / public server
  v
Owned Worker of Agent — SDK v2 server, internal root API
  +-> handshake versions / manifestHash / owner
  +-> revalidation + queue/locks + target registry + artifact/capture manager
  |
  +-> STABLE Playwright 1.64.0, direct public imports/APIs
         Owned Browser -> owned incognito BrowserContext -> custom Page registry
         each request resolves ONE concrete Page; no upstream currentTab
         observation -> Locator.ariaSnapshot YAML + custom refs/targets
         interaction -> Locator/ElementHandle bound to Page/document
         screenshot -> guarded buffer/file
         touch -> tap / Chromium CDP with closed commands
         video -> page-scoped Screencast
         trace -> context-scoped tracing ZIP
```

Boundaries:

- DSH/tools/cordis/scope/attachment services resolved in host graph. Do not load second copy of peers identifying scopes.
- Dependencies of stable Playwright, validators, and worker SDK v2 belong to pinned worker checkout/package. Nothing borrowed from private DSH/Claude cache.
- SDK v2 client/server/core at boundary use compatible versions. Only JSON/protocol data crosses host↔worker; no SDK1/InMemory/createConnection or Page objects transported to host/model.
- The worker sees managed scratch and staged copies; does not receive product root as cwd/default roots.
- The model does not choose owner, grants, `_meta`, cwd, scripts, flags, executablePath, or transport.
- One Browser instance per worker; isolated contexts per session. No sharing between Agents. Initially up to two sessions per Agent, subject to global limits; cross-Agent pooling optimization is out of scope.
- Fixed probe/readiness/geometry functions are trusted adapter code using public APIs, not LLM scripts, RCE templates, or Playwright expression strings.

### Controlled alternative choices

Backend switch was **decided by the owner**; there is no dynamic selection between MCP/CLI/stable. If stable Page-bound, SDK2 stdio, or public observation does not satisfy a gate, halt, record cause, and return to owner. Do not reinstall SDK1/MCP, use private APIs, or start a second engine as a workaround.

Public MCP facade + native bridge is not an automatic fallback; any change to native/global root and inherited restrictions requires a new decision. Official CLI can serve as token/ergonomics comparison baseline, not execution route or license to install skills. PTC/deferred loading are proven optional optimizations, not default architecture changes.

## 4. Public API: one tool, not a monster-schema

### 4.1 Minimal wire envelope

```json
{
  "operation": "media.screenshot",
  "sessionId": "bs_example",
  "pageId": "bp_example",
  "catalogRevision": "bc_example",
  "args": {"mode":"viewport","format":"png","scale":"css"}
}
```

Conceptual wire schema, within DSH subset:

```json
{
  "type":"object",
  "properties":{
    "operation":{"type":"string"},
    "path":{"type":"string"},
    "sessionId":{"type":"string"},
    "pageId":{"type":"string"},
    "catalogRevision":{"type":"string"},
    "args":{"type":"object","additionalProperties":true}
  },
  "required":["operation","args"],
  "additionalProperties":false
}
```

Open `args` on the **wire** is not open on the executor. Each operation has its own mandatory schema/semantics. Do not use a giant enum, union of all leaves, silent aliases, redundant action field, or thousands of optional parameters.

Rules:

- Exact, case-sensitive `operation`; leaf uses curated dotted path. No pass-through of unknown MCP/Playwright name.
- `path` only in `help`/`describe`; forbidden in execution. IDs accepted only where descriptor permits; do not ignore improper fields.
- `catalogRevision` is optional drift detection, not an approval token. Reported drift returns `CATALOG_CHANGED` prior to effect.
- Mandatory `args`, even `{}`; no batch/array operations in MVP. One call corresponds to one auditable decision.
- Preliminary bounds on bytes/depth/strings/arrays precede AJV and path resolution. Since host may log arguments before hook, this does not guarantee huge input never enters transcript.

### 4.2 Catalog navigation

```json
{"operation":"help","args":{}}
{"operation":"help","path":"media","args":{}}
{"operation":"help","path":"media.video","args":{}}
{"operation":"describe","path":"media.video.start","args":{}}
{"operation":"capabilities","args":{}}
```

- Help root: immediate branches and short summary; not all schemas.
- Help branch: immediate children, purpose, availability, and summarized effects. Optional text search only on curated catalog.
- `describe`: single leaf, input/output schemas, required refs, defaults, limits, effects, availability/reason, version/hash, and short example.
- `capabilities`: local versions/preflight, installed dependencies, engine support, provider image support, limits, and known state. Does not launch browser to prove capability; distinguishes `declared`, `verified`, `unverified`, `disabled`, `unsupported`.
- Discovery does not grant permission or reveal cookies, personal profiles, tokens, or credentialed endpoints.
- Help: default 12 / max 30 children, cursor bound to owner/path/revision, text up to 8 KiB. Describe: up to 16 KiB; exceptionally large schemas use spill accessible via artifactId, never silent truncation that invalidates schema.
- Do not require describe before every call; root and catalog remain prefix-stable. Policy/runtime status do not generate gratuitous schema churn.

### 4.3 Single source of descriptors

Shared versioned host/worker manifest generates catalog/describe/validator/classifier/backend map/test fixtures. Each descriptor contains:

```text
operation, public input/output schema and dialect
required refs / supported engines / capability prerequisites
effects and classifier / explicit defaults / limits
availability resolver / adapter id/version / allowlisted public Playwright mapping
```

Pinned AJV/SDK validators, without coercion, automatic property removal, or silent mutating defaults. Local-only `$ref` resolved at build/bootstrap; no remote fetch / arbitrary import. Explicit defaults produce deterministic effectiveArgs after validation; policy examines same normalization that worker executes.

Public facade schema is stable and does not expose generic Playwright options: IDs, paths, and options are deliberately adapted. Keep public adapter contract separately and test transformation. Full leaf schemas are **returned data**, not DSH/PTC wire schemas. There is no upstream MCP schema/discovery in r4 production.

## 5. Initial catalog and expansion strategy

| Branch | Proposed operations | Availability / notes |
| --- | --- | --- |
| session | open, list, status, close, replace | Core; explicit open before stateful effect |
| page | list, create, close, navigate, back, forward, reload, wait, frames, dialog.respond | Core; concrete Page, no invisible global current tab |
| observe | snapshot, text, attributes, geometry | Core; public ariaSnapshot + custom targets; untrusted page data, limits/spill |
| interact | click, fill, select, check, press, hover, drag, scroll | Core; Page-bound locators/handles, ambiguity not resolved via first/nth |
| mobile | devices, tap, swipe | Public touch tap; trusted Chromium swipe after stable gate |
| emulate | viewport, media, offline | Identity changes via session.replace; viewport does not imply mobile |
| diagnostics | console, errors, requests, request | Public Page/Context events, cursors/filters; sensitive bodies/headers opt-in |
| media | screenshot, video.start/status/stop, trace.start/status/stop | Core screenshot/video; trace opt-in; explicit scopes |
| files | upload, downloads.list/status | Authorized/staged upload; download disabled in default context |
| artifacts | list, inspect, export | Core, separated from live handle; controlled paths |
| advanced | pdf, routes.add/list/remove, actions.start/stop, auth.import/export, session.attach/detach | Extras disabled/unsupported until public API, gate, and specific authorization; no private codegen |

No `advanced.run_code`, unconstrained evaluate, arbitrary HTTP request, or LLM-supplied CDP method in baseline. Geometry/text/readiness use fixed internal functions, not page scripts. If owner requests non-representable capability, answer missing capability and propose reviewable extension; do not automatically escape via bash/Python.

New APIs/dependencies/external tools do not automatically enter authorized tree. Changes require descriptor, classifier, schema, output/paths, and tests. Page-provided tools / WebMCP do not escalate privileges.

## 6. Canonical output, multimodal, and failures

### 6.1 Success

```json
{
  "apiVersion":"1",
  "operation":"media.screenshot",
  "callId":"host-owned",
  "catalogRevision":"bc_example",
  "status":"completed",
  "refs":{"sessionId":"bs_example","pageId":"bp_example","generation":1},
  "data":{"mode":"viewport","coordinateSpace":"css-viewport"},
  "artifacts":[{"artifactId":"ba_example","mime":"image/png","bytes":12345,"width":393,"height":852,"state":"finalized","path":"managed-existing-path"}],
  "effects":[{"kind":"write-managed-artifact","state":"applied"}],
  "warnings":[],
  "imageRefs":[]
}
```

Values above are illustrative. Root output uses DSH subset; leaf-specific `data` is validated in worker/host before projection. IDs/callId originate from host/broker, not model. Internal error/success schema in worker protocol does not alter native DSH failure contract.

- `completed`: expected effect finished and artifacts finalized per verification.
- `partial`: genuinely partial effect, with facts, partial artifacts, and recovery; never a masked denial or incomplete video declared ready.
- `effects` records `none`/`applied`/`partial`/`unknown`; unknown does not authorize replay.
- Normal response summarized/bounded; do not automatically attach full snapshot after every interaction.

### 6.2 Screenshot visible to model

- Worker returns verifiable bytes/image content and metadata, separated from original artifact.
- Host checks current route `session.requestHeader`/model, not frozen route from creation. Require `inputModalities` with image and public AttachmentStore.
- Use public APIs `attachments.saveImages` and output.render with image attachment refs. Do not keep base64 image data in canonical value/transcript; serializable references and metadata suffice.
- Original artifact and normalized attachment are distinct. Normalization may downscale pixels; preserve originalDimensions and report CSS coordinates versus image pixels.
- Absence of image-capable store/model: artifact remains available and response reports `imageUnavailable`; do not fabricate image block or claim LLM saw image.
- Check cancellation before and after save; observed public API does not accept signal for hard-abort of commit. Do not promise atomic cancellation; await quiescence and treat created attachment/file as known effect.
- Video/trace are file deliveries, not magic image blocks. Video inspection uses metadata + frames, not equivalent to model watching video/audio.

### 6.3 Failures and recovery

Use native error / HarnessError from host installation, maintaining durable code and sanitized message. Worker error envelope is converted by gateway; do not claim native failures contain canonical `value`. Native deny / unavailable ask / timeout / abort remain authoritative (`ABORTED_BEFORE_DISPATCH`, `ABORTED`, `TOOL_TIMEOUT`, etc.).

Minimal domain codes: `INVALID_ENVELOPE`, `UNKNOWN_OPERATION`, `INVALID_ARGS`, `UNSUPPORTED_CAPABILITY`, `CATALOG_CHANGED`, `SESSION_NOT_FOUND`, `PAGE_NOT_FOUND`, `STALE_HANDLE`, `STALE_SNAPSHOT`, `AMBIGUOUS_TARGET`, `INVALID_STATE`, `LIMIT_EXCEEDED`, `ARTIFACT_PATH_DENIED`, `BACKEND_UNAVAILABLE`, `BACKEND_ERROR`.

Safe internal diagnostics: operation/callId, bounded fields, effectState, retryable flag, and proposed recovery. Message to model includes only facts/recovery without raw tokens/headers/stack. Foreign IDs answer not-found without revealing neighbors. Do not turn authorization violation into status:error success. Partial success is permitted only with known partial result; unknown failure is error with guidance to observe before repeating.

Do not promise universal error JSON delivery across third-party policies. Validate native observability / PTC / replay during gate.

## 7. Pipeline, policy, and handshake

```text
1. ToolRuntime resolves root visible to Agent (native allowlist/guard)
2. Pre-hook validates bounds and envelope; exact lookup in manifest
3. Leaf AJV + refs + revision + effectiveArgs; classify real effects
4. Administrative policy + session effective policy + ask when required
5. Body revalidates, resolves owner, and acquires context queue/lock
6. Recheck state/generation/policy epoch/quotas and capture bound Page prior to effect
7. Validated worker SDK2 handshake; revalidate request/manifest/refs/limits
8. Public adapter executes ONE operation on concrete Page/Context, with deadline/cancellation
9. Validate/map output, register artifacts, project image/error
10. ToolRuntime records canonical outcome and auditable facts
```

- Authorized root does not authorize all leaves. Classifier uses normalized operation+args and effects, not third-party readOnly annotations.
- Pre-hook and body use same schema source; worker repeats validation and limits. Operation without classifier, unknown, or with manifest mismatch is denied prior to effect.
- Do not emit fake pre-execute with virtual name, recursively call browser, or invent native leaf logs. Private SDK2 is body I/O, not ToolRuntime subdispatch.
- Manifest/schema/adapter hashes and relevant policy epoch are verified host↔worker. Do not include secrets in exposed hashes, or permit `approved:true` / owner `_meta` in public input.
- Worker internal MCP API carries normalized public request + execution context **injected by host**: opaque owner, generation, manifestHash, callId/rootCallId, deadline, and permitted policy snapshot. None of these authorities is a model-passable field.
- Owned process/stdin, no HTTP listener / exposed CDP. Worker trusts private host channel, not page payload. Separate process alone is not containment against code running under same user with unrestricted shell access.
- If policy changes while awaiting lock, revalidate; grant-once does not become standing grant. Owner store cannot be chosen by model IDs/cwd.
- `isConcurrencySafe`: false for stateful initially; true only for proven pure local meta-ops. Locks protect calls/cleanup, but do not prevent close/navigation events: concrete Page is the effect binding, not mutex/current tab.
- After resolving Page, do not re-query "first/current/neighbor" after await. If it closes/crashes/navigates invalidating document/ref, fail with known/unknown state, without retargeting/retrying on another Page.

## 8. Effect classes and real host policies

| Class | Examples | Handling |
| --- | --- | --- |
| discovery/status | help, describe, capabilities local | No browser/installation/external effects |
| observe-page | snapshot/text/geometry | Untrusted content; may read sensitive data from authorized page |
| navigate-network | navigate/reload/open URL | Network/redirects/localhost; do not promise GET without effects |
| mutate-page | click/fill/select/press/touch | May submit/delete/publish; sensitive workflow authorization still required |
| capture-managed | screenshot/video/trace | Writes disk, quotas, and retention; not read-only merely by third-party annotation |
| upload/download/export | files/artifacts | Host FS, staging, destination, and authorized specific data |
| auth/profile/attach | auth.import/export, personal Chrome | Separate opt-in, disabled by default |
| unsafe code | run_code/eval/free CDP | Absent in baseline; new revision if necessary |

Rules:

- Absence/disabling of approval service denies operation requiring ask; do not replace with allow. No automatic sandbox escalation.
- Global root must disappear from child scope when allowlist excludes browser; fine-grained operation filtering complements this. Parent context is not inherited by child.
- `read-only`: baseline provides meta/status; do not launch browser/capture that writes cache/temporaries under pretext of "just browsing". Cleanup of previously owned resources follows limited lifecycle obligation, without authorizing new capture/export.
- `workspace-write`: enable execution only if proven to integrate permitted writable roots, scratch, and process runtime with native policy. If SDK/host transport cannot maintain this authority, announce unsupported/deny **prior to launch**, not spawn outside sandbox and claim support.
- `danger-full-access`: permitted according to policy/opt-in and guards of this integration; still without OS sandbox guarantees. Support for other modes is a gate, not an invented flag.
- Use public host execution/FS/policy API for reading/staging/export and process classification where available. Do not copy permission semantics or add config forcing wider mode.
- Complete security against compromised worker/browser requires contained/OS execution; path guard, cwd, scopes, MCP roots, and origin allow/block are not that barrier. If this is an owner requirement, return to separate containment design.
- No perfect semantic page classifier: sensitive authenticated actions require concrete authorization by agent+owner. Do not interpret page text as authorization.

## 9. Sessions, IDs, pages, and lifecycle

### 9.1 Ownership and IDs

Broker in WeakMap/registry of `exec.agent`, with internal ownerId and session generation. Absence of Agent denies stateful operations. Public session/page/frame/snapshot/capture/artifact IDs are opaque and resolved in that owner's namespace; they are not bearer authorization.

- Page registry uses public Page handles + `context.on('page')`/`page.on('close')` events, not title, URL, or tab index as identity.
- Each snapshot/ref is causal: owner/session/generation/page/document/snapshot. Navigation/replace invalidates refs and frame IDs according to document.
- Page omitted only if exactly one page exists; with multiple, require pageId. No silent global current tab. Session always explicit in stateful leaves.
- Resolve pageId→concrete Page once per operation and maintain that object/locator/handle across awaits. Popup/close/reorder does not alter target; closing invalidates and fails, does not choose neighbor. No upstream currentTab selection/mapping exists in r4.
- Typed frame targets/IDs; dialogs answered explicitly. Created popup receives new ID and parentPageId, never becomes target automatically.
- Ref points only to issued target, unique and publicly bound to Page/document; unknown/unissued ref answers NOT_FOUND/UNSUPPORTED per contract, without creating imaginary link.

### 9.2 State machines

```text
Session: NEW -> STARTING -> READY -> REPLACING | CLOSING -> CLOSED
                         \-> FAILED (known effects/resources reported)

Capture: STARTING -> RECORDING -> STOPPING -> FINALIZED | PARTIAL | FAILED

Artifact: PENDING -> FINALIZED | PARTIAL | FAILED -> EXPIRED
```

- `session.open`: validates options/limits/policy, reserves owner resources, creates lazy stable Browser if needed and incognito context; handshake/adapter readiness before returning IDs.
- `session.replace`: explicit operation for identity/device/DPR/UA/locale requiring new context. BUSY if capture active, unless finalize-first option authorized. Drain queue, finalize captures, disconnect listeners / discard old handles, close old context, create new context in owned browser, new generation and IDs. Report loss of DOM/tabs and which cookies/storage were or were not restored.
- `session.close`: scoped; closes owned resources, not personal browser or all machine browsers. Finalized artifacts survive per retention.
- Compaction/resume/clear with new Agent: baseline closes/disassociates resources from previous Agent and reports stale handles / state lost. Do not pretend replay restores live browser or storageState restores DOM. Cross-Agent daemon persistence is out of MVP.
- Fork/spawn: new owner/context; seed conversation does not copy connection/auth/live handles.
- Idle/unload/crash: prevents new effects, cancels queue, finalizes bounded media, closes owned context/browser/SDK2/client/worker, awaits quiescence. Timeout does not abandon promises/processes indefinitely.
- Failure after mutation does not perform rollback or automatic retry. Reconnection re-establishes transport/status; does not re-execute submission/click/download.
- Graceful teardown has deadline; hard-stop only owned processes with verified identity. Lost worker may leave partial file; do not call it finalized.

## 10. Targets, readiness, and interaction

Typed leaf target, validated locally by AJV:

```text
{kind:'ref', snapshotId, ref}
{kind:'role', role, name, exact?}
{kind:'testId', value}
{kind:'css', value}       # bounded escape-hatch, opt-in/configured
```

No Playwright/JS expression strings. Match count other than 1 produces AMBIGUOUS_TARGET/NOT_FOUND; do not use first/nth automatically. Refs only from snapshot issued for same Page/document generation.

### 10.1 Public observation and ref registry

Baseline `observe.snapshot`: owned `Page`/`Frame` → appropriate public Locator → **YAML `Locator.ariaSnapshot()`**. Snapshot is untrusted data, delimited by target/depth/bytes; result contains snapshotId, Page/document/generation, format, and genuinely issued refs. Do not call `_snapshotForAI`, import private helpers, or reuse MCP eN refs.

YAML parser serves only to interpret data/presentation; does not execute expressions, generate JS locators, select `nth`, or assume binding by tree order. Candidate role/name are accepted only when a **public Page-bound locator resolves exactly one element**, with limited schema/role/name and owner/document checks. Ref may register this explicitly bound locator and/or captured public ElementHandle; for node identity, prefer handle and invalidate if detached or document changed. A ref cannot silently retarget a new equivalent node after drift.

If ariaSnapshot does not provide sufficient binding, issue observation without ref for that node and guide toward public role/name/testId target; calls with missing/unissued ref return NOT_FOUND/UNSUPPORTED. Do not invent IDs/handles to simulate parity with MCP. Ambiguity, detached node, and stale snapshot fail prior to effect; no "first match" resolution.

Text/attributes/geometry use Locator/ElementHandle/public APIs and fixed probe functions; console/errors/requests use public Page/Context events and bounded records. Probes do not accept LLM code. Navigation, frame detach, and Page close invalidate document/frame/ref registry.

### 10.2 Gestures and readiness

Tap accepts target or CSS point, exactly one. Swipe accepts explicit CSS points and bounded duration/steps. Coordinates are relative to main frame viewport; iframe/offset requires known transformation, not guess from normalized screenshot.

Wait/readiness is explicit: element/text/state, fonts/images when requested, deadline. `networkidle` is not universal guarantee of ready app; do not rely on indefinite sleeps. Capture returns verified conditions or timeout. Do not hide banners/data or alter UI by default; masks/demo state require explicit selection.

## 11. Desktop, mobile, and emulation

`session.open.args` accepts curated subset: engine/headless and emulation via preset **or** full custom. Do not accept generic launchOptions/contextOptions, executablePath/proxy/ignoreHTTPS/noSandbox from model.

- Default desktop: headless Chromium, viewport 1280×720, no touch/mobile.
- Canonical mobile for custom: 393×852, DPR 2, true isMobile/hasTouch, and explicit effective UA/preset. Prefer official devices; preset name is validated against pinned stable version, not invented.
- Documented device + overrides merge; return actual engine, viewport, screen, DPR, hasTouch, isMobile, UA, orientation, locale/timezone/media.
- `emulate.viewport` changes viewport, not UA/DPR/touch/mobile. Identity change via `session.replace`.
- `emulate.media`/offline may operate on existing context/page when API supports it. Geolocation/extra permissions are opt-in capabilities, not default grants.
- `mobile.tap`: public Playwright touchscreen with hasTouch; not mouse click alias.
- `mobile.swipe`: public Chromium adapter `context.newCDPSession(page)` using only Input.dispatchTouchEvent with closed list of types, pointer id, steps, and finally end/cancel. Capability only becomes verified after fixture on **stable** proves touch/pointer isTrusted and expected scroll/gesture. WebKit/Firefox unsupported for this adapter; never synthetic fallback / hidden mouse.
- Emulation does not prove physical Android/iOS, system bar, native keyboard, permissions picker, or app shell. Physical/ADB access is a different capability.

## 12. Screenshots

Proposed public input:

```text
mode: viewport | fullPage | element
format: png | jpeg | webp
scale: css | device
target mandatory only in element mode
clip? / maskTargets? / readiness? only in declared combinations
```

No unconstrained filename/path. FullPage+element/clip incompatible; conflict is schema/semantic error, not implicit preference.

Public adapter **`Page.screenshot` on owned Page** produces guarded buffer/file + image. Do not use upstream MCP tool / filename / inline image in r4 production. Host performs explicit admission/projection as defined in Section 6.

- Validate dimension/DPR/pixel budget beforehand, size afterward, and readiness conditions.
- Giant fullPage is not silently cropped; deny with suggestion of viewport/element/clip.
- Metadata: CSS viewport, original pixels, scale, format, page/generation, capture time, and artifactId. Normalized attachment reports its own dimensions.
- Mask is opt-in via authorized targets; not universal redaction guarantee.
- Test layout/composition by reading the real image, not just screenshot path.

## 13. Video, trace, and action recording

### 13.1 Page-scoped baseline video

Public Screencast adapter with owned path on concrete Page; start/stop do not recreate context. This is the baseline. Extra context-wide capture is a separate/optional implementation, **explicitly distinct**, not reused MCP.

```text
media.video.start args:
  scope:'page', size? {width,height}, fps?, cursorPreset?, maxDurationMs?
  returns captureId, scope, pageId, generation, state, effective limits
media.video.status/stop args:
  captureId
```

- Size is max bounds/aspect ratio when API defines it as such; return measured effective dimension, do not promise exact 1280×720. Alpha spike showed canvas padding and odd width rounding; repeat on stable and inspect frames before declaring usable media.
- Reserve ID/path/quota before starting. Duplicate start on same recorder => INVALID_STATE; stop on same captureId may return already-finalized result, without re-executing effects.
- Auto-stop by duration, quota/idle/close follows state machine; do not keep recorder running indefinitely after cancellation.
- Stop awaits flush, stat/metadata/container/duration/dimensions, and representative frames. If encoder/browser died, return factual partial/failure.
- Closed/crashed Page still requires verified finalization/path. No audio/camera/desktop recording in baseline.
- Configurable FPS only if runtime supports it; Firefox/WebKit may produce fewer frames. Availability of managed FFmpeg encoder is part of preflight; do not automatically install system packages.
- Cursor/action overlay is curated preset, not LLM HTML/CSS/free code; if pacing alters actions, declare in result.
- `recordVideo` is fallback only as capture session explicitly created with initial options and state loss reported; never silent recreation of existing session.

### 13.2 Optional page-bound context-wide

If implemented via direct public adapters, declare `scope:'context'`, existing/future pages, and `artifacts[]` per pageId. Record failures on future pages; planned path does not count as success. Limit tabs/bytes and permit capture only of authorized Pages in context. Do not expose this as exclusive recording of current tab. Disabled/unsupported until specific gate; do not reintroduce start_video MCP.

### 13.3 Trace / actions

Trace is opt-in due to snapshots/network/auth. Baseline ZIP via public `context.tracing.start/stop({path})`, context-scoped. Sources:false by default. Snapshots/screenshots are explicit options; redaction does not necessarily eliminate secrets.

Live trace is a capability different from ZIP, with multiple files/resources, not baseline. Do not call live directory trace.zip. Library tracing does not automatically record assertions from a test runner. No private API or upstream trace to fill gap.

Initially, trace+video and recordVideo+Screencast are mutually exclusive on same recorder/context where configuration conflicts. Only permit combination after size/ownership/flush testing; do not allow existing recorder to silently ignore size.

Action recording / codegen is not video. Opt-in extra, possible sensitive data, output in artifact, and no automatic commit of generated test. If no compatible stable public API exists, declare unsupported, do not call `_startRecording`/internals.

MP4/GIF/trim/optimization are optional post-processing with bounded inputs/outputs and declared dependency. They are not part of baseline nor do they authorize arbitrary ffmpeg/shell.

## 14. Artifacts, files, paths, and retention

### 14.1 Layout

```text
managed environment outside repo
  installation/cache/browser binaries
  runtime/<owner>/<session>/<generation>/
    observation-output/  downloads/  uploads-staged/  captures/  traces/

project, only if .dumps is ignored and policy permits
  .dumps/browser/<session>/<capture>/
    local evidence / deliberate export + artifact manifest
```

Worker absolute cwd is private scratch; on host `process.chdir`. Depending on mode/policy, scratch must be within permitted writable roots; environment path is not automatic authorization. If `.dumps` is not ignored, use permitted runtime and notify, without altering gitignore.

Artifact schema: artifactId, internal owner, kind/MIME/bytes, state, existing local path when applicable, origin page/session generation, dimensions/duration, checksum when useful, retentionUntil, and export/attachment relationships. Do not derive authority from page markdown/links or external processes.

### 14.2 All write routes

- Generated, collision-safe names; no model provides backend filename / cwd / _meta / roots.
- Audit screenshot, video, snapshots, console/network, tracing, downloads, storage-state, and popup events. Configured isolated directory does not replace control of every writer/overwrite.
- Verify absolute/relative paths, `..`, symlinks, ancestors, and collisions before opening/publishing. Do not overwrite owner files silently. Path guards do not promise TOCTOU race-free operation against a hostile writer.
- Private dirs/permissions, exclusive creation, and atomic publication when supported. Incomplete files remain pending/partial and are not exported as final.
- Quotas reserved beforehand; watcher/accounting during recording detects overage and finalizes. Without filesystem/OS limits, overshoot is possible: do not call watcher an absolute hard quota.
- Custom cleanup respects retention/IDs and owned resources; do not use library eviction to remove deliverables. No product-wide globbing or kill-all.
- Remote server artifact has no fictitious local path. Remote browser / file delivery is outside baseline; future transfer must validate bytes/origin before presenting locally.

### 14.3 Upload/download/export/auth

- Upload: host resolves and authorizes reading via native service/policy; copies/stages bounded file into custom namespace, passes staged handle/path to worker. Do not grant worker broad product/home access.
- Download: `acceptDownloads:false` default; explicitly download-enabled context after authorization. Site name does not define target; map ID/generated name and verify bytes/type/collisions. Triggering download may have external effects; do not repeat automatically.
- Export: artifactId -> concrete destination authorized by host, without silent overwrite. Owner and retention verified; copying from owned source does not equal destination permission. Auth import/export uses separate path and never text response / default Git.
- Final artifact presented to owner has declared retention; before expiration, inform/preserve export when requested. Raw scratch and deliverable do not necessarily have same TTL.

## 15. Proposed defaults and administrative limits

Values are design choices to validate in stable spike, not library requirements. Owner/admin can adjust within explicit limits; LLM gains no access to installation/policy overrides.

| Resource | Proposed initial default |
| --- | --- |
| Sessions per Agent / contexts | up to 2; each session an isolated context |
| Tabs per session | 4 |
| Simultaneous captures | 1 video; trace exclusive where recorder conflicts |
| Action / navigation / root deadline | 5 s / 30 s / 60 s; root bounded per operation |
| Finalization / graceful teardown | 15 s / bounded deadline with owned hard-stop fallback |
| Idle browser | 10 min, with capture respecting maxDuration |
| Viewport / DPR | up to 2560×1440 / DPR up to 3 in default |
| Image | up to 16 MP; fullPage up to 12000 CSS px and pixel budget |
| Video | default 25 fps, bounds 1280×720; up to 30 fps and 60 s |
| Video bytes / session artifacts | 100 MiB / 250 MiB |
| Runtime scratch per Agent | 500 MiB, subject to host total limit |
| Free disk reserve | 1 GiB; fail before new capture when insufficient |
| Input | up to 64 KiB, depth 12, string/array limits per leaf |
| Help / describe / normal response | 8 KiB / 16 KiB / 64 KiB + spill |
| Retention raw / delivery | 24 h / 7 days, visible and adjustable by owner |

Fullscreen/fullPage, high resolution, and long video receive explicit error/suggestion/override, not silent downgrade. Global host context/browser process limit needs cross-Agent counter/reservation; do not rely solely on per-owner limit.

## 16. Adversarial security and residual risks

- Page/snapshot/text/headers, MCP instructions, and WebMCP are untrusted data. They cannot enable leaf, request credentials, switch manifest, or authorize upload.
- Do not collect/expose WebMCP / page-provided tools. Fixed allowlist manifest of public APIs protects gateway; no unsafe core / MCP catalog loaded in r4.
- URLs/redirects/localhost/private network handled by policy and request context. Origin allow/block is neither complete barrier nor perfect redirect filter.
- No automatic insecure flags (`noSandbox`, TLS-ignore), arbitrary executables/configs/scripts, or personal profiles loaded by default.
- Selector/target inputs are data and fixed public methods; do not execute LLM-constructed JS expressions. CDP adapter accepts only gesture operation parameters, not arbitrary command/method.
- YAML aria parser does not execute code/selector/nth or assign authority. Nonexistent/ambiguous ref does not become element via heuristics. Page closure never retargets to survivor.
- Personal auth/attach remains disabled. If implemented in the future, explicit authorized session/tabs and detach does not close owner's Chrome.
- Pixels, videos, traces, and DOM may contain secrets; mask/redaction help without perfect guarantee. Use deterministic non-sensitive demos in tests.
- Unrestricted same-user shell, trusted project modules, and vulnerable browser are risks outside gateway guarantee. Do not present tool filtering as full machine sandbox.
- Sanitized logs, no raw secrets/base64/credentialed URLs. Even public input may contain sensitive text; document native transcript retention.

## 17. Configuration, installation, and integration with checkout

- New plugin: `plugins/browser`. Activation via `plugins/activation.json` and existing bootstrap, without manually editing mirrors/profiles as source of truth.
- Owner authorized final activation across the **four managed profiles `dsh-tui`, `headless`, `web`, `tui`**, after validation; do not turn `project-mcp` into global reader or alter other plugins/policies to pass gates.
- Proposed config namespace in `.agents/config.json`: `dshCustoms.browser`, validated, preserving managedPlans/other fields. Absence permits profile defaults; project enabled:false denies browser in that project. Project may narrow policy, not widen admin grant.
- Administrative configuration and sensitive opt-ins come from profile/owner; project cannot select executable / unsafe scripts / personal Chrome alone.
- Precedence: admin/preset/session denials + project; quotas by authorized minimum; compatible overrides only where permitted. Reload does not silently alter live manifest: new generation/Agent per documented policy.
- Already configured Playwright MCP: detect diagnostic/duplicate config. Do not eliminate/mutate user server. Explicit choice between existing route and gateway; do not expose both automatically and call it standardized integration. Removal of old skill is not authorization to remove MCP servers/configs.
- Worker dependencies in dedicated package or root checkout lock per gate; **stable Playwright 1.64.0 + SDK2** graph, without MCP wrapper / SDK1. Reproducible bootstrap; do not add packages to inspected product.
- Browser download/installation only as authorized administrative environment operation. Preflight is verification only; missing dependency returns BACKEND_UNAVAILABLE / clear capabilities and does not break coding session.
- Root meta-ops must remain available if backend is absent; therefore native registration does not depend on eagerly imported SDK/Playwright worker.
- Version Node/Playwright/core/SDK2/validator/browsers/encoder and compatibility via matrix. No `npx @latest` in normal path.
- Do not create `.agents/skills/browser`, replacement skill, or install/copy Playwright/MCP/CLI skills. Functional documentation is README and native orientation / help.

## 18. Proposed modules and responsibilities

Names are design; production creation occurs through coordinated implementation, not plan review sub-step:

```text
plugins/browser/
  index.mjs                 global native root, hooks/prompt, lifecycle/plugin unload
  host.mjs                  resolves host peers + public services without identity drift
  config.mjs                precedence/admin/project/read-only preflight
  manifest.mjs              curated public catalog, schemas/effects/adapter metadata
  validation.mjs            bounds/AJV/pure normalization/hash
  policy.mjs                classification, prehook/guard, and effective recheck
  broker.mjs                Agent ownership, lazy worker, reservations/lifecycle
  render.mjs                text/images/errors using public APIs
  host-files.mjs            guarded read/staging/export
  worker/
    server.mjs              private SDK2 MCP server, internal root, and handshake
    sessions.mjs            Playwright stable Browser/Context ownership/state/replace/close
    targets.mjs             public Page/frame/document/ref registries, no currentTab
    observation.mjs         Locator.ariaSnapshot YAML, unique targets, public probes/events
    capture.mjs             video/trace states, finalize, and quotas
    artifacts.mjs           namespaces/writers/manifests/retention
    adapters/               public Page-bound interaction/screenshot/touch/video/trace
  *.test.mjs                pure suites, SDK2 integration, and native contracts
  fixtures/                 deterministic/hostile local pages, closure-race regression
  live-check.mjs            opt-in real host/TUI/providers/browser proof
  README.md                 contract, authorization, installation, limits/recovery
```

No `upstream.mjs` / SDK1 / embed / MCP factory / internal helper is needed. Dependency graph must be acyclic: pure shared manifest/validation; host policy does not import backend; meta-ops do not load Playwright; worker does not import DSH peers; render does not decide authorization. Extract existing utilities only when necessary and with regression test, without broad refactoring of project-mcp/common for convenience.

## 19. Feasibility gates before production delivery

**G0 — Host/authority:** inherited global root, child restrictions, prehook validated prior to effect, native error, policy modes, and process/scratch not bypassing host. If support for a mode is not proven, denied/unsupported in that mode.

**G1 — Schema/provider:** wire open `args` roundtrip across active providers (Codex/pi-ai, Antigravity/Gemini, DeepSeek, and others actually configured). Strict providers may not accept open object: test non-strict adapter with mandatory AJV; if infeasible, return to owner before giant argsJson/schema. Do not convert silently.

**G2 — Stable backend and SDK2 boundary:** public Playwright 1.64.0 imports/types/exports, owned Browser/Context/Page, and lazy lifecycle/close. **Prove real runtime SDK2 client/server handshake + stdio / single root**, manifest/owner/errors/cancellation/quiescence; outer SDK2 was not yet tested by historical spike. Zero SDK1 / embed / private exports / RCE templates.

**G3 — Page-bound failclosed:** resolve owned Page by ID and maintain that object across awaits. Identical URL/title fixture with popup/close/reorder/frame/document invalidated and closure-race **during request/effect** must fail without mutating survivor. Ref only unique/publicly bound; no currentTab API or index/URL/title fallback. Reproduce historical counterexample as inverse regression: survivorCount must remain 0.

**G4 — Multimodal:** real screenshot becomes attachment for image-capable model; models without image support receive diagnostic/file. Native/PTC/replay and storage cancellation respected.

**G5 — STABLE mobile/media:** repeat effective mobile settings, tap, trusted Chromium swipe, finalized per-page video, and trace scope/conflicts on selected stable graph/browsers/encoder. Verified file/container/effective dimension/frames. Historical alpha pass does not satisfy this gate.

Output: short versioned report, capability verified/unverified inventory, baseline tokens/latency, confirmed architecture / gaps, and decision. Gates do not authorize removing requirements or changing architecture again without owner.

## 20. Authorized execution phases

| Phase | Delivery | Dependency / output |
| --- | --- | --- |
| A — stable/protocol bounded spike | G0–G5 with local fixture / ignored temporaries; closure regression and SDK2 stdio runtime | Record differences from historical spike; no premature final activation |
| B — contracts | manifest, wire, validators, errors, help/describe, hashes | Pure suites pass; catalog without eager Playwright |
| C — native integration | global root, policy, lazy broker/worker, lifecycle | Child filters and native/PTC denies demonstrated |
| D — session/observation | public stable, Page/document/ref registry, ariaSnapshot YAML, nav/interact/diagnostics | G3, stale refs without inventing, correct popups/frames/targets |
| E — mobile/media | screenshot/image, mobile gestures, video/trace states | G4/G5 stable + verified real artifacts |
| F — files/limits | staged uploads / export / opt-in download, quotas/cleanup | path/ownership/adversarial/regressions |
| G — rollout | pinned installation, README/help/native prompt, activation across four managed profiles | TUI/providers/profiles and repo hygiene; tested rollback; **no new skill** |
| H — specific final cleanup | recoverably remove only old `playwright` skill, with verified path/identity | Only after validated/activated integration; no replacement and without removing mobile-media/other skills |

Some spike proofs exercise final APIs before phases; this does not mean building the entire solution in the spike. Keep each change small/reversible and update goal/todos. Do not close steps via mocks when they require real runtime.

## 21. Test matrix and acceptance evidence

| ID | Mandatory proof |
| --- | --- |
| API-01 | Only one browser root in schemas(scope); zero Playwright leaves |
| API-02 | Bounded multi-level help; describe single schema/example; no browser/worker launch in meta-op |
| API-03 | Unknown leaf / new backend capability / meta / code / command rejected before effect |
| API-04 | Distinct root/subset DSH and leaf AJV; tested unknown fields / default / coercion / drift |
| API-05 | Active providers roundtrip open args; failure does not terminate Agent; native/PTC share same policy |
| SDK-01 | SDK2 stdio runtime: real client/server handshake / single root / schema / manifest / owner / error / cancel / close, no SDK1 |
| POL-01 | Child allowlist without browser: no schema and UNKNOWN_TOOL before body/worker |
| POL-02 | Child with browser: new owner; parent IDs/auth not accessible |
| POL-03 | Deny / missing ask / read-only / unsupported workspace authority do not cause launch/write |
| POL-04 | Policy changes in queue: recheck; grant-once does not enable another op/params |
| POL-05 | Direct worker malformed authority/manifest/hash/owner rejected; no approved flag from model |
| LIFE-01 | Two Agents same cwd / isolated projects: cookies/tabs/files/captures |
| LIFE-02 | Fork/spawn/compaction/resume/clear communicate state loss/generation without replay of effects |
| LIFE-03 | Unload/startup/crash/reconnect/idle/cancel leave owned resources finalized or known partial |
| LIFE-04 | Concurrent mutations/lifecycle serialized; no reentrancy / recursive browser calls |
| PAGE-01 | Navigate/fill/click/wait local real state; stale/ambiguous without first fallback |
| PAGE-02 | Popup/close/reorder/frames/dialogs hit concrete Page, without trusting title/URL/index as ID |
| PAGE-03 | Closure-race during dispatch/await: Page closes, operation fails closed, and survivorCount==0; no equivalent retarget/ref |
| OBS-01 | Bounded snapshot/text/console/network with cursor/spill and hostile payload treated as data |
| OBS-02 | Public Locator.ariaSnapshot YAML; parser does not execute JS/nth; refs only unique locator/handle Page/document-bound |
| OBS-03 | Unissued / unknown / ambiguous / detached / stale document ref fails; no invented eN or private helper |
| IMG-01 | Valid viewport/fullPage/element/clip + invalid conflicts + explicit DPR/scale/masks |
| IMG-02 | Image genuinely in model context / TUI / PTC, not just path/base64; diagnostic on no-image route |
| IMG-03 | Original vs normalized attachment dimensions, fonts/images readiness, and pixel limits |
| MOB-01 | Desktop/preset/custom assertions for viewport/UA/DPR/isMobile/hasTouch/orientation in stable |
| MOB-02 | Trusted touch tap and Chromium swipe + default scroll in stable; WebKit/Firefox unsupported, no mouse fallback |
| VID-01 | Start -> interaction -> stop produces stable WebM with verified duration/effective dimensions/frames |
| VID-02 | Exclusive page scope; extra context-wide describes all pages/failures/artifacts or unsupported |
| VID-03 | Duplicate start / stop already-finalized / page close / crash / missing encoder / time / bytes / disk / abort |
| VID-04 | Cancel/idle/teardown does not leave endless recording; partial never delivered as finalized |
| TRACE-01 | Real ZIP vs declared/unsupported live, context scope, and multiple artifacts; sources default false |
| TRACE-02 | Trace/video/recordVideo conflict denied or proven combination, without ignored size |
| FILE-01 | Authorized/staged upload; worker receives no unconstrained root/home path |
| FILE-02 | Traversal / symlink / absolute / relative / filename / site-name / collision / overwrite rejected |
| FILE-03 | All writers and spontaneous downloads/popups accounted for; no writer outside artifact manager |
| ART-01 | Artifact metadata matches file/container; remote path not feigned local |
| ART-02 | Retention / pending / finalized / partial / expiry / export / cleanup owned, without deleting delivery/product |
| ADV-01 | WebMCP / unsafe code / init / config / free CDP not enabled via args/caps/discovery; zero private exports |
| ENV-01 | Missing/offline/version-mismatched browser/SDK2/encoder diagnosed without breaking coding |
| ENV-02 | Reproducible lock+stable reinstall / browser binaries / Node version; no @latest runtime / MCP / SDK1 produced |
| CLEAN-01 | Fixture product receives no trackable package/lock/scripts/config/media/cache; git status before/after preserves preexisting dirt |
| LIVE-01 | Real host/TUI: root call, deny, image, file/video, and teardown, not just mock dispatch |
| PROFILE-01 | Activation and root/policy/lifecycle proven in dsh-tui/headless/web/tui without changing other plugins |
| SKILL-01 | Final step recoverably removes only old playwright; mobile-media/others preserved; ZERO new/replacement skill |
| PERF-01 | Prompt + discovery + responses + turns/processes/latency compared in same flow against flat MCP / CLI as benchmark, not backend |

Fixtures without personal accounts / payment / external effects. Unit/schema tests do not execute unknown modules merely to inspect. Captures have deterministic non-sensitive state. Test tools use ignored `.dumps` or authorized temporaries. Opt-in browser/live tests are not implicitly part of every LTS suite.

## 22. Observability, rollout, final cleanup, and rollback

- Root logs already show operation/args/callId; add sanitized backend/owner/capture metadata/facts using existing APIs. Do not invent arbitrary Session events or claim private SDK generates `tools/ptc-dispatch`.
- Durable errors preserve native code; status/recovery do not expose secrets. Report unverified capability instead of claiming support based on README / alpha spike.
- README, descriptions/help/describe, and native prompt teach root, targets, state loss, screenshots/media, and limits. **Do not create/install new or replacement skill**; do not edit unprompted skills to perform migration.
- Update checkout documentation that still calls task 5 experimental alongside the new approved real delivery.
- Rollout authorized for **dsh-tui/headless/web/tui**, via existing manifest/bootstrap, with smoke/root/policy/lifecycle in each profile and TUI testing where frontend exists. A controlled smoke phase prior to expansion is permitted; final delivery must include all four.
- **Specific final cleanup:** verify entry / absolute path and identity of old `playwright` skill (observed base `/home/alex/.agents/skills/playwright`); read/inspect prior to removal according to policy, treat symlink as link, and do not inadvertently delete external target. Use recoverable removal (`trash`) only on the confirmed explicit path. Do not touch `playwright-mobile-media`, project-mcp, or other skills; do not add a replacement. Do this only at the end after verified smoke/activation, record receipt/recovery, and confirm future catalog does not promise removed skill.
- Rollback: disable browser row in manifest via bootstrap, owned unload/quiescence, preserve finalized artifacts, and do not remove personal browser/product. Prior pins / managed cache allow rolling back stable backend version; opt-in auth/profile never destroyed as automatic cleanup. Removed skill has recovery via receipt, not automatic replacement reinstallation.
- Task closure records version/revision, genuinely executed tests, four activated profiles, evidence, skill receipt, and remaining limitations/unsupported capabilities. Merely saving configuration or exposing an empty root is insufficient.

## 23. Out of scope and still conditional decisions

Do not create a generic tool tree framework for all DSH tools, modify core/provider to force discovery, write browser engine / manual MCP / test runner / video editor, automate captcha/2FA, or operate native mobile apps.

Disabled in baseline: personal Chrome/attach, persistent auth/export, unconstrained eval/RCE, remote browser, audio/webcam/desktop livestream, universal support of engines/gestures, persistent daemon across Agents. Extra operations have explicit availability and require review/proof; they do not all need to be implemented for baseline.

Excluded from r4 production: Playwright MCP embed/factory, SDK1/InMemory pair, currentTab selection, RCE templates, `_snapshotForAI`, `_startRecording`, and other private exports. Excluded any new/replacement skill; sole authorized removal is old `playwright`, in final recoverable step.

Conditionals to resolve: outer SDK2 handshake / stdio runtime / authority, stable Page-bound closure/ref failclosed, host workspace-write authority, open object schema in providers, recorder conflicts / encoder in stable. "Not demonstrated" result keeps capability blocked or returns to owner; does not become silent improvisation. The switch to stable has already been decided, but its runtime proof has not yet been inherited from the alpha spike.

## 24. Researched references, history, and limits of proofs

Local evidence: `plugins/project-mcp/README.md`, `index.mjs`, `host.mjs`, `config.mjs`; `plugins/activation.json`, `plugins/README.md`, `package.json`; installed exports/types/implementations of `dsh-tools`, `dsh-llm`, `dsh-llm-pi-ai`, `dsh-llm-deepseek`, `dsh-mcp-client`, `dsh-attachment`, `dsh-tool-fs`. Resolve via running host, not hardcoded from investigated cache.

Preserved history: task 5 r3 hash `970ef77b9ec1b3708ea72ba4d910fb938d3985e4a328f35d556861bd4beb2017`; `.dumps/tasks/task05-backend-spike/RESULT.md`, `output/selection-race.json`, `selection-race.mjs`, `probe.mjs`, `output/report.json`, `run-history.json`. Do not edit historical revision / mirrors directly to erase rejected hypothesis.

Selected and historical references:

- [Playwright stable 1.64.0](https://registry.npmjs.org/playwright/1.64.0), [Locator API/ariaSnapshot](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot), [SDK2 Client](https://registry.npmjs.org/@modelcontextprotocol/client/2.3.1), [SDK2 Server](https://registry.npmjs.org/@modelcontextprotocol/server/2.3.1): pins of r4 architecture.
- [MCP consulted version](https://registry.npmjs.org/@playwright/mcp/latest), [CLI](https://registry.npmjs.org/@playwright/cli/latest), [SDK v1](https://registry.npmjs.org/@modelcontextprotocol/sdk/latest): latest is evidence of historical query, not production dependency / permanent pin.
- [Historical MCP export](https://github.com/microsoft/playwright-mcp/blob/f183dad4a52965583e3cc1d59b88cdc279e2e57d/index.js) and [types](https://github.com/microsoft/playwright-mcp/blob/f183dad4a52965583e3cc1d59b88cdc279e2e57d/index.d.ts): explain spike, do not import in r4.
- [Historical core MCP backend](https://github.com/microsoft/playwright/tree/e8149b8257d32dcf8f72573ecc43e72439da7080/packages/playwright-core/src/tools/backend): context/tabs document currentTab/closure cause; screenshot/video/tracing/response and unsafe/caps are history of risks.
- [Historical public in-memory SDK v1](https://github.com/modelcontextprotocol/typescript-sdk/blob/ff07b001194fe60ee9deb2121cf119057565796d/src/inMemory.ts): do not integrate into r4.
- [Screencast v1.64.0](https://github.com/microsoft/playwright/blob/v1.64.0/docs/src/api/class-screencast.md), [Tracing](https://github.com/microsoft/playwright/blob/v1.64.0/docs/src/api/class-tracing.md), [videos](https://playwright.dev/docs/videos).
- [Touchscreen](https://playwright.dev/docs/api/class-touchscreen), [legacy touch](https://github.com/microsoft/playwright/blob/v1.64.0/docs/src/touch-events.md), [Chromium touch input](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/src/server/chromium/crInput.ts).
- [MCP overview](https://github.com/microsoft/playwright-mcp/blob/main/README.md), [CLI overview](https://github.com/microsoft/playwright-cli/blob/main/README.md): comparison/historical references, not runtime route.

Two initial studies covered contracts/provider/DSH and backend/mobile/media; subsequently, the real isolated spike installed historical pins, launched sandbox-enabled Chromium on loopback fixture, and proved blocker G3 and primitives of G2/G5 alpha. No production/activation/skill was modified by the spike or by this editorial revision. New stable implementation requires its own proofs and follows explicit owner authorization, with recoverable removal of only the old `playwright` skill at the end.

## Definition of Done

One inherited and filterable browser root, compact and useful logical tree, per-operation schemas/policies with no known bypass in tests, **proven Page-bound stable Playwright and private SDK2**, closure/ref failclosed without neighbor mutation, navigation/screenshot/mobile-touch/video functioning in real runtime, inspected and controlled final artifacts, product free of pollution, reproducible installation/teardown, validated activation across **dsh-tui/headless/web/tui**, only the old `playwright` skill recoverably removed at the end and **ZERO new/replacement skills**, with explicit limits. Unproven gate, registered external tool, or uninspected video file do not count as ready integration.
