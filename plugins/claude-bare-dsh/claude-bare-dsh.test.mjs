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
  assert.deepEqual(JSON.parse(arg('--settings')), { autoMemoryEnabled: false, enabledPlugins: { 'cc-plugin-agents-md@builtin': false, 'cc-plugin-plugin-authoring@builtin': false } });
  assert.equal(arg('--session-id'), claudeSessionId('s-flags'));
  assert.ok(!run.argv.includes('--append-system-prompt'), 'the prompt goes by file, not argv');
  assert.match(run.systemPrompt, /^DSH SYSTEM PROMPT\n\n# Tools\n.*built-in tools are disabled.*## echo\nEcho a value\nArguments \(JSON Schema\): \{"type":"object"/s);
  assert.ok(!run.argv.includes('--mcp-config') && !run.argv.includes('--allowedTools'), 'no MCP at all');
  assert.equal(run.env.CLAUDE_CONFIG_DIR, join(process.env.XDG_STATE_HOME, 'claude-bare-dsh/claude-home'));
  assert.equal(run.env.CLAUDE_CODE_OAUTH_TOKEN, 'set');
  assert.equal(run.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(run.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
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
  assert.equal(prompts().at(-1), '<dsh_result name="echo" index="1">\nRESULT-X\n</dsh_result>');
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
  assert.deepEqual([...bad.feed('<dsh_call oops>{}</dsh_call>ok'), ...bad.end()], [{ text: 'ok' }]);
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
