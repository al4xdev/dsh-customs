import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from './index.mjs';

const target = (name) => ({ targetKey: `/fixture/${name}`, displayPath: `/fixture/${name}` });
const file = (name) => ({ name, type: 'file' });
const directory = (name, key = name) => ({ name, type: 'directory', target: target(key) });

function fixture(tree = { root: [] }, overrides = {}) {
  let tool, section;
  const calls = [];
  const root = target('root');
  const ctx = {
    fs: {
      async resolve(path, options) { calls.push({ kind: 'resolve', path, options }); return root; },
      async stat() { return { type: 'directory' }; },
      async listDir(value, signal) {
        signal?.throwIfAborted();
        const key = value.targetKey.slice('/fixture/'.length);
        calls.push({ kind: 'listDir', key });
        assert.ok(Object.hasOwn(tree, key), `Unexpected directory: ${key}`);
        return tree[key].map((entry) => ({ ...entry }));
      },
      ...overrides,
    },
    tools: {
      register(value) { tool = value; },
      get(name) { return name === 'list' ? tool : undefined; },
    },
    systemPrompt: {
      getSectionOrder(name) { assert.equal(name, 'TOOL_READ'); return 10; },
      section(value) { section = value; },
    },
  };
  apply(ctx);
  const exec = { agent: { session: { header: { cwd: '/session' } } }, signal: new AbortController().signal };
  return { tool, section, ctx, calls, exec, run: (args = { path: '.' }) => tool.execute(args, exec) };
}

test('registered tool uses session cwd, accepts aliases, and prefers file_path', async () => {
  const { run, calls } = fixture();
  await run({ path: 'relative' });
  await run({ file_path: 'primary', path: 'alias' });
  assert.deepEqual(calls.filter((call) => call.kind === 'resolve').map((call) => [call.path, call.options.cwd]), [
    ['relative', '/session'], ['primary', '/session'],
  ]);
});

test('invalid arguments are rejected before any filesystem operation', async () => {
  const { run, calls } = fixture();
  for (const args of [
    {}, { path: '' }, { path: '  ' }, { path: 1 }, { path: '.', hidden: 'false' },
    ...[0, -1, 1.5, 9, '2'].map((depth) => ({ path: '.', depth })),
    ...[0, -1, 1.5, 1001, '2'].map((limit) => ({ path: '.', limit })),
  ]) await assert.rejects(run(args));
  assert.deepEqual(calls, []);
  await run({ path: '.', depth: 8, limit: 1000 });
});

test('default depth is immediate entries; directories precede files and other entries', async () => {
  const { run, calls } = fixture({ root: [file('z'), { name: 'socket', type: 'other' }, directory('b'), file('a'), directory('a-dir')] });
  const value = await run();
  assert.deepEqual(value.entries.map((entry) => entry.path), ['a-dir', 'b', 'a', 'z', 'socket']);
  assert.equal(value.total, 5);
  assert.equal(value.truncated, false);
  assert.equal(calls.filter((call) => call.kind === 'listDir').length, 1);
});

test('recursive listing respects depth and returns relative paths', async () => {
  const { run, calls } = fixture({ root: [directory('dir'), file('root.txt')], dir: [directory('nested'), file('child.txt')] });
  const value = await run({ path: '.', depth: 2 });
  assert.deepEqual(value.entries.map((entry) => entry.path), ['dir', 'dir/nested', 'dir/child.txt', 'root.txt']);
  assert.deepEqual(calls.filter((call) => call.kind === 'listDir').map((call) => call.key), ['root', 'dir']);
});

test('hidden entries are included by default; filtering also avoids hidden subtrees', async () => {
  const { run, calls } = fixture({ root: [directory('.private'), file('.env'), file('visible')], '.private': [file('inside')] });
  assert.equal((await run()).total, 3);
  calls.length = 0;
  const value = await run({ path: '.', depth: 2, hidden: false });
  assert.deepEqual(value.entries.map((entry) => entry.path), ['visible']);
  assert.equal(value.total, 1);
  assert.deepEqual(calls.filter((call) => call.kind === 'listDir').map((call) => call.key), ['root']);
});

