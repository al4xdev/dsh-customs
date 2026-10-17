# Companion: Review Corrections (Host, Android, Prompts)

## Origin (2026-10-16)
Four read-only reviews (host core, `companion-*` plugins, Android app, prompts), consolidated and approved by owner for correction: host JS, Android, and prompts.
Owner decision: **retain** `alex-session-bridge` in lab `dsh-tui`. It is the only pathway for Companion to talk to `dsh-tui` agents (closed instance) and access is already bounded within tailnet. Risk accepted and recorded: `grant.key` is readable by any process belonging to the user, including the bash of a `danger-full-access` TUI agent, which could forge grants and inject messages into other sessions.

## Shared Contract Host ↔ App (A1)
`/api/session/uploadFileBinary` accepts up to 20 MiB + margin with mandatory `Content-Length`; `Transfer-Encoding: chunked` remains 411; other POSTs remain at 1 MiB. App starts sending body with known size.

## Host JS (plugins/session, session-create, companion-*, frontend/mobile-companion/server,
## tools/session-companion)
- A1 host-side (proxy 3082 and `companion-transport/request-budget.mjs`).
- A4: approvals (send, resume, session_create, Bash, download) escape/reject invisible Unicode (`\p{Cf}`, `\p{Co}`, tags U+E0000–E007F, bidi, CR) and show bytes + sha256.
- A5: sandbox escalation and `workdir` denial with actionable text for the model.
- Bridge: discovery counts only `.json` and ignores/removes records of dead processes; handler does not execute request whose socket already dropped or expired; `retrySafe`/side-effect-free failure does not become UNKNOWN in ledger; `owner.lock` records pid/startTime and reports dead owner; resume with failure lacking side effects does not burn receipt; `close()` with timeout and try/finally.
- Download: TTL renewed on commit; rate limit only after validating ticket (or per peer); expanded denylist (CLI credentials, keyrings, keys); plugin tests (currently 0).
- Push: status with specific reason upon hitting limit; orphan lock detection.
- `file-events`: per-frame decoder (Node 25.7 decodes only the 1st zstd frame).
- `session` tool description: untrusted content warning upfront; `session_create` without unavailable `new_project` branch; term "owner" for human.
- Portability: no `/home/alex` in Companion code/tests (homedir/XDG_DATA_HOME/DSH_HOME); tests depending on absent `.dumps` switch to fixture.

## Android (android/companion/app)
- A1 app-side: upload with `Content-Length`.
- A2: "Resend" action for UNKNOWN submission reusing `requestId` and literal; uncertain "New conversation" unlocked via user action; `onStop` ignores `isChangingConfigurations`.
- A3: event socket reconnection with backoff as long as an approval-responding screen is visible; "approvals unavailable" warning; handle `onClosing`.
- Item outside vocabulary/limit does not drop connection (isolate and mark "view on PC").
- `openSocket` without cookie does not crash app (try/catch → handled failure).
- Goal control permit renewed when stale; remaining minor items if safe.
- New unit tests; Gradle build and tests run in lab (no toolchain on this machine).

## Prompts (dotfiles)
- `~/.dsh/AGENTS-Companion.md`: explicit fencing of untrusted content and avoidance of sending PC-read content to web queries unprompted; remove duplications and impossible rules under real tools; split long bullets. Research method retained pending owner decision.

## Acceptance Criteria
Suites for touched directories green on this machine (without `/home/alex`) and in lab; Gradle `testDebugUnitTest` green in lab; lab deploy with coordinated restart of `dsh-companion`.

## State (2026-10-16)
- [x] Host JS: all items; scoped suites green (session 160/160, session-create 67/67, companion-download 13/13 new, push 37/37, native-host 53/53, workspace 37/37).
- [x] Android: all items except push (design decision documented in NOTIFICATIONS.md); Gradle build/tests in lab.
- [x] Prompts: `AGENTS-Companion.md` streamlined (8051 → 6182 bytes) and reviewed by critic.
- [x] Approved extension (abc5b3e): `ask`/`recap` (btw) via bridge, no approval required, `session` with `ask`/`recap` first and `read` as last resort; CRLF normalized to LF.
- [x] Lab deploy with `dsh-companion` restart; debug APK 0.16.0 installed via lab `adb`.
- [x] Prompt audit (3445bd5): `npm run prompt:audit`, companion baseline generated in lab (on this machine companion differs due to lab-only paths: expected).
- [x] `stale` latch: SDK ConfigEditor reconciles host row with raw path (boot uses `file:` URL); host previously compared `name` byte-for-byte. Now compares imported module.
