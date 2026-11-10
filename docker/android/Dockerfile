FROM eclipse-temurin:21-jdk-jammy

# Hermetic Android toolchain for the Companion app: SDK 34, build-tools 34, Gradle via the
# repository wrapper (checksum-pinned in gradle-wrapper.properties). Nothing from the host
# home, keystores or other projects is mounted.
ARG CMDLINE_TOOLS=11076708
ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p $ANDROID_HOME/cmdline-tools && cd /tmp \
    && curl -fsSL -o tools.zip https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip \
    && unzip -q tools.zip -d $ANDROID_HOME/cmdline-tools && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
    && rm tools.zip
RUN yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null \
    && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools"
ENV PATH=$PATH:$ANDROID_HOME/platform-tools
WORKDIR /work
