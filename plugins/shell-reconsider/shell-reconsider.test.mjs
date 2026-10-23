import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from './index.mjs';

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

  const nativeRead = f.exec();
  nativeRead.arguments = { command: 'cat README.md', description: 'Read it' };
  const denial = await f.emit('tools/pre-execute', nativeRead);
  assert.equal(denial.kind, 'deny');
  assert.match(denial.reason, /native `read` tool/);
});

test('a denial is never rewritten: no hook may mutate an existing message', async () => {
  const f = fixture();
  // Rewriting a denial one step later replaces a mid-history message, and the
  // provider then re-evaluates everything after it.
  assert.equal(f.handlers.get('agent/pre-step'), undefined, 'no per-step history editing');
  assert.equal(f.handlers.get('session/event'), undefined, 'no message tracking for later edits');
  const denied = f.exec();
  denied.arguments = { command: 'cat README.md', description: 'Read it' };
  await f.emit('tools/pre-execute', denied);
  // Nothing is queued for a later step: the denial text stays as the model saw it.
  await f.emit('agent/request', { agent: denied.agent, turn: 2, step: 1 });
});
