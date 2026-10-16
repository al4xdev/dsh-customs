import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequestBudget, MAX_REQUEST_BYTES } from './request-budget.mjs';

const request = headers => ({ httpVersionMajor: 1, headers });

test('HTTP/1 framing permits empty bodies and known lengths up to the wire cap', () => {
  assert.equal(MAX_REQUEST_BYTES, 1048576);
  for (const headers of [{}, { 'content-length': '0' }, { 'content-length': '1024' }, { 'content-length': '1048576' }, { 'content-length': '0001' }]) {
    assert.equal(classifyRequestBudget(request(headers)), null);
  }
});

test('declared oversize is rejected before body consumption or native dispatch', () => {
  for (const length of ['1048577', '314572800', '9007199254740991']) {
    assert.deepEqual(classifyRequestBudget(request({ 'content-length': length })), { status: 413, code: 'request_too_large' });
  }
});

test('chunked or ambiguous transfer coding cannot evade the wire budget', () => {
  for (const encoding of ['chunked', 'gzip, chunked', 'identity', '', ['chunked'], undefined]) {
    assert.deepEqual(classifyRequestBudget(request({ 'transfer-encoding': encoding, 'content-length': '1' })), {
      status: 411, code: 'known_body_length_required'
    });
  }
});

test('body framing does not coerce malformed lengths or duplicate header values', () => {
  for (const length of [1, null, undefined, ['1'], '1, 1', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '１', '9007199254740992', '00000000000000000']) {
    assert.deepEqual(classifyRequestBudget(request({ 'content-length': length })), { status: 400, code: 'invalid_body_framing' });
  }
});

test('the parser-framing guarantee is not silently applied to HTTP/2', () => {
  assert.deepEqual(classifyRequestBudget({ httpVersionMajor: 2, headers: {} }), { status: 400, code: 'unsupported_http_framing' });
  for (const req of [null, {}, { headers: null }, { headers: [] }]) {
    assert.deepEqual(classifyRequestBudget(req), { status: 400, code: 'invalid_body_framing' });
  }
});
