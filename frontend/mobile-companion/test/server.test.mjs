import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMobileServer, PUBLIC_ORIGIN } from '../server/index.mjs';
import { companionMetadata } from '../server/session-catalog.mjs';

async function fixture(t, options = {}) {
  const seen = []; let catalogReads = 0; let closed = 0;
  const native = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    seen.push({ path: req.url, method: req.method, headers: req.headers, body });
    if (req.url === '/?token=synthetic') { res.writeHead(303, { 'set-cookie': 'fixture=authorized; HttpOnly; SameSite=Strict', location: options.loginLocation ?? '/' }); res.end(); return; }
    if (req.url === '/') {
      if (req.headers.cookie !== 'fixture=authorized') { res.writeHead(options.login200 ? 200 : 401); res.end('login'); return; }
      const html = options.rootHtml ?? '<html><script>window.__DSH_BOOT__ = {};</script></html>';
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(html) });
      res.end(html); return;
    }
    function result(value) {
      const data = JSON.stringify({ result: { ok: true, value } });
      // A realistic fixture compresses unless the parsing NodeHTTP caller opts
      // out; the earlier implementation inherited the browser's gzip header.
      if (options.compressRpc && req.headers['accept-encoding'] !== 'identity') {
        res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync(data));
      } else res.end(data);
    }
    if (req.url === '/api/agentPresets/list') {
      if (!req.headers.origin) { res.writeHead(403); res.end(); return; }
      result({ presets: options.presets ?? [{ id: 'companion' }] }); return;
    }
    if (req.url === '/api/session/create') {
      result(options.createResult ?? { sessionId: 'new-companion', agentPreset: 'companion' }); return;
    }
    res.writeHead(200, { connection: 'keep-alive, x-hop', 'x-hop': 'drop', 'set-cookie': 'fixture=authorized; HttpOnly' }); res.end('native-asset');
  });
  native.on('upgrade', (req, socket, head) => {
    seen.push({ path: req.url, headers: req.headers, upgrade: true });
    if (req.headers.cookie !== 'fixture=authorized') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: fixture\r\n\r\n');
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  await new Promise(resolve => { native.listen(0, '127.0.0.1', resolve); });
  const snapshots = options.snapshots ?? [
    { header: { id: 'mine', agentPreset: 'companion', createdAt: 10, cwd: '/secret' }, metadataSnapshot: { title: 'Companion', updatedAt: 20, credential: 'never' } },
    { header: { id: 'foreign', agentPreset: 'ordinary', createdAt: 30 } },
  ];
  const app = createMobileServer({ port: 0, backend: `http://127.0.0.1:${native.address().port}`, sessionCatalog: { list: async () => { catalogReads++; return snapshots; }, get: async id => { catalogReads++; return snapshots.find(row => row.header.id === id); }, close: async () => { closed++; } }, transformHtml: html => html.replace('</html>', '<!--mobile--></html>'), ...options });
  await app.listen();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); native.closeAllConnections(); await new Promise(resolve => { native.close(resolve); }); assert.equal(closed, 1); });
  const request = (path, opts = {}) => fetch(origin + path, { redirect: 'manual', ...opts, headers: { cookie: 'fixture=authorized', origin, ...opts.headers } });
  return { app, native, origin, request, seen, snapshots, catalogReads: () => catalogReads };
}

test('root native 401 and token 303/cookie pass through; boot alone is transformed', async t => {
  const f = await fixture(t);
  const unauth = await f.request('/', { headers: { cookie: '' } }); assert.equal(unauth.status, 401); assert.equal(await unauth.text(), 'login');
  const exchange = await f.request('/?token=synthetic', { headers: { cookie: '' } }); assert.equal(exchange.status, 303); assert.equal(exchange.headers.get('location'), '/'); assert.match(exchange.headers.get('set-cookie'), /HttpOnly/);
  const auth = await fetch(f.origin + '/', { headers: { cookie: 'fixture=authorized' } }); assert.equal(auth.status, 200); assert.match(await auth.text(), /<!--mobile-->/);
  assert.equal(f.seen[0].headers.origin, `http://127.0.0.1:${f.native.address().port}`);
});

