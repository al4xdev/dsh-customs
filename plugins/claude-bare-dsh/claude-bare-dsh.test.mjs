import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const fake = join(here, 'test-fake-claude.mjs');
chmodSync(fake, 0o755);
const root = mkdtempSync(join(tmpdir(), 'claude-bare-dsh-test-'));
process.env.XDG_STATE_HOME = join(root, 'state');
process.env.FAKE_CLAUDE_LOG = join(root, 'fake.log');
process.env.ANTHROPIC_API_KEY = 'must-not-reach-the-cli';
const { ClaudeCliAdapter, Config, afterLastAssistant, claudeSessionId, imageTarget } = await import('./index.mjs');
const { resultReason } = await import('./session.mjs');
const { CallParser, toolsPrompt } = await import('./protocol.mjs');
test.after(() => rmSync(root, { recursive: true, force: true }));

const targets = [];
const attachments = { readImageRequest: async (ref, target) => { targets.push({ id: ref.attachmentId, ...target }); return { data: new TextEncoder().encode(`png:${ref.attachmentId}`), mediaType: 'image/png' }; } };
const ctx = (token = 'test-token') => ({ credentials: { resolve: async () => (token ? { value: token, source: 'test' } : undefined) },
  get: name => (name === 'attachments' ? attachments : undefined) });
const adapterFor = (token) => new ClaudeCliAdapter(ctx(token), Config({ command: fake }));
const log = () => readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
let counter = 0;
const id = () => `m${++counter}`;
const system = { id: id(), role: 'system', content: [{ type: 'text', text: 'DSH SYSTEM PROMPT' }], source: { kind: 'system-prompt' } };
const user = text => ({ id: id(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
const echoTool = { name: 'echo', description: 'Echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } } } };

async function collect(adapter, options) {
  const chunks = [];
  for await (const chunk of adapter.stream({ provider: 'claude-bare-dsh', model: 'claude-sonnet-5-5', tools: [echoTool], ...options })) chunks.push(chunk);
  return chunks;
}
const textOf = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
const finishOf = chunks => chunks.at(-1);
const spawns = () => log().filter(entry => entry.argv).length;
const prompts = () => log().filter(entry => entry.prompt !== undefined).map(entry => entry.prompt);

test('a plain turn streams text and reasoning, then usage once and a stop finish', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const chunks = await collect(adapter, { sessionId: 's-plain', messages: [system, user('hi')] });
  assert.equal(textOf(chunks), 'hello hi');
  assert.ok(chunks.some(c => c.type === 'reasoning-delta' && c.text === 'pondering'));
  assert.deepEqual(finishOf(chunks), { type: 'finish', reason: { kind: 'stop' } });
  const usage = chunks.filter(c => c.type === 'usage');
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0].usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 18 });
  for (const chunk of chunks.filter(c => c.type === 'block-end')) assert.ok(chunks.some(c => c.type === 'block-start' && c.index === chunk.index));
});

