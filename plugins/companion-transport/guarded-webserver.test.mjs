import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import GuardedWebServer, { NativeWebServer } from './guarded-webserver.mjs';
import { PUBLIC_ORIGIN } from './origin-policy.mjs';
import { MAX_REQUEST_BYTES } from './request-budget.mjs';

const sdk = createRequire(path.join(homedir(), '.local/share/dsh-cli/package.json'));
const load = name => import(pathToFileURL(sdk.resolve(name)).href);
const [{ Context }, Connection, { default: Gateway }, { default: Registry }] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-client-connection'),
  load('@deepseek-ai/dsh-api-gateway'), load('@deepseek-ai/dsh-typert-registry'),
]);
const authority = new URL(PUBLIC_ORIGIN).host;

function request(port, { method = 'GET', pathname = '/', headers = {}, body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, agent: false, headers: { host: authority, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); req.destroy(); });
      res.on('error', () => reject(new Error('fixture-response-failure')));
    });
    req.setTimeout(3000, () => req.destroy(new Error('fixture-timeout')));
    req.on('error', () => reject(new Error('fixture-request-failure')));
    if (chunked) { req.write(body ?? 'fixture-only'); req.end(); } else req.end(body);
  });
}
function upgrade(port, headers = {}) {
  const key = Buffer.alloc(16, 7).toString('base64');
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/remote.mux', agent: false, headers: {
      host: authority, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key, ...headers,
    } });
    req.setTimeout(3000, () => req.destroy(new Error('fixture-upgrade-timeout')));
    req.on('upgrade', (res, socket) => {
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      // Only negotiation is tested: no remote stream, session or model invocation.
      socket.destroy(); resolve({ status: res.statusCode, accepted: res.headers['sec-websocket-accept'] === accept });
    });
    req.on('response', res => { res.resume(); res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers }); req.destroy(); }); });
    req.on('error', () => reject(new Error('fixture-upgrade-failure')));
    req.end();
  });
}
async function host(t) {
  const ctx = new Context();
  const records = new Map(); const counts = { root: 0, rpc: 0, exact: 0 };
  const profile = { name: 'companion' }; ctx.provide('profileContext', profile);
  // BrowserAuth receives only this public RAM capability. No credential-local,
  // paths, profile boot, DSH_HOME state or real credentials provider is mounted.
  ctx.provide('credentials', { async modifyRecord(key, update) {
    const next = await update(records.get(key));
    if (next !== undefined) records.set(key, next);
    return records.get(key);
  } });
  // Exercise the native image-headroom check without any storage/image operation.
  const imageLimits = Object.freeze({ maxMessageImageBytes: 200 * 1024 * 1024 });
  ctx.provide('attachments', { imageLimits });
  t.after(async () => { await ctx.fiber.dispose(); records.clear(); });
  await ctx.plugin(GuardedWebServer, { host: '127.0.0.1', port: 0 });
  // Generic rpc.handle needs the carrier in its public dependency context.
  await ctx.plugin({ ...Connection, inject: [...Connection.inject, 'webServer'] }, { trustedHosts: [authority] });
  await ctx.plugin(Registry); await ctx.plugin(Gateway);
  await ctx.inject(['connection', 'webServer'], routeCtx => {
    routeCtx.connection.rpc.handle('/fixture', async () => { counts.rpc++; return { ok: true, value: { fixture: true } }; });
    routeCtx.effect(() => routeCtx.webServer.register({ kind: 'exact', path: '/exact', handler(req, res) { assert.equal(req.httpVersionMajor, 1); counts.exact++; res.end('fixture-exact'); } }));
    routeCtx.effect(() => routeCtx.webServer.registerFallback((req, res) => {
      counts.root++;
      if (routeCtx.connection.authorizeIndex(req, res)) res.end('fixture-index');
    }));
  });
  return { ctx, port: ctx.get('webServer').port, counts, profile, records, imageLimits };
}
async function authenticate(fixture, host = authority) {
  const origin = host === authority ? PUBLIC_ORIGIN : `http://${host}`;
  const tokenized = new URL(fixture.ctx.get('connection').authenticatedUrl(`${origin}/`));
  const response = await request(fixture.port, { pathname: tokenized.pathname + tokenized.search, headers: { host } });
  assert.equal(response.status, 303, 'native bootstrap redirect');
  assert.equal(response.headers.location, './');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  const issued = response.headers['set-cookie']?.[0];
  assert.ok(typeof issued === 'string' && issued.startsWith('dsh-auth-'), 'native fixture cookie issued');
  assert.ok(issued.includes('HttpOnly') && issued.includes('SameSite=Strict'), 'native cookie attributes');
  return issued.split(';', 1)[0];
}
function envelope(size) {
  const base = { type: 'client-request', rpcId: 'fixture-rpc', method: 'echo', payload: { padding: '' } };
  if (size !== undefined) base.payload.padding = 'x'.repeat(size - Buffer.byteLength(JSON.stringify(base)));
  return JSON.stringify(base);
}
function rpc(fixture, cookie, overrides = {}) {
  const body = envelope();
  return request(fixture.port, { method: 'POST', pathname: '/fixture/echo', body,
    headers: { origin: PUBLIC_ORIGIN, ...(cookie ? { cookie } : {}), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...overrides },
  });
}

