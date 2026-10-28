#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEVICE="${1:-ZY22F2395W}"
OUT_DIR="$DIR/.dumps/visual_open_existing_$(date +%s)"

echo "=== Visual Run (Open Existing Chat): Connecting to $DEVICE ==="
adb -s "$DEVICE" wait-for-device

echo "1. Ensuring portrait mode and bringing app to front"
adb -s "$DEVICE" shell "content insert --uri content://settings/system --bind name:s:accelerometer_rotation --bind value:i:0 && content insert --uri content://settings/system --bind name:s:user_rotation --bind value:i:0"
# If app is not in foreground, bring it to front
CURRENT_FOCUS=$(adb -s "$DEVICE" shell "dumpsys window | grep mCurrentFocus")
if [[ "$CURRENT_FOCUS" != *"dev.alex.dsh.companion"* ]]; then
    adb -s "$DEVICE" shell am start -n dev.alex.dsh.companion/.MainActivity >/dev/null
    sleep 3.0
fi

echo "2. Starting 6s video recording..."
adb -s "$DEVICE" shell "screenrecord --size 720x1600 --bit-rate 4000000 --time-limit 6 /data/local/tmp/visual_open.mp4" &
REC_PID=$!
sleep 1.0

echo "3. Tapping existing conversation item (x=540, y=600)"
adb -s "$DEVICE" shell input tap 540 600

echo "4. Waiting for recording to complete..."
wait $REC_PID || true

echo "5. Pulling video and extracting frames at 30fps..."
mkdir -p "$OUT_DIR"
adb -s "$DEVICE" pull /data/local/tmp/visual_open.mp4 "$DIR/.dumps/visual_open.mp4"
ffmpeg -y -i "$DIR/.dumps/visual_open.mp4" -vf "fps=30,scale=360:-1" "$OUT_DIR/f_%03d.png" -loglevel error

FRAME_COUNT=$(find "$OUT_DIR" -name "f_*.png" | wc -l)
echo "=== Done! Extracted $FRAME_COUNT frames to $OUT_DIR ==="
