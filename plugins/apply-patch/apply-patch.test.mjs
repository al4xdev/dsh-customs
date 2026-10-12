import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePatch, applyChunks } from './parser.mjs';
import { apply as observe, observed, requireCoverage, rememberMutation, snapshot } from './observation.mjs';
import { patchCallView, patchMeta, patchResultView, undoResultView } from './presentation.mjs';

const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
const chunks = (...lines) => parsePatch(patch('*** Update File: draft.txt', ...lines))[0].chunks;

test('parser preserves literal content and supports add, delete, and bodyless move', () => {
  const operations = parsePatch(patch(
    '*** Add File: new.txt', '+  indented', '+',
    '*** Delete File: old.txt',
    '*** Update File: source.txt', '*** Move to: destination.txt',
  ).replaceAll('\n', '\r\n'));
  assert.deepEqual(operations, [
    { kind: 'add', path: 'new.txt', chunks: [], content: '  indented\n\n' },
    { kind: 'delete', path: 'old.txt', chunks: [] },
    { kind: 'update', path: 'source.txt', chunks: [], move: 'destination.txt' },
  ]);
  assert.equal(parsePatch(patch('*** Add File: empty.txt'))[0].content, '');
});

test('parser rejects wrappers, absent boundaries, empty updates, and missing line markers', () => {
  for (const input of [
    `cat <<EOF\n${patch('*** Add File: a', '+a')}\nEOF`,
    '*** Add File: a\n+a', patch(),
    patch('*** Update File: a'),
    patch('*** Add File: a', 'unmarked'),
    patch('*** Update File: a', '@@', 'unmarked'),
  ]) assert.throws(() => parsePatch(input));
});

test('context matches exactly, including indentation; coverage includes unchanged context', () => {
  const change = chunks('@@', ' heading', '-  old', '+  new', ' tail');
  assert.deepEqual(applyChunks('heading\n  old\ntail\n', change), {
    after: 'heading\n  new\ntail\n', covered: [0, 1, 2],
  });
  assert.throws(() => applyChunks('heading\n old\ntail\n', change), /unique exact context, found 0/);
});

test('ambiguous context is rejected instead of choosing the first match', () => {
  assert.throws(() => applyChunks('same\nsame\n', chunks('@@', '-same', '+new')), /found 2/);
});

test('anchors search strictly after the anchor and contribute to coverage', () => {
  assert.deepEqual(applyChunks('scope\nold\n', chunks('@@ scope', '-old', '+new')), {
    after: 'scope\nnew\n', covered: [0, 1],
  });
  assert.throws(() => applyChunks('scope\nold\n', chunks('@@ scope', ' scope', '-old', '+new')), /do not repeat the anchor/);
  assert.throws(() => applyChunks('old\n', chunks('@@ missing', '-old', '+new')), /Anchor not found/);
});

test('end-of-file marker selects only context at the file end', () => {
  assert.deepEqual(applyChunks('same\nmiddle\nsame\n', chunks('@@', '-same', '+last', '*** End of File')), {
    after: 'same\nmiddle\nlast\n', covered: [2],
  });
});

test('updates preserve final newline presence and support removing all content', () => {
  const replace = chunks('@@', '-old', '+new');
  assert.equal(applyChunks('old', replace).after, 'new');
  assert.equal(applyChunks('old\n', replace).after, 'new\n');
  assert.equal(applyChunks('old\n', chunks('@@', '-old')).after, '');
});

test('insert-only chunks append; independent edits retain their order', () => {
  assert.deepEqual(applyChunks('first', chunks('@@', '+second')), { after: 'first\nsecond', covered: [0] });
  assert.deepEqual(applyChunks('', chunks('@@', '+first')), { after: 'first\n', covered: [] });
  assert.equal(applyChunks('a\nmiddle\nb\n', chunks('@@', '-a', '+A', '@@', '-b', '+B')).after, 'A\nmiddle\nB\n');
});

function observationFixture() {
  const listeners = new Map();
  observe({ on(event, listener) { listeners.set(event, listener); } });
  const exec = { name: 'read', agent: { session: {} } };
  const target = { targetKey: '/fixture.txt', displayPath: '/fixture.txt' };
  const read = (version, lines, totalLines = 3, isError = false) => {
    listeners.get('fs/observed')(target, { kind: 'present', version }, exec);
    listeners.get('tools/result')(exec, { isError, value: { lines, totalLines } });
  };
  return { exec, target, read };
}