test('the CLI runs stripped down: no built-in tools, own empty config dir, token login, dsh prompt appended', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  await collect(adapter, { sessionId: 's-flags', messages: [system, user('flags')] });
  const run = log().filter(entry => entry.argv).at(-1);
  const arg = name => run.argv[run.argv.indexOf(name) + 1];
  assert.equal(arg('--tools'), '');
  assert.ok(run.argv.includes('--strict-mcp-config'));
  assert.ok(run.argv.includes('--disable-slash-commands'));
  assert.equal(arg('--setting-sources'), 'user');
  assert.deepEqual(JSON.parse(arg('--settings')), { autoMemoryEnabled: false, autoCompactEnabled: false, enabledPlugins: { 'cc-plugin-agents-md@builtin': false, 'cc-plugin-plugin-authoring@builtin': false } });
  assert.equal(arg('--session-id'), claudeSessionId('s-flags'));
  assert.ok(!run.argv.includes('--append-system-prompt'), 'the prompt goes by file, not argv');
  assert.match(run.systemPrompt, /^DSH SYSTEM PROMPT\n\n# Tools\n.*built-in tools are disabled.*## echo\nEcho a value\nParameters \(JSON Schema\): \{"type":"object"/s);
  assert.ok(!run.argv.includes('--mcp-config') && !run.argv.includes('--allowedTools'), 'no MCP at all');
  assert.equal(run.env.CLAUDE_CONFIG_DIR, join(process.env.XDG_STATE_HOME, 'claude-bare-dsh/claude-home'));
  assert.equal(run.env.CLAUDE_CODE_OAUTH_TOKEN, 'set');
  assert.equal(run.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(run.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(run.env.DISABLE_AUTO_COMPACT, '1');
  assert.equal(run.cwd, join(process.env.XDG_STATE_HOME, 'claude-bare-dsh/work'));
});

test('a call block ends the step as a dsh tool call; its result goes back to the same process', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('please TOOL')];
  const step1 = await collect(adapter, { sessionId: 's-tool', messages: first });
  assert.deepEqual(finishOf(step1), { type: 'finish', reason: { kind: 'tool-calls' } });
  assert.equal(textOf(step1), 'Checking.\n', 'text before the block streams; the block itself does not');
  const call = step1.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block;
  assert.equal(call.name, 'echo');
  assert.deepEqual(JSON.parse(call.arguments), { value: 'x' });
  const assistant = { id: id(), role: 'assistant', content: [call], source: { kind: 'model', provider: 'claude-bare-dsh', model: 'claude-sonnet-5-5' } };
  const result = { id: id(), role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'RESULT-X' }], source: { kind: 'tool', callId: call.id } };
  const spawnsBefore = log().filter(entry => entry.argv).length;
  const step2 = await collect(adapter, { sessionId: 's-tool', messages: [...first, assistant, result] });
  assert.equal(prompts().at(-1), '<function_results>\n<dsh_result name="echo" index="1">\nRESULT-X\n</dsh_result>\n</function_results>');
  assert.equal(textOf(step2), 'got: RESULT-X');
  assert.deepEqual(finishOf(step2), { type: 'finish', reason: { kind: 'stop' } });
  assert.equal(log().filter(entry => entry.argv).length, spawnsBefore, 'no respawn between the two steps');
});

test('parallel calls in one Claude message become one dsh step', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('TWO please')];
  const step1 = await collect(adapter, { sessionId: 's-two', messages: first });
  const calls = step1.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').map(c => c.block);
  assert.equal(calls.length, 2);
  const assistant = { id: id(), role: 'assistant', content: calls, source: { kind: 'model', provider: 'claude-bare-dsh', model: 'm' } };
  const results = calls.map(call => ({ id: id(), role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: JSON.parse(call.arguments).value.toUpperCase() }], source: { kind: 'tool', callId: call.id } }));
  const step2 = await collect(adapter, { sessionId: 's-two', messages: [...first, assistant, ...results] });
  assert.equal(textOf(step2), 'got: A | B');
});

test('a restarted dsh resumes the Claude session and sends only the new turn', async t => {
  const one = adapterFor();
  const history = [system, user('first')];
  await collect(one, { sessionId: 's-resume', messages: history });
  one.dispose();
  const two = adapterFor();
  t.after(() => two.dispose());
  const assistant = { id: id(), role: 'assistant', content: [{ type: 'text', text: 'hello first' }], source: { kind: 'model', provider: 'claude-bare-dsh', model: 'm' } };
  const chunks = await collect(two, { sessionId: 's-resume', messages: [...history, assistant, user('second')] });
  assert.equal(textOf(chunks), 'hello second');
  const run = log().filter(entry => entry.argv).at(-1);
  assert.equal(run.argv[run.argv.indexOf('--resume') + 1], claudeSessionId('s-resume'));
  assert.equal(log().filter(entry => entry.prompt).at(-1).prompt, 'second');
});

