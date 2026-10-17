# Companion — Android 14

Kotlin/Jetpack Compose/Material3 client, without WebView or React. DSH remains on
the PC to observe that PC's sessions. Independent application from CasaTequila.

## APK14 — Optional Context Fixed on Device (Task 109)

`0.14.0-context-fix` (versionCode 14), **installed and validated on physical device**
ZY22F2395W/user0 following debugging authorization. Update -r preserved UID 10318,
CE inode 899458, firstInstallTime, and permissions. Local APK
`.dumps/tasks/dsh-companion-0.14.0-context-fix.apk`, 42,047,426 bytes,
SHA256 `1a0cd2daca1d32bf794a0bafacb7de75ef4886228480cec4c5356741265039bd`.

- Fixes real gap from 13: `agent-instructions`, skill catalogs/invocations,
  clock/tmux now track the option, alongside the three already recognized producers.
  Classification relies on verified public SDK formats/metadata, not text XML.
  Baseline+delta AGENTS with multiple TEXT blocks is also covered.
- Humans with rpcId/timezone, tools, attachments, notices, relay/recall, and unknown
  sources remain visible. Hooks without a public discriminator between initial context
  and security block are **not** blindly hidden. Automatic positive goal round
  remains hidden even with debug ON; model input intact.
- Physical **OFF→ON→OFF** proof on the same original conversation identified by exact
  metadata: OFF shows human+assistant; ON shows instructions and runtime;
  OFF again removes them. Device left in this conversation with option OFF. No message,
  prompt, or goal control sent; work profile untouched.
- Regression: protocol 88 PASS; app 468 PASS + 1 live-opt-in ignored; lint 0; Android suite
  **198/198 PASS across two runs**. Real captures/receipt and limits in
  `.dumps/tasks/task109-final-evidence.md`. Physical Pause/Resume from Task 104 was not yet
  exercised by this debug; do not confuse with context proof.

### Continuation without Device (Task 110)

The owner took back the phone and requested tests without it: physical Pause/Resume validation
**postponed, not PASS**. New test suites: 649 PASS + 1 live-opt-in ignored, including four
isolated SDK cases with genuine HUMAN admission (10 positive controls / 12 refusals), without
continuation driver or external provider. These are neither production goal control nor physical UI.

Diagnosed intentional API retirement after hot Loader mutation. A controlled restart
recovered actual NativeGoals catalog on 3081 (PID 901294, frontend 841 preserved),
without altering code/profile/LOW or legitimate new plugins; 82 pre/PID0/post hashes
identical. No new APK or phone access. Evidence and limits:
`.dumps/tasks/task110-final-evidence.md`. Fail-closed protection preserved.

### Subsequent Physical Proof of Pause/Resume (Task 111)

Following fresh authorization ("celular todo seu vou tomar um banho"), both native buttons
were verified on the physical phone / real instance using an **already existing** test goal
from conversation 9b0165b1: **r2 PAUSED/DISARMED 140 → r3 ACTIVE/ARMED →
r4 PAUSED/DISARMED 145**, cap 256. One tap Resume and one Pause, without uncertain
confirmation / control error; no goal was created or text sent. Five new rounds started,
not an assertion of five successful responses or zero model usage.

Second observation in app and two independent backend reads confirmed
**PAUSED/DISARMED 145**, responding=false / goalRunning=false. Phone left paused,
temporary inspection port forward removed; no install / config / restart. Proof and
real captures in `.dumps/tasks/task111-final-evidence.md`. Postponement 110 above is
historical, not the state after 111. Context 109 remains separate proof.

## APK13 — Goal Fixes and Optional Context (Tasks 104/106)

`0.13.0-goal-fixes` (versionCode 13), tested on API 34 emulator and **installed on
phone in Task 108**, after fresh authorization ("Sim, só instalar"). Update -r / user0
Success on ZY22F2395W, UID 10318 / CE inode 899458 / firstInstallTime preserved; app
neither opened nor touched during install. POST_NOTIFICATIONS already granted and retained;
PackageManager normalized USER_SENSITIVE flags without agent grant/revoke.
Receipt `.dumps/tasks/task108-install-receipt.json` and before/after metadata.

