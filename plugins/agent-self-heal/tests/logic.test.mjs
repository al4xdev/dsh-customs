import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, decide, foldState, transition, INITIAL_STATE, AUDIT_EVENT, chainKey, healthyStepProof, recoveredState, manualResumeState, MAX_HUMAN_GRANTS, MAX_CHAIN_WARNINGS, shouldWarn, warned } from '../logic.mjs';
import { UNBOUNDED_RETRIES } from '../../llm-resilience/policy.mjs';
const facts = { code: 'PI_AI_ERROR', summary: 'fixed' };
const position = { turn: 1, step: 1 };
const event = state => ({ type: AUDIT_EVENT, data: { version: 1, state } });
test('default unbounded, disabled0 and any explicit finite opt-down', () => {
  assert.equal(validateConfig().maxCycles, UNBOUNDED_RETRIES); assert.equal(validateConfig({ maxCycles: 0 }).maxCycles, 0);
  assert.equal(validateConfig({ maxCycles: 10 }).maxCycles, 10); assert.equal(validateConfig({ maxCycles: 11 }).maxCycles, 11);
  assert.equal(decide(INITIAL_STATE, position, 10, facts, 0).kind, 'ignore');
});
for (const maxCycles of [-1, 1.5, NaN, Infinity, null, '3', Number.MAX_SAFE_INTEGER + 2]) test(`invalid configurable budget ${maxCycles}`, () => assert.throws(() => validateConfig({ maxCycles })));
test('unbounded chains continue far beyond ten cycles and survive durable reload', () => {
  let state = INITIAL_STATE;
  for (let cycle = 1; cycle <= 25; cycle++) {
    const result = decide(state, position, cycle * 10, facts, UNBOUNDED_RETRIES);
    assert.equal(result.kind, 'heal'); assert.equal(result.state.chain.cycle, cycle);
    state = JSON.parse(JSON.stringify(foldState(state, event(result.state))));
  }
  assert.equal(state.chain.cycle, 25); assert.equal(state.chain.maxCycles, UNBOUNDED_RETRIES);
  // An explicit finite cap still suspends, and a pinned finite chain cannot grow.
  assert.equal(decide(state, position, 999, facts, 25).kind, 'suspended');
  const finite = decide(INITIAL_STATE, position, 10, facts, 10).state;
  assert.equal(decide(finite, position, 20, facts, UNBOUNDED_RETRIES).state.chain.maxCycles, 10);
});
test('one warning per chain: first failure, then only a changed code, bounded per chain', () => {
  const first = decide(INITIAL_STATE, position, 10, facts, UNBOUNDED_RETRIES).state.chain;
  assert.equal(shouldWarn(first, 'TRANSPORT'), true);
  const announced = warned(first, 'TRANSPORT', 'message-1', 11);
  assert.deepEqual([announced.warnedCode, announced.warnings, announced.messageId, announced.observationSeq], ['TRANSPORT', 1, 'message-1', 11]);
  // The next cycle carries the admitted reference instead of dropping it.
  const next = decide({ ...INITIAL_STATE, seen: { attemptSeq: 10, emptyCount: 0 }, chain: announced }, position, 20, facts, UNBOUNDED_RETRIES).state.chain;
  assert.deepEqual([next.cycle, next.warnedCode, next.messageId, next.observationSeq], [2, 'TRANSPORT', 'message-1', 11]);
  assert.equal(shouldWarn(next, 'TRANSPORT'), false); assert.equal(shouldWarn(next, 'SERVER'), true);
  let chain = next;
  for (let i = 1; i < MAX_CHAIN_WARNINGS; i++) chain = warned(chain, i % 2 ? 'SERVER' : 'TRANSPORT');
  assert.equal(chain.warnings, MAX_CHAIN_WARNINGS); assert.equal(shouldWarn(chain, chain.warnedCode === 'SERVER' ? 'TRANSPORT' : 'SERVER'), false);
  // Terminal: announced once per suspension; a suspended same-code chain is quiet.
  assert.equal(shouldWarn(next, 'TRANSPORT', true), true);
  assert.equal(shouldWarn({ ...next, status: 'suspended' }, 'TRANSPORT', true), false);
  assert.equal(shouldWarn({ ...next, status: 'suspended' }, 'SERVER', true), true);
  // Audit snapshots cannot rewind the warning count of the same chain.
  const state = { ...INITIAL_STATE, chain: next };
  assert.equal(foldState(state, event({ ...state, chain: { ...next, warnings: undefined, warnedCode: undefined } })), state);
});
test('config accessors and foreign knobs rejected without invocation', () => {
  let invoked = false;
  assert.throws(() => validateConfig({ get maxCycles() { invoked = true; return 10; } }));
  assert.equal(invoked, false); assert.throws(() => validateConfig({ enabledCredits: true }));
});
test('three cycles anchored to original position despite changed request series/history/config', () => {
  let state = INITIAL_STATE;
  for (let cycle = 1; cycle <= 3; cycle++) {
    const result = decide(state, { turn: cycle, step: cycle + 1 }, cycle * 10, facts, 3);
    assert.equal(result.kind, 'heal'); assert.equal(result.state.chain.cycle, cycle); assert.equal(chainKey(result.state.chain), '1:2');
    state = foldState(state, event(result.state));
    state = foldState(state, { type: 'request/header', data: { startsSeries: true } });
    state = foldState(state, { type: 'user/message', data: { arbitrary: 'changed-surface' } });
    state = JSON.parse(JSON.stringify(state)); // Rebuild/reload from durable projection.
  }
  assert.equal(decide(state, { turn: 8, step: 9 }, 40, facts, 10).kind, 'suspended');
});
test('independent session projection state has an independent budget', () => {
  const exhausted = { ...INITIAL_STATE, chain: { turn: 1, step: 1, cycle: 3, maxCycles: 3, status: 'retry-requested', attemptSeq: 30 }, seen: { attemptSeq: 30, emptyCount: 0 } };
  assert.equal(decide(exhausted, position, 40, facts, 3).kind, 'suspended');
  assert.equal(decide(INITIAL_STATE, position, 10, facts, 3).state.chain.cycle, 1);
});
test('reservation cannot be refunded by partial admission failure or duplicate callback', () => {
  const reserved = decide(INITIAL_STATE, position, 10, facts, 3).state;
  const failed = transition(reserved, 'append-failed');
  assert.equal(decide(failed, position, 10, facts, 3).kind, 'duplicate');
  assert.equal(decide(failed, position, 9, facts, 3).kind, 'duplicate');
  assert.equal(decide(failed, position, 20, facts, 3).state.chain.cycle, 2);
  assert.equal(foldState(failed, event(INITIAL_STATE)), failed);
});
test('audit cannot manufacture healthy progress or a larger budget', () => {
  const state = decide(INITIAL_STATE, position, 10, facts, 3).state;
  assert.equal(foldState(state, event({ ...state, lastHealthyTurn: 99 })), state);
  assert.equal(foldState(state, event({ ...state, chain: { ...state.chain, cycle: 0 } })), state);
  assert.equal(foldState(state, event({ ...state, chain: { ...state.chain, maxCycles: 10 } })), state);
  assert.equal(foldState(state, event({ ...state, chain: { ...state.chain, turn: 2 } })), state);
});
test('bare completed turn and finally step/end do not reset the chain', () => {
  const state = decide(INITIAL_STATE, position, 10, facts, 3).state;
  for (const kind of ['error', 'aborted', 'max-tokens']) assert.equal(foldState(state, { type: 'turn/end', data: { turn: 1, reason: { kind } } }), state);
  const healthy = foldState(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(healthy.chain, state.chain);
  assert.equal(decide(healthy, { turn: 2, step: 1 }, 30, facts, 3).state.chain.cycle, 2);
  assert.equal(foldState(state, { type: 'step/start', data: {} }), state);
});
test('EMPTY_RESPONSE requires repetition, including official delegated retries', () => {
  const empty = { code: 'EMPTY_RESPONSE', summary: 'fixed' };
  const first = decide(INITIAL_STATE, position, 10, empty, 3, true);
  assert.equal(first.kind, 'observed'); assert.equal(first.state.chain, undefined);
  assert.equal(decide(first.state, position, 20, empty, 3).kind, 'heal');
  assert.equal(decide(INITIAL_STATE, position, 10, empty, 3).kind, 'observed');
});
test('positive provider hint suspends instead of an immediate new local retry engine', () => {
  const wait = decide(INITIAL_STATE, position, 10, { ...facts, providerRetryAfterMs: 120000 }, 3);
  assert.equal(wait.kind, 'suspended'); assert.equal(wait.state.chain.cycle, 0);
});
function nativeWindow(state, options = {}) {
  const turn = options.turn ?? 1, step = options.step ?? 1, toolCount = options.toolCount ?? 0;
  let seq = options.base ?? 100;
  const rows = [{ type: 'step/start', seq: seq++, data: { turn, step } }];
  const content = options.content ?? (toolCount ? Array.from({ length: toolCount }, () => ({ type: 'tool-call', id: 'CANARY_TOOL_ID', name: 'CANARY_TOOL_NAME', arguments: 'CANARY_ARGUMENTS' })) : [{ type: 'text', text: 'complete' }]);
  const finish = { type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: options.finish ?? 'stop' } } };
  rows.push({ type: 'assistant/message', seq: seq++, surfaceOp: options.surfaceOp ?? 'append',
    data: { turn, step, message: { role: options.role ?? 'assistant', source: { kind: 'model' }, content },
      stream: options.noFinish ? [] : options.duplicateFinish ? [finish, finish] : [finish], ...(options.interrupted ? { interrupted: true } : {}) } });
  const calls = [];
  for (let i = 0; i < toolCount; i++) { calls.push(seq); rows.push({ type: 'tool/call', seq: seq++, data: { turn, step, callId: 'CANARY_TOOL_ID', name: 'CANARY_TOOL_NAME', arguments: 'CANARY_ARGUMENTS' } }); }
  for (const callSeq of options.missingResult ? calls.slice(1) : calls) rows.push({ type: 'tool/result', seq: seq++, surfaceOp: 'append',
    sourceEventSeqs: options.wrongCause ? [99999] : options.multiCause ? [callSeq, 99999] : [callSeq],
    data: { turn, step, message: { role: 'tool', isError: Boolean(options.toolError), content: [{ type: 'text', text: 'CANARY_PRIVATE_RESULT' }] },
      ...(options.errorMetadata ? { error: { code: 'CANARY_ERROR' } } : {}) } });
  if (options.duplicateResult && calls.length) rows.push({ type: 'tool/result', seq: seq++, surfaceOp: 'append', sourceEventSeqs: [calls[0]], data: { turn, step, message: { role: 'tool', isError: false } } });
  if (!options.noEnd) rows.push({ type: 'step/end', seq: seq++, data: { turn, step } });
  return rows.reduce(foldState, state);
}
function healthyAck(state) {
  const proof = healthyStepProof(state);
  return { type: AUDIT_EVENT, seq: proof.stepEndSeq + 1, data: { version: 1, action: 'recovered', turn: proof.turn, step: proof.step,
    causalSeq: proof.stepEndSeq, progress: proof, state: recoveredState(state) } };
}
const spent = () => ({ lastHealthyTurn: 0, seen: { attemptSeq: 30, emptyCount: 0 },
  chain: { turn: 1, step: 1, cycle: 3, maxCycles: 3, status: 'suspended', attemptSeq: 30 } });
