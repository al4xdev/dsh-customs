# Goal Notifications — Companion

## Scope of APK12 Delivery

Android code, authenticated registration, and optional sender are implemented.
**Companion Firebase has not yet been configured; no login, real FCM dispatch, or
installation of APK12 onto the physical phone has occurred.** Active configuration
of backend 97/99 remains untouched. Activating the new goals/TODO host also awaits
a safe maintenance window: no minimal native endpoint was found that proves idle status
without returning private projections of other conversations. Do not stop the service
on assumptions.

The implementation reuses the separation of concerns from `ha_app`:
real server event → data-only message → Android service → native notification.
It does not reuse Firebase project, package name, IDs, recipients, credentials,
Home Assistant, automations, or hourly WorkManager from Casa de Tequila.

## Android

- `notifications/GoalNotifications.kt`: Dedicated channel, explicit opt-in,
  `POST_NOTIFICATIONS`, native authority, and dispatch with persisted deduplication.
- `GoalPushPolicy.kt`: Minimal versioned native completion, time validity,
  deterministic eventId, and bounded ledger; persistence failure blocks dispatch.
- `PushRegistration.kt` / `PushRegistrationStore.kt`: Up-to-24h receipt tied to
  device, profile, configuration, tokenDigest, authorized sessions, and persisted
  monotonic generation. Raw FCM token is never persisted.
- `CompanionMessagingService.kt`: Rejects notification payload before SDK
  attempts auto-display. FCM accepts strictly the 14-field envelope bound to receipt;
  confirmed local completion uses 7 native fields and the same ledger.
- `CompanionPushConfiguration.kt`: No automatic initialization or token acquisition
  during boot/login. Only configured opt-in, permission, and native binding permit
  user-requested registration.
- `MainActivity.kt`: Permission requested only upon user action in settings;
  explicit/immutable PendingIntent and persisted single-use nonce. Extras/URIs do not
  grant login or session ownership. The ViewModel verifies current generation and catalog
  before navigation.

Title and body text are generic, omitting objective, messages, or paths. Constructed
notification uses `VISIBILITY_SECRET`. Channel visibility is reserved by Android
to system/user controls and may report `NO_OVERRIDE`; do not claim the app can force
this override. An obsolete, forged, or unauthorized tap opens only the app/catalog,
never a conversation based on trusted extras.

Disabling revokes local authority immediately; authenticated unregister is a single
attempt capped at 3s. Offline or failure does not re-enable alerts locally; remote lease
has maximum 24h validity. Successful server-side FCM dispatch signifies HTTP acceptance,
not guaranteed device display. A crash between commit and notify may drop an alert,
but must not duplicate it upon restart.

## Prepared Backend, Not Activated

- `android/companion/backend-native-goals`: Single active goal + independent native
  TODO, HUMAN controls via public DSH APIs with ref/CAS and actual Peer.
- `plugins/companion-native-host`: Host assembly with public lease from Companion preset.
  Do not place services directly into preset: SDK requires realms, and direct Gateway
  does not resolve isolated services in that topology.
- `plugins/companion-push`: Authenticated registration/unregister/status, validated
  recipients, bounded private outbox, and optional HTTPv1 sender. Default disabled state
  creates no files, goal listeners, timers, or external calls.

Completion originates from native `goal/changed` commit, not from model text tokens.
The eventId is SHA256 of JSON `['companion', sessionId, goalId, revision]`.
Active plugin 99 / mock was neither modified nor replaced.

## Next Steps with the Owner

1. Confirm a safe window for the backend; review the offline candidate mounting
   native TODO into the preset and the new host into ROOT, preserving Settings/model/index.
   Confirm declarative startup/lifecycle proof before applying. Keep push disabled
   until configured. Do not touch TUI or restore other histories.
2. Log in together and create/select a **dedicated Companion Firebase project and app**,
   package `dev.alex.dsh.companion`. Without Analytics/Crashlytics, Firestore, or Functions.
   Never reuse Casa de Tequila production.
3. Populate gitignored local file `companion-push.local.properties` strictly with public
   `androidPackage`, `projectId`, `applicationId`, `apiKey`, `senderId`. Current setup is
   at build time: rebuild APK after acquiring these parameters.
4. Configure backend sender with matching public IDs and dedicated approved Companion
   credentials in a `0600` file outside the repo. Minimal scope
   `roles/firebasecloudmessaging.admin`; never commit or paste credentials into chat/logs.
   Explicitly review push configuration before enabling it.
5. Install only after fresh authorization. On device, opt in to alerts and grant permission;
   register via authenticated native transport and verify receipt.
6. Complete a fresh goal and verify real delivery, dedup/reconnection, revocation, and
   device tap handling, including background and reboot scenarios. Only this proof
   authorizes declaring end-to-end FCM functional.

Local tests, isolated real SDK, and fixture captures do not replace this final step.
No sensitive actions above were executed during the owner's absence.
