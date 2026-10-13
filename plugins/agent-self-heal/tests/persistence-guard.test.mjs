import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPersistenceCompatible, assertAuditReadable } from '../persistence.mjs';
import { stateSchema } from '../index.mjs';

test('installed reader accepts required owner protocol before activation', () => {
  assert.doesNotThrow(assertPersistenceCompatible);
});
test('owner replay rejects unknown protocol versions rather than refunding budget', () => {
  for (const version of [undefined, 0, 2, '1']) {
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
test('v1 receipts and unrelated native events remain readable', () => {
  assert.doesNotThrow(() => assertAuditReadable({ type: 'agent/self-heal', data: {
    version: 1, action: 'observed', state: { lastHealthyTurn: 0 },
  } }, stateSchema));
  assert.doesNotThrow(() => assertAuditReadable({ type: 'turn/start', data: {} }, stateSchema));
});
