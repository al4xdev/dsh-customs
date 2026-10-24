# `/music` — standalone player control

A DSH human slash command, **not an LLM tool**. It calls the standalone
`kiosktunes-mcp` CLI directly, without an agent, model request, MCP connection, shell,
or runtime installation/reload.

## Usage

```text
/music play artist song
/music play "artist — song" --enqueue
/music play --id dQw4w9WgXcQ
/music play
/music pause
/music resume
/music stop
/music next
/music previous
/music last
/music status
/music queue
/music volume 50
/music seek 90
/music seek -10 --relative
/music repeat off
/music repeat one
/music repeat all
/music shuffle
/music clear
/music shutdown
/music auth status
/music auth import-simpmusic
/music auth import-simpmusic --force --auth-user 1
/music help
```

`last` is an alias for `previous`; `play` without a query resumes playback.
Queries (up to 500 characters) are passed as one literal argument;
quotes group words and backslash can escape a quote, space, or backslash.
There is **no** `$HOME`, command substitution, wildcard, pipe, or redirect
expansion. Unknown commands/options and extra arguments are rejected locally.
Video IDs must be 11 ASCII letters, digits, underscores, or hyphens. Volume is
0–100; seek is bounded to 86400 seconds (negative only with `--relative`).
`/music`, `/music help`, and `/music --help` show local English help.

Authentication import has a fixed source defined by the Python project. The
plugin accepts **no credential text or source-path override**. `--force` refreshes
an existing import; `--auth-user` selects an integer account index from 0 to 100.
Import only when
you intend to copy the existing SimpMusic credentials; do not paste secrets into
DSH commands.

## Configuration

Defaults:

- Project: `join(homedir(), 'git/my/kiosktunes-mcp')`.
- `KIOSKTUNES_PROJECT` / `SIMP_MCP_PROJECT`: override with an absolute project path.
- uv executable: `uv`, resolved through the DSH process's `PATH`.
- `KIOSKTUNES_UV` / `SIMP_MCP_UV`: optional absolute uv executable path.
- `timeoutMs`: 30000 (allowed 100–120000).
- `maxOutputBytes`: 32768 combined stdout/stderr bytes (allowed 256–65536).

Cordis plugin configuration can override environment settings with
`projectPath`, `uvBinary`, `timeoutMs`, and `maxOutputBytes`. `uvBinary` accepts
only `uv` or an absolute executable path, not a command string with arguments.
Settings are read when the plugin loads; changes require a newly loaded plugin.
There is no working-directory dependence: every invocation is exactly:

```text
uv run --directory PROJECT kiosktunes-mcp music SUBCOMMAND ...
```

The actual implementation uses `spawn(executable, argv, { shell: false })`, with
stdin ignored and stdout/stderr piped. The project must already be prepared by
its owner; `uv run` may perform its usual dependency synchronization, so prepare
the environment in advance if network-free playback is required.

## Activation / installation (explicit owner step)

The maintained `plugins/activation.json` contains:

```json
{ "id": "alex-music", "module": "music/index.mjs", "profiles": ["dsh-tui", "companion"], "overlay": false }
```

After ensuring uv and the standalone project are available to the DSH process,
review/apply registration from the repository root:

```fish
node tools/activate.mjs
node tools/activate.mjs --write --profile dsh-tui
node tools/activate.mjs --write --profile companion
```

Review **all** reported drift before `--write`; it can activate other pending
manifest edits too. For this delivery the parent installed only the specific
`alex-music` host row in the live `dsh-tui` and `companion` patches, preserving
unrelated rows. It did not restart or reload either runtime. The commands above
remain full-generator installation instructions, not a record of commands run.
The generated host profile row is an absolute module path to
`plugins/music/index.mjs`; the module exports `inject = ['commands']`, so no
`tools` injection or preset tool registration is needed. The companion's
isolated model tool inventory stays unchanged. No change to its profile source
is needed: the manifest is already the managed host plugin authority. Other
profiles and the generic overlay do not receive this plugin. Start a fresh DSH
process using the chosen profile to verify command discovery after activation;
no runtime restart or reload is triggered here.

For an unmanaged profile, insert a Cordis plugin row with `id: alex-music` and
`name: /absolute/path/to/dsh-customs/plugins/music/index.mjs` in its host patch.
Do not register the same plugin twice in a managed profile.

## Native DSH / CLI contract

Requires the native `commands` service (`@deepseek-ai/dsh-commands`) with
`ctx.commands.register({ definitionId, name, description, input, handler })`.
The handler receives `rawInput` and a cancellation `AbortSignal`, and returns
`{ kind: 'success' | 'error', text }`. Registration belongs to the plugin's
Cordis context; unloading cancels pending invocations. DSH's native command
lifecycle stores command results as log-only events, **not model input**. This
plugin sets `recordInput: false`: even malformed input is not persisted, because
it might accidentally contain credentials.
The UI must dispatch `/music` through that native command registry; a plain
headless prompt or unsupported client is not a substitute.

The CLI must implement the English argparse subcommands listed above, accepting
queries as one positional argument, and return exit code 0 for success. Safe
human-readable JSON on stdout is supported without requiring a new JSON schema.
**Success stdout must contain only public player metadata**; auth output must
contain only paths, modes/counts/status, never headers, cookies, or tokens.
Nonzero stdout and all stderr are discarded, and raw exceptions are never
logged or shown. Credential-shaped success lines are defensively omitted and
terminal control bytes stripped, but this is not a universal secret detector:
the CLI's safe-output contract remains essential.

At most four invocations run concurrently. Timeout, cancellation, and combined
output overflow terminate the CLI with SIGTERM, escalating to SIGKILL after
500 ms. The deadline bounds this adapter, not the lifetime of a player daemon
started by the standalone project. An interrupted command may already have
changed playback or imported auth; it is **not rolled back or retried**.
No process-tree-kill guarantee is made for child processes uv/the CLI may spawn.

## Tests

```fish
node --test plugins/music/music.test.mjs
```

Offline contract tests cover every command, literal shell syntax, bounded
input/config, fixed auth import, exact spawn argv, success sanitization,
nonzero/stderr suppression, timeout/kill escalation, cancellation, output limits,
Unicode chunk boundaries, and slash-only registration. A real Node subprocess
also verifies pipe handling; it does not run uv or the music CLI. An optional
installed-host test checks actual native registry dispatch, log-only lifecycle
records, and omission of rejected secret-like input (skipped without DSH).
Tests never
touch credentials, play music, install dependencies, or call a provider.
These tests are not a claim of
live player behavior or of an activated TUI/companion session.