test('a fresh process for an existing conversation gets the whole transcript once', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const assistant = { id: id(), role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], source: { kind: 'model', provider: 'other', model: 'm' } };
  await collect(adapter, { sessionId: 's-switched', messages: [system, user('earlier question'), assistant, user('now')] });
  assert.equal(log().filter(entry => entry.prompt).at(-1).prompt, '[user]\nearlier question\n\n[assistant]\nearlier answer\n\n[user]\nnow');
});

test('titles and compaction are one-shot calls without tools, session or transcript', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const chunks = await collect(adapter, { sessionId: 's-title', purpose: 'session-title', messages: [user('name this')] });
  assert.equal(textOf(chunks), 'hello name this');
  const run = log().filter(entry => entry.argv).at(-1);
  for (const flagName of ['--no-session-persistence', '--strict-mcp-config']) assert.ok(run.argv.includes(flagName));
  assert.equal(run.argv[run.argv.indexOf('--max-turns') + 1], '1');
  assert.ok(!run.argv.includes('--mcp-config') && !run.argv.includes('--session-id'));
});

test('abort interrupts the CLI and finishes aborted', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const chunks = await collect(adapter, { sessionId: 's-abort', messages: [system, user('SLOW')], signal: controller.signal });
  assert.equal(finishOf(chunks).reason.kind, 'aborted');
});

test('no token: a clear credential error and no process', async () => {
  const adapter = adapterFor(null);
  const before = log().filter(entry => entry.argv).length;
  const chunks = await collect(adapter, { sessionId: 's-none', messages: [user('hi')] });
  assert.equal(finishOf(chunks).reason.failure.code, 'MISSING_CREDENTIAL');
  assert.equal(log().filter(entry => entry.argv).length, before);
  adapter.dispose();
});

test('result mapping: login, usage limit, max tokens', () => {
  assert.equal(resultReason({ is_error: true, result: 'Failed to authenticate', api_error_status: 401 }).failure.code, 'MISSING_CREDENTIAL');
  const limited = resultReason({ is_error: true, result: 'limit' }, { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 60 });
  assert.equal(limited.failure.code, 'RATE_LIMIT');
  assert.ok(limited.failure.providerRetryAfterMs > 0);
  assert.deepEqual(resultReason({ stop_reason: 'max_tokens' }), { kind: 'max-tokens' });
  assert.deepEqual(afterLastAssistant([user('a'), { role: 'assistant', content: [] }, user('b')]).map(m => m.content[0].text), ['b']);
});


test('a stale resume is retried fresh without leaving a second usage chunk', async t => {
  const adapter = adapterFor();
  t.after(() => { delete process.env.FAKE_NO_CONVO; adapter.dispose(); });
  adapter.markStarted(claudeSessionId('s-stale'));
  process.env.FAKE_NO_CONVO = '1';
  const chunks = await collect(adapter, { sessionId: 's-stale', messages: [system, user('x')] });
  assert.equal(chunks.filter(c => c.type === 'usage').length, 1);
  assert.equal(textOf(chunks), 'hello x');
  assert.deepEqual(finishOf(chunks), { type: 'finish', reason: { kind: 'stop' } });
});

test('an aborted step does not kill the next step on the same process', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const history = [system, user('SLOW')];
  assert.equal(finishOf(await collect(adapter, { sessionId: 's-abort-reuse', messages: history, signal: controller.signal })).reason.kind, 'aborted');
  const before = spawns();
  const chunks = await collect(adapter, { sessionId: 's-abort-reuse', messages: [...history, user('WAIT6 later')] });
  assert.equal(textOf(chunks), 'hello WAIT6 later');
  assert.equal(spawns(), before, 'same process reused');
});

test('tool results survive a process that died while dsh ran the tool', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('TOOL then crash')];
  const step1 = await collect(adapter, { sessionId: 's-crash', messages: first });
  const call = step1.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block;
  adapter.sessions.get('s-crash').kill();
  await new Promise(resolve => setTimeout(resolve, 300));
  const assistant = { id: id(), role: 'assistant', content: [call], source: { kind: 'model', provider: 'claude-bare-dsh', model: 'm' } };
  const result = { id: id(), role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'RESULT-AFTER-CRASH' }], source: { kind: 'tool', callId: call.id } };
  const step2 = await collect(adapter, { sessionId: 's-crash', messages: [...first, assistant, result] });
  assert.equal(textOf(step2), 'got: RESULT-AFTER-CRASH');
  const run = log().filter(entry => entry.argv).at(-1);
  assert.ok(run.argv.includes('--resume'), 'respawned on the same Claude session');
});

