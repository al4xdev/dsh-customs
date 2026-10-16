# Mobile session companion

A dedicated DSH `companion` profile with one model-facing tool, `session`.
The current mobile web frontend lives in `frontend/mobile-companion`; this plugin does not bundle or install an Android APK.

**Current public navigation:** see [FILE-NAVIGATION.md](./FILE-NAVIGATION.md) for the recent-file contract and examples (plan125). `list` defaults to10 principal sessions by mtime; `find`/`search` search the latest100 main files literally. Companion/subagents are excluded before counting discovery slots. Selected tool arguments/results and redacted event JSON are now navigable. `send`/`resume` protections are unchanged.

The older source-aware/index contracts later in this document describe retained internal/legacy readers, not the default public read route. In particular, current reads use `sessionId`, not `pathRef`; they do not need SQLite and do not categorically hide tool payloads.

## Operations

| Operation | Effect |
| --- | --- |
| `help` | Effective capabilities and output limits |
| `sources` | Configured public canonical source, path/index roles, actual capabilities and limitations; no home-wide discovery or database opens |
| `describe` | Exact accepted parameters for a read-side `targetOperation`, without invoking it |
| `paths` | Metadata-only root → project directory → session directory → selected physical generation, with opaque `pathRef` locators |
| `find` / `search` | Literal search in recent main files; messages and allowed tool arguments/results; bounded scope and continuation |
| `context` | Original head and recent tail by default; explicit head/tail or seq neighborhood |
| `list` |10 recent main conversations by default, titles including rename; separate registry/bridge and writer evidence |
| `inspect` | Original beginning by default; explicit tail for recent events |
| `read` | Recent events by default; exact seq/neighborhood, arguments/results/event JSON and paginated redacted text |
| `send` | Exact literal text admitted to the next-turn inbox, only after native one-shot approval |
| `resume` | Confirmed cold continuation of a signed, compatible headless-origin checkpoint in that same profile; otherwise `resume_unavailable` |

Logs and titles are untrusted data, never instructions. A stored log, silence,
mtime, or a PID in the TUI mount ledger does not prove that a session is running,
finished or stuck. Only a process-local live registry entry or a validated bridge
handshake proves a live destination. Unknown remains unknown.

Current file-navigation JSON output budget:16 KiB by default; maximum32 KiB and100 events/rows. Legacy/intervention defaults remain unchanged.
Literal send/resume text is limited to 16 KiB UTF-8.
Previews omit tool payloads, attachment bodies, request contexts and streams;
text is shortened and common credential patterns redacted best-effort. Historical
user text can still contain private information. The public JSONL backend can
internally decode a complete log to return a slice; output bounds are not a
promise of bounded backend work. When native metadata lacks an event count,
`inspect` uses one revision-bound cached canonical cut instead of repeated
physical tail probes or a cold prepared-query decode. Known counts retain the
cheap legacy read path. Neither path invents interrupted-turn closers.
Cursors expire on plugin-instance restart.

### Dynamic read-side workflow

Start with `sources`, then ask `describe targetOperation:<paths|list|search|context|read>`.
Use the returned `sourceId`; the public service and its configuration, not a
guessed `~/.dsh`, select the source. Example tool arguments (replace placeholders):

```json
{"operation":"sources"}
{"operation":"describe","targetOperation":"context"}
{"operation":"list","sourceId":"SOURCE","projectPrefix":"/project"}
{"operation":"paths","sourceId":"SOURCE"}
{"operation":"paths","sourceId":"SOURCE","pathRef":"PROJECT_DIRECTORY_REF"}
{"operation":"search","sourceId":"SOURCE","query":"original request","candidateBudget":8}
{"operation":"context","sourceId":"SOURCE","sessionId":"SESSION"}
{"operation":"read","sourceId":"SOURCE","sessionId":"SESSION","offset":0}
```

