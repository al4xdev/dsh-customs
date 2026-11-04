# claude-bare-dsh

dsh provider backed by the official Claude Code CLI, used as a bare model: dsh keeps
the agent loop, the tools, the prompt and the approvals; Claude Code only answers.

## Why it exists

Integrations of Claude into another harness usually go one of two ways:

1. **Claude Code as the agent.** The harness wraps the whole CLI, with its own tools,
   loop, prompt, CLAUDE.md, skills and hooks, and mostly displays what it does. The
   harness's tools reach it as extras, typically over MCP.
2. **The API directly.** The harness calls Anthropic's API itself, with an API key or by
   reusing the token Claude Code stores.

This plugin does neither. It treats the official `claude` binary as nothing but a model
behind a dsh provider route:

- **dsh stays the agent.** Every tool call is a real dsh `tool-call`, run by dsh's own
  loop with its approvals, cards, subagents, goals and session log. Claude Code runs no
  tool of its own and loads nothing of the user's Claude setup.
- **Only the official binary talks to Anthropic.** The plugin makes no request, reads no
  stored login and opens no socket or port; the CLI logs in with a token from
  `claude setup-token`, so the interactive login is never shared.
- **Native tool calls.** dsh's tools are an in-process MCP server of the CLI (the Agent
  SDK's `sdk` server type, spoken over the same stdin/stdout), so Claude calls them with
  native `tool_use` and nothing is parsed from text.
- **Same prompt surface as any other dsh model.** dsh's system prompt, AGENTS files and
  skill catalog reach Claude the way they reach every other provider, so one harness
  setup serves all models, and switching a session between providers keeps it coherent.

Use it when you want Claude as one more model inside dsh. If you want Claude Code's own
agent, tools and ecosystem, run Claude Code (or a plugin that wraps it) instead.

## Trade-offs

- Claude Code's own system prompt stays (about 2.5k tokens, cached from the first
  request on): with a subscription login it can only be appended to
  (`--bare`/`--system-prompt` need an API key).
- Claude sees the tools as `mcp__dsh__<name>`; names past the API's 64 characters are
  shortened with a hash. Claude Code cuts each tool description at 2048 characters (no
  dsh tool is that long today).
- The CLI runs one reply's calls one at a time, in order. dsh still runs them in
  parallel: the step hands all of them to dsh, and each parked call is answered as soon
  as the CLI asks for it.
- An `sdk` MCP server is not subject to an organization's `allowedMcpServers` (verified
  with CLI 2.1.318). A later CLI or a stricter policy could change that; the text-protocol
  version is tagged `claude-bare-dsh-text-protocol` in git.
- One `claude` process per active session; state lives in the CLI's own transcript and
  is resumed with `--resume`.

## How it works

- One `claude -p` process per dsh session (stream-json in and out), resumed with
  `--resume` after a dsh restart or an idle stop.
- Tools (`mcp.mjs`, `session.mjs`): the process registers the `dsh` server in its
  `initialize` control request and answers the CLI's `mcp_message` requests
  (`initialize`, `tools/list`, `tools/call`). Each `tools/call` carries the call's
  `tool_use` id in `_meta["claudecode/toolUseId"]`. When the reply that made calls ends,
  the dsh step finishes with `tool-calls`, while the CLI turn stays open with those calls
  parked. The next step answers them with dsh's results (text as is, images attached), and
  the same turn goes on; a message sent meanwhile joins it (`priority: "next"`). Only a
  real abort interrupts a turn.
- The tool calls are allowed without prompts (`--permission-mode dontAsk`,
  `--allowedTools mcp__dsh__*`); tool search is off so every tool is loaded, the MCP
  output cap is raised to 200k tokens, and an inherited `MCP_TOOL_TIMEOUT` is dropped so
  long dsh tools (subagents, builds) are not cut off.
- Compaction is dsh's. The models declare a 250k window, so dsh compacts at ~200k (80%)
  with headroom for the reply; Claude Code's own auto-compaction is off. The provider
  remembers which history each Claude conversation was built from: when dsh rewrites it
  (a compaction checkpoint, an edit), the next step opens a new Claude conversation with
  the current history (past calls and results rendered as plain text) instead of resuming
  the old, larger one, which would keep the reported usage high and make dsh compact
  again in a loop. dsh's summarization call is asked of the live conversation when it
  matches and no turn is parked on tools, scoped to the condensed span, so the whole
  prefix is a cache read; that conversation is then retired. The fixed prefix (Claude
  Code's prompt, dsh's prompt, the tools) is byte-identical across conversations, so a
  new one still reads it from the cache.
- Only the agent loop's steps join that conversation. Side requests that carry the
  session id but no tools (the TUI's session recap, btw questions), titles and
  compaction are answered by a one-shot process with no session of its own; a call made
  during a text-only request is refused.
- Nothing else of Claude Code's own: `--tools ""`, no MCP server from any config
  (`--strict-mcp-config`), no skills or slash commands, only the `user` setting source,
  the built-in AGENTS.md and plugin-authoring plugins off, no auto-memory. The CLI runs in
  an empty config dir of its own (no user CLAUDE.md, settings, hooks, agents or plugins)
  and an empty working dir (no project CLAUDE.md).
- dsh's system prompt is appended to Claude Code's, by file. A changed prompt, tool set,
  model or effort respawns the process on the same Claude session.
- The plugin makes no network request itself and opens no socket or port.

## Login

A long-lived token from `claude setup-token`, stored as the dsh credential
`CLAUDE_CODE_OAUTH_TOKEN` (`$DSH_HOME/.credentials.yaml`, mode 0600, or the environment).
The interactive `~/.claude` login is never read or shared, so the two never rotate each
other's refresh token.

## Config

| key | default | |
|---|---|---|
| `provider` | `claude-bare-dsh` | provider route id |
| `displayName` | `Claude (bare)` | |
| `command` | `claude` | CLI executable |
| `tokenRef` | `CLAUDE_CODE_OAUTH_TOKEN` | dsh credential with the token |
| `models` | Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 | `{ id, name, contextWindow }` (default 250000), fixed list |
| `idleMinutes` | `30` | stop an idle session process; the next step resumes it |
| `maxProcesses` | `6` | idle processes are evicted beyond this |

State: `$XDG_STATE_HOME/claude-bare-dsh` (config dir, empty working dir, started-session
ids, and `lineage.json`: the history each dsh session's Claude conversation was built from).

Images: the images of a step's new messages (your attachments, `read_image` results) are
read through dsh's attachment store and downscaled to Claude's useful bounds (long edge
1568 px, ~1.15 MP, at most 3.5 MB): a user line gets them attached with a marker in the
text where each one was, a tool result carries them in its MCP content. Images from older
history stay text placeholders, so a replayed conversation never re-sends every image it
held.

## Test

`node --test plugins/claude-bare-dsh/claude-bare-dsh.test.mjs` runs against `test-fake-claude.mjs`,
a stand-in that speaks the CLI's stream-json and its side of the MCP control protocol; no
model calls.