**Real regression fixed in APK14 / Task 109 above:** owner opened app and showed context
`agent-instructions`/AGENTS.md despite debug OFF. Physical authorized ADB capture
`.dumps/tasks/apk13-phone-debug-off-20261015.png` proves whitelist 13 gap;
synthetic tests below did not cover all SDK producers. Physical debugging later
authorized by owner; do not confuse with install-only scope 108.

- Native confirmation follows a full journal suffix without dropping read simply
  because irrelevant output arrived. Goal/round change, gap, or incompatible authority
  still revoke permit; ref/CAS/generation intact.
- Automatic continuations `source.kind=goal`, positive round, and canonical format
  do not render as messages. Quoted human/assistant text, attachments, and partial
  metadata are not filtered by substring. Journal/follow/pagination intact.
- No Refresh button on healthy panel; **Try again** recovery appears only on
  error/uncertainty/unavailability and executes a read, never repeating control.
- New conversation is a RAM draft without fictitious SID, remote session, or admission.
  Opening/navigating back does not persist entry. First human Send creates actual session,
  verifies ownership, and awaits ready streams before standard dispatch pipeline.
  Uncertain failures do not repeat POST. Create+prompt are not atomic: after Send,
  a failure may leave session created without message; it is not deleted on speculation.
- Settings → Debugging → **Show model context**, local and persistent,
  **off by default**. Toggling re-projects without new event or altering SDK input/Settings.
  Recognized system/runtime/tool-registry context is optional; security notices,
  unknown/mixed content, and human messages remain.
  **Internal goal rounds stay hidden even with debugging enabled.**

Companion backend active on 3081, real host/TODO active, and push absent. Fixed
startup self-wait `acquireScope → diagnostics → Loader.await`: initial lease
is deferred until public commit, without weakening HMR fences. Only Companion was
restarted, as expressly authorized; frontend 841, Source 99, SDK, and model/LOW
preserved. Profile receives only TODO in preset and host as sibling ROOT.

Validation: **88 protocol + 460 JVM app PASS**, one live opt-in ignored; zero lint
issues; **198 Android tests PASS across last two complete runs**, plus visual
off/on/off comparisons and local draft. An earlier run surfaced lookup without awaiting
Markdown mount in legacy copy test; harness now awaits readiness and native menu dismiss,
without repeating gestures. **87 canonical backend tests PASS**, including 14 host +
2 full-preset SDK regressions; additional offline matrix of 30 overlaps and must not be
summed into the 87. Real API: catalog/read, refusal of stale control, and cold restore by
following empty fixture itself. Also read COMPLETE r7 goal from Task 99 session itself:
positive native ref, disarmed, TODO null, and absent permit verified; no new models
or goal mutations. Positive HUMAN pause in isolated SDK is separate evidence:
**positive pause/resume in physical conversation was not validated**. The real target
lacked known SID; no other conversation bodies were read, nor active goal created to pause
prior to a round. Real FCM/Firebase remains unconfigured, no token/init/network on startup.

APK `.dumps/tasks/dsh-companion-0.13.0-goal-fixes.apk`, 42,350,750 bytes, SHA256
`6b33efd6b05b2275db87b96f36d1d93d291200fb3a1b7c31945db291f01e1538`.
Same package `dev.alex.dsh.companion`, min/target API 34, and SHA256 cert
`1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d`.
Logs: `.dumps/tasks/task106-gradle-r2.log`, `task106-native-full-r3.log`,
`task106-native-full-r4.log`, `task104-backend-canonical-all.log`. Receipt and captures
in `.dumps/tasks/task104-106-final-evidence.md`; backend `task104-support-final.md`,
`task104-backend-final.md`, and `task104-own-complete-goal-read.json`.
No installation, gesture, or grant on physical phone in that run.

## Physical History — APK12, Goals, Activity, and Notifications

State recorded in tasks 101/103, prior to activation/fixes 104 above.

`0.12.0-goals` (versionCode 12), **installed with fresh owner authorization in task 103**.
Update `install -r --user 0` Success: UID 10318, CE inode 899458, and original firstInstallTime
preserved; app not opened, without capture, gesture, or explicit grant.
Receipt: `.dumps/tasks/task103-install-receipt.json`. Backend/push remain pending.
Goal icon 14dp, 48dp target above Send, opens panel within floating composer
without increasing collapsed height. One active native goal, independent TODO,
expandable objective, and human Pause/Resume with exact observation/ref/CAS;
no text commands simulating controls or shadow scheduler.
Switching observation cancels old gesture; repeating tap does not duplicate action.
Catalog displays distinct 15dp indicators for active/armed goal and responding agent,
smooth entry, and discrete pulse, without clock under reduced-motion. Cold/unknown source
does not become false inactivity or inherit another conversation's state.

