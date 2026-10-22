# dsh-customs — DSH Workshop, Plugins & Companion

A modular monorepo containing extensions, LLM resilience controllers, the native Android Companion app, and workshop tooling for the DeepSeek Harness (DSH) ecosystem.

> **Welcome to the workshop!**  
> Whether you're exploring custom DSH plugins, looking for Android integration patterns, or building resilient LLM workflows, here is where to start:
> - **[DSH Plugins](plugins/README.md):** Modular plugins for file operations (`trash`, `list`, `apply-patch`), deep research (`research`), browser automation (`browser`), audio (`music`), cost-aware scheduling (`peak-gate`), and session resilience.
> - **[Android Companion](android/companion/README.md):** Native Jetpack Compose mobile client with zero-trust token handshakes, secure local downloads, and live session interaction.
> - **[Tools & Tooling](tools/task10-profile/README.md):** Offline prompt auditing, profile portability, and clean container builds.

---

## Why These Forks and Plugins Exist (Design Rationale)

This repository is deliberately designed to solve concrete architectural and workflow bottlenecks encountered when using standard agentic coding harnesses in long-running, autonomous engineering environments.

### 1. The Core Forks

#### `plugins/dsh-antigravity` (The Antigravity Engine Fork)
The Antigravity fork is the most advanced component in this workshop, engineered to provide a significantly cleaner, more resilient, and forward-compatible path than upstream:
- **Next-Gen Model Support:** Delivers first-class, native support for cutting-edge models including Claude 5.5 and Gemini 4 Argon, without requiring hacky adapter layers.
- **Quota-Aware Backoff (`antigravity-quota-retry`):** DeepSeek and vendor APIs routinely hit token/tier rate limits. Antigravity tracks official quota reset timestamps directly and gracefully sleeps (up to 24 hours if needed) rather than crashing or terminating active tasks.
- **In-TUI Usage Telemetry:** Direct native integration of quota and consumption telemetry right inside the terminal user interface, allowing real-time monitoring of token budgets and tier capacity.

#### `sources/pi-ai` (The Pi AI Engine Fork)
Upstream Pi 0.87.1 suffered from provider edge cases that broke autonomous sessions:
- **Codex Parameter Hygiene:** Upstream automatically forced `reasoning: none` into OpenAI/Codex completions, which corrupted parameters on reasoning-capable models. The fork eliminates this implicit injection.
- **Persistent Long-Session Resilience:** Long-running coding sessions exceeding 150k tokens previously suffered from fatal WebSocket dropouts. The fork hardens WebSocket lifecycles and enables smooth auto-compaction near 190k tokens without context corruption.

#### `frontend/dsh-tui` (The Terminal User Interface Fork)
Stock terminal interfaces treat agent edits as walls of raw text:
- **Interactive Patch Cards:** Integrated natively with the `apply_patch` plugin to present interactive, side-by-side syntax-highlighted diff cards.
- **Session Navigation & Favorites:** Adds `Ctrl+P` global session quick-switch with persistent favorites, letting you navigate dozens of background tasks without losing terminal state.
- **Buffer-Level Grammar Correction:** Introduces `Ctrl+G` via `grammar-fix` to seamlessly rephrase, translate, or refine user prompts before transmission using lightweight local or cloud models.

---

### 2. Managed Plan Mode (`.plan/`) vs. Native Plan Mode
Native autonomous plan modes often suffer from two extremes: they either run completely unreviewed in the background, or they trap the agent in rigid permission states that lock down necessary tooling.
- **Versioned Project Artifacts:** Instead of an opaque hidden state, plans in `dsh-customs` are version-controlled Markdown artifacts stored in `.plan/` (`tasks/`, `backlog/`, `blocked/`, `closed/`).
- **Cryptographic CAS & SQLite Registry:** Every plan change is guarded by an internal atomic SQLite database (`.plan/.state/store.sqlite`) with content hashes and revision matching (`expected_revision`), preventing race conditions across multi-agent sessions.
- **Auditable Human Checkpoints:** Plans clearly separate staged proposals from executed results, maintaining an immutable history of project decisions and evidence.

---

