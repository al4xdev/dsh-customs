FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

# Native dependencies are built only in this isolated image, never on the host.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git build-essential python3 pkg-config fish \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 --shell /bin/bash alex
USER alex
ENV HOME=/home/alex \
    DSH_HOME=/home/alex/.dsh \
    XDG_DATA_HOME=/home/alex/.local/share \
    XDG_CACHE_HOME=/home/alex/.cache \
    PATH=/home/alex/.local/bin:$PATH \
    GIT_TERMINAL_PROMPT=0
WORKDIR /home/alex/git/my
ARG ROOT_COMMIT
# Only a public remote and immutable commit enter the image; no host build context COPY.
RUN test -n "$ROOT_COMMIT" \
    && git init dsh-customs \
    && git -C dsh-customs remote add origin https://github.com/al4xdev/dsh-customs.git \
    && git -C dsh-customs fetch --depth=1 origin "$ROOT_COMMIT" \
    && git -C dsh-customs checkout --detach FETCH_HEAD \
    && test "$(git -C dsh-customs rev-parse HEAD)" = "$ROOT_COMMIT"
WORKDIR /home/alex/git/my/dsh-customs
RUN bash install.sh --fresh
CMD ["sleep", "infinity"]
