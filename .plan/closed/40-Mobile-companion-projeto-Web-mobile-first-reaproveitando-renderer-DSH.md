# Mobile companion — mobile-first Web frontend

## Objective
Create **frontend/mobile-companion/** as a frontend project, not a DSH plugin or TUI fork. Use the active goal to guide execution after approval. Interface in Portuguese for Alex to converse with the **companion** profile on mobile: conversation list, new chat, conversation, and native confirmations. No settings, profile/model selection, terminal, or project editor.

## Facts and technical decision
- Companion backend already exists on loopback 3081, Tailscale 8443; original Web 3080/443 and TUIs must remain untouched.
- Web DSH 0.2.0-rc.2 is React 18; packages client-ui-chat/conversation/renderer/session implement history, streaming, cards, and approval. Bundles `./client` are modules of `__ModuleLoader__`, not isolated React ESM. ui-settings provides configForms infrastructure and can exist without settings screens.
- Reuse published modules from Web runtime, pinned 0.2.0-rc.2, and upstream bootstrap/shell at tag dsh-v0.2.0-rc.2 (639ed015397290b3745d163aafe02ffee4aa3f84), preserving MIT/license/attribution. Do not edit node_modules or frontend/dsh-tui.
- First verify public root/slots composition APIs for custom shell and necessary modules. NOT a desktop iframe or simple CSS hiding the entire interface; use real renderer with mobile shell. If there is no adequate public seam, vendor exact sources from shell/kernel and preserve renderer/packages, without forking the entire monorepo. Document vendored boundary/dependencies.

## Structure and integration
- Own package.json, mobile shell/layout code, assets, build/serve scripts, tests, and README within the project. Artifacts/cache ignored; dumps and experimental captures outside product.
- Dedicated frontend loopback service (3082 pending availability validation), same-origin proxy to fixed backend 3081, cookie auth and RPC/WS/events/resources preserved. Never arbitrary backend received from query/string or token in build, localStorage, console, screenshots, or journal.
- Conversation selection restricted to companion chats; other sessions/projects are observed through the `session` tool inside the conversation, not mounted directly as normal agents by the frontend. New chat is always companion; no profile/model picker.
- Backend default/preset exclusive to companion already configured: validate at runtime, not just hide select. Foreign chat deep links must not open/resume that target; display safe return to list.
- After local validation, publish only companion 8443 pointing to the frontend, keeping 443/3080 and backend 3081. Previous route/service remain available for rollback. Any necessary backend override must be minimal, preserving ask/read-only policies and single tool.

## Mobile UX
- Single column; chat list and conversation are two screens, back button accessible, clear new chat, connection title/status, and reconnection.
- Reuse Web theme/typography/components; reduce chrome and screens that do not belong to chat. Touch >= 44px, viewport/canvas without horizontal overflow, safe-area and 100dvh/visualViewport for keyboard. Input >= 16px to prevent iOS zoom, safe send/cancel/focus.
- Native renderer for Markdown/code/tables/cards/tool results/streaming/history. Preserve selection/copy, scroll-to-bottom that does not pull user when reading above, loading/empty/disconnected states, dialogs, and prompts when relevant.
- **Confirmation of session send/resume is essential to chat**, not a setting: show target/action/literal text, legible reject/allow-once buttons; never auto-approve or infer consent.
- Manifest/icon for home screen addition if simple and compatible; no offline cache of API/conversations/tokens. No APK or native integration required.

## Validation
- Build/bootstrap/proxy/auth/WS tests, companion-only selection/creation, foreign chats/deep links, body limits, and anti-SSRF/origin/cookie/secret leakage; existing session/profile plugin regression.
- Maintained browser with canonical viewport 393x852 / DPR 2 / touch, also widths 320/360, landscape, and desktop as verification; screenshot of non-sensitive synthetic data, console/network errors, overflow/element bounds.
- Real flows: enter with private auth, list -> create/open chat -> send -> streaming -> response -> history -> back -> reopen -> reconnect; scroll/code/table and rejected/allowed-once approval with exact synthetic targets. Nothing sent to observed real sessions.
- Observe keyboard/visualViewport through what emulated browser permits; do not claim physical Android/iOS validation if not used. Do not bypass disabled browser operations: use test environment's own seams, without attaching personal profile.
- Document usage/build command, versions, limits, and rollback; verify original 443/Web intact and healthy service, remove test helpers, collect jobs. No commit/push.

## Completion criteria
Custom mobile frontend working on companion endpoint, reused renderer and fixed profile, listing/chat/streaming/confirmations tested in mobile browser with evidence, unnecessary user configuration avoided, and original services preserved. Do not treat mock screenshot or build-only as completion.
