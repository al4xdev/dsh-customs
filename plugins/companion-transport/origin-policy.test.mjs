import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRequest, PUBLIC_ORIGIN } from './origin-policy.mjs';

const HOST = 'dsh.tail37b3d7.ts.net:8443';
const localOrigins = ['http://127.0.0.1:3081', 'http://localhost:3081'];
const request = (headers = {}, method = 'GET', url = '/api/companion/listChats') => ({ headers: { host: HOST, ...headers }, method, url });
const invalidHost = { status: 403, code: 'invalid_host' };
const invalidOrigin = { status: 403, code: 'invalid_origin' };
const requiredOrigin = { status: 403, code: 'origin_required' };
const invalidPath = { status: 400, code: 'invalid_path' };

test('public authority is immutable by default and GET/HEAD bootstrap need no Origin', () => {
  assert.equal(PUBLIC_ORIGIN, 'https://dsh.tail37b3d7.ts.net:8443');
  for (const method of ['GET', 'HEAD']) {
    assert.equal(classifyRequest(request({}, method, '/?token=fixture-only%2Fopaque%5Cvalue')), null);
    assert.equal(classifyRequest(request({ origin: PUBLIC_ORIGIN }, method)), null);
  }
});
test('every non-GET/HEAD method and every upgrade requires explicit Origin', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE', 'PROPFIND', 'get', undefined]) {
    const req = request(); req.method = method;
    assert.deepEqual(classifyRequest(req), requiredOrigin);
    req.headers.origin = PUBLIC_ORIGIN;
    assert.equal(classifyRequest(req), null);
  }
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']) {
    assert.deepEqual(classifyRequest(request({}, method), { upgrade: true }), requiredOrigin);
    assert.equal(classifyRequest(request({ origin: PUBLIC_ORIGIN }, method), { upgrade: true }), null);
  }
});
test('attached Origin is a single real exact serialized string, including GET/HEAD', () => {
  for (const origin of ['', undefined, null, [], [PUBLIC_ORIGIN], [PUBLIC_ORIGIN, PUBLIC_ORIGIN], 1, true,
    'null', 'http://dsh.tail37b3d7.ts.net:8443', `${PUBLIC_ORIGIN}/`, `${PUBLIC_ORIGIN}/path`, `${PUBLIC_ORIGIN}?q=fixture`,
    `${PUBLIC_ORIGIN}#fixture`, 'https://user@dsh.tail37b3d7.ts.net:8443', 'https://user:fixture@dsh.tail37b3d7.ts.net:8443',
    'https://dsh.tail37b3d7.ts.net', 'https://dsh.tail37b3d7.ts.net:443', 'https://dsh.tail37b3d7.ts.net:08443',
    'https://dsh.tail37b3d7.ts.net:8444', 'https://foreign.invalid', 'https://DSH.tail37b3d7.ts.net:8443',
    ` ${PUBLIC_ORIGIN}`, `${PUBLIC_ORIGIN} `, `${PUBLIC_ORIGIN}\t`, `${PUBLIC_ORIGIN}, ${PUBLIC_ORIGIN}`,
    'https://dsh.tail37b3d7.ts.net。:8443', 'https://dѕh.tail37b3d7.ts.net:8443']) {
    for (const method of ['GET', 'HEAD', 'POST']) assert.deepEqual(classifyRequest(request({ origin }, method)), invalidOrigin);
  }
});
test('Host must match a literal trusted authority including canonical port', () => {
  for (const host of ['', undefined, null, [], [HOST], 1, 'evil.invalid', 'dsh.tail37b3d7.ts.net',
    'dsh.tail37b3d7.ts.net:443', 'dsh.tail37b3d7.ts.net:08443', 'dsh.tail37b3d7.ts.net:8444',
    'DSH.tail37b3d7.ts.net:8443', `${HOST}.`, `${HOST}/`, `user@${HOST}`, `http://${HOST}`, `${HOST}?q=fixture`,
    `${HOST},${HOST}`, ` ${HOST}`, `${HOST} `, `${HOST}\r\n`, 'dsh.tail37b3d7.ts.net。:8443']) {
    assert.deepEqual(classifyRequest(request({ host, origin: PUBLIC_ORIGIN }, 'POST')), invalidHost);
  }
  assert.deepEqual(classifyRequest({ headers: { origin: PUBLIC_ORIGIN }, method: 'GET', url: '/' }), invalidHost);
  for (const headers of [null, undefined, [], 'host']) assert.deepEqual(classifyRequest({ headers, method: 'GET', url: '/' }), invalidHost);
});
test('explicit local aliases preserve legacy localhost/127 cross-alias Origin behavior', () => {
  for (const host of ['127.0.0.1:3081', 'localhost:3081']) {
    for (const origin of localOrigins) {
      assert.equal(classifyRequest(request({ host, origin }, 'POST'), { localOrigins }), null);
      assert.equal(classifyRequest(request({ host, origin }), { localOrigins, upgrade: true }), null);
    }
    assert.equal(classifyRequest(request({ host }), { localOrigins }), null);
    assert.deepEqual(classifyRequest(request({ host }, 'POST'), { localOrigins }), requiredOrigin);
    assert.deepEqual(classifyRequest(request({ host, origin: PUBLIC_ORIGIN }, 'POST'), { localOrigins }), invalidOrigin);
    assert.deepEqual(classifyRequest(request({ host, origin: 'http://localhost:3082' }, 'POST'), { localOrigins }), invalidOrigin);
    assert.deepEqual(classifyRequest(request({ host }), {}), invalidHost);
  }
  assert.deepEqual(classifyRequest(request({ origin: localOrigins[0] }, 'POST'), { localOrigins }), invalidOrigin);
  assert.deepEqual(classifyRequest(request({ host: 'localhost:3082', origin: localOrigins[0] }, 'POST'), { localOrigins }), invalidHost);
});
test('cross-site and ambiguous fetch markers fail closed before any dispatch', () => {
  for (const site of ['cross-site', ['cross-site'], ['same-origin', 'cross-site'], 'cross-site, same-origin', null, '', 'Cross-Site']) {
    assert.deepEqual(classifyRequest(request({ origin: PUBLIC_ORIGIN, 'sec-fetch-site': site }, 'POST')), invalidOrigin);
    assert.deepEqual(classifyRequest(request({ 'sec-fetch-site': site })), invalidOrigin);
  }
  for (const site of ['same-origin', 'same-site', 'none']) assert.equal(classifyRequest(request({ origin: PUBLIC_ORIGIN, 'sec-fetch-site': site }, 'POST')), null);
});
test('paths require one leading slash and reject backslash/CRLF without normalization', () => {
  for (const path of ['', undefined, null, [], '//evil.invalid/path', '///api', 'api/path', 'https://evil.invalid/', '*', '/\\evil', '/api\\path', '/?fixture=\\value', '/api\rpath', '/api\npath', '/?fixture=\r\n']) {
    const req = request({ origin: PUBLIC_ORIGIN }); req.url = path;
    assert.deepEqual(classifyRequest(req), invalidPath);
  }
  for (const path of ['/', '/api/remote.mux', '/api/companion/listChats', '/?token=fixture-only', '/?token=fixture%0D%0A%5C%2F', '/%2F%2Fevil', '/a/../b']) {
    assert.equal(classifyRequest(request({ origin: PUBLIC_ORIGIN }, 'POST', path)), null);
  }
});
test('duplicate raw Host and Origin headers are rejected case-insensitively', () => {
  const valid = request({ origin: PUBLIC_ORIGIN }, 'POST');
  valid.rawHeaders = ['Host', HOST, 'Origin', PUBLIC_ORIGIN];
  assert.equal(classifyRequest(valid), null);
  assert.deepEqual(classifyRequest({ ...valid, rawHeaders: [...valid.rawHeaders, 'hOsT', HOST] }), invalidHost);
  assert.deepEqual(classifyRequest({ ...valid, rawHeaders: [...valid.rawHeaders, 'oRiGiN', PUBLIC_ORIGIN] }), invalidOrigin);
  assert.deepEqual(classifyRequest({ ...valid, rawHeaders: [...valid.rawHeaders, 'Sec-Fetch-Site', 'same-origin', 'sec-fetch-site', 'same-origin'] }), invalidOrigin);
});
test('malformed or oversized raw headers cannot trigger unbounded scanning', () => {
  for (const rawHeaders of [null, {}, 'Host', ['Host'], ['Host', null], [null, HOST], ['X-Long', 'x'.repeat(16385)], ['X-Multi', 'é'.repeat(8192)], Array.from({ length: 2050 }, () => '')]) {
    assert.deepEqual(classifyRequest({ ...request({ origin: PUBLIC_ORIGIN }), rawHeaders }), invalidHost);
  }
});
test('Host then Origin then fetch marker then path refusal precedence is deterministic', () => {
  assert.deepEqual(classifyRequest(request({ host: 'evil.invalid', origin: 'null' }, 'POST', '//evil')), invalidHost);
  assert.deepEqual(classifyRequest(request({ origin: 'null' }, 'POST', '//evil')), invalidOrigin);
  assert.deepEqual(classifyRequest(request({}, 'POST', '//evil')), requiredOrigin);
  assert.deepEqual(classifyRequest(request({ origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'cross-site' }, 'POST', '//evil')), invalidOrigin);
  assert.deepEqual(classifyRequest(request({ origin: PUBLIC_ORIGIN }, 'POST', '//evil')), invalidPath);
});
test('invalid trusted options throw a fixed source configuration marker', () => {
  for (const options of [null, [], 'invalid', new Date(0), Object.create({ upgrade: false }),
    { get upgrade() { return assert.fail('configuration accessor must never run'); } }, { [Symbol('fixture-only')]: true },
    { localOrigins: Array(1) }, { arbitrary: true }, { upgrade: 1 }, { upgrade: 'false' },
    { publicOrigin: 'http://fixture.invalid:8443' }, { publicOrigin: 'https://fixture.invalid:443' },
    { publicOrigin: 'https://fixture.invalid:8443/' }, { publicOrigin: 'https://user@fixture.invalid:8443' },
    { publicOrigin: 'https://FIXTURE.invalid:8443' }, { publicOrigin: 'null' }, { publicOrigin: 1 },
    { localOrigins: new Set(localOrigins) }, { localOrigins: ['https://localhost:3081'] },
    { localOrigins: ['http://localhost:3081/'] }, { localOrigins: ['http://user@localhost:3081'] },
    { localOrigins: [`http://${HOST}`] }, { localOrigins: ['not-an-origin'] },
    { localOrigins: Array.from({ length: 33 }, () => 'http://localhost:3081') }]) {
    assert.throws(() => classifyRequest(request(), options), error => error instanceof TypeError && error.message === 'companion-transport/invalid-policy-options');
  }
});
test('trusted test-origin seam grants only its exact explicit serialized authority', () => {
  const publicOrigin = 'https://fixture.invalid:9443';
  const options = { publicOrigin };
  assert.equal(classifyRequest(request({ host: 'fixture.invalid:9443', origin: publicOrigin }, 'POST'), options), null);
  assert.deepEqual(classifyRequest(request({ origin: PUBLIC_ORIGIN }, 'POST'), options), invalidHost);
  assert.deepEqual(classifyRequest(request({ host: 'fixture.invalid:9443', origin: 'http://fixture.invalid:9443' }, 'POST'), options), invalidOrigin);
});
test('classification never mutates, normalizes or consumes request/query/header data', () => {
  const req = Object.freeze({ method: 'POST', url: '/?token=fixture-only%5Copaque', headers: Object.freeze({ host: HOST, origin: PUBLIC_ORIGIN }), rawHeaders: Object.freeze(['Host', HOST, 'Origin', PUBLIC_ORIGIN]) });
  assert.equal(classifyRequest(req), null);
  assert.equal(req.url, '/?token=fixture-only%5Copaque');
  assert.equal(req.headers.host, HOST);
  assert.equal(req.headers.origin, PUBLIC_ORIGIN);
});