### 3. Safe Filesystem & Resilience Suite
Autonomous agents given unrestricted shell access tend to make catastrophic mistakes—such as using `rm -rf`, running runaway `grep` across gigabytes of binaries, or rewriting 1,000-line files to change a single comma:
- **`trash` vs. `rm`:** Replaces destructive file deletion with recoverable, quarantine-safe moves to `/tmp/alex-dsh-trash-*`.
- **`list` vs. `ls -R`:** Enforces bounded directory listing with hard depth and limit caps to prevent token exhaustion.
- **`apply-patch` vs. `write`:** Adapts Codex's exact contextual diff parser to apply targeted patches with observed-version guards and recovery receipts.
- **`llm-resilience` & `agent-self-heal`:** A unified exponential retry controller (ten exponential delays up to 60min) paired with a self-healing engine that recovers from server errors (500/503), rate limits (429), and bad requests without wasting context tokens on empty messages.

---

### 4. Android Companion: Beyond a Terminal — A Private AI Assistant
The `android/companion` app is designed not merely as a remote viewer, but as a **private, secure daily-driver chatbot** capable of replacing commercial apps like ChatGPT or Google Gemini:
- **Zero-Trust Private Connection:** Connects over Tailscale or private HTTPS with cryptographic token handshakes, HTTP-only cookies, and local sandbox boundaries. No external cloud servers or third-party relays touch your sessions.
- **True Multi-Source Deep Research:** When asked complex research questions from mobile (e.g. asking the agent to comprehensively research and catalog obscure retro gaming releases like Yu-Gi-Oh! across Reddit, X, and gaming communities), the companion triggers the `research` plugin.
- **Local Materialized Evidence:** Rather than reading superficial search engine snippets, the research engine fetches and parses full forum threads, discards noise, and materializes raw evidence in `.dumps/research/`. The model can either query the raw evidence on demand or synthesize complete, fact-grounded dossiers directly to your phone.

---

## Separation of Responsibilities

| Location | Responsibility |
| --- | --- |
| **dsh-customs** | Plugins, versions/pins, patches, preparation/build tooling, and generated wiring |
| **dotfiles** | Personal `.dsh` configurations, providers, preferences, shell launchers, and services |
| **DSH installation** | CLI and dependency graph produced by the recipe |
| **Private data** | Sessions, attachments, credentials, and OAuth; not included in manifest or bootstrap |

TUI and Antigravity remain in separate forks with fixed URLs and commits. The recovered
Pi is a verified snapshot versioned in `sources/pi-ai`, without an invented Git HEAD.
Unpublished local changes do not appear in a remote clone.

## Clean Installation in Docker

[DOCKER-DSH.md](DOCKER-DSH.md) describes the current recipe, the isolated environment, and
comparison boundaries. `install.sh --fresh` is Docker-only and refuses an existing
installation; no host OAuth or history enters the image. The actual Docker build
and offline basics passed; evidence and limits are documented in the link.

`tools/clean-install/` uses current forks and persistence/Codex improvements.
`tools/workshop/` remains a historical baseline, not the current host recipe.

## Host Installation (New Machine with Dotfiles)

Path to install only `dsh-tui` and its plugins on a machine whose `~/.dsh` is already
restored from dotfiles, without Companion, web, or systemd. This is the same pinned recipe
as Docker (`tools/clean-install/host.mjs` composes stages exported by `install.mjs`), with
Node ≥24 active (nvm works; the runtime executes on it), node-pty headers for that Node,
and no profile seed. See [task 130](.plan/tasks/130-Instalar-dsh-tui-sem-companion-em-maquina-nova-e-portabilidade-de-home.md).

```fish
# Prerequisites: restored dotfiles, Node ≥24, git, g++/make/python3, network (npm/GitHub)
git clone https://github.com/al4xdev/dsh-customs.git ~/git/my/dsh-customs
cd ~/git/my/dsh-customs
node tools/clean-install/host.mjs --fresh
dsh   # fish function from dotfiles → local-model-launch.mjs → --profile dsh-tui
```

`--fresh` rejects an already existing runtime/build. Beyond the runtime in
`~/.local/share/dsh-cli`, it creates only what dotfiles does not carry, and only where missing:
dev checkouts `frontend/dsh-tui` (`custom`) and `plugins/dsh-antigravity` (`main`),
symlinks `~/.dsh/profiles/{,dsh-tui/}node_modules` → runtime, and the launcher
`tools/dsh-launcher/local-model-launch.mjs` copied to runtime. OAuth login is
manual in the TUI; initial launch displays the welcome guide (`Esc` skips).
The launcher also bounds automatic compaction for every local route: `headroomTokens`
becomes a quarter of the message budget (capped at 16k), because the shipped 65k
default makes a 128k model compact at ~32k. Presets mount their own isolated compaction
service, so the policy is carried down the `alex-research-*.yml` include chain instead
of a single known include id.