test('an invented result after a call cuts the turn and never reaches dsh', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const chunks = await collect(adapter, { sessionId: 's-hallu', messages: [system, user('HALLU')] });
  assert.deepEqual(finishOf(chunks), { type: 'finish', reason: { kind: 'tool-calls' } });
  assert.equal(chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').length, 1);
  assert.ok(!textOf(chunks).includes('invented'));
  assert.ok(log().some(entry => entry.interrupted), 'the CLI turn was interrupted');
});

test('developer messages reach Claude', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const developer = { id: id(), role: 'developer', content: [{ type: 'text', text: 'MODE REMINDER' }], source: { kind: 'user' } };
  await collect(adapter, { sessionId: 's-dev', messages: [system, developer, user('go')] });
  assert.equal(prompts().at(-1), '[developer]\nMODE REMINDER\n\n[user]\ngo');
});

test('a changed tool set respawns the process with the new list', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const history = [system, user('one')];
  await collect(adapter, { sessionId: 's-tools', messages: history });
  const before = spawns();
  const other = { name: 'other', description: 'Other', parameters: { type: 'object' } };
  const assistant = { id: id(), role: 'assistant', content: [{ type: 'text', text: 'hello one' }], source: { kind: 'model', provider: 'claude-bare-dsh', model: 'm' } };
  await collect(adapter, { sessionId: 's-tools', messages: [...history, assistant, user('two')], tools: [other] });
  assert.equal(spawns(), before + 1);
  assert.match(log().filter(entry => entry.argv).at(-1).systemPrompt, /## other\n/);
  assert.equal(prompts().at(-1), 'two', 'resumed: only the new turn is sent');
});

test('parser: blocks split at any point, held prefixes, malformed headers', () => {
  const text = 'Look <b>here</b>.\n<dsh_call name="read">{"path": "a<b"}</dsh_call>\n<dsh_call name=\'list\'></dsh_call>';
  for (const size of [1, 3, 7, text.length]) {
    const parser = new CallParser();
    const pieces = [];
    for (let at = 0; at < text.length; at += size) pieces.push(...parser.feed(text.slice(at, at + size)));
    pieces.push(...parser.end());
    assert.equal(pieces.filter(p => p.text).map(p => p.text).join(''), 'Look <b>here</b>.\n', `chunk ${size}`);
    assert.deepEqual(pieces.filter(p => p.call).map(p => p.call), [{ name: 'read', arguments: '{"path": "a<b"}' }, { name: 'list', arguments: '{}' }]);
  }
  const held = new CallParser();
  assert.deepEqual(held.feed('ends with <dsh'), [{ text: 'ends with ' }]);
  assert.deepEqual(held.end(), [{ text: '<dsh' }], 'a held prefix is text at the end');
  const unfinished = new CallParser();
  unfinished.feed('x <dsh_call name="a">{"never": ');
  assert.deepEqual(unfinished.end(), [], 'an unfinished block never runs');
  const bad = new CallParser();
  const badOut = [...bad.feed('<dsh_call oops>{}</dsh_call>ok'), ...bad.end()];
  assert.equal(badOut.filter(p => p.text).map(p => p.text).join(''), '<dsh_call oops>{}</dsh_call>ok', 'a malformed header is shown, never run or dropped');
  assert.equal(bad.calls, 0);
  assert.equal(toolsPrompt([]), '');
});

const image = (attachmentId, width = 3000, height = 2000) => ({ type: 'image', attachment: { attachmentId, name: `${attachmentId}.png`, width, height } });
const b64 = text => Buffer.from(text).toString('base64');

