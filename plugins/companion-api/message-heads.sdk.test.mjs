import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveHost } from '../common.mjs';
import { createMessageHeads } from './message-heads.mjs';
import { apply } from './index.mjs';
const [{ Context }, sessions, persistence, query, llm, { default: Registry }, { default: Gateway }] = await Promise.all([
  import(resolveHost('@deepseek-ai/cordis')), import(resolveHost('@deepseek-ai/dsh-session')),
  import(resolveHost('@deepseek-ai/dsh-session-persistence-jsonl')), import(resolveHost('@deepseek-ai/dsh-session-query')),
  import(resolveHost('@deepseek-ai/dsh-llm')), import(resolveHost('@deepseek-ai/dsh-typert-registry')), import(resolveHost('@deepseek-ai/dsh-api-gateway')),
]);
const text = value => ({ type: 'text', text: value });
function assistant(seq, content = [text('synthetic private reply')], interrupted) {
  return { seq, time: seq + 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1,
    message: llm.createAssistantMessage({ content, source: { provider: 'synthetic', model: 'synthetic' } }), stream: [],
    ...(interrupted ? { interrupted: true } : {}) } };
}
function user(seq, source = { kind: 'user' }, extra = {}) {
  return { seq, time: seq + 1, type: 'user/message', surfaceOp: 'append', data: llm.createUserMessage({ content: [text('synthetic private input')], source }), ...extra };
}
function addTurn(events, turn, payloads, reason = { kind: 'completed' }) {
  const append = event => { const seq = events.length; events.push({ ...event, seq, time: seq + 1 }); };
  append({ type: 'turn/start', data: { turn } }); append({ type: 'step/start', data: { turn, step: 1 } });
  for (const payload of payloads) append({ ...payload, data: 'turn' in payload.data ? { ...payload.data, turn, step: 1 } : payload.data });
  append({ type: 'step/end', data: { turn, step: 1 } }); append({ type: 'turn/end', data: { turn, reason } });
}
async function host(t, compression = 'none') {
  const scratch = resolve(import.meta.dirname, '../../.dumps/tasks');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(resolve(scratch, 'task113-fixtures-sdk-'));
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(sessions.default);
  await ctx.plugin(persistence.default, { root, compression });
  await ctx.plugin(query.default);
  return { root, ctx };
}
async function store(ctx, id, events, createdAt = 7) {
  const header = { version: 4, id: sessions.SessionId(id), createdAt, isSeeded: false, cwd: '/synthetic-private', agentPreset: 'companion' };
  const writer = await ctx.sessionPersistence.create(header);
  try { await writer.append(events); await writer.flush(); } finally { await writer.close(); }
  return header;
}
function apiFor(ctx) {
  let observations = 0;
  const actual = ctx.get('sessionQuery');
  const publicQuery = { observeSession(...args) { observations++; return actual.observeSession(...args); } };
  const api = createMessageHeads({ sessionPersistence: ctx.sessionPersistence,
    get: key => key === 'sessionQuery' ? publicQuery : ctx.get(key) });
  return { api, observations: () => observations, read: sessionIds => api.read({ sessionIds }) };
}

test('installed public SDK cold fixture exposes sizeBytes not eventCount and prepares without making a Session live', async t => {
  const { ctx } = await host(t);
  const events = []; addTurn(events, 1, [user(0, { kind: 'goal', goalId: 'synthetic-goal', revision: 1, round: 1 }), assistant(1)]);
  const header = await store(ctx, 'synthetic-cold', events);
  const before = await ctx.sessionPersistence.stat(header.id);
  assert.equal(Number.isSafeInteger(before.sizeBytes), true); assert.equal(before.eventCount, undefined);
  assert.equal(header.origin, undefined); assert.equal(header.parentSession, undefined); assert.equal(header.delegationDepth, undefined);
  assert.equal(ctx.sessions.get(header.id), undefined); assert.equal(ctx.get('agents'), undefined);
  const observation = await ctx.sessionQuery.observeSession(header.id, { projectionMode: 'none' });
  try {
    assert.equal(observation.source, 'prepared'); assert.equal(observation.inheritedEventCount, 0);
    assert.equal(observation.header.agentPreset, 'companion'); assert.equal(observation.cursor, events.length - 1);
    assert.equal(query.buildSessionEventRecords(header.id, observation.events)[3].surface, 'current');
  } finally { observation[Symbol.dispose](); }
  assert.equal(ctx.sessions.get(header.id), undefined); assert.equal(ctx.get('agents'), undefined);
  const f = apiFor(ctx); const output = await f.read([header.id]);
  assert.equal(output.heads[0].knowledge, 'current'); assert.equal(output.heads[0].lastVisibleAssistant.messageId, events[3].data.message.id);
  const count = f.observations(); await f.read([header.id]); assert.equal(f.observations(), count);
  assert.equal(ctx.sessions.get(header.id), undefined); assert.equal(ctx.get('agents'), undefined);
  assert.deepEqual(await ctx.sessionPersistence.stat(header.id), before);
});

