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
process.env.MCP_TOOL_TIMEOUT = '1000';
const { ClaudeCliAdapter, Config, afterLastAssistant, claudeSessionId, imageTarget } = await import('./index.mjs');
const { resultReason } = await import('./session.mjs');
const { PREFIX, definitions, dshName, shortName } = await import('./mcp.mjs');
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
const callsOf = chunks => chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').map(c => c.block);
const spawns = () => log().filter(entry => entry.argv).length;
const prompts = () => log().filter(entry => entry.prompt !== undefined).map(entry => entry.prompt);
const toolResults = () => log().filter(entry => entry.toolResult).map(entry => entry.toolResult);
const lastRun = () => log().filter(entry => entry.argv).at(-1);
/** Log entries of the process spawned last. */
const sinceLastSpawn = () => { const all = log(); return all.slice(all.findLastIndex(entry => entry.argv) + 1); };
const assistantWith = content => ({ id: id(), role: 'assistant', content, source: { kind: 'model', provider: 'claude-bare-dsh', model: 'claude-sonnet-5-5' } });
const toolMessage = (call, content, extra = {}) => ({ id: id(), role: 'tool', toolCallId: call.id, content, source: { kind: 'tool', callId: call.id }, ...extra });

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

test('the CLI runs stripped down, with dsh tools as an in-process MCP server allowed without prompts', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  await collect(adapter, { sessionId: 's-flags', messages: [system, user('flags')] });
  const run = lastRun();
  const arg = name => run.argv[run.argv.indexOf(name) + 1];
  assert.equal(arg('--tools'), '');
  assert.ok(run.argv.includes('--strict-mcp-config'));
  assert.ok(run.argv.includes('--disable-slash-commands'));
  assert.equal(arg('--setting-sources'), 'user');
  assert.equal(arg('--permission-mode'), 'dontAsk');
  assert.equal(arg('--allowedTools'), 'mcp__dsh__*');
  assert.deepEqual(JSON.parse(arg('--settings')), { autoMemoryEnabled: false, autoCompactEnabled: false, enabledPlugins: { 'cc-plugin-agents-md@builtin': false, 'cc-plugin-plugin-authoring@builtin': false } });
  assert.equal(arg('--session-id'), claudeSessionId('s-flags'));
  assert.ok(!run.argv.includes('--append-system-prompt'), 'the prompt goes by file, not argv');
  assert.match(run.systemPrompt, /^DSH SYSTEM PROMPT\n\nThe working directory, platform and git facts/);
  assert.ok(!run.systemPrompt.includes('# Tools'), 'tools travel over MCP, not in the prompt');
  assert.ok(!run.argv.includes('--mcp-config'), 'no MCP server from any config file');
  const entries = sinceLastSpawn();
  assert.deepEqual(entries.find(entry => entry.initialize).initialize, { subtype: 'initialize', sdkMcpServers: ['dsh'] });
  const listed = entries.find(entry => entry.tools).tools;
  assert.deepEqual(listed.map(tool => tool.name), ['echo']);
  assert.deepEqual(listed[0].inputSchema, echoTool.parameters);
  assert.equal(run.env.CLAUDE_CONFIG_DIR, join(process.env.XDG_STATE_HOME, 'claude-bare-dsh/claude-home'));
  assert.equal(run.env.CLAUDE_CODE_OAUTH_TOKEN, 'set');
  assert.equal(run.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(run.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(run.env.DISABLE_AUTO_COMPACT, '1');
  assert.equal(run.env.ENABLE_TOOL_SEARCH, 'false');
  assert.equal(run.env.MAX_MCP_OUTPUT_TOKENS, '200000');
  assert.equal(run.env.MCP_TOOL_TIMEOUT, undefined, 'an inherited cap would fail long dsh tools');
  assert.equal(run.cwd, join(process.env.XDG_STATE_HOME, 'claude-bare-dsh/work'));
});

test('a tool call parks the CLI turn; its result answers the call and the same turn goes on', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('please TOOL')];
  const step1 = await collect(adapter, { sessionId: 's-tool', messages: first });
  assert.deepEqual(finishOf(step1), { type: 'finish', reason: { kind: 'tool-calls' } });
  assert.equal(textOf(step1), 'Checking.\n');
  const [call] = callsOf(step1);
  assert.equal(call.name, 'echo');
  assert.match(call.id, /^toolu_/, 'the call keeps Claude\'s own tool_use id');
  assert.deepEqual(JSON.parse(call.arguments), { value: 'x' });
  assert.ok(adapter.sessions.get('s-tool').parked);
  const promptsBefore = prompts().length, spawnsBefore = spawns();
  const step2 = await collect(adapter, { sessionId: 's-tool', messages: [...first, assistantWith([call]), toolMessage(call, [{ type: 'text', text: 'RESULT-X' }])] });
  assert.deepEqual(toolResults().at(-1), { id: call.id, content: [{ type: 'text', text: 'RESULT-X' }] });
  assert.equal(textOf(step2), 'got: RESULT-X');
  assert.deepEqual(finishOf(step2), { type: 'finish', reason: { kind: 'stop' } });
  assert.equal(prompts().length, promptsBefore, 'no new user line: the result went to the parked call');
  assert.equal(spawns(), spawnsBefore, 'no respawn between the two steps');
  assert.ok(!log().some(entry => entry.interrupted), 'nothing was interrupted');
  assert.ok(!adapter.sessions.get('s-tool').parked);
});

