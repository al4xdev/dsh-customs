# Physical installation of APK12

Fresh owner authorization: **pode instalar** ("you may install"), referring to delivered APK12. Scope is Companion update only; does not authorize backend/Firebase/login, opening the app, gestures, screenshots, or granting permissions.

1. Confirm artifact `.dumps/tasks/dsh-companion-0.12.0-goals.apk`, SHA256 ab948dc43a78abbf92b8008fa75620334e4b3989c606bec1631ae883a27e84da, package dev.alex.dsh.companion / versionCode 12 / API 34 and signature SHA256 1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d.
2. Discover ADB 5037 devices and confirm known serial ZY22F2395W / model XT2201-2 / SDK 34; if different/ambiguous/offline, halt before installing. Read only package metadata to record version, UID/CE inode, and firstInstallTime.
3. Update exactly once with explicit serial adb 5037 `install -r`, without -g, uninstall, or clear. Upon failure, investigate before any retry.
4. Confirm version 12 / name 0.12.0-goals and preservation of UID, CE inode, and firstInstallTime; record sanitized receipt in .dumps/tasks/task103-install-receipt.json. Do not audit private data byte by byte or claim to do so.
5. Close plan/goal after confirmation and report backend/push limits that remain pending. No commit/push/HA/cloud.
