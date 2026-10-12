# Project-local MCP (native DSH)

This plugin connects MCP servers **only for a new/resumed Agent whose immutable
`session.header.cwd` belongs to an opted-in Git project**. It reads only
`<canonical nearest Git worktree root>/.agents/mcp.json`. Missing cwd, no Git
root, or absent config means no contributions. Home/global MCP files are never
loaded. Nested repositories and Git worktree `.git` files are supported.

**Correction:** DSH does support native scoped plugin composition. Earlier claims
that it has no project/scoped support were based on recursive searches that did
not traverse package symlinks. This wrapper supplies project discovery/config;
`@deepseek-ai/dsh-mcp-client` supplies the transport, reconnect supervisor, scoped
tool registration, optional scoped resource registry and prompt instructions.
The client transport stays native. Builtin servers use the official MCP server
SDK through a small local module loader; there is no hand-written MCP protocol.

## Project opt-in

```json
{
  "mcpServers": {
    "project": {
      "command": "/absolute/path/to/server",
      "args": ["--example"],
      "env": { "EXPLICIT_SERVER_SETTING": "value" },
      "cwd": ".",
      "toolCallTimeoutMs": 60000
    },
    "remote": {
      "transport": "streamable-http",
      "url": "https://example.invalid/mcp",
      "headers": { "Authorization": "Bearer replace-me" },
      "enabled": false
    },
    "legacy_restricted": {
      "enabled": false,
      "command": "/path/to/restricted-server",
      "approval": "prompt"
    }
  }
}
```

- `transport` defaults to `stdio`, or `streamable-http` when `url` is present.
- Object keys become native `serverName` (1–32 characters `[A-Za-z0-9_-]`).
  Tools are named `mcp__<serverName>__<toolName>` with native normalization.
  Identical names in unrelated Agent scopes are isolated, not conflicting.
- Stdio `cwd` defaults to the canonical project root. Relative values resolve
  against that root, not the host process cwd; absolute values are canonicalized.
  The directory must exist. Explicit paths outside the project are permitted:
  this is a working-directory setting, **not a filesystem sandbox**.
- Native config fields: stdio `command`, `args`, `env`, `cwd`; HTTP `url`,
  `headers`; both `toolCallTimeoutMs`, `failOnStartupError`,
  `maxInstructionBytes`, `reconnect`. `serverName`, if supplied, must match its key.
- This wrapper defaults `failOnStartupError` to **true**. All entries are
  validated before any server is launched. A later connection failure rolls back
  earlier connections for that Agent. Explicit native `false` allows startup
  without tools while native reconnect runs.
- Native reconnect defaults: enabled, 500 ms initial delay, 30 s maximum delay,
  10 attempts. Native tool/resource timeout defaults to 60 s; instruction limit
  defaults to 32768 UTF-8 bytes.
- `enabled:false` entries are never loaded and may retain legacy metadata. For
  enabled entries, **every unknown field is rejected**. In particular `approval`,
  `startupTimeoutMs`, `permissions` and legacy sandbox flags are not dropped.
  Do not enable restricted servers by deleting their old approval policy.
- The config is bounded to 1 MiB and must resolve inside the selected project.
  Config symlinks escaping to a home/global file are rejected.

Project-local config is trusted executable configuration: opening an opted-in
project may start its configured command. Review it before opening untrusted
repositories. Environment values are explicit server inputs and may contain
secrets; prefer local ignored config rather than committing credentials.

## Builtin: project tool modules

Install this checkout's pinned server dependency once (Node.js 20+):

```fish
npm ci
```

Opt in using the same project-local `.agents/mcp.json`:

```json
{
  "mcpServers": {
    "local": {
      "builtin": true,
      "toolsDir": ".agents/tools",
      "timeoutMs": 30000
    }
  }
}
```

`toolsDir` defaults to `.agents/tools`, must exist as a directory, and must
resolve within the canonical project root. Relative paths are project-relative;
absolute paths inside the project also work. `timeoutMs` defaults to 30000 and
must be an integer from 1 to 2147483647. Other accepted builtin fields are
`enabled` and `failOnStartupError` (default true). Native `command`/`url` entries
remain unchanged; their fields are not mixed into a builtin entry.

