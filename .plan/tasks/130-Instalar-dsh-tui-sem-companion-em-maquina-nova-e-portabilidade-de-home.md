# Install dsh-tui (without Companion) on a new machine and make profiles/plugins portable across HOME directories

## Request
Install on this machine (home `/home/alexsandro-pessoa`) only the customized `dsh-tui` and its plugins, using dotfiles configs, matching the lab flow (home `/home/alex`). Without Companion (app/profile/services), without web/headless/tui or `dsh-web.service`: `dsh-tui` runs core `dsh` as its base directly inside the terminal instance.
Owner decision: fix `/home/alex` **at the source** (dotfiles + plugins + generators) and apply it to the lab as well, avoiding local symlinks or `sed`.

## Discovered State (2026-10-16)
- Lab: `dsh-customs` at `096bd6f` (same as this clone), TUI `custom@4d0b808` (= recipe pin `ebea5d7` + 2 commits: global bookmarks, question ownership), Antigravity `main@77c0c0f` (= pin). All three clean with no local commits. Node v26.10.
- This machine: Node 25.7 (nvm.fish), git/g++/python3/pkg-config, GitHub and npm accessible.
- Dotfiles updated via fast-forward to `b850ed3` (pull with rebase refused due to unrelated local change in `alacritty.toml`; `merge --ff-only` preserves it).

## Gaps in Recipe/Repos (for owner to improve git)
1. **Unversioned `local-model-launch.mjs`.** The dotfiles `dsh.fish` calls `~/.local/share/dsh-cli/local-model-launch.mjs`, which only existed in the lab runtime. It runs `node_modules/.bin/dsh --profile dsh-tui --patch /dev/fd/3`, injecting the `strata-local` provider (`http://127.0.0.1:8080/v1`); without a local server, it proceeds without errors. It requires `js-yaml` and `@deepseek-ai/cordis-plugin-include` in the runtime.
   → Version it (dotfiles or dsh-customs) and install alongside the runtime.
2. **Regression in `096bd6f`: `tools/clean-install/install.mjs` broke on import on a clean machine.** `profile.mjs` began importing `tools/resilience/profile.mjs`, which loads `yaml` at import time, before any `node_modules` exist. This also affected `install.sh --fresh` in Docker. Fixed: `install.mjs` now imports `./profile.mjs` only during the seed step (matching the lazy pattern of the recovery builder).
3. **Clean-install recipe is Docker-only and Node 24 exact.** There was no path for a host with `~/.dsh` restored from dotfiles. Now `tools/clean-install/host.mjs --fresh` composes the same exported steps (buildForks/preparePi/installProtocol/prepareUnifiedRecovery/sharedGraph) differing only in: no `/.dockerenv`, Node ≥24, node-pty headers from the active Node prefix, no profile seed; creates checkouts, `node_modules` links, and launcher where missing. Initial real execution done via driver `.dumps/host-install-20261016/install-host.mjs` (same code + TUI pin).
7. **`@deepseek-ai/cordis` 4.0.5 split the graph.** Published after the Docker build; `dsh` (`~4.0.4`) nested another copy and `sharedGraph` rejected it (1st attempt, `.dumps/host-install-20261016/attempt1-*`). Fixed with `cordis: 4.0.4` override in `runtimePackage` (exact version from Antigravity and lab).
8. **Hardcoded `/home/alex` in tools/tests** preventing running tests here: `tools/clean-install/profile-transfer{,.test}.mjs`, `tools/activate.test.mjs` (fixed using `homedir()`). `plugins/common.mjs` intentionally retains the `/home/alex` fallback: it is part of the immutable controller5/self-heal6 bundles with reviewed hashes, and at runtime is never reached (`process.argv[1]` in `bin.js` resolves first).
4. **Lab runtime ≠ recipe.** Lab: `@deepseek-ai/dsh` + pi-ai override in `~/.local/share/dsh-cli`, TUI/AG via profile `link:` to checkouts, plus consolidation history (404 links). Recipe: single runtime with packaged TUI/AG/pi-ai and `profile/node_modules` → runtime. This machine follows the recipe.
5. **Hardcoded `/home/alex`** (being fixed in this task):
   - Dotfiles `dsh-tui` profile: `name:` of `alex-*`, include of `standard-managed-plugins.yml`, `antigravity-tui-login`, include liangshen, research block includes, paths inside `alex-research-*.yml`, `package.json` `link:`.
   - Plugins: `plugins/common.mjs` (resolution fallback), `plugins/trash/index.mjs` (runtime protection), `plugins/workspace-context/index.mjs` (prompt text).
   - Generators rewriting absolute paths: `tools/activate.mjs`, `tools/research-activation.mjs`, `tools/resilience/profile.mjs`.
   - Out of scope (documented): `tools/task10-profile/promotion.mjs`, `tools/clean-install/profile-transfer.mjs`, `tools/resilience/pi-ai-candidate-worker.mjs`, `plugins/session-create/contracts.mjs` (Companion), historical docs.
