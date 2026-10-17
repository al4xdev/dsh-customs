# Physical APK13 installation — fresh authorization

Owner responded **Sim, só instalar** ("Yes, just install") to question install-apk13. Goal 8c2c23c6r3 anchors execution; Task 106 completed and Task 104 in para-o-dono awaiting real human validation. Do not repeat lifecycle/backend question.

## Exclusive scope
- Install `.dumps/tasks/dsh-companion-0.13.0-goal-fixes.apk`, 42350750 bytes / SHA256 6b33efd6b05b2275db87b96f36d1d93d291200fb3a1b7c31945db291f01e1538.
- Same package dev.alex.dsh.companion, versionCode 13 / 0.13.0-goal-fixes, min/target 34, signer SHA256 1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d.
- Confirm exact device ZY22F2395W / XT2201-2 / API 34, user 0; read only package metadata beforehand.
- Update `adb -P5037 -s ZY22F2395W install -r --user 0 APK`, without -g/clear/uninstall, without switching user or authorizing other device. Preserve UID 10318 / CE inode 899458 / firstInstallTime and permissions; if identity/signature/baseline incompatible, do not force destructive downgrade/replacement.
- Read metadata afterward, verify version 13 / UID / inode / firstInstallTime / permissions; record local receipt and README distinguishing install from human E2E.

## Prohibitions and delivery
Do not open app, send launch intent, capture screen/hierarchy/chat logs, tap/gesture, pause/resume goal, dispatch model, or grant permissions. Do not stop/restart backend, do not modify profile/SDK/Settings/TUI/frontend/Firebase/HA/histories. Do not commit/push. Emulator and ADB 5039 already stopped; use exclusively 5037 / explicit serial for authorized update.

Deliver short confirmation of installation and let owner open/test Pause/Resume in the correct conversation. Do not close Task 104 as human E2E merely because of install; global goal remains awaiting evidence/decision from owner.