**Portable profiles.** DSH anchors the loader `baseUrl` to the profile directory, and
`name:`/`path:` starting with `./` or `../` resolve relative to it. Thus the
`dsh-tui` profile uses relative paths (`../../../git/my/dsh-customs/plugins/...`) and works
in any HOME with identical layout. `node tools/profile-portable.mjs --profile NAME
[--from-home DIR] [--write]` converts a profile with absolute paths, providing structural
proof of equivalence and cascading renames of `alex-research-<hash>.yml`.
The lab `web`, `headless`, `tui`, and `companion` profiles still contain `/home/alex`.

**Machine-only configuration** (corporate providers, default model) goes into
`~/.dsh/cordis.patch.yml`: a DSH layer applied after the profile and ignored by
dotfiles, avoiding committing machine-specific data to Git or breaking another host.

## Documentation Map (README Directory)

| Path | Topic / Scope | Primary Target |
| --- | --- | --- |
| **[`README.md`](README.md)** | Root repository overview, installation recipes, environment configuration | All developers & visitors |
| **[`plugins/README.md`](plugins/README.md)** | Comprehensive plugin catalog, coupling matrix, and activation model | Plugin users & extenders |
| **[`plugins/browser/README.md`](plugins/browser/README.md)** | Hierarchical browser automation, Playwright integration, screenshots | Tool consumers |
| **[`plugins/research/README.md`](plugins/research/README.md)** | Orchestrated search tool, evidence dumps, and multi-source connectors | Tool consumers |
| **[`plugins/research/REDDIT.md`](plugins/research/REDDIT.md)** | Reddit OAuth read-only connector specifications | Integrators |
| **[`plugins/peak-gate/README.md`](plugins/peak-gate/README.md)** | DeepSeek peak/off-peak hold, schedule shared with the `wait` tool, `npm run peak:plan` | Cost-conscious operators |
| **[`plugins/session/README.md`](plugins/session/README.md)** | Session reader API, pagination, and multi-version JSONL discovery | Host / Companion engine |
| **[`android/companion/README.md`](android/companion/README.md)** | Native Android Companion application (Architecture, UI, Security) | Mobile developers |
| **[`android/companion/NOTIFICATIONS.md`](android/companion/NOTIFICATIONS.md)**| Android FCM push delivery and background notifications | Mobile / Cloud infra |
| **[`frontend/mobile-companion/README.md`](frontend/mobile-companion/README.md)**| Mobile Companion web application and HTTP gateway | Web / Mobile gateway |
| **[`tools/task10-profile/README.md`](tools/task10-profile/README.md)**| Historical isolated-profile recipe and profile provisioning | Workshop maintainers |
| **[`tools/workshop/README.md`](tools/workshop/README.md)** | Historical workshop build recipe (Sources → Artifacts → Runtime) | Runtime packagers |
| **[`tools/pi-ai-fork/README.md`](tools/pi-ai-fork/README.md)** | Vendored Pi AI engine build and packaging pipeline | Core engine maintainers |
| **[`tools/installation-consolidation/README.md`](tools/installation-consolidation/README.md)**| Historical runtime links consolidation and audit notes | Host maintainers |
| **[`DOCKER-DSH.md`](DOCKER-DSH.md)** | Clean Docker container build specification and execution boundaries | Container operators |

## Repository Map

- `plugins/`: local plugins. `plugins/activation.json` is the single activation list.
- `tools/workshop/manifest.json`: exact versions, sources/pins, and workshop strategies.
- `tools/workshop/bootstrap.mjs`: effect-free doctor, planning, preparation, and explicit bootstrap.
- `tools/task10-frontend/`: upstream TUI recipe + patch of committed local extensions.
- `tools/pi-ai-fork/`: build/validation of pi-ai fix; legacy promotion tools are scoped to this machine, not universal installers.
- `tools/activate.mjs`: generates only managed `alex-*` blocks in profiles.
- `tools/clean-install/host.mjs`: host installation (above); `install.mjs` is for Docker.
- `tools/profile-portable.mjs` + `tools/profile-paths.mjs`: paths relative to profile.
- `tools/dsh-launcher/local-model-launch.mjs`: launcher invoked by `dsh.fish` in dotfiles.
- `tools/prompt-audit/`: offline audit of text the harness sends to the model (below).
- `frontend/dsh-tui/` and `plugins/dsh-antigravity/`: separate local checkouts, gitignored.
- `.plan/`: task history. `.dumps/`: local evidence/fixtures, gitignored.