test('parallel calls in one Claude message become one dsh step', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('TWO please')];
  const step1 = await collect(adapter, { sessionId: 's-two', messages: first });
  const calls = callsOf(step1);
  assert.equal(calls.length, 2);
  const results = calls.map(call => toolMessage(call, [{ type: 'text', text: JSON.parse(call.arguments).value.toUpperCase() }]));
  const step2 = await collect(adapter, { sessionId: 's-two', messages: [...first, assistantWith(calls), ...results] });
  assert.equal(textOf(step2), 'got: A | B');
});

test('a message sent while the tools ran joins the open turn', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('TOOL go')];
  const [call] = callsOf(await collect(adapter, { sessionId: 's-steer', messages: first }));
  const step2 = await collect(adapter, { sessionId: 's-steer', messages: [...first, assistantWith([call]), toolMessage(call, [{ type: 'text', text: 'R' }]), user('also this')] });
  assert.equal(textOf(step2), 'got: R + also this');
  assert.deepEqual(log().filter(entry => entry.prompt !== undefined).at(-1), { prompt: 'also this', priority: 'next' });
});

test('a call missing from dsh history is answered as not run', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('TOOL lost')];
  const [call] = callsOf(await collect(adapter, { sessionId: 's-lost', messages: first }));
  const step2 = await collect(adapter, { sessionId: 's-lost', messages: [...first, assistantWith([call])] });
  assert.equal(toolResults().at(-1).isError, true);
  assert.match(textOf(step2), /^got: \(no result: dsh did not run this call\)/);
});

test('a turn parked on tools is neither evicted for a new process nor swept as idle', async t => {
  const adapter = new ClaudeCliAdapter(ctx(), Config({ command: fake, maxProcesses: 1 }));
  t.after(() => adapter.dispose());
  const first = [system, user('TOOL long')];
  const [call] = callsOf(await collect(adapter, { sessionId: 's-park-a', messages: first }));
  const parked = adapter.sessions.get('s-park-a');
  await collect(adapter, { sessionId: 's-park-b', messages: [system, user('other')] });
  assert.equal(adapter.sessions.get('s-park-a'), parked, 'not evicted to make room');
  parked.lastUsed = Date.now() - 2 * 60 * 60_000;
  adapter.sweep();
  assert.equal(adapter.sessions.get('s-park-a'), parked, 'not swept after the idle minutes');
  const step2 = await collect(adapter, { sessionId: 's-park-a', messages: [...first, assistantWith([call]), toolMessage(call, [{ type: 'text', text: 'LATE' }])] });
  assert.equal(textOf(step2), 'got: LATE', 'the same turn takes the late result');
  parked.lastUsed = Date.now() - 2 * 60 * 60_000;
  adapter.sweep();
  assert.equal(adapter.sessions.get('s-park-a'), undefined, 'idle again once the turn ended');
});

