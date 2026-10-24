import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apply, inject, parseInput, resolveConfig, runMusic, tokenize, HELP } from './index.mjs';

const settings = resolveConfig({}, {}, '/test-home');
function fakeSpawn(action = () => {}, { closeOnKill = true } = {}) {
  const calls = [], kills = [];
  const spawnProcess = (...argv) => {
    calls.push(argv);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = signal => { kills.push(signal); if (closeOnKill) queueMicrotask(() => child.emit('close', null)); return true; };
    queueMicrotask(() => action(child));
    return child;
  };
  return { spawnProcess, calls, kills };
}

test('all supported command forms become deterministic argv', () => {
  for (const cmd of ['pause','resume','stop','next','previous','status','queue','shuffle','clear','shutdown']) assert.deepEqual(parseInput(cmd), [cmd]);
  assert.deepEqual(parseInput('last'), ['previous']);
  assert.deepEqual(parseInput('play'), ['play']);
  assert.deepEqual(parseInput('auth import-simpmusic --auth-user 01 --force'), ['auth','import-simpmusic','--force','--auth-user','1']);
  assert.deepEqual(parseInput('auth import-simpmusic --auth-user 100'), ['auth','import-simpmusic','--auth-user','100']);
  for (const mode of ['off','one','all']) assert.deepEqual(parseInput(`repeat ${mode}`), ['repeat', mode]);
  for (const cmd of ['status','import-simpmusic']) assert.deepEqual(parseInput(`auth ${cmd}`), ['auth', cmd]);
  assert.deepEqual(parseInput('play artist song --enqueue'), ['play','--enqueue','artist song']);
  assert.deepEqual(parseInput('play --enqueue --id abcdefghi_-'), ['play','--id','abcdefghi_-','--enqueue']);
  assert.deepEqual(parseInput('volume 20.5'), ['volume','20.5']);
  assert.deepEqual(parseInput('seek -10 --relative'), ['seek','-10','--relative']);
  assert.deepEqual(parseInput('seek 10'), ['seek','10']);
  for (const help of ['', ' ', 'help', '--help']) assert.equal(parseInput(help), null);
});

test('lexer is not a shell and preserves literal metacharacters', () => {
  assert.deepEqual(parseInput('play "$(touch /tmp/nope); $HOME `id` & | >"'), ['play','$(touch /tmp/nope); $HOME `id` & | >']);
  assert.deepEqual(tokenize("play 'a b' c\\ d"), ['play','a b','c d']);
  assert.deepEqual(tokenize('play "say \\"hello\\""'), ['play','say "hello"']);
});

test('unsupported flags, malformed values, and auth source overrides are rejected', () => {
  for (const raw of ['bogus', 'pause extra', 'play --enqueue', 'play --id short', 'play --id abcdefghi_- other', 'play --enqueue --enqueue x', 'play x --other', 'auth', 'auth import-simpmusic --source /secret', 'auth cookies', 'auth import-simpmusic --force --force', 'auth import-simpmusic --auth-user -1', 'auth import-simpmusic --auth-user 101', 'auth import-simpmusic --auth-user 1 --auth-user 2', 'auth import-simpmusic --auth-user', 'auth status --force', 'repeat yes', 'volume 101', 'volume -1', 'volume NaN', 'volume 1e2', 'seek -1', 'seek 86401', 'seek 1 --absolute', 'seek Infinity', 'play "unclosed', 'status\n', ' '.repeat(4097), `play ${'x'.repeat(501)}`, 'play '+Array(65).fill('x').join(' ')]) assert.throws(() => parseInput(raw), {message: HELP}, raw);
});

test('configuration respects env and rejects ambiguous executable paths', () => {
  assert.equal(settings.project, '/test-home/git/my/kiosktunes-mcp');
  assert.equal(settings.uv, 'uv');
  assert.equal(resolveConfig({}, {SIMP_MCP_PROJECT:'/music project', SIMP_MCP_UV:'/tools/uv'}, '/h').uv, '/tools/uv');
  assert.equal(resolveConfig({projectPath:'/override'}, {SIMP_MCP_PROJECT:'/env'}).project, '/override');
  for (const config of [{projectPath:'relative'}, {uvBinary:'uv --danger'}, {uvBinary:'./uv'}, {timeoutMs:0}, {timeoutMs:120001}, {maxOutputBytes:100}, {maxOutputBytes:65537}, {projectPath:'/a\nsecret'}]) assert.throws(() => resolveConfig(config));
});

test('spawn uses exact argv, no shell, ignored stdin and success stdout only', async () => {
  const fake = fakeSpawn(child => { child.stderr.emit('data', Buffer.from('secret diagnostic')); child.stdout.emit('data', Buffer.from('{"state":"playing"}\n')); child.emit('close', 0); });
  const result = await runMusic(['play','--enqueue','$(id); song'], settings, fake);
  assert.deepEqual(fake.calls[0], ['uv',['run','--directory','/test-home/git/my/kiosktunes-mcp','kiosktunes-mcp','music','play','--enqueue','$(id); song'],{shell:false,stdio:['ignore','pipe','pipe'],windowsHide:true}]);
  assert.deepEqual(result, {kind:'success',text:'{"state":"playing"}'});
});

test('errors and nonzero output cannot expose subprocess secrets', async () => {
  for (const action of [child => { child.stdout.emit('data', Buffer.from('access_token=SECRET')); child.stderr.emit('data', Buffer.from('cookie=SECRET')); child.emit('close', 1); }, child => child.emit('error', new Error('SECRET'))]) {
    const result = await runMusic(['auth','status'], settings, fakeSpawn(action));
    assert.equal(result.kind, 'error'); assert.doesNotMatch(result.text, /SECRET/);
  }
  const result = await runMusic(['status'], settings, {spawnProcess(){throw new Error('SECRET');}});
  assert.equal(result.kind, 'error'); assert.doesNotMatch(result.text, /SECRET/);
});