test('bounded metadata list and membership expose only companion scalar fields', async t => {
  const f = await fixture(t);
  const list = await f.request('/mobile-api/chats?limit=99999'); assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { chats: [{ id: 'mine', title: 'Companion', createdAt: 10, updatedAt: 20 }], hasMore: false, profile: 'companion' });
  const mine = await f.request('/mobile-api/chats/mine'); assert.deepEqual(await mine.json(), { chat: { id: 'mine', title: 'Companion', createdAt: 10, updatedAt: 20 }, profile: 'companion' });
  assert.equal((await f.request('/mobile-api/chats/foreign')).status, 403);
  assert.equal((await f.request('/mobile-api/chats/missing')).status, 403);
  assert.equal((await f.request('/mobile-api/chats?limit=no')).status, 400);
});

test('unauthenticated and login-200 requests never read local metadata', async t => {
  const f = await fixture(t, { login200: true });
  const response = await f.request('/mobile-api/chats', { headers: { cookie: '' } }); assert.equal(response.status, 401); assert.equal(f.catalogReads(), 0);
});

test('creation uses exact named native request and ignores caller preset/cwd/id', async t => {
  const f = await fixture(t);
  const response = await f.request('/mobile-api/chats', { method: 'POST', body: JSON.stringify({ preset: 'foreign', cwd: '/evil', id: 'foreign' }), headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 201); assert.deepEqual(await response.json(), { id: 'new-companion' });
  const retained = await f.request('/mobile-api/chats/new-companion'); assert.equal(retained.status, 200); assert.equal((await retained.json()).chat.id, 'new-companion');
  assert.ok((await (await f.request('/mobile-api/chats')).json()).chats.some(chat => chat.id === 'new-companion'));
  const create = f.seen.find(row => row.path === '/api/session/create');
  const envelope = JSON.parse(create.body);
  assert.equal(envelope.type, 'client-request'); assert.equal(envelope.method, 'session/create');
  assert.deepEqual(envelope.payload.args, { request: { agentPreset: 'companion', cwd: '/home/alex/git/my/dsh-customs' } });
});

test('wrong profile fails closed before catalog or transform', async t => {
  const f = await fixture(t, { presets: [{ id: 'companion' }, { id: 'ordinary' }] });
  assert.equal((await f.request('/mobile-api/chats')).status, 409); assert.equal(f.catalogReads(), 0);
  assert.equal((await f.request('/')).status, 409);
});

test('Host/Origin validation precedes normalization and rejects cross-site/SSRF', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/', { headers: { host: 'attacker.invalid', origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await f.request('/api/session/create', { method: 'POST', headers: { origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await f.request('/', { headers: { origin: 'null' } })).status, 403);
  assert.equal((await f.request('/api/test', { method: 'POST', headers: { origin: '' } })).status, 403);
  assert.equal((await f.request('/http://attacker.invalid')).status, 404);
  assert.equal((await f.request('//attacker.invalid/api')).status, 400);
  assert.equal(f.seen.length, 0);
  const publicStatus = await new Promise((resolve, reject) => {
    const request = http.get(f.origin + '/plugins/example/client.js?rev=x', { headers: { host: new URL(PUBLIC_ORIGIN).host, origin: PUBLIC_ORIGIN, 'x-forwarded-host': 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(publicStatus, 200);
  assert.equal(f.seen.at(-1).headers.host, new URL(PUBLIC_ORIGIN).host); assert.equal(f.seen.at(-1).headers.origin, PUBLIC_ORIGIN); assert.equal(f.seen.at(-1).headers['x-forwarded-host'], undefined);
});

test('proxy strips hop-by-hop headers and retains native cookies', async t => {
  const f = await fixture(t);
  const response = await f.request('/plugins/example/client.js');
  assert.equal(await response.text(), 'native-asset'); assert.equal(response.headers.get('x-hop'), null); assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await f.request('/__test/login')).status, 404);
});

function upgrade(f, path, { origin = f.origin, cookie = 'fixture=authorized', suffix = '' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(f.app.server.address().port, '127.0.0.1'); let data = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${new URL(f.origin).host}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: synthetic\r\n\r\n${suffix}`));
    socket.on('data', chunk => { data += chunk; if (data.includes('\r\n\r\n') && (!suffix || !data.startsWith('HTTP/1.1 101') || data.endsWith(suffix))) { socket.destroy(); resolve(data); } });
  });
}
test('WS only exact remote.mux; native auth and raw head bytes retained', async t => {
  const f = await fixture(t);
  assert.match(await upgrade(f, '/api/remote.mux', { suffix: 'fixture-bytes' }), /^HTTP\/1.1 101[\s\S]*fixture-bytes$/);
  assert.match(await upgrade(f, '/api/remote.mux', { cookie: '' }), /^HTTP\/1.1 401/);
  assert.match(await upgrade(f, '/api/other'), /^HTTP\/1.1 403/);
  assert.match(await upgrade(f, '/api/remote.mux?target=evil'), /^HTTP\/1.1 403/);
  assert.match(await upgrade(f, '/api/remote.mux', { origin: 'https://evil.invalid' }), /^HTTP\/1.1 403/);
});

test('own dist assets reject escaping symlinks and unsafe methods', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'mobile-server-fixture-'));
  const { mkdir } = await import('node:fs/promises');
  const dist = join(temporary, 'dist'); await mkdir(dist);
  await writeFile(join(dist, 'mobile.js'), 'fixture-mobile');
  await writeFile(join(temporary, 'private.txt'), 'never-serve');
  await symlink(join(temporary, 'private.txt'), join(dist, 'escape.js'));
  t.after(() => rm(temporary, { recursive: true })); // Only this test's freshly allocated root.
  const f = await fixture(t, { distDirectory: dist });
  const asset = await f.request('/mobile-assets/mobile.js'); assert.equal(asset.status, 200); assert.equal(await asset.text(), 'fixture-mobile');
  assert.equal((await f.request('/mobile-assets/escape.js')).status, 403);
  assert.equal((await f.request('/mobile-assets/%2e%2e%2fprivate.txt')).status, 403);
  assert.equal((await f.request('/mobile-assets/mobile.js', { method: 'POST' })).status, 405);
  assert.equal(f.seen.length, 0);
});

test('explicit test-login reads a private startup link only on validated loopback', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'mobile-server-login-fixture-'));
  const connectionFile = join(temporary, 'connection.json');
  t.after(() => rm(temporary, { recursive: true }));
  const f = await fixture(t, { allowTestLogin: true, connectionFile, loginLocation: './' });
  await writeFile(connectionFile, JSON.stringify({ local: `http://127.0.0.1:${f.native.address().port}/?token=synthetic` }), { mode: 0o600 });
  const response = await f.request('/__test/login'); assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/'); assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  const rejected = await new Promise((resolve, reject) => {
    const request = http.get(f.origin + '/__test/login', { headers: { host: new URL(PUBLIC_ORIGIN).host, origin: PUBLIC_ORIGIN } }, result => { result.resume(); resolve(result.statusCode); }); request.on('error', reject);
  });
  assert.equal(rejected, 404);
  await writeFile(connectionFile, JSON.stringify({ local: 'http://attacker.invalid/?token=synthetic' }));
  assert.equal((await f.request('/__test/login')).status, 403);
});

test('metadata denies preset derived from user fields and never emits non-scalars', () => {
  assert.equal(companionMetadata({ header: { id: 'x' }, metadataSnapshot: { agentPreset: 'companion' } }), null);
  assert.deepEqual(companionMetadata({ header: { id: 'x', agentPreset: 'companion' }, title: { unsafe: true }, createdAt: {}, updatedAt: 'short' }), { id: 'x', updatedAt: 'short' });
});

test('actual globalThis bracket bootstrap is transformed and authorizes metadata', async t => {
  const f = await fixture(t, { rootHtml: '<html><script>globalThis["__DSH_BOOT__"] = {};</script></html>' });
  const root = await f.request('/'); assert.equal(root.status, 200); assert.match(await root.text(), /<!--mobile-->/);
  assert.ok(f.seen.some(row => row.path === '/api/agentPresets/list'));
  const list = await f.request('/mobile-api/chats'); assert.equal(list.status, 200);
  assert.equal((await list.json()).profile, 'companion'); assert.equal(f.catalogReads(), 1);
});

test('internal parsed RPC explicitly requests identity even when browser accepts gzip', async t => {
  const f = await fixture(t, { compressRpc: true });
  const root = await f.request('/', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(root.status, 200); assert.match(await root.text(), /<!--mobile-->/);
  const created = await f.request('/mobile-api/chats', { method: 'POST', body: '{}', headers: { 'accept-encoding': 'gzip', 'content-type': 'application/json' } });
  assert.equal(created.status, 201); assert.deepEqual(await created.json(), { id: 'new-companion' });
  const parsed = f.seen.filter(row => ['/api/agentPresets/list', '/api/session/create'].includes(row.path));
  assert.equal(parsed.length, 3);
  for (const row of parsed) assert.equal(row.headers['accept-encoding'], 'identity');
  for (const row of f.seen.filter(row => row.path === '/')) assert.equal(row.headers['accept-encoding'], 'identity');
});

test('native headers with no title or update projection remain valid companion metadata', async t => {
  const f = await fixture(t, { snapshots: [{ header: { id: 'minimal', agentPreset: 'companion' } }] });
  const response = await f.request('/mobile-api/chats'); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { chats: [{ id: 'minimal' }], hasMore: false, profile: 'companion' });
  const detail = await f.request('/mobile-api/chats/minimal'); assert.equal(detail.status, 200);
  assert.deepEqual(await detail.json(), { chat: { id: 'minimal' }, profile: 'companion' });
  assert.deepEqual(companionMetadata({ header: { id: 'bounded', agentPreset: 'companion' }, metadataSnapshot: { title: 'x'.repeat(500), createdAt: Infinity, updatedAt: 'x'.repeat(65), credentials: { secret: 'fixture' } } }), { id: 'bounded', title: 'x'.repeat(240) });
});

test('persisted foreign header revokes a previously verified creation-cache entry', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/mobile-api/chats', { method: 'POST', body: '{}' })).status, 201);
  assert.equal((await f.request('/mobile-api/chats/new-companion')).status, 200);
  f.snapshots.push({ header: { id: 'new-companion', agentPreset: 'ordinary' } });
  assert.equal((await f.request('/mobile-api/chats/new-companion')).status, 403);
  const list = await (await f.request('/mobile-api/chats')).json();
  assert.ok(!list.chats.some(row => row.id === 'new-companion'));
});

