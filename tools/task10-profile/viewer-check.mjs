/** Focused artifact UI regression with the real host renderer and real PlanStore.
 * Run from frontend/dsh-tui:
 *   node --import tsx/esm ../../tools/task10-profile/viewer-check.mjs
 * Only the keyboard/channel boundaries are controlled; no LLM or profile writes.
 */
process.env.FORCE_COLOR = '3';
process.env.DSH_TUI_LANG = 'en';
const base = '../../frontend/dsh-tui/';
const assert = (await import('node:assert/strict')).default;
const fs = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const React = await import(base + 'node_modules/react/index.js');
const { LegacyRoot } = await import(base + 'node_modules/react-reconciler/constants.js');
const kit = await import(base + 'src/ui.ts');
const { TerminalSizeContext } = await import(base + 'src/ink/components/TerminalSizeContext.tsx');
const { createNode } = await import(base + 'src/ink/dom.ts');
const { FocusManager } = await import(base + 'src/ink/focus.ts');
const { default: reconciler } = await import(base + 'src/ink/reconciler.ts');
const { default: Output } = await import(base + 'src/ink/output.ts');
const { default: paint, resetLayoutShifted } = await import(base + 'src/ink/render-node-to-output.ts');
const { createScreen, cellAt, StylePool, CharPool, HyperlinkPool } = await import(base + 'src/ink/screen.ts');
const { getMermaidEnginePromise } = await import(base + 'src/terminal-utils/mermaid.ts');
const { applyMermaidDiagrams } = await import(base + 'src/tuiDisplayPrefs.ts');
const { settled } = await import(base + 'scripts/lib/term-test.mjs');
const { PlanStore } = await import('../../plugins/managed-plans/store.mjs');
const { PlanArtifactsScene } = await import('../../plugins/managed-plans/tui.mjs');
applyMermaidDiagrams(true);
assert.ok(await getMermaidEnginePromise());
const source = '# Cursor test\n\n- First item\n- Second item\n\nBEFORE diagram.\n\n```mermaid\nflowchart TD\n A[Start] --> B[Read]\n B --> C[Check]\n C --> D[Finish]\n```\n\nAFTER diagram.\n\nTAIL final paragraph.\n';

for (const text of [source, 'first\r\nsecond\r\n', '[r]: https://one\n\n[r]: https://two\n\nA [link][r]\n', '# Repeat\n\nSame\n\nSame\n', '- One\n  - Nested\n- Two\n']) {
  for (const range of kit.markdownSourceBlocks(text)) assert.equal(range.quote, text.split('\n').slice(range.startLine - 1, range.endLine).join('\n'));
}
assert.deepEqual(kit.markdownSourceBlocks(source).filter(range => range.type === 'list').map(range => range.startLine), [3, 4]);

