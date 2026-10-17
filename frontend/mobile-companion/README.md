# Mobile companion

Mobile-first web frontend for the existing DSH **companion profile**. Independent project, not a host plugin and not a TUI fork.

Two screens: conversations and chat. No settings, model/profile selection, workspaces, or terminal. Other projects are queried via the `session` tool inside the conversation. The official renderer preserves Markdown, code, tables, streaming, history, tool cards, approvals, and questions.

## Running

Requires Node >=22 and durable DSH **0.2.0-rc.2** installation in `~/.local/share/dsh-cli`. The companion backend must be active at `127.0.0.1:3081`, with its dedicated `companion` preset and existing policies. Does not create or modify that profile.

Inside this project directory:

```fish
npm ci --include=dev
npm run check
npm start
```

Frontend listens on **127.0.0.1:3082 by default**. For access via machine IP on a trusted network:

```fish
npm start -- --host 0.0.0.0 --port 8889
```

Open `http://MACHINE_IP:8889`; `0.0.0.0` is the bind address, not the address to open on your phone. This exposes HTTP across all IPv4 interfaces without encryption; do not publish to the open internet. Native authentication remains mandatory. Arbitrary hostnames are rejected, only local interface IPs identified during server startup are accepted.

For recommended private access, use the companion link; under the deployment detailed below, public address 8443 remains unchanged. Never place tokens in code, build variables, or browser storage. Native login/cookie is forwarded via proxy. If your npm environment blocks esbuild postinstall, the distributed optional binary may function without this script; do not bypass installation policies.

`DSH_RUNTIME_NODE_MODULES` can specify an alternate dependency directory during build. Runtime version remains strictly validated; updating DSH requires explicit review, not silent mixing of versions. Declaration aliases in `tsconfig.json` point to this host's durable installation; adjust aliases when moving project or runtime.

## Typing and Linting

React remains the framework. TypeScript enforces `strict`, exact optionals, verified indexed access, `unknown` catch variables, and actual public contracts for DSH services/slots. Network payloads are validated prior to use. Local dependencies include only React 18 types; React runtime and store originate from the official singleton, avoiding a bundled second instance.

`npm run typecheck` validates internal TypeScript code; `npm run lint` mandates zero warnings under strict type-aware ESLint, promises, React hooks, and accessibility rules. Server, scripts, and JS tests adhere to genuine JS rules rather than claims of equivalent typing. Upstream or generated code is not masked as approved internal code. `npm run check` runs typecheck, lint, tests, and build, in that order.

## Architecture

- `src/`: Custom React shell and navigation, leveraging official Web React/store singletons.
- `server/`: Same-origin HTTP/WS proxy targeting fixed 3081 backend, read-only public catalog of Zstd headers, and bootstrap transformation. Forwarded POST bodies are limited to 1 MiB, except `POST /api/session/uploadFileBinary` (one file per request): up to 20 MiB + 64 KiB, only with `Content-Length`, forwarded as a stream (without buffering before native auth); requests lacking size or using chunked transfer receive 411 (A1 contract shared with `plugins/companion-transport/request-budget.mjs` and the app).
- `styles/`: Single-column layout, safe-area insets, dynamic viewport, 44px tap targets, and 16px input font size.
- `public/`: Icon and local manifest. No service worker: no offline caching of conversations, API, or credentials. Adding to home screen depends on browser; not an APK.
- `test/`: Isolated regression suites for auth, proxy, profile, bootstrap, and navigation. Build artifacts in `dist/`, gitignored.

Web bootstrap and modular composition are reused. The shell does not wrap a desktop page in an iframe or hide the desktop UI with CSS. It replaces the root and official navigation, whose automatic restoration could otherwise reopen sessions from other profiles. The conversation list is filtered strictly by the **persisted header `agentPreset: companion`**, prior to any `retain`/follow action. Titles and updates may be augmented by cached projections from official `session/list`, without launching agents or reading history files for filtering.

New chats are spawned through native creation with an explicitly pinned preset. The validated response permits a short cache window for empty chats not yet materialized; a foreign persisted header always takes precedence and revokes that entry. Links, Back, and Forward actions are revalidated; no obsolete workspace selection is restored. URIs include solely the chat id, never credentials.

The service integrates with the dedicated companion backend. The `/api/` proxy remains the API **of the authenticated owner**, not an RPC firewall for hostile clients. The absence of configuration screens is not a new authorization boundary. Verifying the single preset does not cryptographically prove profile/policies: preserve the existing companion service and its restricted configuration.

### Upstream Adaptation Boundary

Version/tag: `dsh-v0.2.0-rc.2`, commit `639ed015397290b3745d163aafe02ffee4aa3f84`, repository [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2).

Browser bundles `@deepseek-ai/dsh-client-*` rely on `__ModuleLoader__`, not isolated ESM imports. This project maintains the module closure for renderer/conversation/composer and infrastructure, while excluding settings/model/preset screens and HMR that might restore the desktop roster. Each served bundle receives content-hashed atomic publishing; the installed runtime is never edited.

Sole text adaptation in native bundle: `server/native-adaptations.mjs` omits the `onBranch` callback from the footer. rc.2 lacks a public switch and the original callback spawns forks directly, bypassing protected navigation. The cut is exact, requires a single match, and fails closed when upstream code shifts. Parser, transcript, cards, composer, streaming, and confirmations remain untouched. DeepSeek's MIT license and Montserrat's OFL license are copied to `dist/licenses/`. Upstream dependencies retain their respective licenses.

## Publishing to Current Service

Reference systemd unit is located at `deploy/dsh-mobile-companion.service`, configured for this host's paths. Production runs `server/start.mjs`, which contains no test-login flags/envs or arbitrary backend switches.

1. Build, test, and verify that no ephemeral audit instance occupies 3082.
2. Install unit at `~/.config/systemd/user/dsh-mobile-companion.service`; run `systemctl --user daemon-reload` and `systemctl --user enable --now dsh-mobile-companion.service`.
3. Update **strictly** Tailscale HTTPS 8443 route to `http://127.0.0.1:3082`. Backend 3081 remains running. HTTPS 443 / Web 3080 and TUIs must not change.
4. Verify private login, chat/streaming, history, and confirmations through the 8443 endpoint; never print link or token to terminal or journal logs.

Deployment on this host as of 2026-10-13: frontend unit active on 3082 and HTTPS 8443 proxying to it; HTTPS 443 remains at 3080, preserving original Web and companion processes. Unauthenticated public requests return 401; `/__test/login` returns 404 in production. Native HTTPS login returned 303, followed by mobile bootstrap 200 and authenticated companion-only catalog 200, without printing credentials. Renderer, history, live responses, and reconnection were verified via loopback browser using established native authentication. Physical keyboard and bounce behavior still require on-device validation.

Rollback: restore route 8443 back to `http://127.0.0.1:3081` and stop/disable the frontend systemd unit. Do not delete or convert histories, reinstall profiles, or restart original Web.

## Limits and Evidence

Automated tests do not represent a physical Android/iPhone device. Emulated browser testing uses 393×852, DPR 2, and touch/mobile profiles; test also 320/360 widths, landscape, overflow, history, reconnect, and approvals. Physical keyboard handling, system bars, and home screen PWA installation require testing on hardware. Catalog currently returns up to 100 chats; legacy authenticated links still pass header guard, but pagination beyond 100 requires future work. Untitled headers use a short identifier to differentiate conversations.

Login helpers, fixtures, and captures are local under `.dumps/mobile-companion`, outside the product. The login seam exists solely as a constructor option for loopback audits and is disabled in production CLI. Never publish audit instances or auto-answering approval bots.
