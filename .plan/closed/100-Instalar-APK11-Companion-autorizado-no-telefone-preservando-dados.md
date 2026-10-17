# Authorized physical APK11 update

Fresh owner request: `pode instalar` ("you may install"), after delivery of validated APK11. Authorizes installing the update, not wiping data or navigating/capturing the UI.

1. Check ADB 5037 connection for known target ZY22F2395W / Moto XT2201-2 / API 34 and current Companion version/package/user0/UID via minimal metadata. Do not start alternative server/emulator or touch other devices.
2. Revalidate `.dumps/tasks/dsh-companion-0.11.0-polish.apk`, 40,087,797 bytes, SHA256 170033650c9ff7aed664094c1391b4149b1255bcc8739acaba1762dc4edd7622, package dev.alex.dsh.companion / versionCode 11 / versionName 0.11.0-polish / cert 1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d.
3. Execute only `adb -s ZY22F2395W install -r` of the exact APK: update preserving data; no uninstall/clear/-d/-g/-t or extra permissions. If there is incompatibility/error, diagnose before any retry, never reset the app.
4. Verify installed version 11 and UID/user0/firstInstallTime preserved via metadata; record redacted receipt `.dumps/tasks/task100-*` if allocated id 100 (or equivalent effective id). Do not claim byte-by-byte audit of private data. Close after Success + verification.

No app opening, screenshot, UI gestures, reading private data/credentials, Settings changes, backend/frontend/TUI/SDK, commit/push. APK10 remains local rollback artifact; downgrade is never automatic.
