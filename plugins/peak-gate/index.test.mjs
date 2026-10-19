// Wiring tests: these load the real host LlmError, so they need a DSH install
// (same constraint as plugins/codex-transient-close and llm-resilience tests).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyWithClock, name, inject } from './index.mjs';

const UTC = (...parts) => Date.UTC(...parts);
const PEAK = UTC(2026, 9, 20, 2, 0); // Tue 02:00 UTC
const OPEN = UTC(2026, 9, 20, 4, 30); // Tue 04:30 UTC

function harness(clockValue) {
  const listeners = [];
  const logs = [];
  let read = typeof clockValue === 'function' ? clockValue : () => clockValue;
  const ctx = {
    on(event, handler) {
      assert.equal(event, 'llm/stream');
      listeners.push(handler);
      return () => {};
    },
    logger: { info: (line) => logs.push(line) },
  };
  return {
    ctx,
    logs,
    clock: () => read(),
    setClock: (next) => { read = typeof next === 'function' ? next : () => next; },
    listener: () => listeners[0],
  };
}

function upstream(chunks = [{ type: 'text-delta', text: 'ok' }]) {
  const state = { calls: 0 };
  const next = () => (async function* () {
    state.calls += 1;
    for (const chunk of chunks) yield chunk;
  })();
  return { next, state };
}

test('registers exactly one llm/stream waterfall and nothing else', () => {
  const { ctx, listener } = harness(OPEN);
  applyWithClock(ctx, { timeZone: 'America/Sao_Paulo' }, harness(OPEN).clock);
  assert.equal(typeof listener(), 'function');
  assert.equal(name, 'alex-peak-gate');
  assert.deepEqual(inject, ['llm']);
});

test('an ungated provider is dispatched synchronously and untouched', async () => {
  const h = harness(PEAK);
  applyWithClock(h.ctx, { timeZone: 'America/Sao_Paulo' }, h.clock);
  const stream = h.listener()({ provider: 'openai-codex' }, upstream().next);
  assert.equal(typeof stream[Symbol.asyncIterator], 'function');
});

test('a gated request yields nothing until the window closes', async () => {
  let now = PEAK;
  const h = harness(() => now);
  applyWithClock(h.ctx, { timeZone: 'America/Sao_Paulo', waitSliceMs: 1 }, h.clock);
  const { next, state } = upstream();
  const handler = h.listener();

  const held = handler({ provider: 'deepseek-official', signal: undefined }, next);
  // The generator body has not run yet: nothing was dispatched, nothing yielded.
  assert.equal(state.calls, 0);
  const iterator = held[Symbol.asyncIterator]();
  const first = iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(state.calls, 0, 'upstream must stay untouched while the gate is closed');

  now = UTC(2026, 9, 20, 4, 10); // the resume instant
  const chunk = await first;
  assert.deepEqual(chunk, { done: false, value: { type: 'text-delta', text: 'ok' } });
  assert.equal(state.calls, 1);
  assert.ok(h.logs.some((line) => line.includes('held until 01:10 America/Sao_Paulo')));
  assert.ok(h.logs.some((line) => line.includes('released deepseek-official')));
});

test('refuse mode fails fast with a named PEAK_HOURS error', () => {
  const h = harness(PEAK);
  applyWithClock(h.ctx, { timeZone: 'America/Sao_Paulo', mode: 'refuse' }, h.clock);
  const { next, state } = upstream();
  assert.throws(() => h.listener()({ provider: 'deepseek-official' }, next), (error) => {
    assert.equal(error.code, 'PEAK_HOURS');
    assert.match(error.message, /off-peak in 2h10m \(01:10 America\/Sao_Paulo\)/);
    assert.match(error.message, /Set mode: wait/);
    return true;
  });
  assert.equal(state.calls, 0);
});

test('a wait longer than maxWaitMs refuses instead of holding for hours', () => {
  const h = harness(PEAK);
  applyWithClock(h.ctx, { timeZone: 'America/Sao_Paulo', maxWaitMs: 60_000 }, h.clock);
  assert.throws(() => h.listener()({ provider: 'deepseek-official' }, upstream().next), (error) => error.code === 'PEAK_HOURS');
});

test('DSH_PEAK_GATE=off bypasses the gate entirely', () => {
  const h = harness(PEAK);
  applyWithClock(h.ctx, { timeZone: 'America/Sao_Paulo' }, h.clock);
  const { next, state } = upstream();
  const restore = process.env.DSH_PEAK_GATE;
  process.env.DSH_PEAK_GATE = 'off';
  try {
    const stream = h.listener()({ provider: 'deepseek-official' }, next);
    assert.equal(typeof stream[Symbol.asyncIterator], 'function');
  } finally {
    if (restore === undefined) delete process.env.DSH_PEAK_GATE;
    else process.env.DSH_PEAK_GATE = restore;
  }
});
