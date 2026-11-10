#!/usr/bin/env bash
# Shared settings for the Companion Android routines. Source it; do not run it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT/android/companion"
OUT_DIR="$ROOT/.dumps/tasks"
# Pinned debug key: without it every container build signs with a fresh key and
# `adb install -r` over the phone's copy fails with INSTALL_FAILED_UPDATE_INCOMPATIBLE.
SIGN_DIR="$ROOT/.dumps/android-signing"

BUILD_IMAGE="dsh-companion-android:34"
EMU_IMAGE="dsh-companion-emulator:34"
GRADLE_VOLUME="dsh-gradle-cache"
EMU_NAME="dsh-emu"
PHONE_SERIAL="${PHONE_SERIAL:-}"
PACKAGE="dev.alex.dsh.companion"

# Flags from android/companion/README.md; they avoid native crashes seen in OpenJDK 21.
GRADLE_ARGS=(--no-daemon "-Dorg.gradle.jvmargs=-Xmx3g -XX:+UseSerialGC -XX:-ClassUnloading -Xshare:off -Dfile.encoding=UTF-8" --max-workers=2)

ensure_image() { # name dockerfile-dir
  docker image inspect "$1" >/dev/null 2>&1 || docker build -t "$1" "$2"
}

ensure_images() {
  ensure_image "$BUILD_IMAGE" "$ROOT/docker/android"
  ensure_image "$EMU_IMAGE" "$ROOT/docker/android-emulator"
}

# Mount an empty file over local.properties so the host's sdk.dir does not shadow the
# container's ANDROID_HOME, and the host file is never rewritten.
docker_mounts() {
  mkdir -p "$SIGN_DIR"
  printf '%s\n' -v "$ROOT:/work" -v "$GRADLE_VOLUME:/root/.gradle" -v "$SIGN_DIR:/root/.android" \
    -v /dev/null:/work/android/companion/local.properties
}

# Build output created by the root container is handed back to the invoking user.
CHOWN_TAIL="chown -R $(id -u):$(id -g) /work/android/companion /work/.dumps 2>/dev/null || true"

pick_phone() {
  local devices
  mapfile -t devices < <(adb devices | awk 'NR>1 && $2=="device" {print $1}')
  if [[ -n "$PHONE_SERIAL" ]]; then return; fi
  [[ ${#devices[@]} -eq 1 ]] || { echo "Expected exactly one adb device (found ${#devices[@]}); set PHONE_SERIAL." >&2; exit 1; }
  PHONE_SERIAL="${devices[0]}"
}
