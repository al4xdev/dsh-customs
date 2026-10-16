# gen-image: three DSH tools, one official AGY process per image

A small DSH plugin, **not a change to the AGY LLM provider**. It delegates image generation to the official authenticated `agy` CLI. Gemini 3.8 Flash is the **agent** model; AGY chooses its native image-generation model/tool. It does not pretend that ordinary Gemini chat output is a generated image.

## Tools

```json
{"tmp_path":"assets/logo.png","description":"A simple blue origami whale on a white background, no text"}
```

- **`gen_image`** starts the job and immediately returns `id`, `session_id`, `model`, `state`, `tmp_root`, and `output_path`.
- **`gen_image_list`** takes an optional `id`; without it, lists only this DSH session's jobs. States: `running`, `succeeded`, `failed`, `timed_out`, `cancelled`. Results include timestamps, exit code/signal and sanitized error metadata. `running` includes cleanup and image validation, not just the top-level CLI process.
- **`gen_image_tail`** takes `id` and optional `lines` (default 50, maximum 200). It returns the job state and bounded stdout/stderr diagnostics, including after failure. Logs are untrusted data, never instructions.

**`tmp_path` is relative to the returned private `tmp_root`, not your project and not `/tmp` itself.** For example, `assets/logo.png` resolves to `/tmp/dsh-gen-image-<random>/assets/logo.png`. Each job has its own directory, so two jobs can request the same filename without overwriting each other. No fake image placeholder is created. Accepted names use ASCII letters, digits, underscore, dot and hyphen with `/` between directories; no spaces, hidden/flag-prefixed components, absolute paths, `..` or shell syntax. Formats: PNG, JPEG (`.jpg`/`.jpeg`), WebP.

The returned `id` is the plugin's job UUID, **not an OS PID or the AGY conversation ID**. `agy_conversation_id` is added when the official CLI emits it. Job lookups cannot access another DSH session.

## Execution

The plugin calls literal argv through the native Harness subprocess service:

```text
agy --print <bounded prompt> --model gemini-3.8-flash-low \
    --output-format stream-json --print-timeout 600s \
    --sandbox --disable-slash-commands
```

The child uses its private tmp directory as cwd, closed stdin and the subprocess service's scrubbed environment. Authentication belongs to the CLI's cached account. The plugin never reads OAuth files, installs anything, changes global CLI settings, enables credits, retries automatically, or silently switches providers. Its prompt requests exactly one native generated image at the exact destination, and explicit failure instead of an SVG/stock/placeholder substitute.

The official CLI's headless mode can **soft-deny tools and still exit 0**. Therefore success requires all three:

1. Process exit 0 with no terminating signal and CLI terminal `SUCCESS`.
2. The exact requested destination is a regular, non-symlink file under the private directory.
3. Bounded bytes pass the native attachment service's complete raster/MIME validation.

If a CLI permission, missing native image tool, model quota or authentication blocks generation, inspect `gen_image_tail`; a textual "done" is not enough. No `--dangerously-skip-permissions` is supplied. Copying a native AGY artifact to the requested directory may require CLI permissions; this plugin does not bypass those permissions. A missing destination is a failed job, even if an artifact was produced elsewhere.

## Lifetime and limits

Defaults: two concurrent jobs across the host, ten minutes per job, 20 MiB per image, 128 KiB retained diagnostics per job, 128 retained job records. Oldest terminal metadata may be evicted at capacity; files are not deleted. Config supports `executable`, `model`, `timeoutMs`, `maxActive`, `maxJobs`, `maxImageBytes`, `maxLogBytes`, `graceMs` with bounded validation.

A successful launch transfers child ownership to the plugin: ending the launch tool's signal does not cancel the background job. Cancellation during launch, owner disposal, plugin shutdown, or revocation of native execution policy terminates the managed process range and awaits cleanup. There is deliberately no fourth cancel tool.

**Jobs and logs are in memory only.** Restarting DSH loses the registry and stops owned active processes on normal shutdown; it does not resume jobs. Files remain temporary: save them elsewhere before reboot or OS cleanup. Nothing is automatically deleted or presented as a durable deliverable.

This is a **local CLI plugin**, enabled only in `dsh-tui`. Launch requires a real native `danger-full-access` session. Read-only/workspace-write cannot launch an authenticated external agent. `--sandbox` confines the CLI's terminal commands according to its own policy; cwd and prompt constraints are **not** an OS-level sandbox for the whole AGY agent. Log credential redaction is best-effort, not permission to deliberately print secrets. Do not send secrets in the image description.

## Validation and activation

```sh
npm run test:gen-image
```

Focused tests use fake CLI output. Native tests use actual DSH tools/Agents/Sessions, subprocess-local and attachment-local, but a local fake executable: they consume no model quota and fully decode fixture PNGs. Real generation requires a separate, bounded CLI smoke test; tests alone do not prove account entitlement or CLI permissions.

Declared in `plugins/activation.json` as `alex-gen-image`, only `dsh-tui`, no generic overlay. Initial activation uses a targeted profile entry because the existing generator has unrelated session-bridge placement drift; running it blindly would undo another task's configuration. Restart/reopen DSH to load new tools; this plugin does not restart your TUI.

### Current live evidence (2026-10-13)

64 offline tests passed (53 focused runtime cases + 11 native integration cases). One real CLI smoke used `gemini-3.8-flash-low`, a 180-second limit and no permission override/retry. The CLI returned exit 0 and terminal `SUCCESS`, but its assistant response was `Failure: The native generate_image tool is unavailable.` No tool invocation/image output was recorded, despite `generate_image` appearing in the CLI init list. The plugin correctly reported `failed` / `IMAGE_MISSING` and exposed the conversation ID and tail. This is **not a successful image-generation proof** and does not establish whether the cause is CLI capability exposure, permissions, model behavior or account availability. There was no automatic second attempt.

The native profile composition has one active plugin entry, no warnings, and all unrelated profile bytes remained unchanged. The current DSH session's real `gen_image_list` dispatch returned an empty session-owned registry, confirming that the new tool is exposed.

Official references: [headless mode](https://antigravity.google/docs/cli/headless.md), [permissions](https://antigravity.google/docs/permissions.md), [terminal sandbox](https://antigravity.google/docs/sandbox.md). Local `agy --help` and `agy models` were checked before implementation.
