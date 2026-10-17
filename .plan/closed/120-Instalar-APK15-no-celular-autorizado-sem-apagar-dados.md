# Update Companion on Device

Specific human authorization: `pode instalar voltei`. Installation only; do not assume opt-in/POST_NOTIFICATIONS/registration/FCM sending or execution of new goals. Broader E2E decision 119 remains pending for those operations.

Use active goal to guide execution. Identify available ADB device; if multiple or unauthorized, prompt for choice/unlock/authorize USB. Select explicit serial in ALL device operations; do not touch emulators/other apps. Verify binary `.dumps/tasks/dsh-companion-0.15.0-badges-fcm.apk` SHA256 a10eaa2bb84f391b21034ee494d3ed5aa88d3542d0dff5aad57889f952fae37d, original certificate 1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d. Check only metadata of the dev.alex.dsh.companion package already installed; do not read private data/cookies/token/accounts.

Execute adb install -r on the explicit target, without -g, uninstall, clear, downgrade, or reset. Verify versionCode 15 / versionName 0.15.0-badges-fcm after success. Do not start the app automatically or touch notifications/login/goals/backend. Preserve data and signing; if signature is incompatible, stop without uninstalling. Do not touch goal 806 paused 145, Source 99 / SDK / HA / Casa / GCP. Collect job if necessary, record minimal result, and close installation/goal once verified.