for (const toolCount of [0, 1, 3]) test(`healthy native step stages then commits with ${toolCount} tool calls`, () => {
  const original = spent(), staged = nativeWindow(original, { toolCount, finish: toolCount ? 'tool-calls' : 'stop' });
  assert.equal(staged.chain.cycle, 3); assert.ok(healthyStepProof(staged));
  const healthy = foldState(staged, healthyAck(staged));
  assert.equal(healthy.chain, undefined); assert.equal(healthy.lastRecovered.cycle, 3);
  assert.equal(healthy.seen.attemptSeq, 30); assert.equal(decide(healthy, position, 30, facts, 3).kind, 'duplicate');
  assert.equal(decide(healthy, { turn: 1, step: 2 }, 200, facts, 3).state.chain.cycle, 1);
  assert.ok(!JSON.stringify(healthy).includes('CANARY_'));
});
for (const [label, options] of Object.entries({ partial: { noFinish: true }, maxTokens: { finish: 'max-tokens' },
  aborted: { finish: 'aborted' }, error: { finish: 'error' }, interrupted: { interrupted: true },
  thoughtOnly: { content: [{ type: 'reasoning', text: 'CANARY_THOUGHT' }] }, empty: { content: [] },
  whitespace: { content: [{ type: 'text', text: '  ' }] }, replacement: { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } },
  wrongRole: { role: 'user' }, duplicateFinish: { duplicateFinish: true }, noEnd: { noEnd: true },
  missingResult: { toolCount: 2, missingResult: true }, wrongCause: { toolCount: 1, wrongCause: true },
  multiCause: { toolCount: 1, multiCause: true }, toolError: { toolCount: 1, toolError: true },
  inconsistentError: { toolCount: 1, errorMetadata: true }, duplicateResult: { toolCount: 1, duplicateResult: true } })) {
  test(`${label} is not healthy step progress`, () => {
    const state = nativeWindow(spent(), options);
    assert.equal(healthyStepProof(state), undefined); assert.equal(state.chain.cycle, 3);
    assert.ok(!JSON.stringify(state).includes('CANARY_'));
  });
}
for (const kind of ['aborted', 'error', 'max-tokens']) test(`${kind} turn invalidates staged progress before acknowledgement`, () => {
  const staged = nativeWindow(spent()), ack = healthyAck(staged);
  const cancelled = foldState(staged, { type: 'turn/end', seq: ack.seq, data: { turn: 1, reason: { kind } } });
  assert.equal(healthyStepProof(cancelled), undefined);
  assert.equal(foldState(cancelled, { ...ack, seq: ack.seq + 1 }).chain.cycle, 3);
});
test('five healthy steps split consecutive failure episodes while same-session dedupe survives', () => {
  let state = INITIAL_STATE;
  for (let step = 1; step <= 5; step++) {
    const attemptSeq = step * 100;
    const decision = decide(state, { turn: 1, step }, attemptSeq, facts, 3);
    assert.equal(decision.state.chain.cycle, 1);
    state = nativeWindow(decision.state, { step, base: attemptSeq + 1, toolCount: 1, finish: 'tool-calls' });
    state = foldState(state, healthyAck(state));
    assert.equal(state.seen.attemptSeq, attemptSeq); assert.equal(state.chain, undefined);
  }
  assert.equal(decide(state, { turn: 1, step: 6 }, 600, facts, 3).state.chain.cycle, 1);
});
for (const change of ['causal', 'position', 'assistant', 'earlySeq', 'fakeSnapshot']) test(`healthy ACK rejects mismatched ${change}`, () => {
  const staged = nativeWindow(spent()), ack = healthyAck(staged);
  if (change === 'causal') ack.data.causalSeq--;
  if (change === 'position') ack.data.step++;
  if (change === 'assistant') ack.data.progress = { ...ack.data.progress, assistantSeq: 1 };
  if (change === 'earlySeq') ack.seq = ack.data.causalSeq;
  if (change === 'fakeSnapshot') { delete ack.data.progress; ack.data.state = { lastHealthyTurn: 0 }; }
  assert.equal(foldState(staged, ack).chain.cycle, 3);
});
test('ack dedupe and stale V1 snapshot cannot resurrect a recovered chain', () => {
  const original = spent(), staged = nativeWindow(original), ack = healthyAck(staged), healthy = foldState(staged, ack);
  assert.equal(foldState(healthy, ack), healthy);
  assert.equal(foldState(healthy, event({ ...original, lastHealthyTurn: healthy.lastHealthyTurn })), healthy);
});
function humanWindow(state) {
  let value = foldState(state, { type: 'agent/inbox/spliced', seq: 100, data: { target: 'next-turn', start: 0, inserted: [{ id: 'CANARY_RPC_ID', source: { kind: 'user', rpcId: 'CANARY_RPC_ID' } }] } });
  value = foldState(value, { type: 'agent/inbox/spliced', seq: 101, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } });
  value = foldState(value, { type: 'step/start', seq: 102, data: { turn: 2, step: 1 } });
  return value;
}
const humanProof = () => ({ kind: 'human-resume', authority: 'live-root-inbox', turn: 2, step: 1, inboxSeq: 100, claimSeq: 101, stepStartSeq: 102 });
function humanAck(state, progress = humanProof()) { return { type: AUDIT_EVENT, seq: 103, data: { version: 1, action: 'manual-resumed', turn: 2, step: 1,
  causalSeq: progress.claimSeq, progress, state: { lastHealthyTurn: 0 } } }; }
