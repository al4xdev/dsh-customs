# Plan: add a `builtin` generic MCP server mode to `project-mcp`

## 1. Goal (anchored)
`goal-19ed6d45-6a04-4d08-8eec-0ff881480400` — Add a "builtin" (generic in-module MCP server) mode so projects expose **static** tools via `.agents/tools/*.mjs`, while keeping `command`/`url` intact, **without** a sandbox, and **without** touching DSH's native plugin tools.

## 2. Confirmed decisions this turn
- The `.mjs` tool contract is acceptable ("tá bom sim").
- Do **not** disable anything in DSH / do **not** touch the native plugin tool registry — our MCP is a separate plugin; we only **add**. The existing `mcp__<serverName>__<toolName>` prefix already keeps MCP tools in a distinct namespace from native tools, so we preserve that (directly addresses the "não confundir tools nativos com MCP" concern).
- **No sandbox / no worker isolation** for the generic server (you are careful with MCP yourself; sandboxing is deferred).

## 3. Key findings from investigation
- Native `@deepseek-ai/dsh-mcp-client` (0.2.0-rc.2) is **client-side only**: it connects to external servers and registers their tools as `mcp__<serverName>__<rawName>` on `ctx.tools`. It has **no** MCP *server* side (evidence: the project's own `stub.mjs` is a hand-written stdio JSON-RPC server used as a test fixture). → The generic server is therefore **hand-written as a minimal stdio JSON-RPC server** (no new SDK, no duplicated transport).
- The wrapper `index.mjs` only does project discovery + `agent/created` scoping + rollback; it calls `agent.ctx.plugin(mcp, config)` with each native config and **spawns nothing itself**.
- `loadProject` → `serverConfigs` (config.mjs) produce the native configs. So all new behavior lives in `config.mjs` + a new `server/generic.mjs`. **No changes to `index.mjs` or `host.mjs`.**

## 4. Design
- A project entry with `"builtin": true` is served by the module's generic server:
  `.agents/mcp.json` → `{ "builtin": true, "toolsDir": ".agents/tools", "toolCallTimeoutMs": 60000 }`
- `config.mjs` detects `builtin: true`, resolves `toolsDir` under the canonical root (rejecting escapes), and **synthesizes a native stdio config** that spawns `<module>/server/generic.mjs` with `--project-root`, `--tools-dir`, `--server-name`, `cwd=root`, `env` passthrough, and `reconnect: { enabled: false }`. That config flows through `agent.ctx.plugin(mcp, config)` exactly like a normal stdio server → its tools land under the existing `mcp__<serverName>__<toolName>` namespace, isolated per agent scope, with the existing rollback/reconnect/failOnStartupError behavior.
- The generic server scans `toolsDir/*.mjs`, `import()`s each (static, git-auditable), collects the exported `tools[]`, and serves a minimal stdio JSON-RPC MCP (`initialize`, `tools/list`, `tools/call`, `ping`). It trusts the project (same trust level as `command`) but is more auditable (static `.mjs`). No sandbox.

### Tool contract (`.agents/tools/*.mjs`)
Each file exports an array; each item: `{ name (string, ^[A-Za-z0-9_-]+$), description (string), inputSchema (object, `type:'object'`), handler: async (args, ctx) => ... }`.
`ctx = { root (canonical project root), cwd, env, serverName }`.
Handler return → MCP result: a string becomes text content; an object with `isError:true` or `content:` is passed through; anything else is JSON-stringified to text.

## 5. File-by-file changes
### NEW `plugins/project-mcp/server/generic.mjs`
- Standalone stdio MCP server. Parses `--project-root` / `--tools-dir` / `--server-name`.
- Reuses the same inside-root escape guard (shared helper) — `toolsDir` must be the root or inside it; otherwise exit 1.
- Imports each `.mjs`, validates + collects tools, dedupes names.
- Serves JSON-RPC (newline-delimited) over stdin/stdout: `initialize` (echoes protocolVersion, `capabilities: { tools: {} }`, `serverInfo`), `tools/list`, `tools/call` (per-call timeout from env, result→content mapping above, `isError`), `ping`; ignores notifications; JSON-RPC errors for unknown method / unknown tool / bad args.
- Shutdown on SIGTERM/SIGINT/stdin close.

### EDIT `plugins/project-mcp/config.mjs`
- Add `import { fileURLToPath } from 'node:url'`; compute `BUILTIN_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server', 'generic.mjs')`.
- Add an async `isInsideDirectory(base, target)` helper (realpath both; `t === b || t.startsWith(b + '/')`); reuse it in `readProjectConfig` (replacing the `relative()` check) and for `toolsDir`.
- Add the `builtin` field family (`builtin`, `toolsDir`, `serverName`, `enabled`, `toolCallTimeoutMs`, `failOnStartupError`, `maxInstructionBytes`, `reconnect`, `env`); detect `raw.builtin === true` **before** transport selection; reject any other field.
- Synthesize the native stdio config for `builtin` (command/args to the generic server, `cwd=root`, `reconnect {enabled:false}`, `failOnStartupError` default true) and run it through the existing `nativeConfig['~standard'].validate` + push.
- Leave the `stdio`/`streamable-http` logic byte-identical.

### EDIT `plugins/project-mcp/project-mcp.test.mjs`
- Preserve all 7 existing tests (stdio/stdio-http/native-scope/rollback/unload) — unchanged.
- Add: (a) builtin entry accepted with `toolsDir` + synthesized config shape asserted; (b) builtin rejects unknown fields (e.g. `command`), rejects `toolsDir` escaping the root, rejects a missing `toolsDir` dir; (c) direct generic-server tests (spawn it; assert `initialize`/`tools/list`/`tools/call`/`ping`, empty dir → 0 tools, escaping symlink → exit 1); (d) end-to-end via the real native client: `.agents/mcp.json` builtin entry + `.agents/tools/where.mjs`, two agents, assert `mcp__local__where` executes per-scope (modeled on the existing "real native transport" test).

### EDIT `plugins/project-mcp/README.md`
- Document the `builtin` mode, the `.agents/tools/*.mjs` contract, the config shape, and an explicit **no-sandbox** + "trusted project code, review before opening untrusted repos" note (mirroring the existing security note). Note the `mcp__` prefix keeps MCP tools distinct from native tools and that we do not modify the native tool registry.

## 6. Security & non-goals
- **No sandbox, no worker isolation** for the generic server (per you). A `.mjs` import executes project code — same trust as the existing `command` transport — but is static and git-auditable. Documented.
- **Do not** modify DSH's native plugin tools, the native tool registry, or disable anything. The plugin is purely additive; the `mcp__<serverName>__<toolName>` prefix (existing) keeps MCP tools in a distinct namespace from native tools.
- Escape guard preserved for both the config file and `toolsDir`.
- **Out of scope:** a standalone "dsh-mcp" product and any DSH-level MCP toggle (resolved as unnecessary — just add the plugin).

## 7. Acceptance criteria
- A project with `.agents/mcp.json { mcpServers: { local: { builtin: true, toolsDir: ".agents/tools" } } }` + `.agents/tools/*.mjs` gets its tools mounted per agent as `mcp__local__*`, executing handlers with `ctx`, isolated across agents, and torn down on agent/wrapper dispose — same lifecycle as existing stdio servers.
- Unknown fields / escaping `toolsDir` are rejected before any process is spawned.
- `command`/`url` entries behave exactly as before (all 7 existing tests still pass).
- No changes to `index.mjs`, `host.mjs`, or the native tool registry.

## 8. After approval — execution guided by the goal
1. Create `server/generic.mjs` (contract above); run the direct server tests.
2. Extend `config.mjs` (helper + `builtin` family + synthesis); run config-validation tests.
3. Add the integration test via the real native client; run the full suite until green.
4. Update README; verify the suite is green and the 7 existing tests unchanged.
5. Report the result and mark the goal complete **only after** the suite is green and the acceptance criteria are met.