# Authorized physical update — APK8 only

## Fresh authorization
After confirming that APK8 was the latest build, the owner asked to install it, turned on ADB, and answered 'it is connected, you can update' to the explicit condition of no pending stream/send/approval/intent. Now authorizes physical upgrade to APK8 while preserving data; NOT restart/activation of backend nor new tools 82/83.

## Procedure
1. Verify checksum of already-validated artifact `.dumps/tasks/dsh-companion-0.8.0-lazy.apk`: SHA256 a06cae5d1faef90f2ed9e0d15e4980f8b162eb16254bcd6c29427198f2c0a699. V2 signer 1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d, package dev.alex.dsh.companion versionCode 8/0.8.0-lazy min/target 34. Closed source/tests 81: 67 protocol + 309 JVM / 1 skip + 118 Android, no physical FPS measured.
2. List ADB 5037 and target EXCLUSIVELY known phone ZY22F2395W. Verify package/user0/version and original UID 10318 before operation. If connection is absent, unauthorized, unexpected identity/version/signature, or unsafe upgrade, stop and ask; no ADB/auth reset, downgrade, or inference of another device.
3. `adb -P5037 -s ZY22F2395W install --user 0 -r <APK8>`; without uninstall/clear-data, new grants, prior force-stop, capture/logcat/profiler, access to cookies/vault or Work profile. Verify Success; errors do not authorize destructive workarounds.
4. Verify versionCode 8/0.8.0-lazy and UID 10318 after upgrade. Launch only MainActivity user0 as conclusion of installation, without sending prompt / browsing chats / modifying models/grants. Record only metadata + Status:ok; do not claim visual acceptance / physical FPS.
5. Document local evidence and close task with concrete result. APK8 upgrade may terminate app process; consent conditioned on no in-RAM intent was requested and owner authorized.

## Limits
Do not restart/change backend 3081 / proxy 3082 / profile / model / SDK / TUI / OAuth / HA / network; do not activate tools 82/83. No capture of private content / ADB logs, no real prompt/model/grant/delete, commit/push/publication. Preserve signature, UID, data, and vault; if anything does not match, stop without uninstalling.