Android receives verified native completion and strict data-only FCM; explicit opt-in,
permission, catalog/ownership, receipt ≤ 24h, persisted generation, durable dedup, and
validated tap handling. Alerts are generic and use `VISIBILITY_SECRET`; channel override
is governed by Android/user. Firebase does not initialize or request token at startup.
**Real FCM unconfigured/untested**: dedicated Companion login and project planned;
nothing from Casa de Tequila was reused. Guide: [NOTIFICATIONS.md](NOTIFICATIONS.md).

Central build with Firebase Messaging 24.1.0: **82 protocol + 422 JVM app approved**,
1 live opt-in test ignored; lint without issues. Offline: startup 9 / icon 4 / maid 7 approved.
**190/190 Android across two full runs** in private API 34 emulator and four fixture captures
inspected; expanded composer also captured from Android window to confirm visible draft.
**99/99 backend**, including 28 real SDK composition / declarative boot, cancellation,
initial failure, and fail-closed HMR tests.
APK `.dumps/tasks/dsh-companion-0.12.0-goals.apk`, 42,329,922 bytes, SHA256
`ab948dc43a78abbf92b8008fa75620334e4b3989c606bec1631ae883a27e84da`,
same package/cert/API 34 as 11. Evidence: `.dumps/tasks/task101-parent-evidence.md`.
New backend modules were exercised with isolated real public SDK, but active profile
was not altered: pending safe window for activation. Declarative boot gap was resolved
with audited public staging/commit. Do not stop agents assuming idle state or read private
projections of other conversations to attempt proof. Push remains absent from configuration.

Authorized conversation friction, UUID suffix `e6d547cb`: Companion workspace specific
instructions added preserving 2637 original bytes. Distinguishes existing tool from channel
`send:false`, pause ACK, cwd boundaries, and partial evidence / cursor.
Shared session/TUI help remains only an offline proposal due to HMR risk.

## Physical History — APK11, Updated to 12 in Task 103

**APK11 installed with owner authorization: 0.11.0-polish (versionCode 11), user0/UID 10318.**
Composer repurposes legacy bottom row as editable viewport, without increasing height budget
and preserving 48dp send/stop, literal text, and native editing.
Edge gesture starts up to 45% width, respecting IME/selection/media/code/tables.
Follow-bottom tracks keyboard resize in remeasure itself, both ways; manual reading
is not dragged. Refresh preserves native titles only with coherent id+createdAt; catalog
retains server membership/order/timestamps and fallback never becomes title.
Literal subtitle `i use arch btw`. Maid cycles 22 animations / 267 original frames in
random full loops without repeating prior, without false success/error state.
The 32 legacy assets and icon remain byte-identical; additional playlist in sibling
directory, lazy serial decode off UI, and LRU ≤ 24 frames / 2 MiB, without 267 preload.
Strict build: 67 protocol + 393 JVM app approved / 1 live opt-in ignored, lint without issues;
icon 4 / startup 9 / maid 7 offline approved and **170/170 Android** in private API 34 emulator.
Four synthetic captures inspected: document/table, catalog, longpress, and six lines.
Removed Stop slot guard prevents second tap from hitting editor or another response;
does not add height or keep phantom action. Test covers immediate completion.
Artifact `.dumps/tasks/dsh-companion-0.11.0-polish.apk` (40,087,797 bytes), SHA256
`170033650c9ff7aed664094c1391b4149b1255bcc8739acaba1762dc4edd7622`;
V2 cert preserved. Do not infer FPS or physical visual acceptance.
Physical update 100 authorized by "pode instalar": `install -r` Success, original UID / CE
directory and firstInstallTime preserved. App not opened, no gesture, capture, or data wipe.
Evidence: `.dumps/tasks/task95-apk11-evidence.md` (pre-install validation) and
`.dumps/tasks/task100-install-receipt.json` (installed version 11 / metadata).

