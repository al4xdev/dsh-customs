# Joint activation of APK7 and fixed profile

## Fresh authorization
In the operational question safe-apk7-profile-activation, the owner selected 'Yes, all clear: update both' (custom 'x iss'), confirming the absence of pending draft/send/streaming/approval and authorizing installing/opening APK7 and restarting only the Companion backend.

## Execution
1. Preserve CURRENT installed configuration: inspect only public fields of controller/default model and service WorkingDirectory. Local private backup of the composition file, without printing secrets/credentials. Do not regenerate defaults. Apply minimal change: disable stock session-controller and insert companion-session-controller with wrapper module. Preserve current model choice, music, OAuth/JWT refs, persistence, ports, and proxy.
2. Restart only the existing Companion backend unit; do not touch web3080/proxy3082/443/TUI/SDK/HA/network. Verify active/health/read-only models without printing auth. Source 79 already has 39 passing real SDK/Gateway/FS tests; confirm correct installed composition and health without sending prompt, authorizing Bash, or migrating old headers.
3. ADB 5037 only with physical serial ZY22F2395W/user0: confirm presence, upgrade -r APK7 SHA256 7fab4de7e6a4a2fd33e7e51dfcaff0ac59fd85f5a2928f88598e7762808fd931, without uninstall/clear/grants/capture/logcat. Verify versionCode 7 and preserved UID 10318, open MainActivity as authorized. Do not touch screen/send/grant/delete anything. If transport is absent, request replug instead of resetting the shared server.
4. Record applied versus prepared, verified facts versus visual validation still pending with the owner. New CWD only for new conversations; legacy maintains header and read access, without write/Bash in the old repo. No claims of real FPS/perf. Close 79/80 and goal only after real result or explicit decision from the owner.