`cwd` is an original header field. `persistenceRoot`, `projectDir`, `sessionDir`,
`logGeneration` and the derived index path are different roles. Project directory
encoding is lossy: it is **never decoded into a cwd**. For current logical V4
JSONL only, the documented directory layout is applied **forward** to the native
validated header cwd/id, then the candidate directory device/inode, existing
highest generation and configured encoding must agree. Native global `stat(id)`
alone is not physical-location proof: an empty alias in another project cannot
borrow its identity. References are re-proved before logical reads/filters.
Future, corrupt, mixed-encoding, empty or unproven locations remain unconfirmed;
older generations are never silently selected. Other physical layouts are
metadata navigation only, not supported directory-to-session bindings.

Prefer opaque `pathRef` after `paths`. References are bounded (1024), expire
after 60 seconds unless reissued and reject replaced inodes and interior symlinks.
A configured root alias may be trusted, but nested links cannot escape that root.
Root/project references scope discovery; only confirmed selected readable
session/generation references target context/read. A reference is a locator,
**not a read/write grant**. Paths with cwd filters require a project/session
directory; use `list` for header-based cwd discovery. Prefix matching is component
aware (`/a` includes `/a/x`, not `/ab`); directory scopes stay within the configured
root. Read IDs preserve native Unicode and encoding rules. Send/resume keep
their existing conservative identifiers and literal native approval boundary.

`context` labels `head` and `tail` windows independently and never claims they
are a complete conversation. Its head starts at the first producer-declared
`source.kind:user` input when present, otherwise bounded beginning with
`originalRequestConfirmed:false`; that declaration is not human authentication.
Exact sequence anchors preserve structural event metadata without raw payloads.
`read` distinguishes event paging from redacted-text paging (`textOffset`,
`textLimit`, `nextTextOffset`, measured in JavaScript UTF-16 units).

Source-aware `nextCursor` is **null at real end of the selected cut**. Drain it
before polling; only the separate `pollingCursor` requests a fresh cut. Frozen
pages bind source, target, filters, revision and lifecycle. Polling verifies
canonical full-event prefix digests, not merely visible text, and rejects
shrink/rewrite/incarnation drift. Cold revision changes stale frozen continuations;
live append-only growth can leave an already observed cut frozen. Cuts retain only
sanitized rows/digests (3 cuts / 16 MiB serialized weight / 60-second retention);
live objects are weak references. Source/configuration or public-query instance
changes invalidate source identifiers. Eviction/expiry requires a fresh request.

Search continues even after a no-hit bounded batch. Follow `nextCursor` until
null, and still inspect `coverage`: `complete` applies only to public-visible
authorized message text, **not all physical artifacts or unreadable history**.
`skippedCount`/`skippedCounts` accumulate skip attempts, not distinct sessions;
only two bounded examples are displayed per page. A byte-budget replay can
repeat verification/skip work. Search navigation state is private metadata,
never transcript data: at most 512 states / 4 MiB, 32 KiB each and 60-second
retention. Tool cursors contain only authenticated short state references, not
nested native provider cursors or growing session-id lists.

Only user/assistant text blocks cross the boundary. Reasoning, attachments,
request envelopes, streams and tool args/results (including mixed assistant tool
calls) are excluded. Redaction happens **before matching/excerpts**. Native FTS
supplies addresses, never trusted snippets; every hit is checked against the
canonical authorized redacted text, header, sequence and source revision. No-hit
native pages avoid an additional read-side canonical decode. Phrase mode uses
native literal unicode61 candidates when available, otherwise an explicitly
labelled Unicode-word/diacritic-folded scan; these analyzers are not identical.
Use `substring` for literal fragments/punctuation/emoji and whitespace-flexible
matching. No SQL or user regex is accepted. Surface/time/type filters are checked
canonically; unavailable surface classification remains unavailable even for
warm cuts. Index generations/cursors never replace canonical verification.

