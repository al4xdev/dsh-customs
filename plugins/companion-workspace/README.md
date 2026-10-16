# Companion workspace policy

## Native creation and cwd

The backend process may start in `/home/alex/git/my/dsh-customs` to resolve its
plugins. An ordinary **Android-created companion Session/Agent** must instead have immutable
`header.cwd = /home/alex/git/my/dsh-companion-workspace`; native FS execution and
sandbox context resolve from that header, not the backend process cwd. The separately
confirmed `session_create` owner may provision direct `projects/<name>` children with
fresh scoped incarnation authority; it never changes the Android creation controller.

`session-controller.mjs` subclasses the public native SessionController and
specializes only `create(request)`. Clients supply exactly
`{ agentPreset: "companion" }`; the host supplies the dedicated cwd. Native
registration, Gateway codecs, Agent creation/preset mounting and lifecycle remain
owned by the SDK. Client cwd/workspace/session-identity options are rejected.

**Loader detail:** patch `name` is an identity assertion, not a module replacement.
A mismatched name skips the patch. The generated profile therefore disables
`session-controller` and inserts `companion-session-controller` as a distinct row.
The previous same-ID/different-name patch left the stock controller active, whose
creation fallback was the backend process cwd. Actual Gateway regression covers
this; fake superclass tests alone did not detect it.

## Reads and writes

- Companion `read`, `read_image` and `list` can read host paths outside the
  dedicated workspace in native read-only/workspace-write modes. The public
  sandboxed filesystem already permits those reads; there is no host-read
  allowlist or private FS interception.
- Old companion conversations retain their original cwd. They may read host
  paths after this guard is activated, but **write/edit/Bash remain denied** when
  their immutable cwd is not the dedicated root. Start a new dedicated-context
  conversation for mutations; do not rewrite old headers or resume provenance.
- New dedicated-context conversations can write/edit normal nested paths in the
  project without an artificial per-file allowlist. Native observation rules
  (read existing files before changing them) remain in effect.
- Native workspace-write canonical containment rejects outside-project writes,
  including symlink/traversal escapes. The SDK's technical temporary roots remain
  available; they are not a grant over personal files.
- Bash always requires full literal-command plus fixed-cwd human allowed-once
  review, including read-only or repeated commands. Limit:64KiB UTF-8. No
  escalation, auto-grant, background promotion or relaxed legacy-cwd execution.
  Cancellation/unknown policy/foreign preset still fail closed.

## Optional confirmed project authority (task83)

The scoped guard optionally joins the public root-owned `sessionCreateAuthority` via
`ctx.inject`, so a standing preset mounted before the owner remains safe and can join
later. `attachGuard` is only a lifecycle handshake, never a grant. The owner privately
mints proofs after native body approval/publication, bound to exact Agent/Session/header
incarnation, epoch, canonical direct-child cwd and native policy root. Saved IDs, model
arguments, cold resumed sessions and unproven legacy sessions do not obtain authority.

A per-execution WeakMap records asynchronous canonical dev/ino validation. The final
synchronous guard also invokes `allows`, which freshly checks the three approved directory
metadata facts after any long Bash approval wait. Drift or vanished owner fails closed;
Bash still always asks with the complete literal and exact child cwd. Native filesystem
containment and observation remain authoritative. This closes awaited TOCTOU windows,
not an invented fd-pinned transaction against hostile external OS actors.

Without the optional owner, dedicated-root and legacy-read behavior is unchanged. Child
provisioning capability is false before effects until the trusted guard handshake is ready.
See `../session-create/README.md` for approval, root lifetime, partial/UNKNOWN journal and
composition proposal. Nothing here activates or rewrites a live profile.

## Validation

```fish
node --test plugins/companion-workspace/*.test.mjs tools/session-companion/profile.test.mjs
```

`native-runtime.test.mjs` boots the actual installed public SDK generated profile,
Connection/FileUploads, Gateway, controller and sandboxed FS in an isolated
synthetic home with an ephemeral loopback port. It reads only authored files and
supplies synthetic model metadata for image capability; any model dispatch fails.
It checks Gateway cwd/header/preset/policy/context, rejected client cwd, host
text/image/list reads, ordinary nested writes/edits, outside/symlink denials,
legacy read-only access with mutation denial, cancellation, and the actual scoped
Bash ASK waterfall without approving or executing a command. Its fresh local
transport-signing store has no relationship to real credentials.

## Activation

Source prepared does not mean installed or active. Do not edit the live profile,
hotreload or restart while a phone turn/draft/send/approval is pending. Parent
integration must obtain a fresh owner-confirmed safe boundary first.

Apply only the controller disable/insert delta to the existing companion
composition; preserve the owner's **current** saved model choice, music manual
command, OAuth/credential references, persistence encoding, transports and ports.
Do not regenerate defaults over saved Settings. Root profile/policy installation
and final joint owner checks belong to the integrating parent. No old sessions
are migrated automatically.
