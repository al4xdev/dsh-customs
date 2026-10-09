/** Native rendered tool-card regression, source-only and without model calls.
 * Run from frontend/dsh-tui:
 *   node --import tsx/esm ../../tools/task10-profile/presentation-check.mjs
 */
process.env.FORCE_COLOR = '3';
process.env.DSH_TUI_LANG = 'en';
const base = '../../frontend/dsh-tui/';
const assert = (await import('node:assert/strict')).default;
const React = await import(base + 'node_modules/react/index.js');
const { renderToScreen } = await import(base + 'src/ink/render-to-screen.ts');
const { cellAt } = await import(base + 'src/ink/screen.ts');
const { TerminalSizeContext } = await import(base + 'src/ink/components/TerminalSizeContext.tsx');
const { AssistantToolUseMessage } = await import(base + 'src/components/messages/AssistantToolUseMessage.tsx');
const { managedPlanResultView } = await import('../../plugins/managed-plans/presentation.mjs');
const data = {
  plan_id: 4, revision: 2, current_revision: 2, hash: 'a'.repeat(64), title: 'Readability test', category: 'tasks', status: 'staged',
  path: 'staging/4-readability.r2.md', pending_review: true, execution_authorized: false,
  content: '# Display heading\n\nA **bold** result, not JSON.\n', offset: 1, line_start: 1, line_end: 5, total_lines: 5,
  comments: [], decisions: [], closure: null,
};
const raw = JSON.stringify(data);
const resultView = managedPlanResultView('plan_read', {}, { content: [{ type: 'text', text: raw }] });
const tool = { callId: 'test-plan', name: 'plan_read', argsText: '', status: 'ok', durationMs: 1, resultFull: raw, resultView };
function screen(tool, props = {}) {
  const rendered = renderToScreen(React.createElement(TerminalSizeContext.Provider, { value: { columns: 140, rows: 80 } },
    React.createElement(AssistantToolUseMessage, { tool, marginTopOnTurn: false, verbose: true, ...props })), 140);
  return Array.from({ length: rendered.height }, (_, row) => Array.from({ length: 140 }, (_, col) => cellAt(rendered.screen, col, row)?.char ?? '').join('').trimEnd()).join('\n');
}
const expanded = screen(tool);
assert.ok(expanded.includes('Display heading'));
assert.ok(expanded.includes('A bold result, not JSON.'));
assert.ok(!expanded.includes('# Display heading'), 'expanded managed-plan source is rendered Markdown');
assert.ok(!expanded.includes('**bold**'));
assert.ok(!expanded.includes('"plan_id"'));
assert.ok(expanded.includes('Execution authorized: No'));
const compact = screen(tool, { verbose: false });
assert.ok(compact.includes('Execution authorized: No'), 'compact card retains authorization');
const ordinary = screen({ ...tool, name: 'other_tool' });
assert.ok(ordinary.includes('**bold**'), 'ordinary generic cards retain their original renderer');
const failure = screen({ ...tool, status: 'error', errorText: 'Explicit failure message' });
assert.ok(failure.includes('Explicit failure message'));
assert.ok(!failure.includes('Display heading'));
console.log('PASS: readable compact authorization, rendered expanded plan Markdown, raw machine JSON retained, ordinary/error tool cards unchanged.');
