# claude-bare-dsh

dsh provider backed by the official Claude Code CLI, used as a bare model: dsh keeps
the agent loop, the tools, the prompt and the approvals; Claude Code only answers.

- One `claude -p` process per dsh session (stream-json in and out), resumed with
  `--resume` after a dsh restart or an idle stop.
- Claude Code has no tools at all: `--tools ""` and no MCP servers. An organization's MCP
  allowlist keeps a local MCP server's tools out of the request, so dsh's tools travel as
  text (`protocol.mjs`): they are described in the appended prompt, Claude writes
  `<dsh_call name="tool">{json}</dsh_call>` blocks and ends its reply, each block becomes
  a real dsh `tool-call`, dsh runs it in its own loop, and the results return as the next
  user message in `<dsh_result>` blocks. A reply that starts inventing results is cut.
- Nothing else of Claude Code's own: no skills or slash commands, only the `user` setting
  source, the built-in AGENTS.md and plugin-authoring plugins off, no auto-memory. The
  CLI runs in an empty config dir of its own (no user CLAUDE.md, settings, hooks, agents
  or plugins) and an empty working dir (no project CLAUDE.md).
- dsh's system prompt and the tool list are appended to Claude Code's prompt, by file.
  With a subscription login Claude Code's own prompt cannot be replaced
  (`--bare`/`--system-prompt` need an API key). A changed prompt or tool set respawns the
  process on the same Claude session.
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
| `models` | Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 | `{ id, name, contextWindow }`, fixed list |
| `idleMinutes` | `30` | stop an idle session process; the next step resumes it |
| `maxProcesses` | `6` | idle processes are evicted beyond this |

State: `$XDG_STATE_HOME/claude-bare-dsh` (config dir, empty working dir, started-session
ids). Images in user messages are sent as a text placeholder.

## Test

`node --test plugins/claude-bare-dsh/claude-bare-dsh.test.mjs` runs against `test-fake-claude.mjs`,
a stand-in that speaks the CLI's stream-json and the text tool protocol; no model calls.
