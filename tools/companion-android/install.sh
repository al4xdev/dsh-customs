#!/usr/bin/env bash
# Update the app on the physical phone (user 0 only), keeping its data.
# Never uninstalls by itself: a signature mismatch wipes the login, so that stays a human decision.
# Usage: install.sh [path-to.apk]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
apk="${1:-$OUT_DIR/dsh-companion-latest.apk}"
[[ -f "$apk" ]] || { echo "APK not found: $apk (run build.sh)" >&2; exit 1; }
pick_phone
if ! out=$(adb -s "$PHONE_SERIAL" install -r --user 0 "$apk" 2>&1); then
  echo "$out" >&2
  if grep -q INSTALL_FAILED_UPDATE_INCOMPATIBLE <<<"$out"; then
    echo "Signature differs from the installed copy. Uninstalling wipes the login; do it deliberately:" >&2
    echo "  adb -s $PHONE_SERIAL uninstall --user 0 $PACKAGE   (and --user 10 if the Work profile has a copy)" >&2
  fi
  exit 1
fi
echo "$out" | tail -1
adb -s "$PHONE_SERIAL" shell dumpsys package "$PACKAGE" | grep -m1 versionName
