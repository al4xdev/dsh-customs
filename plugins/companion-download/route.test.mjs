import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSnapshotRegistry } from './registry.mjs';
import { createDownloadRoute } from './route.mjs';
import { proxyTicketDownload } from './proxy.mjs';

const ORIGIN = 'https://dsh.tail37b3d7.ts.net:8443';
const PUBLIC_HOST = new URL(ORIGIN).host;
function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}
function send(port, { method = 'GET', path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, agent: false, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}
async function fixture(t) {
  const registry = createSnapshotRegistry({ origin: ORIGIN });
  const route = createDownloadRoute(registry, { origin: ORIGIN });
  const server = await listen((req, res) => route.handler(req, res));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); }); await registry.close(); });
  const publish = (bytes, name = 'relatório final.pdf') => {
    const link = registry.reserve(() => {}, async () => {}, 'scope').commit(bytes, name);
    return new URL(link.url).pathname;
  };
  return { registry, port: server.address().port, publish };
}

test('route serves one exact snapshot as an attachment, then forgets it', async t => {
  const f = await fixture(t);
  // The registry owns (and later wipes) the committed buffer: compare a copy.
  const bytes = Buffer.alloc(200_000, 3), expected = Buffer.from(bytes);
  const path = f.publish(bytes);
  const head = await send(f.port, { method: 'HEAD', path, headers: { host: PUBLIC_HOST } });
  assert.equal(head.status, 200); assert.equal(head.headers['content-length'], String(bytes.length)); assert.equal(head.body.length, 0);
  const got = await send(f.port, { path, headers: { host: PUBLIC_HOST, 'sec-fetch-site': 'none' } });
  assert.equal(got.status, 200); assert.ok(got.body.equals(expected), 'exact bytes');
  assert.match(got.headers['content-disposition'], /^attachment; filename="relat_rio final\.pdf"; filename\*=UTF-8''relat%C3%B3rio%20final\.pdf$/);
  assert.equal(got.headers['cache-control'], 'private, no-store'); assert.equal(got.headers['x-content-type-options'], 'nosniff');
  assert.equal((await send(f.port, { path, headers: { host: PUBLIC_HOST } })).status, 404, 'one successful transfer');
  assert.ok(bytes.every(byte => byte === 0), 'snapshot memory is wiped after the successful transfer');
});

test('route refuses foreign authority, ranges, bodies, other methods and malformed tickets without consuming', async t => {
  const f = await fixture(t);
  const path = f.publish(Buffer.from('secret-ish'));
  const cases = [
    [{ path, headers: { host: 'evil.example' } }, 403], [{ path, headers: { host: PUBLIC_HOST, origin: 'https://evil.example' } }, 403],
    [{ path, headers: { host: PUBLIC_HOST, 'sec-fetch-site': 'cross-site' } }, 403], [{ path, headers: { host: PUBLIC_HOST, 'content-length': '1' } }, 403],
    [{ path, headers: { host: PUBLIC_HOST, purpose: 'prefetch' } }, 403], [{ path, headers: { host: PUBLIC_HOST, range: 'bytes=0-1' } }, 416],
    [{ method: 'POST', path, headers: { host: PUBLIC_HOST, origin: ORIGIN } }, 405], [{ path: `${path}?x=1`, headers: { host: PUBLIC_HOST } }, 404],
    [{ path: '/companion-download/short', headers: { host: PUBLIC_HOST } }, 404], [{ path: `/companion-download/${'A'.repeat(43)}`, headers: { host: PUBLIC_HOST } }, 404],
  ];
  for (const [request, status] of cases) assert.equal((await send(f.port, request)).status, status, JSON.stringify(request));
  assert.equal((await send(f.port, { path, headers: { host: PUBLIC_HOST } })).status, 200, 'refusals did not burn the ticket');
});

test('3082 proxy forwards only exact ticket GET/HEAD and rejects unsafe upstream answers', async t => {
  let answer = (req, res) => { res.writeHead(200, { 'content-length': '3', 'content-disposition': 'attachment; filename="a"' }); res.end('abc'); };
  const seen = [];
  const backend = await listen((req, res) => { seen.push({ url: req.url, headers: req.headers }); answer(req, res); });
  const proxy = await listen((req, res) => proxyTicketDownload(req, res, { backend: `http://127.0.0.1:${backend.address().port}`, publicOrigin: ORIGIN }));
  t.after(async () => { for (const server of [proxy, backend]) await new Promise(resolve => { server.close(resolve); }); });
  const path = `/companion-download/${'B'.repeat(43)}`;
  const ok = await send(proxy.address().port, { path, headers: { host: PUBLIC_HOST, cookie: 'never-forwarded' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.toString(), 'abc'); assert.equal(ok.headers['content-type'], 'application/octet-stream');
  assert.equal(seen[0].headers.cookie, undefined, 'credentials are never forwarded');
  for (const [request, status] of [[{ path: '/companion-download/x', headers: { host: PUBLIC_HOST } }, 404], [{ path, headers: { host: 'evil.example' } }, 403], [{ method: 'DELETE', path, headers: { host: PUBLIC_HOST } }, 405]]) {
    assert.equal((await send(proxy.address().port, request)).status, status);
  }
  for (const unsafe of [
    (req, res) => { res.writeHead(200, { 'set-cookie': 'a=b', 'content-length': '1', 'content-disposition': 'attachment' }); res.end('a'); },
    (req, res) => { res.writeHead(200, { 'content-length': '1' }); res.end('a'); },
    (req, res) => { res.writeHead(500); res.end(); },
  ]) { answer = unsafe; assert.equal((await send(proxy.address().port, { path, headers: { host: PUBLIC_HOST } })).status, 502); }
  answer = (req, res) => { res.writeHead(429); res.end(); };
  assert.equal((await send(proxy.address().port, { path, headers: { host: PUBLIC_HOST } })).status, 429);
});
