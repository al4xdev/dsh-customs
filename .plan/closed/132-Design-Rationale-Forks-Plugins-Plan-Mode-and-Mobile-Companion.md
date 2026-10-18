# Plan 132 — Architectural Rationale: Forks, Plugins, Plan Mode, Antigravity, and Mobile Chatbot

## Objective
Add an extensive, authoritative "Why These Forks and Plugins Exist (Design Rationale)" section to `README.md` (in English). It will explain the architectural motivations behind the forks and plugins, spotlighting:
1. **The Antigravity Fork (`dsh-antigravity`):** Why it is the most advanced fork, providing a cleaner, more robust path than upstream, natively supporting next-gen models (Claude 5.5, Gemini 4 Argon), dedicated quota reset retry, and native in-TUI usage tracking.
2. **The Pi Engine Fork (`sources/pi-ai`):** Preventing implicit `reasoning: none` poisoning on Codex, surviving long-session WebSocket disconnects, and fine-grained compaction near 190k tokens.
3. **The TUI Fork (`frontend/dsh-tui`):** Rich inline diff cards for `apply_patch`, background favorite sessions (`Ctrl+P`), and inline buffer grammar editing (`Ctrl+G`).
4. **Managed Plan Mode (`plugins/managed-plans`):** How it differs from native autonomous plan mode by maintaining reviewed, versioned, immutable Markdown artifacts in `.plan/` with atomic database tracking and revision guards.
5. **The Resilience & Safe Filesystem Suite:** Why `trash`, `list`, `apply-patch`, and `llm-resilience` / `agent-self-heal` prevent accidental context explosions, destructive bash operations, and transient API failures.
6. **Mobile Companion as a Private AI Assistant/Chatbot:** How the Android app functions as a private, secure replacement for commercial mobile apps (ChatGPT/Gemini) backed by local sandboxing, real developer workspace access, and deep multi-source research (`research` / `.dumps/research`), citing real-world examples (e.g. mining obscure game databases across Reddit, X, and forums with materialized local evidence).

---

## Action Steps
1. Draft the comprehensive Rationale section in `README.md` in clear, technical, and objective English.
2. Verify that `npm run prompt:audit` remains completely clean.
3. Commit and push the changes.
