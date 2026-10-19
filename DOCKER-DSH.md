# Clean DSH Installation in Docker

Clean build completed and offline basics passed. Image `alex-dsh-clean:20261013-current`, built from central commit `98f3882356767c6d010824633ba459d316e9b814`. Does not use host `~/.dsh`, caches, `node_modules`, or machine runtimes as input. The Dockerfile clones the central public root by exact commit and forks by pinned commits; the local build context only permits the Dockerfile.

## Recipe changes after validated commit (2026-10-16)

The build above is from `98f3882`; **Docker was not rebuilt after these changes**, which the host installation (`tools/clean-install/host.mjs`, same recipe) exercised:

- `096bd6f` caused `install.mjs` to break on import on a clean machine (`profile.mjs` → `tools/resilience/profile.mjs` loaded `yaml` at import time). Now `profile.mjs` is imported only during the seed step, when the runtime already has `yaml`.
- `@deepseek-ai/cordis` 4.0.5 was released after the build: `dsh` (`~4.0.4`) nested a second copy and `sharedGraph` rejected it. The runtime now pins `cordis` 4.0.4 via override, the exact version Antigravity requires and identical to the lab setup.
- TUI pin: `ebea5d7` → `4d0b808` (lab `custom` branch: added global favorites and question ownership) → `7df3780` (background update-check notice removed: this fork is not the upstream package), built and with `verify:oauth` approved on host.

## Compilation

- TUI: fork `al4xdev/dsh-TUI`, commit `ebea5d738481bbc7c35006410ad9ce1a998dc883`, fixed submodule and source build with pnpm 11.21.0.
- Pi: recovered snapshot versioned in `sources/pi-ai`, without faked Git HEAD; lock dependencies, complete telemetry/AI build with observer38 patch, versioned public catalog, and Codex fix.
- Antigravity: fork `al4xdev/dsh-antigravity`, commit `77c0c0fe39c0ddfa9647400db6d4726720aa7852`; host JS compiled via esbuild 0.28.2. **Auxiliary types/client/typert remain prebuilt and committed**: this is not claimed as a build of all exports.
- Self-heal: bundle recompiled from current sources, including persistence; SDK50 bridge applied to only two official catalogs with checked base hashes.
- DSH 0.2.0-rc.2 installed at `/home/alex/.local/share/dsh-cli`; shared Cordis/scope/Pi must have a single physical identity. New public profile at `/home/alex/.dsh/profiles/dsh-tui`; no private session or configuration is copied.

Debian/glibc Node 24 base with fixed digest. Compilers and package managers are explicit. Initial resolution of runtime dependencies generates a fresh lock; identity of all transitive dependencies with host must be measured, not assumed.

## Reproducing via Fish Terminal

The validated container is already running with zero host mounts. To attach:

```fish
docker exec -it --user alex alex-dsh-clean-current-c6aa8602 fish
```

To reproduce in another container from the published and validated commit:

```fish
cd /home/alex/git/my/dsh-customs
docker build --build-arg ROOT_COMMIT=98f3882356767c6d010824633ba459d316e9b814 -f docker/clean/Dockerfile -t alex-dsh-clean:20261013-current .
docker run -d --init --name alex-dsh-clean-manual alex-dsh-clean:20261013-current
docker exec -it --user alex alex-dsh-clean-manual fish
```

`docker run` should create a new container. If that name already exists, use the existing container or choose a different name; do not remove random containers.

Inside the container:

```fish
cd /home/alex/git/my/dsh-customs
node /home/alex/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js --profile dsh-tui
```

Interactive initialization, login, and any prompt involving inference are **manual user actions**, outside automated tests. Neither systemd nor local host model servers are embedded in the container. Browser/headless libraries and auxiliary services require dedicated validation before asserting full parity.

## Codex Credentials

No OAuth token was located via broad search, read, published, copied to the build, or placed in an image. The official TUI path is `$DSH_HOME/dsh-auth/credentials.json` (or `DSH_AUTH_CREDENTIALS`), with an adjacent `device-id`. This file may contain multiple providers and refresh routines may write to it; **a read-only bind mount does not guarantee functional login/refresh**.

Prefer manual login inside the container. If you choose to reuse an existing credential, make that a separate and explicitly scoped step, never a `COPY ~/.dsh` or mounting of the entire home directory. Do not post tokens in chat, build args, Git, or logs.

## Evidence and Boundaries

Receipts for source/build/artifacts/versions reside in `/home/alex/.local/share/dsh-cli/artifacts/` and `clean-install-receipt.json`. Recipe tests use temporary fixtures with no accounts. Public capture/comparison inspects only manifests and selected code, never configs, OAuth, or history.

**Actual execution state:** passed offline basics.

- Image: `sha256:cdba98d0382e88de7d31a3d71f8d753d0b3eefaab7453611339ef9902ad9ec16`; container `alex-dsh-clean-current-c6aa8602`, running with zero mounts.
- 54 recipe tests passed. In the container: SDK50 accepts synthetic event `agent/self-heal`, rejects unknown mandatory events; observer38 classifies quota/rate limits, sanitizes facts, and drops listener; self-heal compatibility probe passes. This is in-memory validation, not replay of real sessions.
- TUI CLI `--version` returns 0.14.0 without boot; `node-pty` executed `printf` with `pty-ok` output, exit 0.
- Comparison with current host capture: 11 identical versions, all selected sources match, and all selected hashes match except the Antigravity bundle. In that bundle, only 17 comments swap scratch prefix `.dumps/.../source/src/` for `src/`; after this specific transformation, all remaining bytes match. Executable code is equivalent; raw equality remains **false**, without generic normalization.
- Installed Cordis/scope/Pi packages share the canonical identity. Development dependencies of the host TUI fork were reported separately: they are not proof of profile activation or running daemon constructors.
- Local public evidence, gitignored: `.dumps/docker-dsh-52/host-public-v3.json`, `container-current-public.json`, and `code-comparison/antigravity-comment-proof.json`. Previous captures were preserved: concurrent changes occurred in TUI artifacts and AG fork during validation.
- Credentials/OAuth/history read or copied: **none**. Model calls: **zero**. Interactive boot and authentication remain manual tests.

The new Antigravity quota-reset source is present, but **disabled by default**. The separate runner and private host policy to wait up to 24h were neither enabled nor copied. Personal configs, local servers, browser, systemd, and authenticated provider behavior are not part of the equivalence verified here.