test('a user image is attached, downscaled to Claude bounds and marked in the text', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const message = { id: id(), role: 'user', content: [{ type: 'text', text: 'what is this?' }, image('pic1')], source: { kind: 'user' } };
  await collect(adapter, { sessionId: 's-image', messages: [system, message] });
  const entry = log().filter(e => e.prompt !== undefined).at(-1);
  assert.equal(entry.prompt, 'what is this?\n[image 1 pic1.png: attached below]');
  assert.deepEqual(entry.images, [{ type: 'image/png', data: b64('png:pic1') }]);
  assert.deepEqual(targets.at(-1), { id: 'pic1', ...imageTarget({ width: 3000, height: 2000 }) });
  const target = targets.at(-1);
  assert.ok(Math.max(target.width, target.height) <= 1568 && target.width * target.height <= 1_150_000);
  assert.deepEqual(imageTarget({ width: 400, height: 300 }), { width: 400, height: 300, maxBytes: 3_500_000 }, 'never upscaled');
});

test('an image in a tool result (read_image) reaches Claude with that result', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('TOOL look')];
  const step1 = await collect(adapter, { sessionId: 's-read-image', messages: first });
  const call = step1.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block;
  const assistant = { id: id(), role: 'assistant', content: [call], source: { kind: 'model', provider: 'claude-bare-dsh', model: 'm' } };
  const result = { id: id(), role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'read ok' }, image('shot', 800, 600)], source: { kind: 'tool', callId: call.id } };
  await collect(adapter, { sessionId: 's-read-image', messages: [...first, assistant, result] });
  const entry = log().filter(e => e.prompt !== undefined).at(-1);
  assert.match(entry.prompt, /<dsh_result name="echo" index="1">\nread ok\n\[image 1 shot\.png: attached below\]\n<\/dsh_result>/);
  assert.deepEqual(entry.images, [{ type: 'image/png', data: b64('png:shot') }]);
});

test('older images stay placeholders when a fresh process replays the history', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const old = { id: id(), role: 'user', content: [{ type: 'text', text: 'earlier' }, image('old')], source: { kind: 'user' } };
  const assistant = { id: id(), role: 'assistant', content: [{ type: 'text', text: 'seen' }], source: { kind: 'model', provider: 'other', model: 'm' } };
  const now = { id: id(), role: 'user', content: [{ type: 'text', text: 'and this' }, image('new')], source: { kind: 'user' } };
  await collect(adapter, { sessionId: 's-replay', messages: [system, old, assistant, now] });
  const entry = log().filter(e => e.prompt !== undefined).at(-1);
  assert.match(entry.prompt, /earlier\n\[image old\.png: not attached here\]/);
  assert.match(entry.prompt, /and this\n\[image 1 new\.png: attached below\]/);
  assert.deepEqual(entry.images.map(i => i.data), [b64('png:new')]);
});

test('models declare image input', async () => {
  const adapter = adapterFor();
  assert.deepEqual((await adapter.listModels('claude-bare-dsh'))[0].inputModalities, ['text', 'image']);
  assert.deepEqual((await adapter.resolveModel('claude-bare-dsh', 'claude-opus-5-5')).inputModalities, ['text', 'image']);
  adapter.dispose();
});

test('a call in the native <invoke> markup runs like a dsh_call block', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('INVOKE please')];
  const step1 = await collect(adapter, { sessionId: 's-invoke', messages: first });
  assert.deepEqual(finishOf(step1), { type: 'finish', reason: { kind: 'tool-calls' } });
  assert.equal(textOf(step1), 'Vou checar.\n', 'the wrapper and the invented tail never reach dsh');
  const call = step1.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block;
  assert.equal(call.name, 'echo');
  assert.deepEqual(JSON.parse(call.arguments), { value: 'native' });
  const assistant = { id: id(), role: 'assistant', content: [call], source: { kind: 'model', provider: 'claude-bare-dsh', model: 'm' } };
  const result = { id: id(), role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'NATIVE-OK' }], source: { kind: 'tool', callId: call.id } };
  assert.equal(textOf(await collect(adapter, { sessionId: 's-invoke', messages: [...first, assistant, result] })), 'got: NATIVE-OK');
});