Default scan admission per cut: 20000 logical events / 8 MiB raw serialized
events; candidate batches default to 8, maximum 64. Matching also has cumulative
per-call event/byte counters and cooperative time checks. First-item progress is
allowed after an uninterruptible SDK call, so duration is **not a hard deadline**.
`events`/`bytes` count retained canonical materialization; `scanEvents`/`scanBytes`
count matching work, including cached cuts. Other counters count direct public
API calls only (zero counters omitted), not hidden provider work. Public JSONL
slice reads can decode whole compressed generations; metadata enumeration,
prepared-session caches and synchronous native SQLite work have no strict
decoder/CPU/RAM bound here. `backendWorkBounded:false` is deliberate.

At small byte budgets display metadata can be omitted (`metadataTruncated`),
while source/revision/watermarks and continuation progress survive. An oversized
row is emitted as an explicit omission with its identity and advances the cursor;
retry its exact event offset with a larger byte budget to read its text.
If essential metadata itself cannot fit, `metadata_budget` requests a larger
budget instead of emitting an unusable/repeating cursor.

Local live-only/unflushed history uses the public live store and disposable
`observeSession(..., projectionMode:'none')`, never resolve/resume/Agent creation.
Foreign/TUI RAM and another SQLite connection's TEMP overlay are unavailable.
Source-aware discovery covers the configured public persistence/local store;
legacy `list` additionally retains bridge/ledger-only operational metadata.
Writer-held/live/control evidence remains independent of transcript completeness.

### Derived index configuration — proposal only, not activation

Tested public SDK: `0.2.0-rc.2`, current JSONL.zstd logical V4 and native SQLite
derived FTS schema V8 / application id `1146308689`. Retired canonical SQLite
schema17 / application id `1146308688` is **not the current store**. `sources`
reports only configured services: it does not search arbitrary databases or open
an external SQLite reader. Such an adapter is unavailable until source binding
and zero-sidecar mutation can be proven; `readOnly`/`query_only` alone do not
guarantee that, and immutable/nolock shortcuts are not used.

Current compositions with `path:':memory:'`, `openAt:'never'` are disabled and
produce explicit bounded-scan fallback. Merely configuring a native index is
also insufficient: the scoped session plugin (`alex-session`; preserve the
existing composition alias) defaults to
`readSide.allowManagedIndex:false`. Native public search may create/reconcile/
reset its configured **derived cache**, so enabling it requires explicit Host
authorization and reports `effect:derived-cache-may-write`,
`managedIndexWrites:true`; canonical persistence is never opened for write.

**Proposed configuration delta for a separate approved safe boundary:** preserve
the existing composition/profile fields, set native `session-query-sqlite`
`openAt:first-search` (with either `:memory:` or a fresh dedicated owner-selected
cache path), then set the existing scoped session plugin configuration's
`readSide.allowManagedIndex:true`. A persistent cache must live in an owner-private
directory with verified permissions. Native semantic indexing includes more
private text than this tool exposes, so treat the cache as sensitive. Never
point the mutating native loader at a canonical, unrelated or legacy database.
This proposal does **not** edit a profile, enable an index, restart a backend,
create a real session or discard pending RAM intents; those require a fresh
owner decision and safe context. Synthetic fixture indexes are not activation.

### Synthetic read-side verification

`node --test plugins/session/*test.mjs` covers the unchanged control suites plus
authored `.dumps/session-tests` fixtures: installed public JSONL.zstd and managed
SQLite V8, canonical hashes unchanged, disabled index creates no file, highest
future generation refusal, live-only unflushed observation/polling/surfaces,
cached legacy inspection, 1100-session small-byte discovery, authenticated
terminal/polling pagination, oversized Unicode omissions, long path references,
long-ID skip walks, private large provider cursors, warm/cold unavailable
surfaces, and empty/corrupt/future alias-location fencing. No model or user
history/credentials/profile/index is required by the new fixtures.

### Context-first and precise reads (legacy compatibility)

The examples below describe compatibility calls without `sourceId`/`pathRef`.
Legacy `read.nextCursor` remains a polling watermark at end; new source-aware
read has terminal `nextCursor:null` and separate `pollingCursor` as documented
above. Use the dynamic workflow for cut reuse and precise EOF semantics.

