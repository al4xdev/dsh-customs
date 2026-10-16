import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPersistenceCompatible, assertAuditReadable } from '../persistence.mjs';
import { stateSchema } from '../index.mjs';

test('installed reader accepts required owner protocol before activation', () => {
  assert.doesNotThrow(assertPersistenceCompatible);
});
test('owner replay rejects unknown protocol versions rather than refunding budget', () => {
  for (const version of [undefined, 0, 3, '1', '2']) {
    assert.throws(() => assertAuditReadable({ type: 'agent/self-heal', data: {
      version, action: 'reserved', state: { lastHealthyTurn: 0 },
    } }, stateSchema), /unsupported required audit/);
  }
});
test('owner replay rejects unknown actions and invalid checkpoint data', () => {
  assert.throws(() => assertAuditReadable({ type: 'agent/self-heal', data: {
    version: 1, action: 'reset-budget', state: { lastHealthyTurn: 0 },
  } }, stateSchema), /unsupported required audit/);
  assert.throws(() => assertAuditReadable({ type: 'agent/self-heal', data: {
    version: 1, action: 'reserved', state: { lastHealthyTurn: -1 },
  } }, stateSchema));
});
test('v1 receipts, v2 (policy 3) audits and unrelated native events remain readable', () => {
  assert.doesNotThrow(() => assertAuditReadable({ type: 'agent/self-heal', data: {
    version: 1, action: 'observed', state: { lastHealthyTurn: 0, policyVersion: 2 },
  } }, stateSchema));
  assert.doesNotThrow(() => assertAuditReadable({ type: 'agent/self-heal', data: {
    version: 2, action: 'reserved', state: { lastHealthyTurn: 0, policyVersion: 3,
      chain: { turn: 1, step: 1, cycle: 11, maxCycles: Number.MAX_SAFE_INTEGER, status: 'reserved', attemptSeq: 9, warnedCode: 'TRANSPORT', warnings: 1 } },
  } }, stateSchema));
  assert.throws(() => assertAuditReadable({ type: 'agent/self-heal', data: {
    version: 2, action: 'reserved', state: { lastHealthyTurn: 0, chain: { turn: 1, step: 1, cycle: 1, maxCycles: 1, status: 'reserved', attemptSeq: 9, warnedCode: 'ARBITRARY_CODE' } },
  } }, stateSchema));
  assert.doesNotThrow(() => assertAuditReadable({ type: 'turn/start', data: {} }, stateSchema));
});