## New Machine: Safe Sequence

Requirements for current recipe: Node **24+**, Git, npm, and frontend toolchain.
Configurations must be restored via **dotfiles**, following its README.
Do not copy sessions or credentials through this recipe.

```fish
git clone https://github.com/al4xdev/dsh-customs.git ~/git/my/dsh-customs
cd ~/git/my/dsh-customs
npm ci --ignore-scripts
npm run workshop:doctor
```

The doctor validates the recipe and hashes; it does not start DSH, does not connect providers,
does not read private configs, and does not install anything. `ready: true` signifies a
**consistent recipe**, not a verified full build or interactive acceptance.

Choose a **new** destination whose parent directory already exists. Do not target the
active installation or `.dsh`. The recipe protects these paths and rejects overwrites:

```fish
set WORKSHOP "$HOME/.local/share/dsh-workshop-rc2"
node tools/workshop/bootstrap.mjs --plan --destination "$WORKSHOP" --json
# Only after reviewing the plan; consumes network and compiles sources:
node tools/workshop/bootstrap.mjs --bootstrap --destination "$WORKSHOP" --allow-network --allow-build --json
```

`--prepare` only creates plan/manifest/seed in a missing destination, without running
commands. It **does not install** and **cannot later be reused by --bootstrap**:
both modes require distinct fresh targets. Do not wipe partial staging to
hide failures; preserve its receipt and review/choose a fresh run.

The result separates `runtime/`, `sources/`, `artifacts/`, and `receipt.json`. Artifacts
used by an installation must remain in **durable storage**, not in `.dumps`.
Here `.dumps` is strictly used for dry runs, never for fresh activation.

**Profiles are not activated automatically.** Bootstrap prepares the CLI with the
patched pi-ai and Antigravity package, plus the TUI artifact. Installing the TUI bundle
into restored profiles, generating wiring, and adjusting dotfiles launchers are
explicit subsequent steps. See [the workshop guide](tools/workshop/README.md).

## Current Recipe and Limits

| Component | Recipe |
| --- | --- |
| DSH | `@deepseek-ai/dsh@0.2.0-rc.2` |
| TUI | Base `c2eee952…`, full patch equivalent to local fork `c4f04010…`, pnpm `11.21.0` |
| pi-ai | Portable baseline `c043dedb…`, based on `0.87.1`, with implicit reasoning fix; does not follow HEAD |
| Antigravity | Fork `7dcd2427…`, version `0.1.0-rc.5`, `lib` export already committed |

The host on this machine already runs the separate promotion from task 26: source `f5a24c96…`
and pi-ai artifact `206545bfd51e`. This does not automatically update workshop pins.

Task 32 adds per-provider `retryPolicies` to local TUI fork OAuth;
in this machine's profile, Codex uses normal mode, nine retries, and backoff from 5s
up to 20min (last actual wait 18–20min with jitter; 41min15s nominal accumulated,
excluding request durations). The official engine remains owner of budget and cancellation.
Step 32 does not alter other providers; the Antigravity 36 extension described below
configures its policy separately. That local extension is not in historical TUI/patch
pins above; the checkout contains unpublished changes. Do not claim
reproduction of current configuration solely from doctor/portable baseline. Candidate and
validation/promotion receipts are distinct, without repackaging legacy artifacts.