**Backend 97/98: isolated Companion test instance**, lifecycle autonomously authorized
by owner; do not repeatedly ask for same RAM-safe window. 7-line integration 97
preserved Settings / model openai-codex/gpt-6-sol/low, frontend/TUI, and never index.
98 proved legitimate auth and real modelCatalog on 3081, announced saved route, and native
plugin inventory with active session/create/workspace/owner/controller. Proof of real
agent execution completed in 99 below, not inferred from inventory or 401.
Legacy `dsh-web` unit was recoverably removed; backend 3081 and frontend 3082 services
remain, without restarting TUI.
Evidence: `.dumps/tasks/task97-backend-activation-evidence.md` and `task98-capabilities-r3.json`.

**Goal 99 active and validated on real instance.** Companion preset now mounts native
components `agent-instructions`, `command-goal`, `tool-goal`, and dedicated mock. Web bundle
disabled these three components on host, and custom preset lacked them.
Goal engine and round-driver remain native; no scheduler or parallel goal store.
Actual workspace AGENTS received global goal section and native constraints, with
full loading verified in `agent-instructions` event of test session.

Real proof: get/create/pause on same goal, resume via native human command, and
**two autonomous rounds admitted**. First hit scan budget of session itself and was
explicitly cancelled; after parameter adjustment only, second read session itself and
32-byte fixture, verified objective, and completed same native goal. Total:
3 logical turns / 11 SDK requests, saved model unaltered, no new grants.
Paused goal mandates human `/goal resume` control; model cannot bypass this rule.

Plugin `plugins/companion-notifications`: **one mock event persisted** on real completion,
unaltered after authenticated reconnection. Private 0600 ledger, minimal payload without
objective/body, dedup by goal/revision, and notification failure does not revert goal.
**In this active mock 99 there is no phone push, Firebase, or HA**; new APK12 adapter
above is not yet enabled. 13/13 pre-activation SDK/isolated tests also approved,
separated from real model proof.
Evidence: `.dumps/tasks/task99-source-report.md`, `task99-goal-autonomous-r2.json`,
and `task99-executor-invariants.json`.
**Diagnostic 96 closed:** authorized conversation referenced relative SVG created by
write tool, without typed image / receipt. Expected placeholder 87; no URI/path relaxation
or SVG read. Admitted fresh test requires typed raster / read_image and exact alias.

**Historical APK10 (updated to 11 in task 100): 0.10.0-amoled (versionCode 10), user0/UID 10318 and data preserved.**
AMOLED canvas `#000000`, neutral surfaces, rounded composer with text above controls
and circular send button. Chat has no visible header/title/back button; retains edge gesture
and Android Back, accessible context and exit. Stop response sits in composer without
displacing ability to queue additional literal text. Catalog opens with short tap; long press
offers Delete, always with confirmation and accessibility alternative, without permanent three dots.
Retaining card with pending deletion does not open conversation on release or duplicate destructive action.

Native Android 14 black splash with same accepted maid; initial restore uses original
loading view, without synthetic delay and without reappearing on chat navigation/refresh.
Tables form continuous group: two columns adapt when legible, larger fonts / wide tables share
pan; only extremes have rounded corners. Budget sums rounded pixels per component to avoid
squeezing final column. Typography, cadence, assets, selection, lazy bounds, and image
authority are preserved. In APK10 round, exact diagnosis of print1 image was missing. Task 96
above tracked only authorized conversation and proved SVG without receipt; do not bypass subset via URI.

In that round, backend 89/91 was prepared, **110/110 tests passed**, without activation;
subsequent integration 97 is recorded above.
In that round, activation and physical upgrade were separate decisions, with fresh consent and
safe RAM state across all conversations. Backend authorization 98/99 is noted above; physical
upgrade remains separate. Physical upgrade 92 already authorized and completed: APK9→10,
same UID/dataDir/inode/firstInstallTime; without activating backend.
Log: `.dumps/tasks/task92-apk10-install-evidence.md`.
Final validation: 67 protocol, 359 app JVM approved + 1 live opt-in ignored,
152 Android in private emulator, 4 icon fixtures, and 9 splash fixtures; strict Werror/lint.
Local artifact `.dumps/tasks/dsh-companion-0.10.0-amoled.apk`, SHA256
`6fe81acbffb68c301c6b007bac561e2100a1fed710fe6178b5fa829ce52cf5b0`;
same V2 cert as APK8/9. Three synthetic PNGs inspected, without asserting physical FPS
or visual acceptance. Evidence: `.dumps/tasks/task90-apk10-evidence.md`.

