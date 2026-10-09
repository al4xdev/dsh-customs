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
There is no custom MCP transport or duplicated MCP SDK.

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
node --test plugins/project-mcp/project-mcp.test.mjs
```

Tests use the installed native Cordis, scope, prompt and tool registries, and
only the tiny local `stub.mjs` server. They verify two unrelated scopes with the
same server/tool names return their own canonical cwd; global/absent-project views
see neither; Agent and wrapper teardown close every native transport/probe child;
startup failure rolls back earlier connections; unload during config IO cannot
launch a child; native schemas, policy rejection and project discovery hold.
Test fixtures are created in the operating system temporary directory.

## Live validation

The offline tests fabricate the `agent/created` dispatch, so they do not cover the
real `AgentRegistry` handoff. That path was confirmed in a running TUI session
opened in a project with an enabled server: the native client mounted it and the
server logged `connected and ready`. A second project whose entries are all
`enabled: false` reports no MCP servers, which is the intended outcome —
discovery ran and deliberately contributed nothing.