6. **`activate.mjs` rejected restored profile** (three `alex-*` runs): now respects the `research-activation` block and wraps isolated migrator `- insert:`. `research-activation.mjs` (requiring all five profiles) now accepts and outputs profile-relative paths; without this, conversion broke `--check`. `alex-session-bridge` (Companion only) is applied to lab `dsh-tui`, as manifest declares; on this machine it is disabled in the local layer.

## Portability (Owner Decision: Fix at the Source)
- Verified DSH semantics: loader `baseUrl` = profile directory (`profile-boot`), and `name`/`path` starting with `./`/`../` resolve relative to it (`cordis-plugin-loader` `import`, `cordis-plugin-include` `path`).
- `tools/profile-paths.mjs`: profile-relative format. `activate.mjs` and resilience migrator (`profileDir`) now output/accept relative; repo overlay remains absolute (`--patch` anchors at profile).
- `tools/profile-portable.mjs`: conversion with structural proof and cascading rename of `alex-research-<hash>.yml`. In `dsh-tui`: 33 rewrites, 3 renames.
- Proof: `--dump-config` here vs lab resolves identical `file:///HOME/...`; only line wrapping and include text differ (`.dumps/host-install-20261016/n-{lab,host}.yml`).
- Launcher versioned in `tools/dsh-launcher/` reading include relative to profile.
- Plugins: `trash` (runtime protected via XDG_DATA_HOME/homedir), `workspace-context` (Home/projects from `homedir()`).

## Machine-Specific Configuration
Machine-specific providers/models reside in `~/.dsh/cordis.patch.yml` (DSH layer loaded after profile, ignored by dotfiles). Local details in `.dumps/`, not in git.

## Out of Scope for This Machine
Companion (`alex-session-bridge` is Companion-only; `companion: skin: whaleGirl` in `dsh-tui` is the TUI sidebar mascot and stays), web/headless/tui, systemd.
Usage-dependent, not load-dependent: `alex-browser` (`npm run browser:install`, ~680 MiB), `alex-gen-image` (`agy` CLI), `alex-music` (`~/git/my/simp_mcp` + `uv`), research Reddit/context7 (keys). OAuth login (Codex/Antigravity) is manual in the TUI.

## Steps
- [x] Pull dotfiles; inspect lab via read-only SSH.
- [x] Fix lazy import in `install.mjs`.
- [x] Host build: runtime, forks, pi-ai, self-heal protocol, recovery (2nd attempt).
- [x] Portable format in plugins, generators, and profile; repo tests.
- [x] Checkouts, `node_modules` links, launcher; 19 plugins + 4 liangshen import cleanly; TUI opens (welcome guide). Owner tested TUI here: normal.
- [x] Machine local layer (`~/.dsh/cordis.patch.yml`).
- [ ] `host.mjs --fresh` validated in an isolated HOME.
- [ ] Apply to lab (text patch), tests and `--dump-config` there; owner test in lab TUI.
- [ ] Commits (dsh-customs, dotfiles) from the lab.