**Historical APK9: 0.9.0-night (versionCode 9), replaced by APK10 under 92r1.**
Night charcoal palette, no visible copy buttons (native selection/longpress only),
and static icon of SAME maid from loading animation. Accepted layout/typography/spacing/motion/gestures
remain. The 32 loading assets/timings unchanged; offline recipe in [icon/README.md](icon/README.md),
without generation/repainting of original art.

Task 87 adds Markdown images ONLY by exact association with prior confirmed typed image:
`attachment:<opaqueId>` or ORIGINAL `read_image.file_path`. Does not open files/URLs by text.
Live/tables and external targets remain inert; subsequent Task 96 confirmed real SVG/write example
is not admitted under this subset.

Strict build/lint passed: 67 protocol, 341 app JVM (342 cases / 1 live opt-in ignored),
130 Android in private API 34 emulator, 4 offline icon fixtures.
V2 signature identical to APK8. No profile/backend/model/tool 82/83 was activated or
restarted. Task 88 installed via user0 upgrade following FRESH authorization and
confirmation of zero pending work: ADB Success, version 9 / UID 10318 / data inode / first install
preserved; MainActivity Status:ok. Never wipe data or read keystore/chats.
Visual acceptance / physical FPS not inferred; new update mandates fresh safe condition.
Local evidence: `.dumps/tasks/task85-87-apk9-evidence.md` (build/tests) and
`.dumps/tasks/task88-apk9-install-evidence.md` (authorized upgrade).

**Earlier APK8: 0.8.0-lazy (versionCode 8), UID 10318 preserved.**
Task 84 ran authorized user0 upgrade after safe condition: ADB Success and MainActivity Status:ok.
Without wiping data / restarting backend / enabling tools 82/83; owner later confirmed
images, streaming, and sliding worked; requested Task 85 adjustments. This is not physical FPS
measurement. Local evidence: `.dumps/tasks/task84-apk8-install-evidence.md`.
Task 81 keeps facts/approvals in proprietary dispatcher, decodes socket in ordered queue,
and prepares projection/Markdown off UI, including history and completion. Single LazyColumn
mounts bounded cells instead of entire responses/tools. Gesture starts up to 88dp from edge;
confirmed typed images appear in timeline outside collapsed activity, and tap opens existing
preview. Not an FPS metric. Fresh install mandates fresh authorization and zero pending RAM intentions.
Strict build/lint, 67 protocol tests, 309 app JVM, and 118 Android passed; one live opt-in test
ignored. Same V2 signature; inspected screens use synthetic fixtures only. Local evidence:
`.dumps/tasks/task81-apk8-evidence.md`.

**Earlier APK7: 0.7.0-editorial (versionCode 7), original UID preserved.**
Build/JVM/protocol/strict lint and **92 Android tests** passed in dedicated API 34 emulator.
Only humans receive bubbles; assistant sits on background and activity/tools start collapsed.
Streaming Markdown uses sequential worker off UI; this is a code/test improvement, not on-device
FPS measurement. Final images are synthetic fixtures, not content of the two private reference
screenshots authorized by owner. Owner confirmed zero pending work and approved upgrade/restart;
ADB returned Success and MainActivity Status:ok. Companion backend restarted with preserved saved
model. Owner subsequently confirmed visuals and operation; not a physical FPS metric. Fresh update
mandates safe condition.

**Earlier APK6: 0.6.0-agentic (versionCode 6).** Build/JVM/protocol/strict lint passed;
**85 Android tests** passed in dedicated API 34 emulator. V2 signature identical to earlier APKs.
Upon return, owner authorized upgrade preserving data and restart of Companion backend only,
confirming zero pending intentions. Physical install returned `Success`; visual and functional
acceptance rests with owner. No uninstall, clear-data, fresh private capture, or live model swap used.

Includes compact tools, deep session context reading, shared motion, retained catalog without
refresh on return, Settings with Exit/models, and Delete conversation with confirmation / recoverable
server archive. Real model test used isolated synthetic conversation only; the 85 Android tests use
no real chats, camera, or grants. Reproducible images of tools/settings/bottom edge are synthetic
and local; not proof of on-device fluidity or jank.

