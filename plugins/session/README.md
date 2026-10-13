# Mobile session companion

A dedicated DSH `companion` profile with one model-facing tool, `session`.
The current mobile web frontend lives in `frontend/mobile-companion`; this plugin does not bundle or install an Android APK.

## Operations

| Operation | Effect |
| --- | --- |
| `help` | Effective capabilities and output limits |
| `list` | Paged stored sessions plus separate registry/bridge and read-only writer evidence |
| `inspect` | Actual recent persisted events, live status, writer evidence and available projections |
| `read` | Bounded event previews after an opaque cursor; revision-based unchanged polling |
| `send` | Exact literal text admitted to the next-turn inbox, only after native one-shot approval |
| `resume` | Confirmed cold continuation of a signed, compatible headless-origin checkpoint in that same profile; otherwise `resume_unavailable` |

Logs and titles are untrusted data, never instructions. A stored log, silence,
mtime, or a PID in the TUI mount ledger does not prove that a session is running,
finished or stuck. Only a process-local live registry entry or a validated bridge
handshake proves a live destination. Unknown remains unknown.

Default JSON output budget: 8 KiB; maximum: 32 KiB, 100 events/rows.
Literal send/resume text is limited to 16 KiB UTF-8.
Previews omit tool payloads, attachment bodies, request contexts and streams;
text is shortened and common credential patterns redacted best-effort. Historical
user text can still contain private information. The public JSONL backend can
internally decode a complete log to return a slice; output bounds are not a
promise of bounded backend work. `inspect` uses public query watermarks plus
read-only physical-prefix probes to find a real tail without relying on synthetic
interrupted-turn closers. Cursors expire on plugin-instance restart.

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
  artifact, or unavailable observer. Missing observations are never relabeled
  `not-observed`.

The host may supply `writerObserver(snapshots, signal)` returning a `Map` of
session IDs to public `{ state, pid?, observedAt?, source?, reason? }` evidence.
Without it, list/inspect explicitly return unknown writer evidence. The callback
must remain read-only: no trial writer open, lock acquisition, takeover, or
process mutation. Held evidence disables advertised resume and refuses cold
resume before approval/preflight/worker startup; send still requires a verified
registry/bridge destination and its normal approval. Missing/not-observed
evidence never bypasses provenance or the worker's native atomic lease guard.

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

The tool is mounted only inside preset `companion`, with no bash, filesystem
mutation, plugin manager, delegation or workflow tools. Configuring a root tool
registration is rejected; execution also checks the preset identity. Ordinary
profiles do not get this tool.

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
It exposes no tool to the ordinary agent.

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