test('installed SDK fixture surface replacement, tool-only, attempt and interrupted text retain only positive current text metadata', async t => {
  const { ctx } = await host(t);
  const events = []; addTurn(events, 1, [assistant(0)]);
  const callId = llm.ToolCallId('synthetic-call');
  addTurn(events, 2, [user(0, { kind: 'synthetic-compaction' },
    { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] }),
    assistant(0, [{ type: 'tool-call', id: callId, name: 'synthetic-tool', arguments: '{}' }]),
    { type: 'tool/call', data: { turn: 2, step: 1, callId, name: 'synthetic-tool', arguments: '{}' } },
    { type: 'tool/result', surfaceOp: 'append', data: { turn: 2, step: 1,
      message: llm.createToolResultMessage({ callId, content: [text('synthetic private tool result')], isError: false }) } }]);
  addTurn(events, 3, [assistant(0, [{ type: 'reasoning', text: 'synthetic private reasoning' }])]);
  addTurn(events, 4, [{ type: 'assistant/attempt', data: { turn: 4, step: 1, stream: [] } }]);
  addTurn(events, 5, [assistant(0, [text('synthetic private partial')], true)], { kind: 'aborted', reason: { kind: 'user' } });
  const header = await store(ctx, 'synthetic-fold', events);
  const f = apiFor(ctx); const output = await f.read([header.id]);
  assert.equal(output.heads[0].knowledge, 'current');
  const partial = events.find(event => event.data.interrupted === true);
  assert.deepEqual(output.heads[0].lastVisibleAssistant, { seq: partial.seq, messageId: partial.data.message.id, time: partial.time, interrupted: true });
  assert.equal(JSON.stringify(output).includes('synthetic private'), false);
  assert.equal(ctx.sessions.get(header.id), undefined);
});

test('installed SDK live fixture is queried lazily and cache invalidates after a new settled response without Agent services', async t => {
  const { ctx } = await host(t);
  const live = ctx.sessions.create(sessions.SessionId('synthetic-live'), { meta: { createdAt: 7, cwd: '/synthetic-private', agentPreset: 'companion' } });
  const writer = await ctx.sessionPersistence.create(live.header); t.after(() => writer.close());
  const f = apiFor(ctx);
  assert.equal((await f.read([live.id])).heads[0].lastVisibleAssistant, null);
  const message = llm.createAssistantMessage({ content: [text('synthetic private live')], source: { provider: 'synthetic', model: 'synthetic' } });
  live.append('assistant/message', { turn: 1, step: 1, message, stream: [] }, { surfaceOp: 'append' });
  const output = await f.read([live.id]);
  assert.equal(output.heads[0].knowledge, 'current'); assert.equal(output.heads[0].lastVisibleAssistant.messageId, message.id);
  assert.equal(output.heads[0].asOfSeq, 0); assert.equal(ctx.get('agents'), undefined);
});

test('installed SDK compressed cold root remains unknown before any public body observation', async t => {
  const { ctx } = await host(t, 'zstd');
  const events = []; addTurn(events, 1, [assistant(0)]);
  const header = await store(ctx, 'synthetic-compressed', events);
  const snapshot = await ctx.sessionPersistence.stat(header.id);
  assert.equal(Number.isSafeInteger(snapshot.sizeBytes), true);
  const f = apiFor(ctx); const output = await f.read([header.id]);
  assert.equal(output.heads[0].knowledge, 'unknown'); assert.equal(output.heads[0].lastVisibleAssistant, null);
  assert.equal(f.observations(), 0); assert.equal(ctx.sessions.get(header.id), undefined); assert.equal(ctx.get('agents'), undefined);
});

test('real Cordis Gateway adds strict optional messageHeads without gating previous APIs and rechecks profile', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Registry); await ctx.plugin(Gateway);
  await ctx.plugin(sessions.default);
  ctx.provide('profileContext', { name: 'companion', dir: '/synthetic/companion-profile' });
  const headers = new Map([['synthetic-chat', { header: { version: 4, id: 'synthetic-chat', createdAt: 7, isSeeded: false, agentPreset: 'companion' }, revision: 'v1' }]]);
  ctx.provide('sessionPersistence', { list: async () => [...headers.values()], stat: async id => headers.get(id) });
  let owner;
  await ctx.plugin({ name: 'synthetic-message-head-owner', inject: ['typert', 'sessionPersistence'], apply: async scoped => { owner = scoped; await apply(scoped); } });
  const invoke = (request, extra = {}) => ctx.typertGateway.invoke({ namespace: 'companion', method: 'messageHeads', args: { request, ...extra }, signal: new AbortController().signal });
  assert.deepEqual(await invoke({ sessionIds: [] }), { version: 1, profile: 'companion', heads: [] });
  assert.equal((await invoke({ sessionIds: ['synthetic-chat'] })).heads[0].knowledge, 'unknown');
  await assert.rejects(invoke({ sessionIds: ['synthetic-chat'], body: 'synthetic private' }), error => error.code === 'gateway/input-invalid');
  await assert.rejects(invoke({ sessionIds: [] }, { root: '/synthetic-private' }), error => error.code === 'gateway/arguments-invalid');
  assert.equal(ctx.get('agents'), undefined); assert.equal(ctx.get('llm'), undefined);
  ctx.get('profileContext').name = 'ordinary';
  await assert.rejects(invoke({ sessionIds: [] }), error => error.code === 'companion/profile-mismatch');
  ctx.get('profileContext').name = 'companion';
  await owner.fiber.dispose();
  await assert.rejects(invoke({ sessionIds: [] }), error => error.code === 'gateway/definition-unavailable');
});