APK5 login was previously confirmed by owner. Credentials remain in Keystore of the same app;
no URL/token/cookie is logged in evidence. Web frontend / proxy 3082 remain fallback, without
VPN/DNS/publishing/TTL changes. Prior to updating/restarting again, verify zero RAM intentions will be lost.

## Platform and Build

- minSdk 34, targetSdk 34, and compileSdk 34; JDK 21, JVM bytecode 17.
- Gradle 8.13 with [mandatory official checksum](https://downloads.gradle.org/distributions/gradle-8.13-bin.zip.sha256)
  `20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78`.
- AGP 8.9.2; Kotlin/Compose compiler 2.1.21; Compose BOM 2024.12.01.
- Local SDK/build caches in `.dumps/android-toolchain`, without modifying SDK, cache, or signing
  keys of other projects. `local.properties` is not versioned.
- APK8 strict build: 67 protocol tests and 309 app JVM tests passed; `LiveOwnerReadOnlyTest` is the
  sole ignored test (310 app cases). 118 Android tests passed in dedicated 5039/5580 API 34 emulator,
  without real reads/grants/models.
- `:app:lintDebug` and `:app:assembleDebug` passed; package and signature verified. Only `OldTargetApi`
  and `GradleDependency` (newer version suggestions) have documented exceptions due to deliberate
  API 34 target. Backup and data transfer explicitly disabled; all other lint findings are fatal.
- Real backend: catalog mandates cookie and Origin, rejects foreign chats; mux preserved 36 records /
  cursor 35 across reopening and reconnection, without dispatch or Agent resumption.
- Kotlin transport repeated this proof, applying history and streaming reducers. `LiveOwnerReadOnlyTest`
  is opt-in and normally skips prior to credential read or connection; do not confuse default skip
  with executed test.

## Using the Prototype

Debug APK is located at `app/build/outputs/apk/debug/app-debug.apk`. Requires Android 14 or higher,
Tailscale access to the PC, and the running Companion backend. Contains no WebView, React runtime,
or on-device LLM engine.

Use the **complete initial private link** for Companion; the cleaned post-login URL does not
authenticate this app. The input field obscures and clears it upon connection. Never share this link
or include it in reports, screenshots, or logs.

In version 0.2, only owner cookies are stored with AES256-GCM and non-exportable Android Keystore
keys in a private no-backup file. The initial link/token is never persisted; cookie is recorded only
after validating the 303 redirect and its destination. On launch, the app verifies saved login strictly
against read-only catalog. Network failures do not delete credentials. Expired cookie or true 401
mandates fresh login. `Sign Out` / `Forget login` deletes local credentials; does not revoke server-side
access. DSH uses finite validity, default 30 days, and persistent signing secret: rebooting PC does not
invalidate a valid cookie. Backend validity periods remain unchanged.

Drafts and delivery control remain in RAM; ledger is non-persistent. Never recreate an unconfirmed
dispatch manually: reconnect and check history first. App does not restore or resend drafts automatically.

Published frontend remains available for rollback. ADB installation was explicitly authorized with
`--user 0`; no install or launch occurred in Work profile. Never repeat device actions without authorization.

With local toolchain configured, the validation run from repo root:

```fish
set -lx JAVA_HOME /usr/lib/jvm/java-21-openjdk
set -lx GRADLE_USER_HOME "$PWD/.dumps/android-toolchain/gradle-cache"
set -lx ANDROID_USER_HOME "$PWD/.dumps/android-toolchain/android-home"
env -u ANDROID_PREFS_ROOT -u DSH_LIVE_READONLY .dumps/android-toolchain/gradle-8.13/bin/gradle -Duser.home="$PWD/.dumps/android-toolchain/java-home" '-Dorg.gradle.jvmargs=-Xmx3g -XX:+UseSerialGC -XX:-ClassUnloading -Xshare:off -Dfile.encoding=UTF-8' -p android/companion :protocol:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon --no-parallel --max-workers=2
```

JVM flags above are local to this invocation, mitigating two native crashes observed in OpenJDK 21.0.12.1;
they do not modify Android VM or global settings. After moving identically named resources between
qualifiers, a full `--rerun-tasks` regenerated local merge and R symbols prior to final validation.
Never disable lint/Werror to bypass inconsistent source or cache.

Build must use dedicated `GRADLE_USER_HOME` and isolated Java/Android home directories: Android plugin
may attempt to record metrics preferences. Do not mix `ANDROID_USER_HOME` with legacy `ANDROID_PREFS_ROOT`:
fresh daemons reject contradictory paths, even if an earlier daemon passed. Do not reuse or modify private
files / signing keys of another app. Delivered APKs must be compiled and inspected; never install to
personal phone without confirmation.

## Contracts and Security

`protocol` contains DTOs, strict JSON codecs, and history/streaming/approval reducers. The catalog
`companion/listChats`/`detail` resides in `plugins/companion-api`: headers prove preset before opening
or retaining a chat. A title, PID, or projection hint does not grant access. The catalog is a **product
boundary**, not a multitenant firewall: native API remains operator API.

- Fixed HTTPS authority: `https://dsh.tail37b3d7.ts.net:8443`.
- In-memory private initial link, login GET, validated 303 to same root.
- Opaque cookie encrypted in private no-backup storage; Android Keystore key per UID/profile.
  Expiration, domain, path, and HttpOnly preserved. No alternate refresh/bearer tokens or persisted
  startup tokens.
- Standard TLS and explicit Origin on POST and WSS; current proxy mandates this Origin.
- Native rc.2 cookie omits `Secure`: cookie jar independently enforces exact HTTPS/host/port and
  never dispatches credentials to another authority.
- No bearer substitute, URL/token/cookie/body logging, or trust-all SSL.
- Acknowledged dispatch is admission, not completed execution. Unknown outcome is never automatically resent.
- Automatic OkHttp connection recovery and redirects disabled: standard transport could duplicate POSTs.
  Stale generation ACK does not authorize resend; ledger validates literal evidence via `source.rpcId`
  in history.
- Approvals use native waterfall and `allowed-once`/`rejected` decisions bound to
  generation/clientId/eventId/agentId; never persist or replay decisions.

Settings enables querying native catalog and confirming **profile default**; conversations that already
ran a model retain their selection. No profile picker, generic settings editor, terminal, or auto-approval.
Missing capability/catalog disables selection; uncertain mutation receives no replay. Existing terminals
without bridge remain observable but not sendable; do not restart them or seize their locks.

Deleting a conversation requires verified identity/creation and native lease without active writer.
Moves session directory to trash outside corpus; does not delete external attachments.
Only exact receipt confirms local/draft/cache deletion; uncertain failure prevents repeating action.

## Workspace and Native Rendering

- AMOLED black canvas `#000000` with neutral charcoal tiers, fullscreen layers, not bottom sheets.
  Centralized tokens in `PremiumPalette`; no wallpaper dynamic colors. New/existing share 600ms enter /
  480ms exit and origin at card/+. Drag follows finger; release resolves remaining distance and cancel
  spring-settles. Retained backing, single callbacks, no automatic refresh on return. 12-conversation
  RAM cache preserves position/folds/following only; placeholders do not clamp scroll position. Does not
  store transcripts or reload older pages automatically: restores exact effectively reloaded window.
  Reduced motion / scale 0 disables animations. Final 20dp padding integrates afterContentPadding in
  follow-bottom, including tall cards.
- Only human messages receive right-aligned bubbles (max 88%); assistant prose, warnings, and context
  reside directly on canvas without repeated DSH headers. Theme provides `onSurface` outside Surface as
  well, maintaining contrast on background. Consecutive tools/thinking within a turn group into an
  Activity row, collapsed by default; prose between activities remains visible in original sequence.
  Native IDs, folds, and tails preserved; no duration or completion is invented. Expanding activity
  mounts only 48dp headers near viewport; opened details become independent cells. Typed images with
  confirmed receipt un-fold at associated chronological position, without duplicating in details. Tool name,
  literal XML/JSON, or URL does not authorize promotion. Inspecting suspends tail-following; native
  selection and preview also suspend it.
- Native Markdown via CommonMark/GFM: headings, lists, blockquotes, emphasis, validated links,
  selectable code, tables, and strikethrough. Streaming maintains indexed blocks and history replacement
  without duplication. Sequential workers conflate presentation snapshots only, never protocol/control
  frames. Static, live, final parsing and cell planning execute on Default dispatcher; no synchronous
  finalization flush or temporary 64 KiB Text. Preparation is explicit and AST/cell cache lives only in
  selected window, not in 12-cache. Tiles contain up to 2048 UTF-16 units and 48 source newlines;
  code/tables preserve fonts and spans with explicit boundaries. Native selection covers mounted lazy
  content, **not unmounted spans**. Per owner request, Task 85 removes message/code/source copy buttons;
  copying is handled via native longpress/selection menu. No promise of copying global source or
  unmounted sections. Code/literals have independent pan per fragment to prevent a short fragment from
  clamping a long one; table rows share pan and coherent columns, responsive for up to two readable
  columns without shrinking font size. Live growth uses direct scroll, not per-token tween; final
  geometry follows bottom without overlapping manual reading/selection. Discrete admission settles in
  220ms without scale/stagger; does not animate history or individual deltas. Horizontal edge gesture
  uses 88dp side zone; 96dp header zone exists only in Settings, never over headerless chat text.
  Slop/axis-lock and recent velocity; code/tables/media/composer, longpress/selection, and IME take precedence.
- Tools feature identity/call/result, partial/error states, bounded JSON, code, searches/lines,
  before/after, and typed images. Unknown families use inert literal fallback; rendering does not
  install tools or grant permissions.
- Math/Mermaid render as explicit source, not executable HTML. Bare GFM autolinks and task checkboxes
  remain literal; GIFs display first frame only. Advanced compaction/feedback/offload features are
  bounded/inert notices.

The [workspace profile](../../plugins/companion-workspace/README.md) was corrected to create new
conversations in the dedicated project and permit host reading with writes restricted to that project.
Task 80 enabled only the controller delta, following confirmed safe condition by owner; other configurations
remained byte-identical. Do not rewrite legacy headers or restart while RAM intentions exist. Backend process
CWD may remain in app repository; it must not dictate new Agent CWD. Legacy conversations with old CWD
retain read access, but require a new conversation in the dedicated context to write/execute Bash.

## Authorized Images and Limits

`read_image` renders only references present in admitted chat. The app uses read-only `session/attachment`
with proof of current admission, selection, and generation, rechecked before/after I/O. Does not open PC
paths or arbitrary URLs, does not upload files, and does not perform external fetch from Markdown.
Pending projections await current durable revision before admitting a reference; results from older
workers do not authorize removed or other-generation images.

In final Markdown, destination may associate only with valid original receipt of prior call/result
(`callSeq < resultSeq < durable assistant boundary`). Real name/args and a single successful typed image
are captured BEFORE preview fallback; filename, JSON/text, and visual position of call prove nothing.
Duplicate/partial args, errors, offload/truncation, and ambiguities remain inert. Paths are exact,
without cwd guessing, normalization, or basename heuristics. Markdown cache stores only alt/destination,
not authorization. Full dependencies are rechecked against current revision, including whether same ref
still exists in another receipt. Up to 4 images per original assistant turn; exceeding 4096-receipt index
disables associations without hiding conflicts. Lists/quotes share existing decoration; tables/live and
generic URLs/URIs do not fetch images. Owner's actual case depends on inspecting their `![...](...)` snippet;
not assumed.

- General parser remains 2 MiB / frame, 512 KiB / string. Only typed attachment envelope admits 8 MiB,
  canonical base64, and maximum 4 MiB decoded.
- MIME PNG/JPEG/WebP/GIF, known ID digests, metadata, and actual dimensions verified. Oversize or
  unavailability generates honest notice without auto-retry.
- Thumbnails ≤ 768px and preview ≤ 2048px / 16 MiB per bitmap; concurrent decode 1. RAM LRU 24 MiB /
  24 entries **is not total process RAM ceiling**. Cards maintain 220dp slots, but unmount images outside
  viewport to avoid holding dozens of bitmaps in a single row. Eviction never recycles visible bitmaps.
- Preview fits viewport; 1×–4× pinch and bounded pan exclusive to preview. Changing selection/generation
  dismisses dialog and discards pixels of previous Ready state.

Activity `.preview.FixtureActivity` exists solely in debug APK without launcher or deep link. Ignores
extras and uses in-RAM generated data/pixels, displaying banner "Local preview · no actions on PC";
does not access ViewModel, keystore, transport, camera, storage, provider, or real permissions.
Returning to app is an explicit click.