Each immediate `*.mjs` file exports a `tools` array. For example,
`.agents/tools/greet.mjs`:

```js
export const tools = [{
  name: 'greet',
  description: 'Greet someone in this project',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
  async handler({ name }, ctx) {
    ctx.signal.throwIfAborted();
    return `Hello ${name} from ${ctx.root}`;
  },
}];
```

- Names use `[A-Za-z0-9_-]+`, are unique across all loaded modules, and appear
  as `mcp__local__greet`, only in the owning Agent's scope. Native DSH tools
  are not replaced or disabled.
- `inputSchema` and optional `outputSchema` are JSON Schema objects with
  `type: 'object'`. The official SDK's AJV provider validates them without a
  lossy schema conversion. With no `$schema`, the default dialect is 2020-12;
  declared draft-07, draft-06 and 2019-09 are also supported by that provider.
- `handler(args, ctx)` receives validated arguments and
  `{ root, cwd, env, serverName, signal }`. `cwd` is the project root; `env` is
  the child process environment supplied by the native transport.
- Strings become MCP text content; other JSON-serializable values become JSON
  text (an undefined return becomes empty text). MCP results with `content`,
  `structuredContent` or `isError` are passed through, with fallback text content
  when omitted. An `outputSchema` requires a successful MCP result containing
  matching `structuredContent`. Exceptions and schema failures become SDK tool
  errors, which the native DSH bridge reports as failed calls.
- `timeoutMs` sets the native client's call deadline and the handler's abort
  signal. Client cancellation also reaches that signal. Cancellation is
  **cooperative**: pass `ctx.signal` to `fetch`, abortable timers and other IO.
  Ignoring it can leave work running after the client times out; there is no
  hard interruption, worker isolation, or rollback of side effects.
- Modules are imported once at startup, in filename order, with no hot reload.
  An empty directory exports no tools. Import errors, broken/escaping symlinks,
  invalid definitions and duplicate names fail startup with a file-specific
  stderr diagnostic rather than silently dropping tools.
- The official SDK owns version negotiation, stdio, discovery, calls and protocol
  errors. The wrapper owns only module loading, schema/result adaptation and
  project context. Its dependencies are local to this checkout and locked in
  `package-lock.json`, not borrowed from the DSH client's private packages.

**No sandbox:** importing a module executes trusted project code with full Node
access, including transitive imports. The path guard is not containment. Console
logging is redirected to stderr; modules must not write directly to stdout, which
is reserved for MCP. Review modules before enabling an untrusted project.

## Composition and lifecycle

The wrapper installs an awaited serial `agent/created` listener and uses:

```js
import * as McpClient from '@deepseek-ai/dsh-mcp-client';

ctx.on('agent/created', async ({ agent }) => {
  await agent.ctx.plugin(McpClient, {
    transport: 'stdio', serverName: 'project',
    command: '/path/to/server', cwd: canonicalProjectRoot,
    failOnStartupError: true,
  });
  return undefined;
});
```

The actual code resolves packages from the running DSH host, then a portable
`homedir()/.dsh/profiles/package.json` fallback, and verifies MCP resolves the same
Cordis/scope package identities. Scope tags use a module-local Symbol: mixing a
second CLI installation can otherwise turn scoped contributions global.

`ctx.plugin` applies native `Config` normalization and `inject:['tools']`, and
awaiting its Fiber waits for initial connection/tool discovery. Do not call bare
`McpClient.apply`, construct an SDK client, use global `ctx.plugin` for these
servers, or mutate `process.chdir()` to retarget a shared server.

Agent teardown drains its driver and unwinds its native scope. The wrapper also
owns explicit child-Fiber disposal capabilities, so unloading it closes servers
still attached to live Agents. Startup/unload races are tracked; no native child
is launched after wrapper shutdown begins. Native transport/probe closure is
awaited, including an already-claimed Fiber's asynchronous `inertia`.

