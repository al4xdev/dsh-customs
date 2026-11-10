#!/usr/bin/env bash
# JVM tests + lint + debug APK + androidTest APK, all inside Docker.
# Usage: build.sh [--quick]   (--quick skips lint)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_images

tasks=(:protocol:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest)
[[ "${1:-}" == "--quick" ]] && tasks=(:app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest)

mapfile -t mounts < <(docker_mounts)
set +e
docker run --rm "${mounts[@]}" -w /work/android/companion "$BUILD_IMAGE" \
  bash -c "./gradlew ${GRADLE_ARGS[*]@Q} ${tasks[*]} 2>&1 | grep -v '^> Task'; rc=\${PIPESTATUS[0]}; $CHOWN_TAIL; exit \$rc"
rc=$?
set -e
[[ $rc -eq 0 ]] || { echo "BUILD FAILED (exit $rc)" >&2; exit "$rc"; }

mkdir -p "$OUT_DIR"
cp "$APP_DIR/app/build/outputs/apk/debug/app-debug.apk" "$OUT_DIR/dsh-companion-latest.apk"
echo "APK: $OUT_DIR/dsh-companion-latest.apk"