`inspect` now defaults to the bounded **beginning**, not a recent tail that can
hide the original request. Use `view: "tail"` explicitly for recent activity.
Both views include independent writer/control evidence. For a contextual
investigation, read the beginning, then continue `read` with its cursor, and
compare the tail; never treat one bounded page as the entire conversation.

`read { sessionId, offset: 35, limit: 1 }` selects the exact zero-based event
index. `offset` cannot be combined with `cursor` or revision polling. A long
message has `textLength`, `textOffset`, and `nextTextOffset`: keep that event
`offset` and `limit: 1`, use `textLimit: 4096`, and continue `textOffset` until
`nextTextOffset` is null. Offsets refer to **redacted** text, not raw historical
content. Output budgets still apply; an omitted preview needs a larger budget,
not an unbounded dump. Tool payloads and attachment bodies remain excluded.
Event cursors remain polling watermarks at the end; `truncated: false` means
no more events at the current read cut (unlike list, whose cursor ends at null).

### Complete session discovery

`list` defaults to **32 rows and 8 KiB**, not 32 complete session descriptions.
The byte budget can return fewer rows. Keep the same `project`, `state`, and
`writer` filters and follow `nextCursor` **until `null`** to enumerate every
match. `total` describes all matching sessions, not the current page. Never
present the first page as the complete list.

Ordering is immutable `createdAt` descending, then session ID ascending; it is
not a claim about latest activity. Sessions without a creation timestamp sort
last. A list revision identifies only the filtered membership and order. Event
appends, transient agent status, writer-observation timestamps and changed row
previews do not invalidate an otherwise identical continuation. A changed
matching set/order returns `cursor_stale`; restart the enumeration. Each row's
own persistence revision can still change between pages.

For open terminal sessions use `writer: "held"`, rather than `state: "alive"`
alone, and report the separate `writerOwnership` evidence:

- `held`: a read-only observer found writer ownership; PID/time/source are
  included when available. This does **not** prove an agent is running, making
  progress, or sendable. An idle agent can still own its session writer.
- `not-observed`: this observation found no writer. It does not prove a free
  lease or authorize resume; native atomic writer acquisition remains decisive.
- `unknown`: no valid observation, unsupported platform/provider, missing
  result, unsafe/changing metadata, or unavailable observer. Missing observations are never relabeled
  `not-observed`.

The companion now wires the bounded Linux kernel-flock observer using only the
public JSONL service's effective configured root. It reads directory/lock metadata
and `/proc/locks`, checks device/inode identity before and after the observation,
and rejects ambiguous paths, symlinks, changed identities and exceeded budgets.
It never probes ownership by trying to acquire a lock. Non-Linux or unsupported
backends remain unknown; this is a diagnostic adapter, not a native DSH lease API.
The TUI's red `held by pid` badge instead comes from its mount ledger; a surviving
or reused PID alone is not authoritative ownership evidence.

The host may supply `writerObserver(snapshots, signal)` returning a `Map` of
session IDs to public `{ state, pid?, observedAt?, source?, reason? }` evidence.
Without it, list/inspect explicitly return unknown writer evidence. The callback
must remain read-only: no trial writer open, lock acquisition, takeover, or
process mutation. Held evidence disables advertised resume and refuses cold
resume before approval/preflight/worker startup; send still requires a verified
registry/bridge destination and its normal approval. Missing/not-observed
evidence never bypasses provenance or the worker's native atomic lease guard.
If `writer: "held"` returns no rows but warns of unknown observations, that is
inconclusive, not evidence that every terminal session is closed.

`state: "alive"` requires local registry/validated bridge proof. An existing TUI
without a bridge can be mounted or writer-held while its agent state remains
`unknown`; `waiting`/`ended` are not inferred from silence or persisted events.
Exact project filters use proven header `cwd`, before display redaction and
truncation. A ledger-only entry without such a header cannot be assigned a
project from its owner's process cwd.

