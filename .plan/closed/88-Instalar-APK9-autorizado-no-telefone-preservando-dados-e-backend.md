# Authorized physical APK9 upgrade

## Fresh authorization
Owner: 'authorized you can update'. In safe_upgrade question answered 'I confirm, no pending items' regarding drafts/sends/streams/approvals across any conversation. Exclusive consent for APK9, not backend restart/activation. Use current goal to guide execution following approval.

## Artifact and target
.dumps is not a path: correct artifact `.dumps/tasks/dsh-companion-0.9.0-night.apk`, package dev.alex.dsh.companion, versionCode 9 / versionName 0.9.0-night, API 34, SHA256 bf7b226de4c0a54e6396e19f6fb91956254af7f1b09fbd92f86b96567508aa15. CertV2 SHA256 1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d identical to APK8. Build/lint/67 protocol / 341 JVM / 130 Android / 4 offline have already passed; `.dumps/tasks/task85-87-apk9-evidence.md`. Specific phone ZY22F2395W (Moto XT2201_2), ADB 5037, expected user0/UID 10318. Do not select other devices or emulators.

## Minimal execution
1. Revalidate local hash/certificate, serial get-state, and package/version/UID metadata beforehand; do not read private content.
2. If APK8 / expected UID are present and device is authorized, install only the above file via adb -P5037 -s ZY22F2395W install --user 0 -r. Without -d, uninstall, clear-data, revoke, or private data backup. Failure does not authorize destructive reset / reinstallation.
3. Confirm package version 9 / UID 10318 / user0 preserved and launch `.MainActivity` with am start -W --user 0; technical status only, do not browse / send prompt / approve in conversation.
4. Record minimal local evidence and notify owner to visually validate longpress/icon/images, without claiming FPS / physical acceptance. Goal completed only after verification of upgrade and launch, or await owner if device is unavailable.

## Limits
No backend restart/HMR, profile/model/Settings/index/tool 82/83 activated/edited; no real Agent/session/project/grant/prompt/delete. No capture/logcat/profiler, chats/vault/cookies/OAuth, HA/network/TUI/SDK/globals/commit/push/publication. Only authorized APK upgrade and minimal technical metadata remain.
