import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryAccountingProjection as projection, recoveryBudget } from './recovery-accounting.mjs';
import { llmRetryProjection } from './main-driver.mjs';
import { policyKey } from './policy.mjs';
import { INITIAL_STATE, foldState, healthyStepProof, recoveredState, manualResumeState } from '../agent-self-heal/logic.mjs';
const policy = { mode: 'normal', maxRetries: 10, initialDelayMs: 7031.25, maxDelayMs: 3600000, jitterRatio: 0, retryableCodes: ['SERVER', 'TRANSPORT', 'PI_AI_ERROR'] };
const old = maxRetries => ({ ...policy, maxRetries, initialDelayMs: 5000, maxDelayMs: 1200000, jitterRatio: .1 });
function fixture() {
  let seq = 0, accounting = projection.init(), ledger = {}, owner = { ...INITIAL_STATE };
  const events = [];
  return { events, get history() { return accounting; }, get owner() { return owner; }, get ledger() { return ledger; },
    append(type, data, options = {}) { const e = { seq: ++seq, type, data, ...options }; events.push(e);
      accounting = projection.apply(accounting, e); ledger = llmRetryProjection.apply(ledger, e); owner = foldState(owner, e); return e; },
    start(turn, step = 1) { return this.append('step/start', { turn, step }); },
    retry(retry, { turn = 1, step = 1, provider = 'p', retryId = 'legacy', captured = old(9) } = {}) {
      return this.append('llm/retry', { turn, step, provider, retryId, policyKey: policyKey(captured), retry }); },
    budget() { return recoveryBudget(owner, accounting, ledger, policy, 'p'); },
    audit(action, state, progress, recoveryOwnership) { return this.append('agent/self-heal', { version: 1, action,
      turn: progress?.turn ?? state.chain?.turn ?? 1, step: progress?.step ?? state.chain?.step ?? 1,
      causalSeq: progress?.claimSeq ?? progress?.stepEndSeq ?? state.chain?.attemptSeq,
      state, ...(progress ? { progress } : {}), ...(recoveryOwnership ? { recoveryOwnership } : {}) }); },
  };
}
function healthy(f, turn = 2) {
  f.start(turn);
  f.append('assistant/message', { turn, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'verified progress' }] },
    stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }] }, { surfaceOp: 'append' });
  f.append('step/end', { turn, step: 1 });
}
function unified() {
  const f = fixture(); f.start(1); f.retry(1);
  const priorAttempt = f.append('assistant/attempt', { turn: 1, step: 1 });
  f.audit('reserved', { lastHealthyTurn: 0, seen: { attemptSeq: priorAttempt.seq, emptyCount: 0 },
    chain: { turn: 1, step: 1, cycle: 1, maxCycles: 3, status: 'reserved', attemptSeq: priorAttempt.seq } });
  const attempt = f.append('assistant/attempt', { turn: 1, step: 1 });
  const chain = { ...f.owner.chain, cycle: 3, attemptSeq: attempt.seq };
  const ownership = { version: 1, kind: 'unified-agent-warning', origin: { turn: 1, step: 1 }, provider: 'p', retryId: 'unified',
    policyKey: policyKey({ ...policy, maxRetries: 3 }), retry: 3, legacyNativeConsumed: 1, legacySemanticConsumed: 1, importedConsumed: 2 };
  f.audit('reserved', { ...f.owner, chain, seen: { attemptSeq: attempt.seq, emptyCount: 0 } }, undefined, ownership);
  return { f, ownership };
}
test('history v2 rebuilds old checkpoint instead of accepting its empty v1 budget', () => {
  assert.equal(projection.stateVersion, 2); assert.throws(() => projection.stateSchema.parse({ mirrors: [] }));
  const f = fixture(); assert.equal(f.budget().consumed, 0);
});
test('nine legacy cumulative ordinals are nine, survive error finally/end and cold replay', () => {
  const f = fixture(); f.start(1);
  for (let retry = 1; retry <= 9; retry++) f.retry(retry);
  f.append('assistant/attempt', { turn: 1, step: 1 }); f.append('step/end', { turn: 1, step: 1 });
  f.append('turn/end', { turn: 1, reason: { kind: 'error' } }); f.start(2);
  assert.deepEqual(f.ledger, {}); assert.equal(f.budget().consumed, 9); assert.equal(f.budget().cap, 9);
  const restored = JSON.parse(JSON.stringify(f.events)).reduce(projection.apply, projection.init());
  assert.equal(recoveryBudget(f.owner, restored, {}, policy, 'p').consumed, 9);
});
test('partial spending pins old7 across route, failed turns and current UI merge without double count', () => {
  const f = fixture(); f.start(1); f.retry(3, { captured: old(7) });
  assert.equal(f.budget().consumed, 3); assert.equal(f.budget().cap, 7);
  f.append('turn/end', { turn: 1, reason: { kind: 'error' } }); f.start(2);
  f.retry(2, { turn: 2, provider: 'q', retryId: 'other', captured: old(9) });
  assert.equal(f.budget().consumed, 5); assert.equal(f.budget().cap, 7);
  assert.equal(f.budget().policy.initialDelayMs, 5000);
});
test('legacy all routes plus semantic spend is disjoint and imported once', () => {
  const f = fixture(); f.start(1); f.retry(1); f.retry(2, { provider: 'q', retryId: 'other' });
  const b = recoveryBudget({ chain: { cycle: 1, maxCycles: 3 } }, f.history, f.ledger, policy, 'p');
  assert.equal(b.consumed, 4); assert.equal(b.importedConsumed, 4); assert.equal(b.cap, 3);
});
test('owner mirror requires exact reservation, policy, id, current scope AND ordinal', () => {
  const { f, ownership } = unified(); assert.equal(f.history.unsafe, false);
  f.retry(3, { retryId: ownership.retryId, captured: { ...policy, maxRetries: 3 } });
  assert.equal(f.history.legacyConsumed, 1); assert.equal(f.budget().consumed, 3);
  f.start(2); assert.equal(f.budget().consumed, 3);
  f.retry(3, { turn: 2, retryId: ownership.retryId, captured: { ...policy, maxRetries: 3 } });
  assert.equal(f.history.legacyConsumed, 4); assert.throws(() => f.budget(), /provenance/);
});
test('unmarked ordinal after an owner reservation is not silently excluded as its mirror', () => {
  const { f, ownership } = unified(); f.retry(4, { retryId: ownership.retryId, captured: { ...policy, maxRetries: 3 } });
  assert(f.history.legacyConsumed > 1); assert.throws(() => f.budget());
});
for (const reason of ['completed', 'error', 'aborted', 'max-tokens']) test(`bare ${reason} end/new turn/nonhuman warning cannot reset historical floor`, () => {
  const f = fixture(); f.start(1); f.retry(9); f.append('assistant/attempt', { turn: 1, step: 1 }); f.append('step/end', { turn: 1, step: 1 });
  f.append('turn/end', { turn: 1, reason: { kind: reason } }); f.start(2);
  f.append('user/message', { role: 'user', source: { kind: 'self-heal-observation' }, content: [{ type: 'text', text: 'continue automatically' }] });
  assert.equal(f.budget().consumed, 9);
});
test('strict successful nonempty native step + completed turn can close old technical-only history', () => {
  const f = fixture(); f.start(1); f.retry(9); f.append('turn/end', { turn: 1, reason: { kind: 'error' } });
  healthy(f); assert.equal(f.budget().consumed, 9);
  f.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  assert.equal(f.budget().consumed, 0); assert.equal(f.budget().cap, 10);
});
test('unified chain requires its accepted healthy receipt, not merely a completed label', () => {
  const { f } = unified(); healthy(f);
  f.append('turn/end', { turn: 2, reason: { kind: 'completed' } }); assert.equal(f.budget().consumed, 3);
  const proof = healthyStepProof(f.owner); f.audit('recovered', recoveredState(f.owner), proof);
  assert.equal(f.budget().consumed, 0);
});
test('cold human labels/forged receipt cannot reset floor; corroborated receipt does', () => {
  const f = fixture(); f.start(1); f.retry(9); f.append('turn/end', { turn: 1, reason: { kind: 'error' } });
  const inserted = f.append('agent/inbox/spliced', { target: 'next-turn', inserted: [{ role: 'user', source: { kind: 'user' } }] });
  const claim = f.append('agent/inbox/spliced', { target: 'next-turn', inserted: [], removedCount: 1 });
  const start = f.start(2);
  assert.equal(f.budget().consumed, 9);
  const proof = { kind: 'human-resume', authority: 'live-root-inbox', turn: 2, step: 1, inboxSeq: inserted.seq, claimSeq: claim.seq, stepStartSeq: start.seq };
  f.audit('manual-resumed', { ...f.owner }, { ...proof, inboxSeq: 999 }); assert.equal(f.budget().consumed, 9);
  f.audit('manual-resumed', manualResumeState(f.owner, proof), proof); assert.equal(f.budget().consumed, 0);
});
test('unknown/unbounded policy fails closed across turns, but valid later progress is not permanently tainted', () => {
  const f = fixture(); f.start(1); f.append('llm/retry', { turn: 1, step: 1, provider: 'p', retryId: 'bad', retry: 9, policyKey: '["normal",null,[],5000,1200000,0]' });
  f.append('turn/end', { turn: 1, reason: { kind: 'error' } }); f.start(2); assert.throws(() => f.budget(), /Unsafe/);
  healthy(f, 3); f.append('turn/end', { turn: 3, reason: { kind: 'completed' } }); assert.equal(f.budget().consumed, 0);
});
test('malformed ledger and unknown ownership do not manufacture an empty budget', () => {
  for (const ledger of [null, { malformed: { retry: 1, retryId: 'x' } }]) assert.throws(() => recoveryBudget({}, projection.init(), ledger, policy, 'p'));
  const { f, ownership } = unified();
  f.audit('reserved', f.owner, undefined, { ...ownership, version: 2 }); assert.equal(f.history.unsafe, true); assert.throws(() => f.budget());
});
test('lower current cap never decreases already spent unified cycle count', () => {
  const { f } = unified(); const b = recoveryBudget(f.owner, f.history, f.ledger, { ...policy, maxRetries: 1 }, 'p');
  assert.equal(b.consumed, 3); assert.equal(b.cap, 1);
});