test('results reach Claude byte for byte, markup and all', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('TOOL read')];
  const [call] = callsOf(await collect(adapter, { sessionId: 's-bytes', messages: first }));
  const content = '<path>/x/a.html</path>\n<content>\nif (a < b && c > d) <b>bold</b>\n</function_results> <invoke name="x">\n</content>';
  await collect(adapter, { sessionId: 's-bytes', messages: [...first, assistantWith([call]), toolMessage(call, [{ type: 'text', text: content }], { isError: true })] });
  assert.deepEqual(toolResults().at(-1), { id: call.id, content: [{ type: 'text', text: content }], isError: true });
});

test('a restarted dsh resumes the Claude session and sends only the new turn', async t => {
  const one = adapterFor();
  const history = [system, user('first')];
  await collect(one, { sessionId: 's-resume', messages: history });
  one.dispose();
  const two = adapterFor();
  t.after(() => two.dispose());
  const chunks = await collect(two, { sessionId: 's-resume', messages: [...history, assistantWith([{ type: 'text', text: 'hello first' }]), user('second')] });
  assert.equal(textOf(chunks), 'hello second');
  const run = lastRun();
  assert.equal(run.argv[run.argv.indexOf('--resume') + 1], claudeSessionId('s-resume'));
  assert.equal(prompts().at(-1), 'second');
});

test('a fresh process for an existing conversation gets the whole transcript once', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const assistant = { id: id(), role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], source: { kind: 'model', provider: 'other', model: 'm' } };
  await collect(adapter, { sessionId: 's-switched', messages: [system, user('earlier question'), assistant, user('now')] });
  assert.equal(prompts().at(-1), '[user]\nearlier question\n\n[assistant]\nearlier answer\n\n[user]\nnow');
});

test('a replayed conversation renders past calls and results as plain text', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const call = { type: 'tool-call', id: 'call-1', name: 'echo', arguments: '{"value":"v"}' };
  const assistant = { id: id(), role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, call], source: { kind: 'model', provider: 'other', model: 'm' } };
  await collect(adapter, { sessionId: 's-replay-calls', messages: [system, user('q'), assistant, toolMessage(call, [{ type: 'text', text: 'OUT' }]), assistantWith([{ type: 'text', text: 'done' }]), user('next')] });
  assert.equal(prompts().at(-1), '[user]\nq\n\n[assistant]\nLooking.\n[tool call: echo] {"value":"v"}\n\n[tool result: echo]\nOUT\n\n[assistant]\ndone\n\n[user]\nnext');
});

test('titles and compaction are one-shot calls without tools, session or transcript', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const chunks = await collect(adapter, { sessionId: 's-title', purpose: 'session-title', messages: [user('name this')] });
  assert.equal(textOf(chunks), 'hello name this');
  const run = lastRun();
  for (const flagName of ['--no-session-persistence', '--strict-mcp-config']) assert.ok(run.argv.includes(flagName));
  assert.equal(run.argv[run.argv.indexOf('--max-turns') + 1], '1');
  assert.ok(!run.argv.includes('--mcp-config') && !run.argv.includes('--session-id'));
  assert.ok(!sinceLastSpawn().some(entry => entry.initialize), 'no MCP server registered');
});

test('abort interrupts the CLI and finishes aborted', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const chunks = await collect(adapter, { sessionId: 's-abort', messages: [system, user('SLOW')], signal: controller.signal });
  assert.equal(finishOf(chunks).reason.kind, 'aborted');
  assert.ok(sinceLastSpawn().some(entry => entry.interrupted));
});

test('after an aborted step the process lives on and the aborted message is not sent again', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const history = [system, user('SLOW')];
  assert.equal(finishOf(await collect(adapter, { sessionId: 's-abort-reuse', messages: history, signal: controller.signal })).reason.kind, 'aborted');
  const before = spawns();
  const chunks = await collect(adapter, { sessionId: 's-abort-reuse', messages: [...history, user('WAIT6 later')] });
  assert.equal(prompts().at(-1), 'WAIT6 later');
  assert.equal(textOf(chunks), 'hello WAIT6 later');
  assert.equal(spawns(), before, 'same process reused');
});

test('no token: a clear credential error and no process', async () => {
  const adapter = adapterFor(null);
  const before = spawns();
  const chunks = await collect(adapter, { sessionId: 's-none', messages: [user('hi')] });
  assert.equal(finishOf(chunks).reason.failure.code, 'MISSING_CREDENTIAL');
  assert.equal(spawns(), before);
  adapter.dispose();
});