test('result limit truncates output, not traversal or the total count', async () => {
  const { run, calls } = fixture({ root: [directory('dir'), file('last')], dir: [file('one'), file('two')] });
  const value = await run({ path: '.', depth: 2, limit: 1 });
  assert.deepEqual(value.entries.map((entry) => entry.path), ['dir']);
  assert.equal(value.total, 4);
  assert.equal(value.truncated, true);
  assert.deepEqual(calls.filter((call) => call.kind === 'listDir').map((call) => call.key), ['root', 'dir']);
});

test('default result limit is 200 and exact-limit results are not marked truncated', async () => {
  const tree = { root: Array.from({ length: 201 }, (_, index) => file(`file-${String(index).padStart(3, '0')}`)) };
  const { run } = fixture(tree);
  const capped = await run();
  assert.equal(capped.entries.length, 200);
  assert.equal(capped.total, 201);
  assert.equal(capped.truncated, true);
  assert.equal((await run({ path: '.', limit: 201 })).truncated, false);
});

test('UTF-8 path budget caps collected entries even below the count limit', async () => {
  // Oversized in-memory names exercise accounting, not real filesystem name limits.
  const { run } = fixture({ root: [file('é'.repeat(32768))] });
  const value = await run();
  assert.equal(value.entries.length, 0);
  assert.equal(value.total, 1);
  assert.equal(value.truncated, true);
});

test('repeated directory identities and ancestor loops are listed but traversed once', async () => {
  const { run, calls } = fixture({ root: [directory('a', 'shared'), directory('alias', 'shared'), directory('loop', 'root')], shared: [file('child')] });
  const value = await run({ path: '.', depth: 8 });
  assert.deepEqual(value.entries.map((entry) => entry.path), ['a', 'a/child', 'alias', 'loop']);
  assert.deepEqual(calls.filter((call) => call.kind === 'listDir').map((call) => call.key), ['root', 'shared']);
});

test('missing and non-directory targets fail without traversal; backend errors propagate', async () => {
  for (const [info, pattern] of [[undefined, /not found/], [{ type: 'file' }, /not a directory/]]) {
    const { run, calls } = fixture({}, { async stat() { return info; } });
    await assert.rejects(run(), pattern);
    assert.equal(calls.some((call) => call.kind === 'listDir'), false);
  }
  const { run } = fixture({}, { async listDir() { throw new Error('backend unavailable'); } });
  await assert.rejects(run(), /backend unavailable/);
});

test('cancellation before execution and during listing rejects instead of returning partial output', async () => {
  const before = fixture();
  before.exec.signal = AbortSignal.abort();
  await assert.rejects(before.run(), { name: 'AbortError' });
  assert.deepEqual(before.calls, []);
  const abort = new AbortController();
  const during = fixture({}, { async listDir() { abort.abort(); return [file('late')]; } });
  during.exec.signal = abort.signal;
  await assert.rejects(during.run(), { name: 'AbortError' });
});

test('rendering and presentation expose paths, counts, hidden filtering, and truncation', async () => {
  const { tool, run } = fixture({ root: [directory('dir'), file('file')] });
  const args = { path: '.', limit: 1, hidden: false };
  const value = await run(args);
  const text = tool.output.render(args, value)[0].text;
  assert.match(text, /<path>\/fixture\/root<\/path>/);
  assert.match(text, /dir\/\n/);
  assert.match(text, /Showing 1 of 2 entries \(capped\)/);
  assert.match(text, /hidden entries omitted/);
  assert.deepEqual(tool.output.presentationMeta(args, value), value);
  assert.equal(tool.presentCall(args).kind, 'read');
  assert.deepEqual(tool.presentCall(args).locations, [{ path: '.' }]);
  assert.equal(tool.isConcurrencySafe(args), true);
  const empty = fixture();
  assert.match(empty.tool.output.render({ path: '.' }, await empty.run())[0].text, /Empty directory/);
});

test('system prompt guidance appears only while the list tool is available', () => {
  const { section, ctx } = fixture();
  assert.equal(section.order, 11);
  assert.match(section.text({ scope: {} }), /Use the list tool/);
  ctx.tools.get = () => undefined;
  assert.equal(section.text({ scope: {} }), '');
});
