#!/usr/bin/env node
// Test double for `claude -p` in stream-json mode with dsh's tools behind an in-process
// MCP server: records its argv, the appended prompt, the env, the MCP tool list, each user
// line and each tool result, and answers each user line by a keyword in its text,
// streaming text and tool input in 7-character deltas:
//   TOOL  -> "Checking." and one echo call; once answered, "got: <result>"
//   TWO   -> two echo calls in one message; once answered, "got: <a> | <b>"
//   [tool result: ...] blocks (a resumed process) -> "got: <their first lines joined by ' | '>"
//   SLOW  -> nothing (waits for interrupt)
//   WAIT6 -> answers after 6 s
//   anything else -> "hello <text>"
// A line sent with `priority: "next"` while a tool turn waits joins that turn's answer.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const promptFile = flag('--append-system-prompt-file');
const record = value => appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(value) + '\n');
record({ argv, systemPrompt: promptFile ? readFileSync(promptFile, 'utf8') : undefined, cwd: process.cwd(), env: {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'set' : undefined,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
  DISABLE_AUTO_COMPACT: process.env.DISABLE_AUTO_COMPACT, ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH,
  MAX_MCP_OUTPUT_TOKENS: process.env.MAX_MCP_OUTPUT_TOKENS, MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT } });

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (flag('--resume') && process.env.FAKE_NO_CONVO) {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${flag('--resume')}`, usage: {} });
  process.exit(1);
}
emit({ type: 'system', subtype: 'init', session_id: flag('--session-id') ?? flag('--resume'), tools: [] });

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 };
let seq = 0;

// Control requests to the provider, answered by control_response.
const answers = new Map();
function request(body) {
  const id = `cli-${++seq}`;
  emit({ type: 'control_request', request_id: id, request: body });
  return new Promise(resolve => answers.set(id, resolve));
}
const mcp = message => request({ subtype: 'mcp_message', server_name: 'dsh', message });

let ready = Promise.resolve();
async function handshake() {
  await mcp({ jsonrpc: '2.0', id: ++seq, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } } });
  await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await mcp({ jsonrpc: '2.0', id: ++seq, method: 'tools/list' });
  record({ tools: listed.response.mcp_response.result.tools });
}

/** One API message: thinking, then text, then tool_use blocks. */
function message(text, calls = []) {
  const id = `msg_${++seq}`;
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  let index = 1;
  if (text) {
    emit({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text' } } });
    for (let at = 0; at < text.length; at += 7) emit({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(at, at + 7) } } });
    emit({ type: 'stream_event', event: { type: 'content_block_stop', index: index++ } });
  }
  for (const call of calls) {
    emit({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: 'mcp__dsh__echo', input: {} } } });
    const json = JSON.stringify({ value: call.value });
    for (let at = 0; at < json.length; at += 7) emit({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(at, at + 7) } } });
    emit({ type: 'stream_event', event: { type: 'content_block_stop', index: index++ } });
  }
  emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } } });
  emit({ type: 'stream_event', event: { type: 'message_stop' } });
  emit({ type: 'assistant', message: { id, content: [...(text ? [{ type: 'text', text }] : []), ...calls.map(call => ({ type: 'tool_use', id: call.id, name: 'mcp__dsh__echo', input: { value: call.value } }))] } });
}
function reply(text) {
  message(text);
  emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: text, usage });
}
const interrupted = () => emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted', usage });

// User lines are answered one turn at a time; a `next` line waits inside a tool turn.
const lines = [];
let wake;
const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : new Promise(resolve => { wake = resolve; }));
let abort;

async function toolTurn(lead, values) {
  const calls = values.map(value => ({ id: `toolu_${++seq}`, value }));
  message(lead, calls);
  const outputs = [];
  for (const call of calls) {
    const answer = await Promise.race([
      mcp({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: 'echo', arguments: { value: call.value }, _meta: { 'claudecode/toolUseId': call.id, progressToken: seq } } }),
      abort.promise.then(() => undefined),
    ]);
    if (!answer) { interrupted(); return; }
    const result = answer.response.mcp_response.result;
    record({ toolResult: { id: call.id, ...result } });
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: result.content }] }, parent_tool_use_id: null });
    outputs.push(result.content.filter(block => block.type === 'text').map(block => block.text).join(''));
  }
  const joined = lines.filter(line => line.priority === 'next');
  for (const line of joined) { lines.splice(lines.indexOf(line), 1); record(seen(line)); }
  reply(`got: ${outputs.join(' | ')}${joined.map(line => ` + ${textOf(line)}`).join('')}`);
}

const textOf = input => input.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
function seen(input) {
  const images = input.message.content.filter(block => block.type === 'image').map(block => ({ type: block.source.media_type, data: block.source.data }));
  return { prompt: textOf(input), ...(images.length ? { images } : {}), ...(input.priority ? { priority: input.priority } : {}) };
}

async function answer(input) {
  // Like the CLI, MCP servers are connected before the first model call.
  await ready;
  record(seen(input));
  const text = textOf(input);
  abort = Promise.withResolvers();
  const results = [...text.matchAll(/\[tool result: [^\]]*\]\n([^\n]*)/g)].map(match => match[1]);
  if (results.length) reply(`got: ${results.join(' | ')}`);
  else if (text.includes('SLOW')) { await abort.promise; interrupted(); }
  else if (text.includes('TWO')) await toolTurn('Running two.\n', ['a', 'b']);
  else if (text.includes('TOOL')) await toolTurn('Checking.\n', ['x']);
  else {
    if (text.includes('WAIT6')) await new Promise(resolve => setTimeout(resolve, 6000));
    reply(`hello ${text}`);
  }
}
(async () => { for (;;) await answer(await nextLine()); })();

for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (input.type === 'control_response') { answers.get(input.response.request_id)?.(input.response); answers.delete(input.response.request_id); continue; }
  if (input.type === 'control_request' && input.request.subtype === 'initialize') {
    record({ initialize: input.request });
    emit({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id, response: {} } });
    if (input.request.sdkMcpServers?.includes('dsh')) ready = handshake();
    continue;
  }
  if (input.type === 'control_request' && input.request.subtype === 'interrupt') {
    record({ interrupted: true });
    abort?.resolve();
    continue;
  }
  if (input.type !== 'user') continue;
  if (wake) { const resolve = wake; wake = undefined; resolve(input); } else lines.push(input);
}
