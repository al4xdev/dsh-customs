import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveHost } from '../common.mjs';
import { createTitleHints } from './title-hints.mjs';
const [{ Context }, sessions, persistence, query] = await Promise.all([
  import(resolveHost('@deepseek-ai/cordis')), import(resolveHost('@deepseek-ai/dsh-session')),
  import(resolveHost('@deepseek-ai/dsh-session-persistence-jsonl')), import(resolveHost('@deepseek-ai/dsh-session-query')),
]);

async function host(t) {
  const scratch = resolve(import.meta.dirname, '../../.dumps/tasks');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(resolve(scratch, 'title-hints-sdk-'));
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(sessions.default);
  await ctx.plugin(persistence.default, { root, compression: 'none' });
  await ctx.plugin(query.default);
  return ctx;
}

async function store(ctx, id, events, createdAt = 7) {
  const header = { version: 4, id: sessions.SessionId(id), createdAt, isSeeded: false, cwd: '/synthetic-private', agentPreset: 'companion' };
  const writer = await ctx.sessionPersistence.create(header);
  try { await writer.append(events.map((event, seq) => ({ ...event, seq, time: createdAt + seq + 1 }))); await writer.flush(); } finally { await writer.close(); }
  return header;
}

const titleEvent = title => ({ type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'user' } } });
const hintsFor = ctx => createTitleHints({ get: key => key === 'sessionQuery' ? ctx.get('sessionQuery') : undefined });

test('the installed public SDK folds the durable log title into an optional hint', async t => {
  const ctx = await host(t);
  const header = await store(ctx, 'synthetic-title', [titleEvent('Nome durável')]);
  const titles = hintsFor(ctx); t.after(() => titles.close());
  assert.equal((await titles.read([{ id: header.id, createdAt: 7 }])).get(header.id), 'Nome durável');
  // Nothing was opened, followed or promoted: the fold stays read-only.
  assert.equal(ctx.sessions.get(header.id), undefined);
});

test('a session without a title event yields no hint and no error', async t => {
  const ctx = await host(t);
  const header = await store(ctx, 'synthetic-no-title', [{ type: 'approval/asked', data: { callId: 'synthetic', tool: 'bash', reason: 'synthetic' } }]);
  const titles = hintsFor(ctx); t.after(() => titles.close());
  assert.equal((await titles.read([{ id: header.id, createdAt: 7 }])).size, 0);
});

test('a title for a different incarnation is not published', async t => {
  const ctx = await host(t);
  const header = await store(ctx, 'synthetic-incarnation', [titleEvent('Nome antigo')]);
  const titles = hintsFor(ctx); t.after(() => titles.close());
  assert.equal((await titles.read([{ id: header.id, createdAt: 99 }])).size, 0);
});