test('successful stdout redacts obvious credential lines and strips terminal escapes', async () => {
  const fake = fakeSpawn(child => { child.stdout.emit('data', Buffer.from('state: playing\nAuthorization: Bearer SECRET\ncookie=SECRET\n\x1b]52;c;evil\x07')); child.emit('close',0); });
  const result = await runMusic(['status'], settings, fake);
  assert.equal(result.kind,'success'); assert.doesNotMatch(result.text,/SECRET|\x1b|\x07/);
});

test('combined output budget kills the process and discards partial stdout', async () => {
  const fake = fakeSpawn(child => { child.stdout.emit('data', Buffer.alloc(200, 'a')); child.stderr.emit('data', Buffer.alloc(200, 's')); });
  const result = await runMusic(['status'], {...settings,maxOutputBytes:256}, fake);
  assert.equal(result.kind,'error'); assert.match(result.text,/limit/); assert.deepEqual(fake.kills,['SIGTERM']);
});

test('timeout terminates and escalates if close never arrives', async () => {
  const fake = fakeSpawn(() => {}, {closeOnKill:false});
  const result = await runMusic(['status'], {...settings,timeoutMs:10}, fake);
  assert.equal(result.kind,'error'); assert.match(result.text,/timed out/); assert.deepEqual(fake.kills,['SIGTERM','SIGKILL']);
});

test('abort cancels, including pre-aborted signals without spawn', async () => {
  const controller = new AbortController();
  controller.abort(new Error('SECRET'));
  const fake = fakeSpawn();
  assert.deepEqual(await runMusic(['status'],settings,{...fake,signal:controller.signal}), {kind:'error',text:'Music command canceled.'});
  assert.equal(fake.calls.length,0);
  const live = new AbortController();
  const running = fakeSpawn(() => live.abort(new Error('SECRET')));
  const result = await runMusic(['status'],settings,{...running,signal:live.signal});
  assert.equal(result.text,'Music command canceled.'); assert.deepEqual(running.kills,['SIGTERM']);
});

test('UTF-8 split across stdout chunks is decoded without corruption', async () => {
  const fake = fakeSpawn(child => {
    const bytes = Buffer.from('🎵 café');
    for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte]));
    child.emit('close', 0);
  });
  assert.equal((await runMusic(['status'], settings, fake)).text, '🎵 café');
});

test('actual child-process pipes return safe metadata without the real CLI', async () => {
  const result = await runMusic(['status'], settings, {
    spawnProcess(_exe, _args, options) {
      return spawn(process.execPath, ['--input-type=module', '-e', 'process.stderr.write("SECRET");process.stdout.write(JSON.stringify({state:"paused",title:"café 🎵"}));'], options);
    },
  });
  assert.deepEqual(result, {kind:'success',text:'{"state":"paused","title":"café 🎵"}'});
});

test('installed native registry dispatches log-only and does not persist raw secrets', async t => {
  let cordisPath, commandsPath;
  for (const base of [import.meta.url, join(homedir(), '.local/share/dsh-cli/package.json')]) {
    try {
      const require = createRequire(base);
      cordisPath = require.resolve('@deepseek-ai/cordis');
      commandsPath = require.resolve('@deepseek-ai/dsh-commands');
      break;
    } catch { /* A standalone checkout need not have the DSH host installed. */ }
  }
  if (!commandsPath) { t.skip('Native DSH command host is not installed'); return; }
  const { Context } = await import(cordisPath);
  const { CommandRuntime } = await import(commandsPath);
  const ctx = new Context();
  new CommandRuntime(ctx);
  const events = [];
  const agent = {session:{append(type,data){ events.push({type,data}); return events.length; }},send(){throw new Error('Must not call the model');}};
  try {
    apply(ctx, {projectPath:'/safe/project'});
    assert.deepEqual(ctx.commands.list(agent).map(command => command.name), ['music']);
    const invocation = await ctx.commands.execute(agent, '/music auth cookie=SECRET', [], new AbortController().signal);
    assert.equal(invocation.result.kind, 'error');
    assert.deepEqual(events.map(event => event.type), ['command/run','command/done']);
    assert.doesNotMatch(JSON.stringify(events), /SECRET|cookie=/);
    assert.equal(Object.hasOwn(events[0].data, 'args'), false);
    const help = await ctx.commands.execute(agent, '/music', [], new AbortController().signal);
    assert.equal(help.result.text, HELP);
  } finally { await ctx.fiber.dispose(); }
});

test('plugin registers only the native music command and handles help/errors locally', async () => {
  const commands = [], cleanups = [];
  const ctx = {commands:{register(definition){commands.push(definition);}},effect(fn){cleanups.push(fn());}};
  apply(ctx, {projectPath:'/safe/project'});
  assert.deepEqual(inject,['commands']); assert.equal(commands.length,1); assert.equal(commands[0].name,'music'); assert.equal(commands[0].recordInput,false);
  assert.deepEqual(commands[0].input,{hint:'<command> [arguments]',attachments:false});
  assert.deepEqual(await commands[0].handler({rawInput:''}),{kind:'success',text:HELP});
  assert.deepEqual(await commands[0].handler({rawInput:'auth import-simpmusic --source /private'}),{kind:'error',text:HELP});
  cleanups[0]();
  assert.equal((await commands[0].handler({rawInput:'status'})).text,'Music plugin is unloaded.');
});