test('result mapping: login, usage limit, max tokens', () => {
  const auth = resultReason({ is_error: true, result: 'Failed to authenticate', api_error_status: 401 });
  assert.equal(auth.failure.code, 'MISSING_CREDENTIAL');
  assert.ok(Object.isFrozen(auth.failure));

  const limited = resultReason({ is_error: true, result: 'limit' }, { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 60 });
  assert.equal(limited.failure.code, 'RATE_LIMIT');
  assert.equal(limited.failure.status, 429);
  assert.ok(limited.failure.providerRetryAfterMs > 0);
  assert.ok(Object.isFrozen(limited.failure));

  const fromApiParams = resultReason({ is_error: true, api_error_status: 429, api_error: 'usage_limit_reached', api_error_params: { rate_limit_info: { resetsAt: Math.floor(Date.now() / 1000) + 60 } } });
  assert.equal(fromApiParams.failure.code, 'RATE_LIMIT');
  assert.equal(fromApiParams.failure.status, 429);
  assert.ok(fromApiParams.failure.providerRetryAfterMs > 0);
  assert.ok(Object.isFrozen(fromApiParams.failure));

  assert.deepEqual(resultReason({ stop_reason: 'max_tokens' }), { kind: 'max-tokens' });
  assert.deepEqual(afterLastAssistant([user('a'), { role: 'assistant', content: [] }, user('b')]).map(m => m.content[0].text), ['b']);
});

test('rate limit events yield a frozen RATE_LIMIT failure with status 429, providerRetryAfterMs and suppress synthetic text', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const chunks = await collect(adapter, { sessionId: 's-rate-limit', messages: [system, user('TRIGGER_RATE_LIMIT')] });
  assert.equal(textOf(chunks), '', 'synthetic CLI error text must never be streamed to the user');
  const finish = finishOf(chunks);
  assert.equal(finish.type, 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.code, 'RATE_LIMIT');
  assert.equal(finish.reason.failure.status, 429);
  assert.ok(finish.reason.failure.providerRetryAfterMs > 0);
  assert.ok(Object.isFrozen(finish.reason.failure));
});