Task 112 unifies recovery introduced by 105 into
[`alex-llm-resilience`](plugins/llm-resilience/README.md): a finite policy
for any native/pi-ai provider, ten additional exponential retries from
7.03125s up to 60min, no jitter by default; retry 9 = 30min and 10 = 60min.
Total wait sums to ~1h59m53s, excluding request times. Self-heal is the sole
owner of the primary budget: appends `harness warning:` with safe diagnostics
and returns fresh preparation, without chaining another technical budget.
The manifest declares controller, typed classifier, and self-heal across all five
profiles, including Companion. Native retry and legacy fork must not compete;
typed AGY reset extension shares the same budget and 60min ceiling; a server
minimum above that ceiling suspends recovery instead of retrying prematurely.
Compaction/titles share the same scheduler and diagnostic context, with safe
replay and discarding of failed attempts. Consumed legacy credits and explicit
limits remain preserved; completed local tools do not repeat.
Controller 5 / self-heal 6 are the current immutable targets; task 124 fixes
implicit schema defaults in controller 5 that disabled recovery. Owner 6 and protocols
remain unchanged; controller 4 is historically preserved. Closed bundles prevent legacy ESM
leaves in cache. SDK, profiles, and bundles have their own promotion/backup; SDK modules in
already open processes stay cached until a fresh launch, without automatic restart.
This does not alter historical pins above or prove live inference/health.

Task 131 revokes two points from 112 ("no 11th attempt" and "one warning per failure").
Controller 6 / self-heal 7 (contract 3, `llmRecoveryUnbounded`) have no count
limit for transient error classes: the first ten waits follow the scale above
and subsequent waits remain at 60min indefinitely; terminal errors remain terminal and
`maxRetries: 0` / explicit finite limits are honored. Typed provider minimums
(Retry-After, AGY quota reset) are waited up to the generic 24h ceiling. Each
chain receives a single short warning without a counter (a new one only if code changes), and
every refusal logs a fixed reason. Audits switch to payload v2 / policy 3
(v1 remains readable); reverting to controller 5 / self-heal 6 afterwards is not a safe
downgrade. `node tools/resilience/doctor.mjs` checks SDK bridge, bundles, and profiles
without writing anything.

Task 33 adds usage tracking to the local Antigravity fork: `/antigravity-usage`
displays reported percentages by model, reset time, and unknown window;
`/antigravity-usage --refresh` ignores the 60s cache. It is on-demand metadata
without inference, polling, or retry/billing changes; host service
`antiGravityUsage` applies a 10s deadline, response bounds, and credential
invalidation. Local promotion uses compiled host/declarations bundle in an isolated
candidate and durable backup; a fresh TUI process is recommended to load modules
reproducibly, without automatic restart.
This does not update the historical Antigravity pin / tarball above or certify web
dashboard or zero-credit usage. Official client overage preferences are not
automatically inherited by the fork.

Tasks 36/42 add shared Claude/Gemini resilience to the local Antigravity fork:
bounded SSE, sanitized typed failures, signature association by logical block,
and request-local bridge to official engine.
Antigravity policy for this profile is normal 9, 5s–20min with jitter 0.1; Search,
catalog, accounts, and credits are not rotated. `enabledCreditTypes: []` is
validated in client, without universal server billing guarantee.

V4 passed 310 package tests and 26 native-loop cases, isolated host build,
14 declarations, and public consumer; root contracts 76/76 + grammar config and public
profile YAML wiring also passed. Real Claude test accepted five code responses
and one follow-up with replay in the same session; four responses reached
the 16k ceiling, thus not proving complete or executed code. Gemini was compared
offline. The sequence stopped at the first real 429: `RATE_LIMIT`, hint 373203889ms
(~4.32 days), exceeding the 20min cap, resulting in zero official retries — correct fail-fast.
Missing final balance remains unknown, not 0%; window and positive recovery
after reset were not verified. Counters 18/26/2 respected 32/40/4 and 45min active.
The root cause of previous 400 remains unknown despite the demonstrated logical bug.

