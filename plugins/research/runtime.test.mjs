import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHost } from '../common.mjs';
import * as Research from './index.mjs';
import { DEFAULT_POLICY } from './engine.mjs';
const { Context } = await import(resolveHost('@deepseek-ai/cordis'));
const { ToolRuntime } = await import(resolveHost('@deepseek-ai/dsh-tools'));
const WebTool = await import(resolveHost('@deepseek-ai/dsh-tool-web'));

test('real registry exposes research and fetch, not standard search; backend survives', async () => {
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 1; } });
  ctx.provide('sandboxPolicy', { resolve() { return { mode: 'read-only', workspaceRoot: '/fixture' }; } });
  ctx.provide('web', { search: async () => ({ sources: [], truncated: false }), fetch: async () => { throw new Error('unused'); } });
  const tools = ctx.plugin(ToolRuntime);
  await tools.await();
  const native = ctx.plugin(WebTool, { search: false, fetch: true });
  await native.await();
  const research = ctx.plugin(Research, DEFAULT_POLICY);
  await research.await();
  try {
    assert.ok(ctx.tools.get('research'));
    assert.equal(ctx.tools.get('research').isConcurrencySafe({ action: 'search' }), true);
    assert.ok(ctx.tools.get('web_fetch'));
    assert.equal(ctx.tools.get('web_search'), undefined);
    assert.equal(typeof ctx.web.search, 'function');
    await assert.rejects(ctx.tools.get('research').execute({ action: 'config' }, { agent: { session: { id: 'fixture', header: { cwd: '/fixture' } } } }), /requires workspace-write/);
    const names = ctx.tools.schemas().map(x => x.name);
    assert.equal(names.filter(n => n === 'research').length, 1);
    assert.ok(!names.includes('web_search'));
  } finally { await research.dispose(); await native.dispose(); await tools.dispose(); }
});