test('metadata response caps rows at 100 and signals omitted older entries', async t => {
  const snapshots = Array.from({ length: 105 }, (...[, index]) => ({ header: { id: `owned-${index}`, agentPreset: 'companion', createdAt: index } }));
  const f = await fixture(t, { snapshots });
  const response = await f.request('/mobile-api/chats?limit=99999'); assert.equal(response.status, 200);
  const list = await response.json(); assert.equal(list.chats.length, 100); assert.equal(list.hasMore, true);
  assert.equal(list.chats[0].id, 'owned-104'); assert.equal(list.chats.at(-1).id, 'owned-5');
});

test('unexpected native creation preset does not authorize metadata via cache', async t => {
  const f = await fixture(t, { createResult: { sessionId: 'bad-create', agentPreset: 'ordinary' } });
  assert.equal((await f.request('/mobile-api/chats', { method: 'POST', body: '{}' })).status, 502);
  assert.equal((await f.request('/mobile-api/chats/bad-create')).status, 403);
  assert.ok(!(await (await f.request('/mobile-api/chats')).json()).chats.some(row => row.id === 'bad-create'));
});

test('creation body cap rejects oversized caller data before native mutation', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/mobile-api/chats', { method: 'POST', body: 'x'.repeat(4097) })).status, 413);
  assert.ok(!f.seen.some(row => row.path === '/api/session/create'));
});

