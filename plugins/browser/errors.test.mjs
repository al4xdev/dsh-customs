import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserError, safeError } from './errors.mjs';

test('canonical browser error identity cannot be overwritten by structured details', () => {
  const result = safeError(new BrowserError('POLICY_DENIED', 'Native authority denied the operation.', { code: 'FAKE_SUCCESS', message: 'Engine details', effectState: 'none', retryable: false }));
  assert.equal(result.code, 'POLICY_DENIED'); assert.equal(result.message, 'Native authority denied the operation.');
  assert.equal(result.effectState, 'none'); assert.equal(result.retryable, false);
});

test('unexpected engine causes, credential URLs and stack traces are not serialized', () => {
  const error = Object.assign(new Error('https://fixture:SECRET@localhost/private'), { cause: { token: 'SECRET' } });
  assert.equal(JSON.stringify(safeError(error)).includes('SECRET'), false);
  assert.equal(safeError(error).effectState, 'unknown'); assert.equal(safeError(error).retryable, false);
});