test('tool names: prefixed, kept under the API limit, mapped back; descriptions cut where Claude Code cuts', () => {
  const long = 'a'.repeat(80), odd = 'x.y/z';
  for (const name of [long, odd]) {
    assert.ok((PREFIX + shortName(name)).length <= 64);
    assert.match(shortName(name), /^[a-zA-Z0-9_-]+$/);
    assert.equal(dshName(PREFIX + shortName(name), [{ name: 'echo' }, { name }]), name);
  }
  assert.equal(shortName('read'), 'read');
  assert.equal(dshName('mcp__other__read', [{ name: 'read' }]), undefined, 'a tool dsh did not offer');
  const [definition] = definitions([{ name: 'big', description: 'd'.repeat(3000) }]);
  assert.equal(definition.description.length, 2048);
  assert.deepEqual(definition.inputSchema, { type: 'object' });
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

test('tool results survive a process that died while dsh ran the tool', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('TOOL then crash')];
  const [call] = callsOf(await collect(adapter, { sessionId: 's-crash', messages: first }));
  adapter.sessions.get('s-crash').kill();
  await new Promise(resolve => setTimeout(resolve, 300));
  const step2 = await collect(adapter, { sessionId: 's-crash', messages: [...first, assistantWith([call]), toolMessage(call, [{ type: 'text', text: 'RESULT-AFTER-CRASH' }])] });
  assert.equal(prompts().at(-1), '[tool result: echo]\nRESULT-AFTER-CRASH', 'the resumed process gets the result as text');
  assert.equal(textOf(step2), 'got: RESULT-AFTER-CRASH');
  assert.ok(lastRun().argv.includes('--resume'), 'respawned on the same Claude session');
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
  await collect(adapter, { sessionId: 's-tools', messages: [...history, assistantWith([{ type: 'text', text: 'hello one' }]), user('two')], tools: [other] });
  assert.equal(spawns(), before + 1);
  assert.deepEqual(sinceLastSpawn().find(entry => entry.tools).tools.map(tool => tool.name), ['other']);
  assert.equal(prompts().at(-1), 'two', 'resumed: only the new turn is sent');
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

test('an image in a tool result (read_image) reaches Claude inside that result', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const first = [system, user('TOOL look')];
  const [call] = callsOf(await collect(adapter, { sessionId: 's-read-image', messages: first }));
  await collect(adapter, { sessionId: 's-read-image', messages: [...first, assistantWith([call]), toolMessage(call, [{ type: 'text', text: 'read ok' }, image('shot', 800, 600)])] });
  assert.deepEqual(toolResults().at(-1).content, [{ type: 'text', text: 'read ok' }, { type: 'image', data: b64('png:shot'), mimeType: 'image/png' }]);
  assert.deepEqual(targets.at(-1), { id: 'shot', ...imageTarget({ width: 800, height: 600 }) });
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
  const run = lastRun();
  assert.ok(run.argv.includes('--no-session-persistence') && !run.argv.includes('--resume') && !run.argv.includes('--session-id'), 'answered by a one-shot process');
  assert.equal(spawns(), spawnsBefore + 1);
  assert.equal(adapter.sessions.get('s-side'), live, 'the conversation process is untouched');
  await collect(adapter, { sessionId: 's-side', messages: [...first, assistantWith([{ type: 'text', text: 'hello real turn' }]), user('next')] });
  assert.equal(spawns(), spawnsBefore + 1, 'the next real turn reuses the same process');
  assert.equal(prompts().at(-1), 'next');
});

const sessionIdOf = run => run.argv[run.argv.indexOf(run.argv.includes('--resume') ? '--resume' : '--session-id') + 1];
const answer = text => assistantWith([{ type: 'text', text }]);
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
  assert.equal(callsOf(chunks).length, 0);
  assert.equal(adapter.sessions.get('s-compact'), undefined, 'the conversation is retired');
  const after = [system, checkpoint('SUMMARY'), u2, answer('x'), user('next')];
  await collect(adapter, { sessionId: 's-compact', messages: after });
  const run = lastRun();
  assert.ok(run.argv.includes('--session-id'));
  assert.equal(sessionIdOf(run), claudeSessionId('s-compact', 1));
});

test('compaction while a turn is parked on tools is a one-shot that leaves the turn alone', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const u1 = user('TOOL first');
  await collect(adapter, { sessionId: 's-compact-parked', messages: [system, u1] });
  const live = adapter.sessions.get('s-compact-parked');
  assert.ok(live.parked);
  const instruction = { role: 'user', content: [{ type: 'text', text: 'SUMMARIZE' }] };
  await collect(adapter, { sessionId: 's-compact-parked', purpose: 'compaction', messages: [system, u1, instruction] });
  assert.ok(lastRun().argv.includes('--no-session-persistence'), 'a one-shot answered');
  assert.equal(adapter.sessions.get('s-compact-parked'), live);
  assert.ok(live.parked, 'the parked turn still waits for its results');
});

test('compaction without a matching conversation is a one-shot sharing the session prompt and tools', async t => {
  const adapter = adapterFor();
  t.after(() => adapter.dispose());
  const instruction = { role: 'user', content: [{ type: 'text', text: 'SUMMARIZE' }] };
  await collect(adapter, { sessionId: 's-compact-cold', purpose: 'compaction', messages: [system, user('old'), answer('reply'), instruction] });
  const run = lastRun();
  assert.ok(run.argv.includes('--no-session-persistence') && !run.argv.includes('--resume') && !run.argv.includes('--session-id'));
  assert.match(run.systemPrompt, /^DSH SYSTEM PROMPT\n\nThe working directory/, 'same prompt as the session, so its prefix is cached');
  assert.deepEqual(sinceLastSpawn().find(entry => entry.tools)?.tools.map(tool => tool.name), ['echo'], 'and the same tools');
});

test('models declare a 250k window so dsh compacts around 200k', async () => {
  const adapter = adapterFor();
  assert.equal((await adapter.resolveModel('claude-bare-dsh', 'claude-sonnet-5-5')).context.contextWindow, 250000);
  assert.equal((await adapter.resolveModel('claude-bare-dsh', 'unknown-model')).context.contextWindow, 250000);
  adapter.dispose();
});