test('partial reads cover only shown lines; truncated lines do not count', () => {
  const { exec, target, read } = observationFixture();
  read('v1', [{ number: 1, text: 'first' }, { number: 2, text: '... (line truncated to 10 characters)' }]);
  assert.equal(requireCoverage(exec, target, [0]).version, 'v1');
  assert.throws(() => requireCoverage(exec, target, [1]), /observation is absent or insufficient/);
  assert.throws(() => requireCoverage(exec, target, [], true), /entire file/);
  read('v1', [{ number: 2, text: 'second' }, { number: 3, text: 'third' }]);
  assert.equal(requireCoverage(exec, target, [], true).full, true);
});

test('new versions reset line coverage; failed reads do not create observations', () => {
  const { exec, target, read } = observationFixture();
  read('v1', [{ number: 1, text: 'first' }]);
  read('v2', [{ number: 2, text: 'second' }]);
  assert.equal(observed(exec, target).version, 'v2');
  assert.throws(() => requireCoverage(exec, target, [0]), /observation is absent/);
  read('v3', [{ number: 3, text: 'third' }], 3, true);
  assert.equal(observed(exec, target).version, 'v2');
});

test('observations are session-local and snapshots keep pre-mutation versions', () => {
  const { exec, target } = observationFixture();
  rememberMutation(exec, target, 'v1', true);
  const captured = snapshot(exec);
  rememberMutation(exec, target, 'v2', false);
  assert.equal(captured.get(target.targetKey).version, 'v1');
  assert.equal(observed(exec, target).version, 'v2');
  assert.throws(() => requireCoverage(exec, target, [0]), /observation is absent/);
  assert.throws(() => requireCoverage({ agent: { session: {} } }, target, []), /observation is absent/);
});

const args = { patch: patch('*** Update File: a.txt', '@@', '-old', '+new') };
const resultOf = (receipt) => ({ content: [{ type: 'text', text: JSON.stringify(receipt) }] });

test('presentation distinguishes proposed and confirmed diffs without replacing receipt text', () => {
  const receipt = { status: 'applied', operations: [{ kind: 'update', path: 'a.txt', output: 'a.txt', state: 'changed' }] };
  const result = resultOf(receipt);
  const meta = patchMeta(args, result.content[0].text);
  assert.equal(patchCallView(args).card, 'diff');
  assert.equal(meta.receipt, result.content[0].text);
  assert.deepEqual(patchResultView(args, { ...result, meta }).diffs, [{ path: 'a.txt', oldText: 'old', newText: 'new' }]);
  assert.deepEqual(patchResultView(args, result).diffs, meta.diffs);
});

test('partial receipts display recovery guidance, never an applied diff card', () => {
  const receipt = { status: 'partial_failure', manifest: '/tmp/fixture/manifest.json', operations: [{ path: 'a.txt', state: 'partial' }], not_attempted: ['b.txt'] };
  const view = patchResultView(args, resultOf(receipt));
  assert.equal(view.card, 'generic');
  assert.match(view.title, /^Patch incomplete/);
  assert.match(view.content[0].text, /partial  a.txt/);
  assert.match(view.content[0].text, /not attempted  b.txt/);
  assert.match(view.content[0].text, /recovery manifest: \/tmp\/fixture\/manifest.json/);
});

test('invalid patch arguments and tool errors keep fallback presentation', () => {
  assert.equal(patchCallView({ patch: 'not a patch' }).card, 'generic');
  assert.equal(patchResultView(args, { isError: true }), undefined);
  assert.equal(patchResultView(args, { content: [{ type: 'text', text: 'not a receipt' }] }), undefined);
});

test('undo presentation distinguishes restored and pending operations', () => {
  const receipt = { status: 'partial_undo', manifest: '/tmp/fixture/manifest.json', operations: [
    { path: 'a.txt', state: 'changed', undo: { state: 'restored' } },
    { path: 'b.txt', state: 'changed', undo: { state: 'not_restored', error: 'newer work' } },
  ] };
  const view = undoResultView({}, resultOf(receipt));
  assert.match(view.title, /^Undo patch incomplete/);
  assert.match(view.content[0].text, /restored  a.txt/);
  assert.match(view.content[0].text, /not_restored  b.txt: newer work/);
  assert.match(view.content[0].text, /recovery manifest:/);
});
