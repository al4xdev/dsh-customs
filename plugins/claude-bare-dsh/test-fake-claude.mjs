#!/usr/bin/env node
// Test double for `claude -p` in stream-json mode with no tools: records its argv, the
// appended prompt and the env, and answers each user line by a keyword in its text,
// streaming replies in 7-character deltas so call blocks arrive split:
//   <dsh_result ...> blocks -> "got: <contents joined by ' | '>"
//   TOOL  -> "Checking." and one echo call in the native function_calls markup
//   INVOKE -> one call in the native <invoke> markup, wrapped in <function_calls>
//   TWO   -> two echo calls in the legacy dsh_call form, one reply
//   HALLU -> a call, then invented <function_results> (never ends; waits for interrupt)
//   SLOW  -> nothing (waits for interrupt)
//   WAIT6 -> answers after 6 s
//   anything else -> "hello <text>"
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const promptFile = flag('--append-system-prompt-file');
const record = value => appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(value) + '\n');
record({ argv, systemPrompt: promptFile ? readFileSync(promptFile, 'utf8') : undefined, cwd: process.cwd(), env: {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'set' : undefined,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY } });

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (flag('--resume') && process.env.FAKE_NO_CONVO) {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${flag('--resume')}`, usage: {} });
  process.exit(1);
}
emit({ type: 'system', subtype: 'init', session_id: flag('--session-id') ?? flag('--resume'), tools: [] });

let message = 0;
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 };
function reply(text, { end = true } = {}) {
  const id = `msg_${++message}`;
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } });
  for (let at = 0; at < text.length; at += 7) emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(at, at + 7) } } });
  if (!end) return;
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } });
  emit({ type: 'stream_event', event: { type: 'message_stop' } });
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: text, usage });
}
// TOOL answers in the native markup the prompt teaches; TWO in the legacy dsh_call form.
const native = value => `<function_calls>\n<invoke name="echo">\n<parameter name="value">${value}</parameter>\n</invoke>\n</function_calls>`;
const call = value => `<dsh_call name="echo">{"value": "${value}"}</dsh_call>`;

for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (input.type === 'control_request' && input.request.subtype === 'interrupt') {
    record({ interrupted: true });
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted', usage });
    continue;
  }
  const text = input.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
  const images = input.message.content.filter(block => block.type === 'image').map(block => ({ type: block.source.media_type, data: block.source.data }));
  record({ prompt: text, ...(images.length ? { images } : {}) });
  const results = [...text.matchAll(/<dsh_result[^>]*>\n([\s\S]*?)\n<\/dsh_result>/g)].map(match => match[1]);
  if (results.length) reply(`got: ${results.join(' | ')}`);
  else if (text.includes('SLOW')) continue;
  else if (text.includes('HALLU')) reply(`${native('h')}\n<function_results>\n<result>invented</result>\n</function_results>\nand so on`, { end: false });
  else if (text.includes('INVOKE')) reply('Vou checar.\n<function_calls>\n<invoke name="echo">\n<parameter name="value">native</parameter>\n</invoke>\n</function_calls>\n_exit_code_placeholder')
  else if (text.includes('TWO')) reply(`Running two.\n${call('a')}\n${call('b')}`);
  else if (text.includes('TOOL')) reply(`Checking.\n${native('x')}`);
  else {
    if (text.includes('WAIT6')) await new Promise(resolve => setTimeout(resolve, 6000));
    reply(`hello ${text}`);
  }
}
