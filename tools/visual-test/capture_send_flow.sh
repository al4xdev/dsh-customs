#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEVICE="${1:-ZY22F2395W}"
OUT_DIR="$DIR/.dumps/visual_send_flow_$(date +%s)"

echo "=== Visual Capture: Send Flow at 30fps (360p) ==="
adb -s "$DEVICE" shell "screenrecord --size 720x1600 --bit-rate 4000000 --time-limit 8 /data/local/tmp/test_send_flow.mp4" &
REC_PID=$!
sleep 0.8

# Tap send button in 720x1600 coordinates: x=620, y=415 (corresponds to physical 875, 625)
# Wait, screenrecord runs in 720x1600, but 'input tap' operates in physical 1080x2400 coordinates!
# Looking at the 1080x2400 screenshot tap_check.png:
# Composer card: y=1300 to y=1600.
# Send circle button: center is at x=875, y=1470! Wait, why did 875, 1470 not tap?
# Let's check where the button is in tap_check.png:
# tap_check.png is 1080x2400.
# The keyboard is from y=1600 to 2400.
# The composer box is from y=1300 to y=1590.
# The send circle button with the up arrow is at x=875, y=1470!
adb -s "$DEVICE" shell input tap 875 1470

wait $REC_PID || true

mkdir -p "$OUT_DIR"
adb -s "$DEVICE" pull /data/local/tmp/test_send_flow.mp4 "$OUT_DIR/send_flow.mp4"
ffmpeg -y -i "$OUT_DIR/send_flow.mp4" -vf "fps=30,scale=360:-1" "$OUT_DIR/f_%03d.png" -loglevel error
echo "Extracted frames to $OUT_DIR"
