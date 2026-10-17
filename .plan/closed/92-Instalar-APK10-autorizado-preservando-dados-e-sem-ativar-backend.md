# Physical APK10 installation — authorized upgrade

## Fresh consent
Owner explicitly asked to update/install and answered **I confirm, no pending items** to the question regarding unsent drafts, uncertain sends, in-progress responses, and approvals in Companion. Authorization in this task is SOLELY APK10 upgrade and app launch, preserving data; no backend restart/activation.

## Artifact and target
APK `.dumps/tasks/dsh-companion-0.10.0-amoled.apk`; expected SHA256 `6fe81acbffb68c301c6b007bac561e2100a1fed710fe6178b5fa829ce52cf5b0`. Package dev.alex.dsh.companion, versionCode 10 / versionName 0.10.0-amoled, API 34. V2 signature certificate SHA256 `1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d`, identical to APK8/9. Werror/lint build, 67 protocol / 359 JVM + 1 ignored / 152 Android / 4 icon + 9 startup and 3 synthetic PNGs validated under closed 90r2; do not repeat tests on phone.
Explicit target ADB 5037 serial ZY22F2395W, Moto XT2201-2, user0. Never adb devices, implicit target / other device / script default.

## Execution and evidence
1. Reconfirm hash/signature of artifact and installed package model/API/metadata, readonly only; check version 9 / cert identity / UID 10318 / dataDir / ceDataInode / firstInstallTime where available. If target divergence / unexpected signature / version occurs, stop and ask, without downgrade/delete.
2. Upgrade `adb -P5037 -s ZY22F2395W install --user 0 -r APK`, without uninstall/clear/grant/takeover. Observe Success/exit; do not repeat uncertain installation without state proof.
3. Readonly package afterwards, prove version 10 and preserved identity / dataDir / UID / inode / firstInstallTime. Launch MainActivity explicitly with am start -W, without browsing / extracting screenshot / UI XML / chats / vault / logcat. Launch may restore login and make usual readonly requests; no prompt/model/delete.
4. Record private evidence .dumps/tasks/task92-apk10-install-evidence.md, update README with actual installed state only, close plan with exact revision. If failure occurs, preserve state/data and report concrete fact, without silencing or claiming installed.

## Limits
No change/restart/activation of backend 89/91 / index / profile / model / Settings / SDK / TUI / OAuth / HA / global, no real grant / project / conversation / prompt / model / delete / history copy / vault. No new captures / physical navigation / FPS measurement / inferred visual acceptance. No commit/push/publication. Do not reuse consent for other updates or tasks.
