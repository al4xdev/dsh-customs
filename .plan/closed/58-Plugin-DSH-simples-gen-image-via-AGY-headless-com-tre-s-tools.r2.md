# DSH gen_image plugin via AGY CLI

## Approved objective
Create new plugin `plugins/gen-image/`, separate from the AGY provider, with exactly `gen_image({tmp_path,description})`, `gen_image_list({id?})`, `gen_image_tail({id,lines?})`. Official CLI wrapper `agy --print`, model `gemini-3.8-flash-low`, stream-json output. Active goal guides execution; complete only with evidence.

## Contract and minimalism
Gen launches asynchronously, returning job UUID/DSH session/paths/state; `tmp_path` strictly relative to private directory `/tmp/dsh-gen-image-*`, PNG/JPEG/WebP, no fake placeholder/overwrite/escape/symlink. List/tail scoped to real session, ID not PID, AGY `conversation_id` as extra metadata. Tail max 200 lines, bounded/sanitized logs / untrusted data. Exactly 3 tools, no new multi-vendor SDK/image provider. Original file stays in tmp, no additional preview in MVP.

Use native Harness subprocess for literal argv/scrubbed environment/range TERM-KILL and `attachments.validateImage` to validate file. CLI stdout consists of `event:init/step_update/result` and SUCCESS result does not equate to existing image. Success requires CLI exit 0 + terminal SUCCESS + exact regular image/MIME/size/full decode. For soft-denied command exit 0 without image, state is failed. Gen requires native danger-full only; do not invent full containment for external agent using cwd/CLI terminal sandbox. Read-only/workspace-write are not authorized. Pass `--sandbox`, no dangerous permission override, no modifying global settings/OAuth/billing, no credit opt-in/automatic retry/paid fallback.

Job lifetime transferred to plugin upon returning gen, timeout config default 10min, host concurrency 2, logs 128 KiB, bounded metadata 128 jobs (oldest terminal jobs can be evicted), each file <= 20 MiB. Jobs/logs in-memory, no resume after restart; leave files for user/OS cleanup. Cancellation during launch/agent disposed/plugin shutdown/policy revocation terminates process range and awaits quiescence; do not declare finished before process range cleanup / valid file check. No new cancel tool.

## Files and activation
Runtime/index/tests/README in `plugins/gen-image`. Manifest `activation.json` adds `alex-gen-image` only to `dsh-tui`; npm focused test script and `plugins/README.md` targeted edits. Do not edit AGY repo, root foreign changes, or commit/push.

**Activation refinement, revision 2:** dry-run `node tools/activate.mjs --profile dsh-tui --json` revealed preexisting drift: generator would reintroduce `alex-session-bridge` into global host, whereas current profile already has a separate standard preset. Exit code 1 was investigated, not blindly normalized. To preserve task 47/companion work, DO NOT execute full managed blocks regeneration in this task. Register manifest and insert only `alex-gen-image` into local profile patch via targeted edit, snapshot backup + byte comparison, and YAML composition check. Document preexisting drift and do not change bridge/standard plugins placement. Optional repo overlay remains outside specific activation; do not re-emit to bypass drift. Future generator fix is an independent task. This replaces the broad activate method planned in r1, without altering functional delivery.

## Gates
Unit/runtime fake CLI: argv model/path ownership/limits/logs/protocol events/missing invalid image/exit error/signal/timeout/dispose/cancellation/policy revocation/symlink escape. Native real Cordis tools + Agents/Sessions + subprocess-local + attachment-local fake executable, schemas of exactly 3 tools, canonical output validation, session ownership, start returns before exit and caller abort after transfer ignored. Do not install dependencies.

One limited smoke test with ONE simple PNG image using official CLI cached account, timeout <= 10min, no billing opt-in or permission override is authorized for proof; do not repeat automatically after failure. Generate only job tmp, logs/result receipt in local gitignored `.dumps`; do not use raw cloud code endpoint/fingerprint spoofing. If access/tool/CLI fails to produce a file, clearly report live failure separate from fake CLI gates, without claiming functional generation.

## Verified baselines
Local `agy --help` ELF confirmed, model metadata listing exit 0 Gemini 3.8 Flash low/medium/high. Docs: https://antigravity.google/docs/cli/headless.md, https://antigravity.google/docs/permissions.md, https://antigravity.google/docs/sandbox.md. Real CLI flags take precedence (default local print timeout 0 but wrapper sets 10min). Do not restart TUI automatically or expose credentials.
