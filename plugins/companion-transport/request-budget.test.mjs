import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequestBudget, isUploadRequest, MAX_REQUEST_BYTES, MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_REQUEST_BYTES, UPLOAD_PATH } from './request-budget.mjs';

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

test('upload route accepts one 20 MiB file plus headroom only with a declared length', () => {
  assert.equal(MAX_UPLOAD_FILE_BYTES, 20 * 1024 * 1024);
  assert.ok(MAX_UPLOAD_REQUEST_BYTES > MAX_UPLOAD_FILE_BYTES && MAX_UPLOAD_REQUEST_BYTES - MAX_UPLOAD_FILE_BYTES <= 64 * 1024);
  const upload = (headers, url = `${UPLOAD_PATH}?sessionId=s&name=a.bin`, method = 'POST') => ({ httpVersionMajor: 1, method, url, headers });
  for (const length of ['0', '1048577', String(MAX_UPLOAD_FILE_BYTES), String(MAX_UPLOAD_REQUEST_BYTES)]) {
    assert.equal(classifyRequestBudget(upload({ 'content-length': length })), null);
  }
  assert.equal(classifyRequestBudget(upload({ 'content-length': '5' }, UPLOAD_PATH)), null);
  assert.deepEqual(classifyRequestBudget(upload({ 'content-length': String(MAX_UPLOAD_REQUEST_BYTES + 1) })), { status: 413, code: 'request_too_large' });
  // Unknown length cannot use the larger budget; chunked stays refused like everywhere else.
  assert.deepEqual(classifyRequestBudget(upload({})), { status: 411, code: 'known_body_length_required' });
  assert.deepEqual(classifyRequestBudget(upload({ 'transfer-encoding': 'chunked' })), { status: 411, code: 'known_body_length_required' });
  assert.deepEqual(classifyRequestBudget(upload({ 'content-length': '1, 1' })), { status: 400, code: 'invalid_body_framing' });
});

test('every other route, method or spelling keeps the 1 MiB budget', () => {
  const big = { 'content-length': '1048577' };
  for (const [method, url] of [['POST', '/api/session/send'], ['PUT', UPLOAD_PATH], ['POST', `${UPLOAD_PATH}/x`], ['POST', `${UPLOAD_PATH}x`],
    ['POST', '/api/session/%75ploadFileBinary'], ['POST', '/api/session/../session/uploadFileBinary'], ['POST', `/x${UPLOAD_PATH}`], [undefined, UPLOAD_PATH]]) {
    assert.equal(isUploadRequest({ method, url }), false);
    assert.deepEqual(classifyRequestBudget({ httpVersionMajor: 1, method, url, headers: big }), { status: 413, code: 'request_too_large' });
  }
  assert.equal(classifyRequestBudget({ httpVersionMajor: 1, method: 'POST', url: '/api/session/send', headers: {} }), null);
});

test('the parser-framing guarantee is not silently applied to HTTP/2', () => {
  assert.deepEqual(classifyRequestBudget({ httpVersionMajor: 2, headers: {} }), { status: 400, code: 'unsupported_http_framing' });
  for (const req of [null, {}, { headers: null }, { headers: [] }]) {
    assert.deepEqual(classifyRequestBudget(req), { status: 400, code: 'invalid_body_framing' });
  }
});