Profiles are not separate stores merely because their names differ. This
machine's companion uses the shared `~/.dsh/sessions` JSONL root with Zstandard;
the ordinary TUI bundle defaults to `$DSH_HOME/sessions` (or `~/.dsh/sessions`),
unless `DSH_TUI_SESSION_ROOT` overrides it. The bridge root under
`session-companion` is **not** the persistence root. Compare effective public
root/encoding and launch overrides before diagnosing missing sessions.

## Safety and transport

The session tool is mounted only inside preset `companion`; root registration
is rejected and execution checks preset identity. Ordinary profiles do not get
this tool. The current preset also has scoped native file tools, list and guarded
Bash in the fixed `/home/alex/git/my/dsh-companion-workspace` native workspace-write
policy. Bash always requires literal-command/fixed-cwd human allowed-once review
(up to 64 KiB), with no escalation, auto-grants or background promotion. There are
no plugin-manager, delegation or workflow tools in this preset. The explicit
music contribution is a manual `/music` command, not a model tool or prompt.

`bridge.mjs` is host-only: it adds no tool or prompt to observed agents.
It publishes private Unix sockets and atomic records under
`$DSH_HOME/session-companion/bridges` (default `~/.dsh/session-companion/bridges`).
Directories are 0700; records, socket and HMAC key are 0600. The trust boundary is
the current OS user, not isolation from another arbitrary program running as that
same unrestricted user.

Before each send or eligible resume, the companion calls `approval.request`. Only `allowed-once`
authorizes the exact destination and literal message. Rejection, cancellation and
unavailability have no effect. Native approvals can wait for a connected user
interface; no answer is not an implicit grant. The model cannot pass
`confirmed:true`. Process and agent identity are checked again after approval.
A short-lived HMAC grant binds remote admission to those identities and the
message. The bridge serializes/deduplicates request IDs for its lifetime; it does
not silently evict accepted IDs. Lost ACK or an exception after possible
admission returns `delivery_unknown`, never an automatic resend.

ACK proves inbox admission, **not** completion or crash-durable execution.
Messages go to `next-turn`: no steering, interruption or editing of terminal
input. The old TUI injection socket is deliberately not used for sending.
No locks are removed, no observed/user process is killed, and readers never acquire a writer.
Queued text does not resolve a target's pending approval/question or interrupt its current turn.

Existing TUIs without the bridge remain observable through persistence/ledger
hints, but cannot be controlled reliably. This installation deliberately does
not hot-inject the bridge into their processes. The activation manifest declares
the bridge for future `dsh-tui` launches; review/apply activation in a safe window,
as profile HMR can affect existing processes. Cold recovery requires verified
original profile/preset/model/policies and a separate worker, not the companion
preset or a copied/forked session. To enable the host-only bridge on a **new**
ordinary launch, without touching any patch watched by existing TUIs:

```fish
dsh --patch (node tools/session-companion/bridge-overlay.mjs)
```

Keep your usual profile/model arguments. The generator creates one unique private
overlay per launch, rather than changing the global activation file in use.
It exposes no tool to the ordinary agent. For the stock TUI launcher, use
`dsh-tui --patch (node /home/alex/git/my/dsh-customs/tools/session-companion/bridge-overlay.mjs)`
with `--patch` before workspace/application arguments. This is for a fresh
launch only; it does not retrofit an already-running terminal. Verify its bridge
handshake before treating it as sendable.

On 2026-10-13, a read-only enumeration completed all 880 stored sessions across
78 default-budget pages with no omissions while writers changed. Kernel evidence
reported 12 writers at that observation; counts are snapshots, not constants.
The default bridge root had no validated bridge and one dead-process record;
that record was ignored, not removed. The current TUI composition did not load
the declared bridge, so its open sessions remained observable but not sendable.
The published companion was then updated alone and a disposable chat exercised
`session.list` with `writer: "held"`: its reply distinguished writer evidence from
the one locally confirmed agent without sending or resuming another session.
A stale bridge warning does not invalidate independently valid bridges.

## Cold recovery limits