test('live-authorized human receipt preserves old episode history and continuous failed-seq dedupe', () => {
  const original = spent(), state = humanWindow(original);
  // The pure fold consumes the owned producer's receipt; runtime tests prove the
  // live ALS/root admission grant. Old durable inbox labels alone are no grant.
  assert.equal(state.chain.cycle, 3);
  const resumed = foldState(state, humanAck(state));
  assert.equal(resumed.chain, undefined); assert.deepEqual(resumed.lastManualResume.previousChain, original.chain);
  assert.equal(resumed.seen.attemptSeq, 30); assert.equal(decide(resumed, position, 30, facts, 3).kind, 'duplicate');
  assert.equal(decide(resumed, { turn: 2, step: 1 }, 200, facts, 3).state.chain.cycle, 1);
  assert.ok(!JSON.stringify(resumed).includes('CANARY_'));
  assert.equal(foldState(resumed, humanAck(resumed)), resumed);
});
for (const [label, change] of Object.entries({ authority: { authority: 'user-label' }, inbox: { inboxSeq: 99 }, claim: { claimSeq: 99 },
  start: { stepStartSeq: 99 }, turn: { turn: 3 }, step: { step: 2 }, privateField: { rpcId: 'CANARY_RPC_ID' } })) {
  test(`manual resume rejects ${label} proof mismatch`, () => {
    const state = humanWindow(spent()), progress = { ...humanProof(), ...change };
    assert.equal(manualResumeState(state, progress), undefined); assert.equal(foldState(state, humanAck(state, progress)), state);
  });
}
test('cold inbox replay, fake user surface and no native step start cannot reset spent budget', () => {
  const state = humanWindow(spent());
  assert.equal(JSON.parse(JSON.stringify(state)).chain.cycle, 3);
  assert.equal(foldState(state, { type: 'user/message', seq: 104, surfaceOp: 'append', data: { source: { kind: 'user', rpcId: 'fake' } } }), state);
  const original = spent();
  assert.equal(foldState(original, humanAck(original)), original);
});
test('native inbox evidence is bounded and never copies user content or RPC identity', () => {
  let state = INITIAL_STATE;
  for (let seq = 1; seq <= MAX_HUMAN_GRANTS + 10; seq++) state = foldState(state, { type: 'agent/inbox/spliced', seq,
    data: { target: 'next-turn', inserted: [{ id: 'CANARY_ID', content: 'CANARY_CONTENT', source: { rpcId: 'CANARY_RPC_ID' } }] } });
  assert.equal(state.inboxEvidence.insertSeqs.length, MAX_HUMAN_GRANTS); assert.ok(!JSON.stringify(state).includes('CANARY_'));
});
test('V1 full-log replay recovers episode A then retains actual latest exhausted episode B', () => {
  let state = INITIAL_STATE;
  for (const attemptSeq of [10, 20]) { const next = decide(state, { turn: 20, step: 1 }, attemptSeq, facts, 3).state; state = foldState(state, event(next)); }
  const oldChain = state.chain;
  state = nativeWindow(state, { turn: 20, step: 2, toolCount: 1, finish: 'tool-calls' });
  const completionSeq = state.pendingStep.stepEndSeq + 1;
  state = foldState(state, { type: 'turn/end', seq: completionSeq, data: { turn: 20, reason: { kind: 'completed' } } });
  state = foldState(state, { type: AUDIT_EVENT, seq: completionSeq + 1, data: { version: 1, action: 'recovered', turn: 20, step: 1,
    causalSeq: completionSeq, state: { lastHealthyTurn: 20, lastRecovered: { ...oldChain, status: 'recovered' } } } });
  assert.equal(state.chain, undefined); assert.equal(state.seen.attemptSeq, 20);
  for (const attemptSeq of [200, 250, 300, 350]) {
    const decision = decide(state, { turn: 21, step: 1 }, attemptSeq, facts, 3);
    const { lastHealthyTurn, seen, chain, lastRecovered } = decision.state;
    state = foldState(state, event({ lastHealthyTurn, seen, chain, lastRecovered }));
  }
  assert.equal(chainKey(state.chain), '21:1'); assert.equal(state.chain.cycle, 3); assert.equal(state.chain.status, 'suspended');
  assert.equal(state.seen.attemptSeq, 350); assert.equal(state.lastRecovered.turn, 20); assert.equal(state.lastRecovered.cycle, 2);
  assert.equal(decide(JSON.parse(JSON.stringify(state)), { turn: 22, step: 1 }, 400, facts, 10).kind, 'suspended');
});
