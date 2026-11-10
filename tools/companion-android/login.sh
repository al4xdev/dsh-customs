#!/usr/bin/env bash
# Type the private Companion startup link into the text box that is focused on the phone.
# The link comes from the service-written 0600 file and is never printed. It is briefly visible
# in this machine's process arguments, so run it on a trusted host only.
# Open the app's login screen and tap the field first. Restarting dsh-companion.service
# regenerates the link; this script always reads the current one.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
file="${DSH_HOME:-$HOME/.dsh}/session-companion/connection.json"
[[ -f "$file" ]] || { echo "No connection file: is dsh-companion.service running?" >&2; exit 1; }
link=$(jq -r .tailscale "$file")
case "$link" in
  https://dsh.tail37b3d7.ts.net:8443/*token=*) ;;
  *) echo "Unexpected link format; not typing it." >&2; exit 1 ;;
esac
pick_phone
adb -s "$PHONE_SERIAL" shell input text "'$link'"
echo "Typed ${#link} characters. Check the field, then tap connect."
