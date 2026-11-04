// dsh's tools as an in-process ("sdk") MCP server of the Claude Code CLI, the transport the
// Agent SDK uses: the CLI asks over stream-json control requests (`mcp_message`) and the
// provider answers them. Claude calls the tools natively (`tool_use`), so there is no text
// protocol to parse and no reply to cut.
//
// Verified against CLI 2.1.318: an sdk server is not subject to the organization's
// `allowedMcpServers`, each `tools/call` carries the call's `tool_use` id in
// `_meta["claudecode/toolUseId"]` (so no hook is needed to pair them), and calls run one
// at a time in the order the reply made them.
import { createHash } from 'node:crypto';

export const SERVER = 'dsh';
export const PREFIX = `mcp__${SERVER}__`;
// Claude Code cuts each MCP tool description at this many characters.
const DESCRIPTION_LIMIT = 2048;

// Claude Code otherwise defers MCP tools behind tool search and caps their results well
// below what dsh's own tools return.
export const MCP_ENV = { ENABLE_TOOL_SEARCH: 'false', MAX_MCP_OUTPUT_TOKENS: '200000' };

/** A tool's name after the prefix: API tool names are capped at 64 characters. */
export function shortName(name) {
  const limit = 64 - PREFIX.length;
  if (name.length <= limit && /^[a-zA-Z0-9_-]+$/.test(name)) return name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 10);
  return `${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, limit - 11)}_${hash}`;
}

/** dsh's name for a tool Claude called, or undefined for one dsh did not offer. */
export function dshName(called, tools) {
  return tools.find(tool => PREFIX + shortName(tool.name) === called)?.name;
}

/** The `tools/list` answer. */
export function definitions(tools) {
  return tools.map(tool => ({
    name: shortName(tool.name),
    description: (tool.description ?? '').slice(0, DESCRIPTION_LIMIT),
    inputSchema: tool.parameters ?? { type: 'object' },
    annotations: { readOnlyHint: false },
    _meta: { 'anthropic/alwaysLoad': true, 'anthropic/maxResultSizeChars': 500_000 },
  }));
}

// A conversation replayed into a fresh process is text: past calls and results are
// rendered plainly, never in a markup the model could take for a way to call tools.
export const callText = call => `[tool call: ${call.name}] ${call.arguments || '{}'}`;
export const resultText = (name, text, isError) => `[tool result: ${name}${isError ? ', error' : ''}]\n${text}`;
