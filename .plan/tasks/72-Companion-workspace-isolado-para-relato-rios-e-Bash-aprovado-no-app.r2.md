# Companion: Native workspace-write Sandbox and App-Approved Bash

## Request and Owner Clarification
The owner authorized tools to create reports/files in a dedicated folder and Bash with command approval in the app. He later clarified: do not create an elaborate parallel hardening project or semantically restrict the agent to reports only; grant write within sandbox and continue everything in parallel. This revision replaces the excessive read-isolation and custom sandbox requirements of revision 1.

## Simple and Native Implementation
- Use `/home/alex/git/my/dsh-companion-workspace` as CWD for **new** enabled sessions; `relatorios/` optional to organize files.
- Compose standard tools read/list/write/edit with native `workspace-write` sandbox. Standard reads and internal temporary files in `/tmp` permitted by default sandbox are accepted; do not construct a virtual/read-only private filesystem, custom hardlink checks, or restrict to specific report formats.
- Preserve native write confinement outside workspace and normal temporary directories. Do not offer automatic `danger-full-access` grants; if Bash approval involves mode promotion, decouple literal approval from execution while maintaining workspace-write.
- Each Bash command must be displayed literally with its CWD and explicitly approved in the app as allowed-once / rejected prior to execution. Reuse existing permission/approval/SDK; introduce a minimal wrapper/hook only if native system cannot enforce prompting on every run without escalating sandbox. No regex allowlists, custom sandbox, or new prompts.
- Renderer/icons do not grant capabilities; permission stems from declared composition and runtime, exclusively within this approved scope. Other profiles / models / publishing / Tailscale / HA remain untouched.

## Required Integration
Read public read-only SDK sources to identify the minimal path preserving native workspace-write mode + literal approval. Enforce CWD/scope via Host for new sessions; do not rely merely on an Android payload that alternative clients could manipulate. Retain preset / catalog / header / admission guards. Do not rewrite CWD or broaden tools of legacy chats inadvertently; no takeover / restart / hot-inject of the active agent the user is interacting with.

## Proportional Testing
- Fixtures/fake providers: file inside workspace permitted, write outside rejected by native protection, unapproved/rejected Bash does not execute, allowed Bash executes once in expected CWD without escalating sandbox; stale generation / double-tap / disconnect does not repeat.
- Display full literal command + CWD in app within existing bounds; reject any command that cannot be presented with integrity, without inventing an expansive inspector or new product.
- Test generator / guards / backend and app, lint / protoc / JVM / Compose / SDK 34 emulator and integrate with APK 4 task 70. No real models/grants for testing, captures strictly fixture-based; in-use phone does not receive updates / force-stop / instrumentation until in a safe condition.

## Acceptance and Delivery
Versatile agent without extra persona, dedicated workspace, and native sandbox write. Bash approved in-app without automatic dangerous grants. Refined Task 70 interface proceeds in parallel. Reports presented via admitted public attachment refs when supported; no arbitrary host path / URL fetching. Honest evidence and limitations, signature/UID/vault preserved, no commit/push, no HA deploy or service changes without explicit requirement / safe idleness.