test('provider inherits native config and rejects an available foreign profile before registration', async t => {
  assert.equal(GuardedWebServer.Config, NativeWebServer.Config);
  assert.ok(GuardedWebServer.prototype instanceof NativeWebServer);
  const ctx = new Context(); t.after(() => ctx.fiber.dispose()); ctx.provide('profileContext', { name: 'web' });
  assert.throws(() => new GuardedWebServer(ctx, { host: '127.0.0.1', port: 0 }), /companion-profile-required/);
  assert.equal(ctx.get('webServer'), undefined);
});

test('HTTP guards origin and host before native authentication or generic RPC ownership', async t => {
  const fixture = await host(t);
  assert.equal((await rpc(fixture)).status, 401);
  for (const origin of [undefined, 'http://' + authority, PUBLIC_ORIGIN + '/', 'null', 'https://foreign.invalid']) {
    const body = envelope(); const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    if (origin !== undefined) headers.origin = origin;
    assert.equal((await request(fixture.port, { method: 'POST', pathname: '/fixture/echo', body, headers })).status, 403);
  }
  assert.equal((await rpc(fixture, null, { host: 'foreign.invalid' })).status, 403);
  assert.equal((await rpc(fixture, null, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(fixture.counts.rpc, 0);
});

test('unchanged native bootstrap and authority-bound RAM cookie admit only a fixed-length fixture RPC', async t => {
  const fixture = await host(t); const cookie = await authenticate(fixture);
  assert.equal(fixture.records.size, 1, 'only the RAM browser-auth record exists');
  assert.equal((await rpc(fixture, cookie)).status, 200);
  assert.equal(fixture.counts.rpc, 1);
  assert.equal((await rpc(fixture, cookie, { origin: 'http://' + authority })).status, 403);
  assert.equal(fixture.counts.rpc, 1);
  const local = `127.0.0.1:${fixture.port}`;
  assert.equal((await rpc(fixture, cookie, { host: local, origin: `http://${local}` })).status, 401, 'public cookie cannot authenticate a different authority');
});

test('public fallback is fenced before the native token exchange without reflecting token inputs', async t => {
  const fixture = await host(t);
  const tokenized = new URL(fixture.ctx.get('connection').authenticatedUrl(`${PUBLIC_ORIGIN}/`));
  assert.equal((await request(fixture.port, { pathname: tokenized.pathname + tokenized.search, headers: { host: 'foreign.invalid' } })).status, 403);
  assert.equal(fixture.counts.root, 0);
  assert.equal((await request(fixture.port, { headers: { origin: 'http://' + authority } })).status, 403);
  assert.equal(fixture.counts.root, 0);
});

test('proper native mux handshakes preserve 403 priority, native 401, and authenticated 101', async t => {
  const fixture = await host(t); const cookie = await authenticate(fixture);
  assert.equal((await upgrade(fixture.port)).status, 403);
  assert.equal((await upgrade(fixture.port, { cookie })).status, 403);
  assert.equal((await upgrade(fixture.port, { origin: PUBLIC_ORIGIN })).status, 401);
  assert.equal((await upgrade(fixture.port, { origin: 'http://' + authority, cookie })).status, 403);
  assert.equal((await upgrade(fixture.port, { origin: PUBLIC_ORIGIN, host: 'foreign.invalid', cookie })).status, 403);
  assert.equal((await upgrade(fixture.port, { origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'cross-site', cookie })).status, 403);
  const admitted = await upgrade(fixture.port, { origin: PUBLIC_ORIGIN, cookie });
  assert.equal(admitted.status, 101); assert.equal(admitted.accepted, true);
});

test('HTTP1 wire budget rejects oversized declarations and chunked bodies before ownership without reducing native image limits', async t => {
  const fixture = await host(t); const cookie = await authenticate(fixture);
  assert.equal(fixture.ctx.get('attachments').imageLimits, fixture.imageLimits);
  assert.equal((await request(fixture.port, { method: 'POST', pathname: '/fixture/echo', headers: { origin: PUBLIC_ORIGIN, cookie, 'content-length': MAX_REQUEST_BYTES + 1 } })).status, 413);
  assert.equal((await request(fixture.port, { method: 'POST', pathname: '/fixture/echo', chunked: true, headers: { origin: PUBLIC_ORIGIN, cookie, 'transfer-encoding': 'chunked' }, body: 'fixture-only' })).status, 411);
  assert.equal((await request(fixture.port, { method: 'POST', pathname: '/fixture/echo', chunked: true, headers: { cookie, 'transfer-encoding': 'chunked' }, body: 'fixture-only' })).status, 403);
  assert.equal(fixture.counts.rpc, 0);
  const body = envelope(MAX_REQUEST_BYTES);
  assert.equal(Buffer.byteLength(body), MAX_REQUEST_BYTES);
  assert.equal((await request(fixture.port, { method: 'POST', pathname: '/fixture/echo', headers: { origin: PUBLIC_ORIGIN, cookie, 'content-type': 'application/json', 'content-length': MAX_REQUEST_BYTES }, body })).status, 200);
  assert.equal(fixture.counts.rpc, 1);
});

test('upgrade and fallback cannot bypass request framing limits', async t => {
  const fixture = await host(t);
  assert.equal((await upgrade(fixture.port, { origin: PUBLIC_ORIGIN, 'content-length': MAX_REQUEST_BYTES + 1 })).status, 413);
  assert.equal((await upgrade(fixture.port, { origin: PUBLIC_ORIGIN, 'transfer-encoding': 'chunked' })).status, 411);
  assert.equal((await request(fixture.port, { pathname: '/unclaimed', headers: { 'content-length': MAX_REQUEST_BYTES + 1 } })).status, 413);
  assert.equal(fixture.counts.root, 0);
});

test('bound local port is evaluated lazily and native public route disposers retain ownership', async t => {
  const fixture = await host(t); const local = `127.0.0.1:${fixture.port}`;
  const cookie = await authenticate(fixture, local);
  assert.equal((await rpc(fixture, cookie, { host: local, origin: `http://${local}` })).status, 200);
  const server = fixture.ctx.get('webServer'); let delegated = 0;
  const dispose = server.register({ kind: 'exact', path: '/temporary', handler(req, res) { assert.equal(req.httpVersionMajor, 1); delegated++; res.end('fixture-only'); } });
  assert.equal((await request(fixture.port, { pathname: '/temporary' })).status, 200);
  assert.equal(delegated, 1); dispose();
  assert.equal((await request(fixture.port, { pathname: '/temporary' })).status, 401);
  assert.equal(delegated, 1);
});

test('every named route and runtime profile change remain fenced', async t => {
  const fixture = await host(t);
  assert.equal((await request(fixture.port, { pathname: '/exact', headers: { origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal(fixture.counts.exact, 0);
  assert.equal((await request(fixture.port, { pathname: '/exact' })).status, 200);
  assert.equal(fixture.counts.exact, 1);
  fixture.profile.name = 'web';
  assert.equal((await request(fixture.port, { pathname: '/exact' })).status, 403);
  assert.equal((await upgrade(fixture.port, { origin: PUBLIC_ORIGIN })).status, 403);
  assert.equal(fixture.counts.exact, 1);
});

test('HTTP and upgrade refusals have fixed anti-sniff/referrer headers and never reflect startup inputs', async t => {
  const fixture = await host(t);
  const httpRefusal = await request(fixture.port, { pathname: '/?token=synthetic-private-input', headers: { host: 'foreign.invalid' } });
  const wsRefusal = await upgrade(fixture.port);
  for (const refusal of [httpRefusal, wsRefusal]) {
    assert.equal(refusal.status, 403);
    assert.equal(refusal.headers['cache-control'], 'no-store');
    assert.equal(refusal.headers['x-content-type-options'], 'nosniff');
    assert.equal(refusal.headers['referrer-policy'], 'no-referrer');
    assert.equal(refusal.headers['content-type'], 'text/plain; charset=utf-8');
  }
  assert.equal(httpRefusal.body, 'invalid_host');
  assert.equal(httpRefusal.body.includes('synthetic-private-input'), false);
  assert.equal(fixture.counts.root, 0);
});