const workspace = fs.mkdtempSync(fileURLToPath(new URL('../../.dumps/task10-viewer-', import.meta.url)));
const store = new PlanStore(workspace);
await store.initialize();
const first = await store.stage({ title: 'Cursor test', plan: source, category: 'tasks', origin: { session_id: 'test-owner', call_id: 'r1' } });
await store.saveComment({ ...first, line_start: 3, line_end: 3, text: 'Previous comment', owner_session_id: 'test-owner' });
await store.decide({ ...first, decision: 'reject', owner_session_id: 'test-owner' });
await store.stage({ plan_id: first.plan_id, expected_revision: 1, title: 'Cursor test', plan: source, category: 'tasks', origin: { session_id: 'test-owner', call_id: 'r2' } });
let input;
let closed = false;
const channel = {
  async runExternalCommandOutcome(name, rawInput) {
    assert.equal(name, 'plan');
    assert.ok(rawInput.startsWith(' ui '), 'registry raw input must retain its leading separator');
    const p = JSON.parse(rawInput.slice(4));
    let data;
    if (p.action === 'list') data = await store.list();
    else if (p.action === 'read') data = await store.read(p.plan_id, { revision: p.revision });
    else if (p.action === 'history') data = await store.history(p.plan_id);
    else if (p.action === 'comment') data = await store.saveComment({ ...p, owner_session_id: 'test-owner' });
    else if (p.action === 'delete_comment') data = await store.deleteComment({ ...p, owner_session_id: 'test-owner' });
    else if (p.action === 'reopen') data = await store.reopen({ ...p, origin: { session_id: 'test-owner', call_id: p.request_id }, owner_session_id: 'test-owner' });
    else throw new Error(`Unexpected action ${p.action}`);
    return { kind: 'success', text: JSON.stringify({ ok: true, data }) };
  },
};
const root = createNode('ink-root');
root.focusManager = new FocusManager(() => false);
const error = error => { throw error; };
const container = reconciler.createContainer(root, LegacyRoot, null, false, null, 'task10-viewer-check', error, error, error, () => {});
const ui = { ...kit, useInput(handler) { React.useLayoutEffect(() => { input = handler; }); } };
let width = 120;
const rows = 24;
function render() {
  reconciler.updateContainerSync(React.createElement(TerminalSizeContext.Provider, { value: { columns: width, rows } }, React.createElement(PlanArtifactsScene, { React, ui, channel, close() { closed = true; } })), container, null, () => {});
  reconciler.flushSyncWork();
}
function frame() {
  reconciler.flushSyncWork();
  root.yogaNode.setWidth(width);
  root.yogaNode.calculateLayout(width);
  const stylePool = new StylePool();
  const screen = createScreen(width, rows, stylePool, new CharPool(), new HyperlinkPool());
  const output = new Output({ width, height: rows, stylePool, screen });
  resetLayoutShifted();
  paint(root, output, { prevScreen: undefined });
  return Array.from({ length: rows }, (_, row) => Array.from({ length: width }, (_, col) => cellAt(output.get(), col, row)?.char ?? '').join('').trimEnd()).join('\n');
}
async function expect(text) {
  assert.ok(await settled(() => frame().includes(text)), `Expected UI text: ${text}\n${frame()}`);
}
function key(text = '', flags = {}) { reconciler.flushSyncFromReconciler(() => input(text, flags)); reconciler.flushSyncWork(); }
function walk(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) { const found = walk(child, predicate); if (found) return found; }
}
try {
  render();
  await expect('STAGING');
  key('', { return: true });
  await expect('#1 r2');
  await expect('Revisions');
  assert.ok(!frame().includes('FOCO NA FONTE'));
  key('', { downArrow: true });
  await expect('L3–3');
  key('c');
  await expect('Add comment');
  key('Original comment');
  key('', { escape: true });
  await expect('Comment saved as a draft');
  key('c');
  await expect('Edit comment');
  key(' updated');
  key('', { escape: true });
  await expect('Comment saved as a draft');
  await expect('Current revision · staged');
  const current = await store.read(first.plan_id);
  assert.equal(current.comments.length, 1);
  assert.equal(current.comments[0].text, 'Original comment updated');
  key('d');
  await expect('Delete draft comment at L3–3?');
  key('n');
  await expect('Deletion cancelled.');
  assert.equal((await store.read(first.plan_id)).comments.length, 1);
  key('d');
  await expect('Delete draft comment at L3–3?');
  key('y');
  await expect('Draft comment deleted.');
  const deleted = await store.read(first.plan_id);
  assert.equal(deleted.comments.length, 0);
  assert.equal(deleted.deleted_comments.length, 1);
  assert.equal(deleted.deleted_comments[0].text, 'Original comment updated');
  key('c');
  await expect('Add comment');
  key('', { return: true });
  await expect('Enter text to save');
  key('x', { ctrl: true });
  await expect('Unsaved text discarded.');
  // Click the second list item's native source wrapper (the formatter has no alternate renderer).
  const target = walk(root, node => node._eventHandlers?.onClick && (() => {
    let content = '';
    const gather = n => { if (n.nodeValue) content += n.nodeValue; for (const c of n.childNodes ?? []) gather(c); };
    gather(node);
    return content.includes('Second') && !content.includes('First');
  })());
  if (!target) {
    const targets = [];
    const inspect = node => {
      if (node._eventHandlers?.onClick) targets.push({ name: node.nodeName, attributes: node.attributes, children: node.childNodes?.map(child => ({ name: child.nodeName, value: child.nodeValue, children: child.childNodes?.length })) });
      for (const child of node.childNodes ?? []) inspect(child);
    };
    inspect(root);
    console.log(JSON.stringify({ targets, children: root.childNodes.length, first: root.childNodes[0]?.nodeName, frame: frame() }));
  }
  assert.ok(target, 'second list item has a native click target');
  target._eventHandlers.onClick({});
  await expect('L4–4');
  key('', { end: true });
  await expect('TAIL final paragraph');
  assert.ok(frame().includes('Esc list'), 'fixed footer remains visible');
  key('', { leftArrow: true });
  key('', { downArrow: true });
  key('', { return: true });
  await expect('#1 r1');
  await expect('Historical revision');
  key('c');
  await expect('Read-only revision');
  key('O');
  await expect('Open the current revision before reopening');
  assert.equal((await store.read(first.plan_id, { revision: 1 })).comments[0].text, 'Previous comment');
  width = 50;
  render();
  key('', { leftArrow: true });
  await expect('Revisions');
  key('', { rightArrow: true });
  await expect('Historical revision');
  key('', { escape: true });
  await expect('STAGING');
  key('O');
  await expect('already awaiting owner review');
  assert.equal((await store.history(first.plan_id)).length, 2);
  const pending = await store.read(first.plan_id);
  await store.decide({ ...pending, decision: 'approve', owner_session_id: 'test-owner' });
  await store.close({ plan_id: first.plan_id, expected_revision: 2, outcome: 'completed', reason: 'UI regression step.', evidence: 'Owner test fixture.' });
  key('r');
  await expect('closed ·');
  key('O');
  await expect('#1 r3');
  await expect('New approval required');
  const reopened = await store.read(first.plan_id);
  assert.equal(reopened.execution_authorized, false);
  assert.equal(reopened.pending_review, true);
  assert.equal(reopened.content, source);
  assert.equal((await store.read(first.plan_id, { revision: 2 })).closure.outcome, 'completed');
  key('', { escape: true });
  await expect('STAGING');
  key('', { escape: true });
  assert.equal(closed, true);
  console.log('PASS: real rendered viewer, mouse/setas, Esc-save, edit/delete with confirmation and audit, empty-text guard, history, O reopen without authorization, historical guards and narrow viewport.');
  console.log(`Test workspace: ${workspace}`);
} finally {
  reconciler.updateContainerSync(null, container, null, () => {});
  reconciler.flushSyncWork();
  store.dispose();
}