The bridge can checkpoint a registered idle agent using official flush/read APIs.
A private HMAC capsule binds the observed original profile/cwd, installed CLI,
direct module and configuration hashes, scoped native tool catalog, preset,
model, effective policies, exact log prefix and disarmed goal/pending-work proof.
This is provenance observed by the original host, **not** an immutable historical
runtime snapshot. It contains no copied credentials, transcript or shell environment.

Recovery initially supports only proven headless origins, no unknown overlays,
forked/delegated sessions, open turns, queued inbox/jobs or changed configuration.
TUI-dependent composition is refused rather than silently replacing its tools.
Old sessions without a capsule remain readable but cannot be recovered here.
The approval explicitly identifies the current original profile, cwd, preset,
model, policies and exact literal message. Current host environment/credential
resolution is used; ephemeral terminal environments are not restored.

Preflight repeats after approval; the worker revalidates before opening the
official writer and under its lock. Preset mounting is strict, never the TUI
helper's fallback. Existing writers are refused. The only tolerated post-prefix
change during core resume is its known empty `session/end-seed` marker. A failure
after writer entry can have housekeeping effects and is reported as uncertain.
Startup fences prevent unintended pre-message LLM/tool activity. No goal is
rearmed. The worker ends after the approved turn, flushes and disposes its handle;
an owned-process exit fallback handles lingering OAuth keepalive handles.

The durable receipt prevents a second launch from the same checkpoint, including
after an ambiguous ACK. **One cold resume per observed source checkpoint**:
after the log advances, another recovery needs a fresh checkpoint from a genuine
original-profile host. The worker does not forge overlay-free provenance.
Admission timeout/cancellation after launch is uncertainty, not a forced stop or
permission to resend. There is no automatic retry or lock takeover.

## Profile and private URL

Recipe: `tools/session-companion/profile.mjs`; create-only provisioning:

```fish
node tools/session-companion/provision.mjs --plan
node tools/session-companion/provision.mjs --write
```

Provisioning refuses existing destinations. The separate service uses loopback
3081; it does not replace `dsh-web.service` or Web port 3080. On this machine the
OAuth-only adapter mounts **only** `openai-codex`, not the TUI. The actually
advertised model is `gpt-6-sol`, low effort; no credentials are copied or printed.
The current profile depends on the existing built OAuth module, which must be
present when reconstructing this machine. It is not a standalone provider build.
The shared session root is explicitly configured as Zstd, verified through public
read-only APIs. The backend requires one physical encoding per root; `none` and
Zstd roots cannot be mixed. No historical logs were converted or rewritten.

Private endpoint: `https://dsh.tail37b3d7.ts.net:8443`. Existing HTTPS 443 remains
mapped to Web. No Funnel or all-interface listener is configured. Startup secrets
are written to the private `connection.json`, not service stdout. Copy the
current authenticated link without printing it:

```fish
node tools/session-companion/connect.mjs --copy
```

Paste only into your own DSH Mobile when it requests the host startup link.
The mobile project's [compatibility table](https://github.com/sorsama/deepseek-harness-mobile/blob/HEAD/docs/COMPATIBILITY.md) targets a newer protocol baseline and lists
older fallbacks; this machine is DSH `0.2.0-rc.2`. API and HTTPS smoke are not
proof that every Android feature works. No real-device APK test is claimed.

## Validation and rollback

```fish
npm run test:session
```

Tests cover schemas, budgets/cursors, real public JSONL reader/writer exclusion,
physical tail, scoped tool visibility, rejection/cancellation, signed grants,
identity changes, deduplication, signed cold provenance, writer-held refusal,
worker lifecycle and ambiguous delivery. Real LLM/synthetic-agent
smoke evidence is local-only under `.dumps/tasks/session-companion/`.

To stop this new endpoint without disturbing Web:

```fish
systemctl --user stop dsh-companion.service
tailscale serve --https=8443 off
```

Retain files/history for inspection. Do not reset all Tailscale Serve routes or
remove session locks as recovery.
