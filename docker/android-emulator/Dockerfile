FROM dsh-companion-android:34

# Headless API 34 emulator (needs --device /dev/kvm). Private AVD; no host adb server or phone involved.
RUN apt-get update && apt-get install -y --no-install-recommends libpulse0 libnss3 libx11-6 libxcb1 libgl1 libasound2 libdbus-1-3 \
    libxkbfile1 && rm -rf /var/lib/apt/lists/*
RUN yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "emulator" "system-images;android-34;google_apis;x86_64" \
    && echo no | $ANDROID_HOME/cmdline-tools/latest/bin/avdmanager create avd -n test34 -k "system-images;android-34;google_apis;x86_64" -d pixel_6
ENV PATH=$PATH:$ANDROID_HOME/emulator
