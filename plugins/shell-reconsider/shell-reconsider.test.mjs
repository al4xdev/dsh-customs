import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, classifyCommand } from './index.mjs';

/**
 * Mounts the plugin against a fixture bash tool that advertises the same
 * `required: ['command', 'description']` the real bash tool ships, and records
 * the handlers so each lifecycle hook can be driven by hand.
 */
function fixture({ required = ['command', 'description'] } = {}) {
  const handlers = new Map();
  const registered = [];
  const bashCalls = [];
  const bash = {
    name: 'bash',
    description: 'Execute a bash command (`bash -c`) and return its stdout/stderr.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: [...required],
    },
    async execute(args) { bashCalls.push(args); return `ran ${args.command}`; },
  };
  const schemaBeforeMount = JSON.stringify({ description: bash.description, parameters: bash.parameters });
  const ctx = {
    tools: {
      get(name) { return name === 'bash' ? bash : registered.find((tool) => tool.name === name); },
      register(tool) { registered.push(tool); },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  apply(ctx, {});
  const emit = async (event, value) => {
    const next = async () => 'next-result';
    let result;
    for (const handler of handlers.get(event) ?? []) result = await handler(value, next);
    return result;
  };
  const exec = () => ({
    name: 'bash',
    callId: 'call-1',
    agent: { session: { header: { cwd: '/fixture' } } },
    signal: new AbortController().signal,
  });
  return { bash, registered, bashCalls, handlers, emit, exec, schemaBeforeMount };
}

test('the advertised bash schema never changes, including after tool changes and executions', async () => {
  const f = fixture();
  const snapshot = () => JSON.stringify({ description: f.bash.description, parameters: f.bash.parameters });
  assert.equal(snapshot(), f.schemaBeforeMount, 'mounting must not rewrite what the model is shown');
  await f.emit('tools/change', {});
  assert.equal(snapshot(), f.schemaBeforeMount, 'a tool change must not rewrite the catalog');
  const exec = f.exec();
  exec.arguments = { command: 'ls -1' };
  await f.emit('tools/execute', exec);
  assert.equal(snapshot(), f.schemaBeforeMount, 'a bash execution must not rewrite the catalog');
  assert.deepEqual(f.bash.parameters.required, ['command', 'description']);
});

test('a missing description is filled before the tool runs, without a schema relaxation', async () => {
  const f = fixture();
  const exec = f.exec();
  exec.arguments = { command: 'npm test' };
  await f.emit('tools/execute', exec);
  assert.deepEqual(exec.arguments, { command: 'npm test', description: 'Run: npm test' });
  // The wrapped execute covers call paths that skip the tools/execute waterfall.
  assert.equal(await f.bash.execute({ command: 'git status' }), 'ran git status');
  assert.deepEqual(f.bashCalls, [{ command: 'git status', description: 'Run: git status' }]);
  // A description the model did supply is preserved verbatim.
  await f.bash.execute({ command: 'ls', description: 'List the directory' });
  assert.equal(f.bashCalls[1].description, 'List the directory');
});

test('the reconsider permit still guards destructive commands end to end', async () => {
  const f = fixture();
  const tool = f.registered.find((entry) => entry.name === 'shell_reconsider');
  assert.ok(tool, 'shell_reconsider must stay registered');

  const blocked = f.exec();
  blocked.arguments = { command: 'rm -rf /tmp/fixture', description: 'Remove it' };
  assert.equal((await f.emit('tools/pre-execute', blocked)).kind, 'deny');

  const permit = await tool.execute({ necessary: true }, blocked);
  assert.equal(permit, 'true');

  // The single-use grant lets the identical arguments through exactly once.
  assert.equal(await f.emit('tools/pre-execute', { ...blocked, arguments: { ...blocked.arguments } }), 'next-result');

  // Plan 134: reading through the shell is not a denial any more, with or without
  // native tools in the catalog.
  const nativeRead = f.exec();
  nativeRead.arguments = { command: 'cat README.md', description: 'Read it' };
  assert.equal(await f.emit('tools/pre-execute', nativeRead), 'next-result');
});

test('a denial is never rewritten: no hook may mutate an existing message', async () => {
  const f = fixture();
  // Rewriting a denial one step later replaces a mid-history message, and the
  // provider then re-evaluates everything after it.
  assert.equal(f.handlers.get('agent/pre-step'), undefined, 'no per-step history editing');
  assert.equal(f.handlers.get('session/event'), undefined, 'no message tracking for later edits');
  const denied = f.exec();
  denied.arguments = { command: 'rm -rf /tmp/fixture', description: 'Remove it' };
  await f.emit('tools/pre-execute', denied);
  // Nothing is queued for a later step: the denial text stays as the model saw it.
  await f.emit('agent/request', { agent: denied.agent, turn: 2, step: 1 });
});

const verdict = (command, options = {}) => classifyCommand(command, options)?.type ?? 'allowed';

test('inspection and chaining pass: the guard no longer defends style', () => {
  // Each of these was denied before Plan 134.
  assert.equal(verdict('cat src/main.c'), 'allowed');
  assert.equal(verdict('ls -la build'), 'allowed');
  assert.equal(verdict('grep -rn foo src | head -20'), 'allowed');
  assert.equal(verdict('rg -n foo src'), 'allowed');
  assert.equal(verdict('find . -name "*.c"'), 'allowed');
  // Writing a script through a here-doc is a write, not a read.
  assert.equal(verdict("cat > /tmp/dump.py <<'EOF'\nprint(1)\nEOF"), 'allowed');
  // A forty-step call is how the current models work; no ceiling by default.
  assert.equal(verdict(Array.from({ length: 40 }, (_, i) => `echo ${i}`).join('; ')), 'allowed');
  // The route-arounds that made the old read denial cosmetic still pass, which is
  // the point: they were never the thing being defended.
  assert.equal(verdict("sed -n 1,80p src/main.c"), 'allowed');
  assert.equal(verdict('awk "{print \\$1}" src/main.c'), 'allowed');
});

test('a ceiling a profile chooses to keep still denies', () => {
  assert.equal(verdict('echo a; echo b; echo c; echo d', { compoundLimit: 3 }), 'compound');
  assert.equal(verdict('echo a; echo b; echo c', { compoundLimit: 3 }), 'allowed');
  // A here-doc holding data is not a script: a commit message must not count.
  assert.equal(verdict("git commit -F - <<'MSG'\none\ntwo\nthree\nfour\nMSG", { compoundLimit: 3 }), 'allowed');
});

test('destructive commands stay denied wherever they hide', () => {
  const forms = [
    'rm -rf /tmp/x',
    'echo ok && rm -rf /tmp/x',
    'rm -rf /tmp/x > /dev/null 2>&1',
    'sh -c "rm -rf /tmp/x"',
    'echo "$(rm -rf /tmp/x)"',
    'find /tmp/x -delete',
    'git clean -fdx',
    'git reset --hard',
    'dd if=/dev/zero of=/dev/sda',
    'shred -u /tmp/x',
    'truncate -s 0 /tmp/x',
  ];
  for (const command of forms) assert.equal(verdict(command), 'destructive', command);
  // The body of a shell here-doc is scanned like a `sh -c` payload. Before Plan 134
  // this passed entirely: the body was stripped and never inspected.
  assert.equal(verdict("bash <<'EOF'\nset -e\ncd /tmp\necho starting\nrm -rf /tmp/importante\nEOF"), 'destructive');
  assert.equal(verdict("bash -s <<'EOF'\nrm -rf /tmp/x\nEOF"), 'destructive');
  // A here-doc whose reader is not a shell is still data, not commands.
  assert.equal(verdict("python3 - <<'EOF'\nimport os\nos.remove('/tmp/x')\nEOF"), 'allowed');
});