test('results keep their content byte for byte; only protocol tags are escaped', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('TOOL read')];
  const step1 = await collect(adapter, { sessionId: 's-escape', messages: first });
  const call = step1.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block;
  const assistant = { id: id(), role: 'assistant', content: [call], source: { kind: 'model', provider: 'claude-bare-dsh', model: 'm' } };
  const content = '<path>/x/a.html</path>\n<content>\nif (a < b && c > d) <b>bold</b>\nquoted </dsh_result> and <dsh_call name="x">\n</content>';
  const result = { id: id(), role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: content }], source: { kind: 'tool', callId: call.id } };
  await collect(adapter, { sessionId: 's-escape', messages: [...first, assistant, result] });
  const sent = prompts().at(-1);
  assert.ok(sent.includes('<path>/x/a.html</path>') && sent.includes('if (a < b && c > d) <b>bold</b>'), 'ordinary markup untouched');
  assert.ok(sent.includes('quoted &lt;/dsh_result> and &lt;dsh_call name="x">'), 'protocol tags escaped');
  assert.equal(sent.match(/<\/dsh_result>/g).length, 1, 'only the real closing tag remains');
});

test('parser: <invoke> calls, typed parameters, quoted markup stays text, invented results cut', async () => {
  const { invokeArguments } = await import('./protocol.mjs');
  const tools = [{ name: 'list', parameters: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'integer' }, hidden: { type: 'boolean' }, ids: { type: 'array' } } } }];
  const text = 'Ok.\n<function_calls>\n<invoke name="list">\n<parameter name="path">/var/log</parameter>\n<parameter name="depth">2</parameter>\n<parameter name="hidden">false</parameter>\n<parameter name="ids">[1, 2]</parameter>\n</invoke>\n</function_calls>';
  for (const size of [1, 4, 9, text.length]) {
    const parser = new CallParser(tools);
    const pieces = [];
    for (let at = 0; at < text.length; at += size) pieces.push(...parser.feed(text.slice(at, at + size)));
    pieces.push(...parser.end());
    assert.equal(pieces.filter(p => p.text).map(p => p.text).join(''), 'Ok.\n', `chunk ${size}`);
    assert.deepEqual(pieces.filter(p => p.call).map(p => [p.call.name, JSON.parse(p.call.arguments)]), [['list', { path: '/var/log', depth: 2, hidden: false, ids: [1, 2] }]]);
  }
  assert.deepEqual(JSON.parse(invokeArguments('<parameter name="n">7</parameter>', undefined)), { n: '7' }, 'unknown schema keeps text');
  const quoted = new CallParser(tools);
  const mention = 'the reply had `<invoke name="bash"...` as plain text, see <b>here</b>.';
  const out = [...quoted.feed(mention), ...quoted.end()];
  assert.equal(out.filter(p => p.text).map(p => p.text).join(''), mention);
  assert.equal(quoted.calls, 0);
  const guessing = new CallParser(tools);
  const guessed = [...guessing.feed('Let me look.\n<function_results>\nfake\n</function_results>'), ...guessing.end()];
  assert.deepEqual(guessed, [{ text: 'Let me look.\n' }, { cut: true }]);
});

