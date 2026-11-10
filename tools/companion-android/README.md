# Companion Android routines

Scripts for the build → test → install → login loop of `android/companion`. Everything
builds and tests in Docker; the host needs only `docker`, `adb`, `jq` and (for emulator tests)
`/dev/kvm`. Run them from anywhere; they locate the repo themselves.

| Step | Command | What it does |
| --- | --- | --- |
| 1. Build + JVM tests | `tools/companion-android/build.sh` | `:protocol:test`, `:app:testDebugUnitTest`, `lintDebug`, debug APK and androidTest APK. `--quick` skips lint. Copies the APK to `.dumps/tasks/dsh-companion-latest.apk`. |
| 2. UI tests | `tools/companion-android/emulator-test.sh [Class,...]` | Boots a headless API 34 emulator container, runs the Compose tests (the whole `ui` package, or the named classes), prints the failing test list, removes the container. |
| 3. Install | `tools/companion-android/install.sh [apk]` | `adb install -r --user 0` on the single connected phone (`PHONE_SERIAL` selects one). Keeps data. |
| 4. Login | `tools/companion-android/login.sh` | Types the private startup link into the text box focused on the phone. |

## Typical session

```fish
tools/companion-android/build.sh
tools/companion-android/emulator-test.sh
tools/companion-android/install.sh
# open the app, tap the login field, then:
tools/companion-android/login.sh
```

## Images

`docker/android` (JDK 21, SDK 34, build-tools 34) and `docker/android-emulator` (adds the
emulator and an API 34 system image). The scripts build them on first use. Gradle's cache lives
in the `dsh-gradle-cache` Docker volume.

## Signing key (important)

Docker builds sign with `.dumps/android-signing/debug.keystore` (created on the first build,
gitignored, mounted as the container's `~/.android`). **Back it up.** Without a stable key,
`install -r` fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` and the only way forward is
uninstalling, which wipes the app's login.

The copy installed on the phone on 2026-11-10 was signed by a throwaway key that no longer
exists, so the first install after adopting these scripts needs one deliberate uninstall
(`adb uninstall --user 0 dev.alex.dsh.companion`; the Work profile, user 10, may hold a copy
too). After that, updates keep their data. `install.sh` never uninstalls on its own.

## Login link

The backend (`dsh-companion.service`, user unit, port 3081) writes the link to
`~/.dsh/session-companion/connection.json` (mode 0600) and regenerates it on every restart.
`login.sh` reads that file. To put it on the clipboard instead:
`node tools/session-companion/connect.mjs --copy`. Never paste the link into logs or reports.

Restarting the service drops in-RAM session state: do it when no conversation is mid-answer.
`systemctl --user restart dsh-companion.service`; the frontend proxy
`dsh-mobile-companion.service` (3082) does not need a restart.

## Known test baseline

On the unmodified code, about 13 of 189 UI tests fail on the emulator (text-selection toolbar
and table tests, a few catalog and premium integration tests); some are flaky. Judge a change
by comparing the failure list with a run from before it, not by a clean pass.

If a Gradle container sits at ~0% CPU for many minutes it is hung (seen once on the full
lint + androidTest run): `docker kill` it and rerun in smaller steps, e.g. `build.sh --quick`.