Serial creation dispatch covers new Agents, resume, clear and compaction, before
queued work is released. It is not the synchronous `session/created` event.
Fork/spawn children get fresh scopes and are independently provisioned from their
own persisted cwd; conversation seeds do not copy live connections. This wrapper
does not attach retroactively to already-live Agents or watch config changes.
After first activation, wrapper reload or config edits, create/resume the session
(or restart DSH) to provision connections again.

When controlling the factory directly, creation-time `setup` is even safer: it
composes the unpublished scope before either creation announcement:

```js
const handle = await ctx.agents.create({
  sessionId,
  meta: { cwd: canonicalProjectRoot },
  setup: async (agentCtx) => {
    await agentCtx.plugin(McpClient, config);
  },
});
// ctx.agents.resume({ resumeSessionId, setup }) has the same setup contract.
await handle.dispose();
```

Native `createScope(ctx, opaqueKey)` returns `{ctx,rawDispose,dispose}`. Its
`dispose()` awaits asynchronous quiescence. `Context.extend` only adds inherited
metadata, and `Context.isolate('service')` isolates a service implementation:
neither alone replaces the native DSH registration scope. No public
`Context.fork` API is required.

## Security limits

Native MCP stdio spawns use the MCP SDK, not DSH's sandbox subprocess execution
path. The native client merges explicit env over scrubbed parent env, but cwd
is not containment and server commands can access the user's other files/network.
HTTP endpoints have no project filesystem boundary. MCP roots are not configured
by this wrapper/native client. Server instructions remain untrusted external text.

Legacy Codex `approval:'prompt'` / `approval:'writes'` are not native MCP config.
Native DSH offers scoped `tools/pre-execute` decisions `{kind:'ask'}` (requires
an approval service returning `allowed-once`, otherwise denies) and monotonic
`agent.ctx.tools.guard()` denial. Preserving a write-only approval policy needs
an audited tool classifier and native approval composition; this wrapper does
**not** implement it. Those field names are rejected outright so their absence
stays explicit instead of degrading into a silent policy relaxation — an owner
who wants the gate back must restore it, not merely delete a stale field. Scoped
registrations also are not automatically excluded by filters intended only for
inherited/global tools.

## `/mcp` cannot see these servers

The TUI's `/mcp` report (`dsh-adapter/channel/reports.js`) enumerates
`ctx.get('tools').schemas()` with **no scope**, and `schemas(scope?)` without an
argument reads the root registry (`dsh-tools/lib/types/index.d.ts:711`). Servers
mounted here live in the Agent's scope, because that is what makes them load only
for a session opened in the project. So `/mcp` reports "No MCP servers configured"
even while the servers are connected and answering `ListToolsRequest`.

This is a reporting limitation, not a failed mount. Confirm the mount by calling
an `mcp__<serverName>__<tool>` tool, or by the server's own stderr. Registering at
root instead would make `/mcp` list them, but would hand every server to every
session regardless of project — the opposite of the intent.

## Offline verification

From this repository (no real archive, ADB, or remote endpoint is launched):

```fish
npm ci
npm run test:project-mcp
```

Tests use the installed native Cordis, scope, prompt and tool registries, the
tiny local `stub.mjs`, and the official-SDK builtin with temporary local modules.
They verify separate Agent scopes, real handler calls, validated arguments and
outputs, preserved results, cooperative timeout and explicit client cancellation
of an already-running handler, canonical project context, startup diagnostics,
escape guards, teardown, rollback and unload races. The cancellation regression
also checks that no delayed completion occurs and the connection stays usable.
The original stdio/HTTP config and lifecycle regressions remain covered. No real
archive, ADB or remote server is connected. Existing fixtures use the operating
system temporary directory; the explicit-cancellation fixture stays under the
checkout's gitignored `.dumps/`.

## Live validation

The offline tests fabricate the `agent/created` dispatch, so they do not cover the
real `AgentRegistry` handoff. That path was confirmed in a running TUI session
opened in a project with an enabled server: the native client mounted it and the
server logged `connected and ready`. A second project whose entries are all
`enabled: false` reports no MCP servers, which is the intended outcome —
discovery ran and deliberately contributed nothing.
