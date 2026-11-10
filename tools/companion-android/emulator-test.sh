#!/usr/bin/env bash
# Instrumented (Compose UI) tests on a headless API 34 emulator in Docker. Needs /dev/kvm.
# Usage: emulator-test.sh [fully.qualified.TestClass[,Other.Class]]   (default: whole ui package)
# A handful of ui tests fail on the unmodified code too; compare against a baseline run.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[[ -e /dev/kvm ]] || { echo "/dev/kvm missing: the emulator would be unusably slow." >&2; exit 1; }
ensure_images

filter="-Pandroid.testInstrumentationRunnerArguments.package=dev.alex.dsh.companion.ui"
[[ -n "${1:-}" ]] && filter="-Pandroid.testInstrumentationRunnerArguments.class=$1"

docker rm -f "$EMU_NAME" >/dev/null 2>&1 || true
trap 'docker rm -f "$EMU_NAME" >/dev/null 2>&1 || true' EXIT
mapfile -t mounts < <(docker_mounts)
docker run -d --name "$EMU_NAME" --device /dev/kvm "${mounts[@]}" -w /work/android/companion "$EMU_IMAGE" bash -c \
  'emulator -avd test34 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot -memory 3072 >/tmp/emu.log 2>&1 &
   adb wait-for-device; until [ "$(adb shell getprop sys.boot_completed | tr -d "\r")" = 1 ]; do sleep 3; done; echo BOOTED; sleep infinity' >/dev/null

echo "Waiting for the emulator to boot..."
until docker logs "$EMU_NAME" 2>&1 | grep -q BOOTED; do sleep 5; done

set +e
docker exec "$EMU_NAME" bash -c "./gradlew ${GRADLE_ARGS[*]@Q} :app:connectedDebugAndroidTest $filter > /tmp/ui.log 2>&1
  grep -E 'FAILED|tests completed|Finished|BUILD' /tmp/ui.log | tail -40; $CHOWN_TAIL"
set -e
echo "Failure list:"
docker exec "$EMU_NAME" bash -c "cd app/build/outputs/androidTest-results/connected/debug 2>/dev/null && grep -h -B1 '<failure' *.xml | grep -o 'testcase name=\"[^\"]*\" classname=\"[^\"]*\"' || echo none"