test('unrecognized native bootstrap fails closed instead of showing original desktop', async t => {
  const f = await fixture(t, { rootHtml: '<html><script>self.__DSH_BOOT__ = {};</script><div>desktop-marker</div></html>' });
  const root = await f.request('/'); assert.equal(root.status, 502);
  const error = await root.json(); assert.equal(error.error.code, 'unsupported_bootstrap');
  assert.ok(!JSON.stringify(error).includes('desktop-marker'));
  assert.equal((await f.request('/mobile-api/chats')).status, 401);
  assert.equal(f.catalogReads(), 0);
});

test('native root token redirect keeps its relative Location outside the audit-only seam', async t => {
  const f = await fixture(t, { loginLocation: './' });
  const root = await f.request('/?token=synthetic', { headers: { cookie: '' } });
  assert.equal(root.status, 303); assert.equal(root.headers.get('location'), './');
});

test('generic native API deliberately remains the authenticated owner API, not a guessed RPC firewall', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/fixture-owner-operation', { method: 'POST', body: 'fixture-owner-request', headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 200); assert.equal(await response.text(), 'native-asset');
  assert.equal(f.seen.length, 1); assert.equal(f.seen[0].path, '/api/fixture-owner-operation');
  assert.equal(f.seen[0].body, 'fixture-owner-request'); assert.equal(f.seen[0].headers.cookie, 'fixture=authorized');
  assert.equal(f.catalogReads(), 0);
});