test('parser: what training makes the model improvise is still a call', async () => {
  const { invokeArguments, callsText } = await import('./protocol.mjs');
  // The tag prefix is assembled at run time so this file never spells the prefixed markup.
  const P = ['ant', 'ml:'].join('');
  const tools = [{ name: 'list', parameters: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'integer' } } } }, { name: 'git_status', parameters: { type: 'object', properties: {} } }];
  const run = text => { const parser = new CallParser(tools); const out = []; for (let at = 0; at < text.length; at += 5) out.push(...parser.feed(text.slice(at, at + 5))); out.push(...parser.end()); return out; };
  const calls = out => out.filter(p => p.call).map(p => [p.call.name, JSON.parse(p.call.arguments)]);
  const prefixed = `<${P}function_calls>\n<${P}invoke name="list">\n<${P}parameter name="path">/tmp</${P}parameter>\n</${P}invoke>\n</${P}function_calls>`;
  const prefixedOut = run(prefixed);
  assert.deepEqual(calls(prefixedOut), [['list', { path: '/tmp' }]], 'prefixed tags');
  assert.equal(prefixedOut.filter(p => p.text).length, 0, 'prefixed wrapper never shown');
  assert.deepEqual(calls(run('<invoke name="list"><parameter name="depth">3</parameter></invoke>')), [['list', { depth: 3 }]], 'no wrapper');
  assert.deepEqual(calls(run('<invoke name="git_status"/>')), [['git_status', {}]], 'self-closing');
  assert.deepEqual(calls(run('<invoke name="list">{"path": "/etc", "depth": 1}</invoke>')), [['list', { path: '/etc', depth: 1 }]], 'JSON body');
  assert.deepEqual(calls(run('<dsh_call name="list"><parameter name="path">/x</parameter></dsh_call>')), [['list', { path: '/x' }]], 'parameters inside dsh_call');
  assert.deepEqual(calls(run('<invoke name="list">\n<parameter name="path">\n/var/log\n</parameter>\n</invoke>')), [['list', { path: '/var/log' }]], 'layout newlines are not value');
  assert.equal(JSON.parse(invokeArguments('<parameter name="content">a\n\nb\n</parameter>', { properties: { content: { type: 'string' } } })).content, 'a\n\nb', 'only one edge newline goes');
  const guessed = run('<invoke name="list"><parameter name="path">/</parameter></invoke>\n<function_results>\n<result>made up</result>');
  assert.equal(calls(guessed).length, 1);
  assert.ok(guessed.some(p => p.cut), 'invented results cut the turn');
  assert.equal(callsText([{ name: 'list', arguments: '{"path":"/tmp","depth":2}' }]), '<function_calls>\n<invoke name="list">\n<parameter name="path">/tmp</parameter>\n<parameter name="depth">2</parameter>\n</invoke>\n</function_calls>', 'history in the taught markup');
});

test('side requests without tools never touch the session conversation', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('real turn')];
  await collect(adapter, { sessionId: 's-side', messages: first });
  const live = adapter.sessions.get('s-side');
  const spawnsBefore = spawns();
  // The TUI's recap: same session id, no tools, a hand-built user message.
  const recap = await collect(adapter, { sessionId: 's-side', tools: undefined, messages: [user('Create a compact session recap')] });
  assert.equal(textOf(recap), 'hello Create a compact session recap');
  const run = log().filter(entry => entry.argv).at(-1);
  assert.ok(run.argv.includes('--no-session-persistence') && !run.argv.includes('--resume') && !run.argv.includes('--session-id'), 'answered by a one-shot process');
  assert.equal(spawns(), spawnsBefore + 1);
  assert.equal(adapter.sessions.get('s-side'), live, 'the conversation process is untouched');
  const assistant = { id: id(), role: 'assistant', content: [{ type: 'text', text: 'hello real turn' }], source: { kind: 'model', provider: 'claude-bare-dsh', model: 'm' } };
  await collect(adapter, { sessionId: 's-side', messages: [...first, assistant, user('next')] });
  assert.equal(spawns(), spawnsBefore + 1, 'the next real turn reuses the same process');
  assert.equal(prompts().at(-1), 'next');
});

