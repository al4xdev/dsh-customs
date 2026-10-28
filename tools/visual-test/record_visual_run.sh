#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEVICE="${1:-ZY22F2395W}"
OUT_DIR="$DIR/.dumps/visual_frames_$(date +%s)"

echo "=== Visual Run: Connecting to device $DEVICE ==="
adb -s "$DEVICE" wait-for-device

echo "1. Opening app clean on list"
adb -s "$DEVICE" shell "content insert --uri content://settings/system --bind name:s:accelerometer_rotation --bind value:i:0 && content insert --uri content://settings/system --bind name:s:user_rotation --bind value:i:0"
# If at list, tap '+' to create new conversation; if already in draft, continue
CURRENT_FOCUS=$(adb -s "$DEVICE" shell "dumpsys window | grep mCurrentFocus")
if [[ "$CURRENT_FOCUS" != *"dev.alex.dsh.companion"* ]]; then
    adb -s "$DEVICE" shell am start -n dev.alex.dsh.companion/.MainActivity >/dev/null
    sleep 2.0
fi

# Ensure app is in foreground and on conversation list
adb -s "$DEVICE" shell am start -n dev.alex.dsh.companion/.MainActivity >/dev/null
sleep 1.0
adb -s "$DEVICE" shell input keyevent 4
sleep 1.5

# Start 15s video recording to capture full sequence
echo "2. Starting 15s video recording..."
adb -s "$DEVICE" shell "screenrecord --size 720x1600 --bit-rate 4000000 --time-limit 15 /data/local/tmp/visual_test.mp4" &
REC_PID=$!
sleep 1.0

# Tap '+' to start new chat (1080x2400 physical coordinates: x=750, y=280)
echo "3. Tapping '+' to start new conversation"
adb -s "$DEVICE" shell input tap 750 280
sleep 1.5

# Focus composer and enter text
echo "4. Focusing composer and entering prompt"
adb -s "$DEVICE" shell input tap 400 2260
sleep 0.8
adb -s "$DEVICE" shell input text "quais%ssessoes%sabertas"
sleep 1.2

# Tap send button in physical 1080x2400 coordinates:
# When keyboard is visible, send button circle is at x=946, y=1501
echo "5. Tapping Send button"
adb -s "$DEVICE" shell input tap 946 1501

echo "5. Waiting for recording to complete..."
wait $REC_PID || true

echo "6. Pulling video and extracting downscaled frames (360p) at 30fps"
mkdir -p "$OUT_DIR"
adb -s "$DEVICE" pull /data/local/tmp/visual_test.mp4 "$DIR/.dumps/visual_test.mp4"
ffmpeg -y -i "$DIR/.dumps/visual_test.mp4" -vf "fps=30,scale=360:-1" "$OUT_DIR/f_%03d.png" -loglevel error

FRAME_COUNT=$(find "$OUT_DIR" -name "f_*.png" | wc -l)
echo "=== Done! Extracted $FRAME_COUNT frames to $OUT_DIR ==="