The V4 promotion replaced only compiled `lib/index.js`, with durable backup,
hash comparison, and rollback that refuses subsequent edits; four declarations,
21 other outputs, and six TUI outputs were preserved. Nothing updates workshop
pins or constitutes a new publication. See [fork documentation](plugins/dsh-antigravity/README.md#official-retry-policy-and-validated-local-rollout)
and [local outcome](.dumps/antigravity-resilience-20261013/promotion-live-result-v4.md).
Self-heal hot-mount was observed in an existing profile, but does not flush SDK caches;
process age does not prove absence of all hooks. A new TUI/worker is recommended
to prove loading; no automatic restart occurred. Task 43 fixed and
published self-heal V2: max 3 per consecutive episode, renewed by healthy causal
progress or authenticated human resumption, not by synthetic messages/reload.
Source 96 and native 50+4 in source/bundle passed; three physical entry gates
observed audit policyVersion 2 in a fresh dedicated process, without asserting
upgrades for open TTYs. The new bundle contains all logic; following potential
V2 activation, restoring V1 bytes is not a safe checkpoint downgrade. See
[local outcome](.dumps/agent-self-heal-20261013-v2/promotion-result-v2.md).

Task 50 fixed actual reopening of self-heal sessions: local dsh-cli SDK
now recognizes mandatory event `agent/self-heal`, without loosening filter for
other events. Plugin checks compatibility before activating and rejects unknown
protocol replay. Profile points to `lib/index-v2-persistence.mjs`;
109 tests (including disk/zstd and task 84) and 49 native-loop per source/bundle
passed. Task 84 preserves 7376 events / 23 audits and original hashes; no session
was rewritten. It is a hashed local bridge, not an npx/web update or upstream
portability; requires a new process. See [contract and installation](plugins/agent-self-heal/README.md#required-persistence-protocol-local-bridge)
and [evidence](.dumps/self-heal-persistence-20261013/result.md).

**Portable baseline remains separate from validated local host build.** Standard
Antigravity monorepo build expects upstream files absent from this clone; historical
recipe bundles committed `lib` and applies a hashed patch to make optional a
legacy peer used solely for types/client. Recent isolated host build uses cached tools
and dependencies of this installation; it does not demonstrate universal bootstrap,
web client integration, all LTS versions, or long-term stability.

The catalog used by the new pi-ai build comes from isolated DSH seed, not the
modified catalog of this machine. Personal providers/models must be explicitly
configured. Initial npm install still resolves transitive dependencies;
resulting lock and hashes are recorded, with no bit-for-bit guarantee across dates.

## Plugin Activation

After installing the proper bundles and restoring profiles via dotfiles:

```fish
node tools/activate.mjs --check --profile dsh-tui
# Review drift before writing:
node tools/activate.mjs --write --profile dsh-tui
```

Generation resolves paths from current checkout and writes them **relative to
the profile directory** (the repository overlay remains absolute, because `--patch`
lines anchor in the profile), preserving unmanaged block bytes, including
per-machine comments/configs. It does not clone forks, build, install bundles, or
automatically create missing profiles. The `yaml` dependency is local and pinned in
this repository's lock; it does not depend on a legacy npx.

Options: `--profile NAME` (repeatable), `--root DIR`, `--json`, `--check`, `--write`.
Without `--profile`, sync can also update repository overlay.
Invalid manifests, missing modules, and multiple separated managed blocks
are reported; no attempt is made to guess configuration. Lines within
`# BEGIN/END alex-research activation` belong to `research-activation` and do
not count as a run or render here; an isolated `- insert:` containing only `alex-*`
lines (the format appended by the resilience migrator) is folded into the managed block.

## Consolidation State of this Machine

Canonical locations: sources/recipes in this repo; CLI at
`~/.local/share/dsh-cli`; configurations in dotfiles/`.dsh`; existing backups
in `~/.local/share/dsh-customs-backups`. External frontend / Android / companion
prototype is not part of the workshop installation.

In the 2026-10-13 maintenance window, **web was migrated from npx to the canonical CLI**,
without altering flags/configs. Two legacy dry-run builds were removed from workspace
and 597 disposable fixture directories were moved to `/tmp`. Pi source was
consolidated in `sources/pi-ai/`: verified snapshot, not Git checkout
(remote unavailable), with `SOURCE-PROVENANCE.json`; see [the Pi guide](tools/pi-ai-fork/README.md).

The owner executed the cut in a separate terminal: **404 canonical links retained and
205 obsolete links removed**. The old npx installation, two scratch Pi runtimes,
and empty directory `dsh-tui-cli` were moved to `/tmp` after confirming zero
consumers/operational references across audited locations. Reopened TUI resolves
adapter from canonical. `status.mjs` verifies current status without depending
on retired roots; cut execution script remains historical and must not be repeated.
See [the post-cleanup inventory](LOCAIS-DSH.md) for preserved locations,
sizes, and cleanup boundaries. Sources, data, backups, and required compiler
were not mistaken for disposable trash.
The manifest already declares self-heal bundle with persistence, without rewriting
live profile. Workshop pins remain historical baseline, not full reproduction
of updated host. No global cache cleanup or automatic deletion occurs during bootstrap.

## Native Browser

`plugins/browser` implements a single hierarchical tool `browser`, with stable public
Playwright 1.64.0 and private SDK2 worker. Sessions/Pages belong to the Agent;
screenshots, mobile, video, and trace use dedicated artifacts, without arbitrary LLM
code execution or product dependencies. See [contract and setup](plugins/browser/README.md).
Activation remains controlled by manifest and profile smoke gates;
module presence or a passing doctor does not prove live rollout.

## Prompt Audit

After updating DSH, forks, plugins, presets, or profiles, or reinstalling runtime,
run `npm run prompt:audit`. It composes offline (no network, credentials, or model
calls) the initial request of a fresh session for `dsh-tui` and `companion` profiles,
fails if harness text contains a prohibited phrase ("playful" status line contract,
"powered by DeepSeek Harness" identity, preset personas, AGENTS wrapper as "guidance"),
and diffs harness text against `tools/prompt-audit/baseline/<profile>.txt`.
AGENTS/CLAUDE files and personal skills enter only as placeholders. Boot uses a copy
of the profile under `/tmp`, never the live profile: rewriting live `cordis.yml` reloads
lab Companion. Handling of failures and who approves `--update` is in [AGENTS.md](AGENTS.md).

## Environment Configuration

A template file [`.env.example`](.env.example) is available with all configurable variables:

| Variable | Default / Fallback | Description | Scope |
| --- | --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | Base directory for DSH profiles and runtime configs | Core |
| `XDG_DATA_HOME` | `~/.local/share` | Data root for DSH CLI install and runtime packages | Core |
| `XDG_CACHE_HOME` | `~/.cache` | Cache directory (Playwright browsers, models) | Core |
| `DSH_COMPANION_ORIGIN` | `https://dsh.tail37b3d7.ts.net:8443` | Public HTTPS origin for Companion and mobile pairing | Companion / Network |
| `DSH_COMPANION_HOST` | `dsh.tail37b3d7.ts.net:8443` | Expected `Host:` header authority for web runtime | Companion / Network |
| `DSH_COMPANION_CLI` | `$XDG_DATA_HOME/dsh-cli/lib/bin.js` | Custom binary path for DSH Companion service | Companion |
| `DSH_LOCAL_URL` | `http://127.0.0.1:8080/v1` | Base URL for local OpenAI-compatible inference server | Local LLM |
| `DSH_LOCAL_MODEL` | *(First advertised model)* | Pinned local model ID if multiple are returned | Local LLM |
| `DSH_DEFAULT_PROVIDER` | `openai-codex` | Default LLM provider route | Local LLM |
| `DSH_DEFAULT_MODEL` | `gpt-6-sol` | Default model selected in launcher | Local LLM |
| `DSH_DEFAULT_EFFORT` | `low` | Default reasoning effort for model | Local LLM |
| `CONTEXT7_API_KEY` | *(None)* | Bearer token for Context7 library queries in `research` | Plugin: `research` |
| `SIMP_MCP_PROJECT` | `~/git/my/simp_mcp` | Path to the SimpMCP audio/music server project | Plugin: `music` |
| `SIMP_MCP_UV` | `uv` | Path to uv executable for music environment | Plugin: `music` |
| `LLAMACPP_BASE_URL` | `http://127.0.0.1:8080` | llama.cpp backend endpoint for grammar correction | Plugin: `grammar-fix` |
| `GRAMMAR_GPT_MODEL` | `openai-codex/gpt-6-sol` | GPT model used for grammar fixes | Plugin: `grammar-fix` |
| `GRAMMAR_GEMINI_MODEL` | `google-antigravity/gemini-3.8-flash-low` | Gemini model used for grammar fixes | Plugin: `grammar-fix` |
| `DSH_PEAK_GATE` | *(unset)* | `off` bypasses the DeepSeek peak-hour hold for that process | Plugin: `peak-gate` |

## Validation

```fish
npm run test:prompt-audit
npm run test:launcher
npm run test:peak-gate
npm run test:wait
npm run peak:plan
npm run test:workshop
npm run test:lts:contracts
npm run test:project-mcp
npm run test:managed-plans
npm run browser:doctor
npm run test:browser
npm run test:browser:live
```

Workshop tests use isolated fixtures and controlled commands; they do not replace
a real build or manual profile testing. Documentation in `tools/task10-profile/`
records historical provisioning/promotion and constraints, not a promise of
universal installation or permission to alter active runtime.