const sessionIdOf = run => run.argv[run.argv.indexOf(run.argv.includes('--resume') ? '--resume' : '--session-id') + 1];
const lastRun = () => log().filter(entry => entry.argv).at(-1);
const answer = text => ({ id: id(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'claude-bare-dsh', model: 'm' } });
const checkpoint = text => ({ id: id(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', compactionId: 'c1' } });

test('a rewritten dsh history starts a new Claude conversation with the current history', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const u1 = user('first'), history = [system, u1];
  await collect(adapter, { sessionId: 's-rewrite', messages: history });
  assert.equal(sessionIdOf(lastRun()), claudeSessionId('s-rewrite'));
  // dsh compacted: the first exchange became a checkpoint, the history no longer starts with u1.
  const compacted = [system, checkpoint('SUMMARY of first'), user('after')];
  await collect(adapter, { sessionId: 's-rewrite', messages: compacted });
  const run = lastRun();
  assert.ok(run.argv.includes('--session-id'), 'a fresh conversation, not a resume');
  assert.equal(sessionIdOf(run), claudeSessionId('s-rewrite', 1));
  assert.equal(prompts().at(-1), 'SUMMARY of first\n\nafter', 'the whole compacted history, once');
  // The next turn continues that new conversation in the same process.
  const spawnsBefore = spawns();
  await collect(adapter, { sessionId: 's-rewrite', messages: [...compacted, answer('hello after'), user('more')] });
  assert.equal(spawns(), spawnsBefore);
  assert.equal(prompts().at(-1), 'more');
});

test('a session from before lineage tracking that dsh already compacted starts fresh once', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  adapter.markStarted(claudeSessionId('s-legacy'));
  const messages = [system, checkpoint('OLD SUMMARY'), answer('ok'), user('continue')];
  await collect(adapter, { sessionId: 's-legacy', messages });
  const run = lastRun();
  assert.ok(run.argv.includes('--session-id'));
  assert.equal(sessionIdOf(run), claudeSessionId('s-legacy', 1));
  assert.match(prompts().at(-1), /OLD SUMMARY/);
});

test('compaction is asked of the live conversation, scoped to the span, and retires it', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const u1 = user('alpha task'), a1 = answer('hello alpha task'), u2 = user('beta task');
  await collect(adapter, { sessionId: 's-compact', messages: [system, u1] });
  await collect(adapter, { sessionId: 's-compact', messages: [system, u1, a1, u2] });
  const spawnsBefore = spawns();
  const instruction = { role: 'user', content: [{ type: 'text', text: 'SUMMARIZE NOW' }] };
  const chunks = await collect(adapter, { sessionId: 's-compact', purpose: 'compaction', messages: [system, u1, a1, instruction] });
  assert.equal(spawns(), spawnsBefore, 'answered by the live process, so its prefix is a cache read');
  assert.equal(prompts().at(-1), 'Condense only the conversation up to and including the assistant message that begins: «hello alpha task». Everything after that message stays verbatim and must not be summarized.\n\nSUMMARIZE NOW');
  assert.equal(finishOf(chunks).reason.kind, 'stop');
  assert.ok(!chunks.some(c => c.type === 'block-end' && c.block.type === 'tool-call'));
  assert.equal(adapter.sessions.get('s-compact'), undefined, 'the conversation is retired');
  const after = [system, checkpoint('SUMMARY'), u2, answer('x'), user('next')];
  await collect(adapter, { sessionId: 's-compact', messages: after });
  const run = lastRun();
  assert.ok(run.argv.includes('--session-id'));
  assert.equal(sessionIdOf(run), claudeSessionId('s-compact', 1));
});

test('compaction without a matching conversation is a one-shot sharing the session prompt', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const instruction = { role: 'user', content: [{ type: 'text', text: 'SUMMARIZE' }] };
  await collect(adapter, { sessionId: 's-compact-cold', purpose: 'compaction', messages: [system, user('old'), answer('reply'), instruction] });
  const run = lastRun();
  assert.ok(run.argv.includes('--no-session-persistence') && !run.argv.includes('--resume') && !run.argv.includes('--session-id'));
  assert.match(run.systemPrompt, /^DSH SYSTEM PROMPT\n\n# Tools\n/, 'same prompt as the session, so its prefix is cached');
});

test('models declare a 250k window so dsh compacts around 200k', async () => {
  const adapter = adapterFor();
  assert.equal((await adapter.resolveModel('claude-bare-dsh', 'claude-sonnet-5-5')).context.contextWindow, 250000);
  assert.equal((await adapter.resolveModel('claude-bare-dsh', 'unknown-model')).context.contextWindow, 250000);
  adapter.dispose();
});
