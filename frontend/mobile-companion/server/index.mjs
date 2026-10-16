import http from 'node:http';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { companionMetadata, createSessionCatalog } from './session-catalog.mjs';
import { proxyTicketDownload } from '../../../plugins/companion-download/proxy.mjs';

export const BACKEND = 'http://127.0.0.1:3081';
export const PUBLIC_ORIGIN = 'https://dsh.tail37b3d7.ts.net:8443';
const MAX_BODY = 1024 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const bootPresent = text => /(?:window|globalThis)\s*(?:\.__DSH_BOOT__|\[\s*["']__DSH_BOOT__["']\s*\])\s*=/.test(text);
const failure = (status, code) => Object.assign(new Error(code), { status, code });
const downloadPath = raw => typeof raw === 'string' && (raw === '/companion-download' || raw.startsWith('/companion-download/'));

function cleanHeaders(headers) {
  const blocked = new Set([...HOP, ...String(headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase()) && !name.toLowerCase().startsWith('x-forwarded-') && !['forwarded', 'proxy-connection'].includes(name.toLowerCase())));
}
async function bytes(stream, max = MAX_BODY) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) throw failure(413, 'request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

/** Backend injection is an isolated loopback fixture seam; CLI never exposes it. */
export function createMobileServer({ port = 3082, host = '127.0.0.1', backend = BACKEND, transformHtml, distDirectory = resolve(import.meta.dirname, '../dist'), sessionCatalog, cwd = '/home/alex/git/my/dsh-customs', allowTestLogin = false, connectionFile = '/home/alex/.dsh/session-companion/connection.json' } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if (!isIPv4(host)) throw new Error('Host must be an IPv4 address');
  if (allowTestLogin && host !== '127.0.0.1') throw new Error('Test login requires loopback binding');
  if (typeof transformHtml !== 'function') throw new Error('A mobile HTML transform hook is required');
  const target = new URL(backend);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Backend must be a loopback HTTP fixture');
  let catalogPromise;
  const catalog = () => catalogPromise ??= Promise.resolve(sessionCatalog ?? createSessionCatalog());
  const sockets = new Set();
  const outgoing = new Set();
  let closing = false;
  const recentCreates = new Map();
  function creationMetadata() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, row] of recentCreates) if (row.createdAt < cutoff) recentCreates.delete(id);
    return recentCreates;
  }
  const localOrigins = () => new Set([`http://127.0.0.1:${server.address()?.port ?? port}`, `http://localhost:${server.address()?.port ?? port}`]);
  // Only this machine's interface IPs are trusted, not arbitrary Host headers.
  const addresses = new Set(host === '0.0.0.0'
    ? Object.values(networkInterfaces()).flatMap(rows => (rows ?? []).filter(row => row.family === 'IPv4').map(row => row.address))
    : [host]);
  const networkOrigins = () => new Set([...addresses].map(address => `http://${address}:${server.address()?.port ?? port}`));

  function validate(req, upgrade = false) {
    const host = req.headers.host;
    const local = [...localOrigins()].find(origin => new URL(origin).host === host);
    const network = [...networkOrigins()].find(origin => new URL(origin).host === host);
    const publicHost = new URL(PUBLIC_ORIGIN).host;
    if (!local && !network && host !== publicHost) throw failure(403, 'invalid_host');
    const origin = req.headers.origin;
    if (origin !== undefined && (typeof origin !== 'string' || (local ? !localOrigins().has(origin) : origin !== (network ?? PUBLIC_ORIGIN)))) throw failure(403, 'invalid_origin');
    if ((upgrade || !['GET', 'HEAD'].includes(req.method)) && !origin) throw failure(403, 'origin_required');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'invalid_origin');
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\') || /[\r\n]/.test(req.url)) throw failure(400, 'invalid_path');
    // Normalize only after validating frontend Host and Origin. Public Host remains
    // untouched so the native backend can apply its trusted TLS-proxy policy.
    const headers = cleanHeaders(req.headers);
    if (local || network) {
      headers.host = target.host;
      if (origin) headers.origin = target.origin;
    }
    return { headers, local: Boolean(local), url: new URL(req.url, 'http://fixed.invalid') };
  }
  function request(path, { method = 'GET', headers, body } = {}) {
    return new Promise((resolveRequest, reject) => {
      const upstream = http.request({ hostname: target.hostname, port: target.port, method, path, headers }, resolveRequest);
      outgoing.add(upstream); upstream.once('close', () => outgoing.delete(upstream));
      upstream.setTimeout(30000, () => upstream.destroy(new Error('upstream_timeout')));
      upstream.once('error', reject);
      upstream.end(body);
    });
  }
  function responseHeaders(upstream) {
    const headers = cleanHeaders(upstream.headers);
    // Native token exchange redirects to its root. Keep the navigation same-origin,
    // without touching cookies or turning arbitrary external Location into a proxy.
    if (typeof headers.location === 'string' && headers.location.startsWith(target.origin + '/')) headers.location = headers.location.slice(target.origin.length);
    headers['x-content-type-options'] = 'nosniff';
    return headers;
  }
  async function rpc(headers, method, args) {
    const body = Buffer.from(JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }));
    const upstream = await request(`/api/${method}`, { method: 'POST', headers: { ...headers, origin: headers.origin ?? (headers.host === target.host ? target.origin : PUBLIC_ORIGIN), 'accept-encoding': 'identity', 'content-type': 'application/json', 'content-length': body.length }, body });
    const data = await bytes(upstream, MAX_BODY);
    if (upstream.statusCode !== 200) throw failure(upstream.statusCode === 401 ? 401 : 502, 'native_request_failed');
    let envelope; try { envelope = JSON.parse(data); } catch { throw failure(502, 'native_response_invalid'); }
    if (envelope.result?.ok !== true) throw failure(502, 'native_request_failed');
    return envelope.result.value;
  }
  async function authorize(res, headers) {
    const authHeaders = { ...headers, 'accept-encoding': 'identity' };
    delete authHeaders['content-length']; delete authHeaders['content-type'];
    const upstream = await request('/', { headers: authHeaders });
    const body = await bytes(upstream, 8 * MAX_BODY);
    if (upstream.statusCode !== 200 || !bootPresent(body.toString('utf8'))) {
      res.writeHead(upstream.statusCode === 200 ? 401 : upstream.statusCode, responseHeaders(upstream)); res.end(body); return false;
    }
    return true;
  }
  async function checkProfile(headers) {
    const roster = await rpc(headers, 'agentPresets/list', {});
    if (!Array.isArray(roster?.presets) || roster.presets.length !== 1 || roster.presets[0].id !== 'companion' || roster.presets[0].broken) throw failure(409, 'profile_mismatch');
  }
  async function membership(id) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw failure(400, 'invalid_session_id');
    const source = await catalog();
    const snapshot = source.get ? await source.get(id) : (await source.list()).find(row => row.header?.id === id);
    // Empty newly created native sessions may not have materialized on disk yet.
    // Only a verified create response seeds this bounded bridge; any stored header
    // wins, including a foreign-preset header that must fail closed.
    const chat = snapshot ? companionMetadata(snapshot) : creationMetadata().get(id);
    if (!chat) throw failure(403, 'foreign_session');
    return chat;
  }

  async function handle(req, res) {
    const { headers, local, url } = validate(req);
    if (closing) throw failure(503, 'closing');
    // Inspect the RAW prefix before normalized pathname routing: traversal/query
    // variants must fail in the ticket helper, never fall through into /api.
    if (downloadPath(req.url)) return proxyTicketDownload(req, res, { backend: target.origin, publicOrigin: PUBLIC_ORIGIN });
    if (url.pathname === '/__test/login') {
      if (!allowTestLogin || !local || req.method !== 'GET') throw failure(404, 'not_found');
      const link = JSON.parse(await readFile(connectionFile, 'utf8'));
      const startup = new URL(link.local);
      if (startup.origin !== target.origin || startup.pathname !== '/') throw failure(403, 'invalid_test_connection');
      const upstream = await request(startup.pathname + startup.search, { headers });
      upstream.once('error', () => res.destroy());
      const loginHeaders = responseHeaders(upstream);
      // The native './' redirect is relative to '/', not this audit-only route.
      if (upstream.statusCode === 303 && loginHeaders.location === './') loginHeaders.location = '/';
      res.writeHead(upstream.statusCode, loginHeaders); upstream.pipe(res); return;
    }
    if (url.pathname.startsWith('/mobile-api/')) {
      if (!await authorize(res, headers)) return;
      await checkProfile(headers);
      if (url.pathname === '/mobile-api/chats' && req.method === 'GET') {
        const rawLimit = url.searchParams.get('limit') ?? '50';
        if (!/^\d+$/.test(rawLimit)) throw failure(400, 'invalid_limit');
        const limit = Math.min(100, Math.max(1, Number(rawLimit)));
        const snapshots = await (await catalog()).list();
        const combined = new Map(creationMetadata());
        for (const snapshot of snapshots) {
          const row = companionMetadata(snapshot);
          if (row) combined.set(row.id, row);
          else if (snapshot.header?.id) combined.delete(snapshot.header.id);
        }
        // Official list hints are cached projections, not agent/history opens.
        // Supplement display fields only after the independent header gate.
        try {
          const summaries = await rpc(headers, 'session/list', { _request: {} });
          for (const summary of Array.isArray(summaries?.items) ? summaries.items : []) {
            const row = combined.get(summary.sessionId);
            if (!row) continue;
            const title = summary.projections?.values?.title;
            if (typeof title === 'string' && title.trim()) row.title = title.slice(0, 240);
            if (typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt)) row.updatedAt = summary.updatedAt;
          }
        } catch { /* Display hints are optional; membership never depends on them. */ }
        const rows = [...combined.values()].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
        json(res, 200, { chats: rows.slice(0, limit), hasMore: rows.length > limit, profile: 'companion' }); return;
      }
      if (url.pathname === '/mobile-api/chats' && req.method === 'POST') {
        // Never adopt a caller-supplied id, cwd, or preset. Native create assigns id.
        await bytes(req, 4096);
        const value = await rpc(headers, 'session/create', { request: { cwd, agentPreset: 'companion' } });
        if (typeof value?.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.sessionId) || value.agentPreset !== 'companion') throw failure(502, 'native_response_invalid');
        const recent = creationMetadata();
        recent.set(value.sessionId, { id: value.sessionId, createdAt: Date.now() });
        while (recent.size > 100) recent.delete(recent.keys().next().value);
        json(res, 201, { id: value.sessionId }); return;
      }
      const match = /^\/mobile-api\/chats\/([^/]+)$/.exec(url.pathname);
      if (match && req.method === 'GET') { json(res, 200, { chat: await membership(decodeURIComponent(match[1])), profile: 'companion' }); return; }
      throw failure(404, 'not_found');
    }
    if (url.pathname.startsWith('/mobile-assets/')) {
      if (!['GET', 'HEAD'].includes(req.method)) throw failure(405, 'method_not_allowed');
      const path = resolve(distDirectory, decodeURIComponent(url.pathname.slice('/mobile-assets/'.length)));
      const root = await realpath(distDirectory);
      const actual = await realpath(path).catch(() => { throw failure(404, 'not_found'); });
      if (!actual.startsWith(root + sep) || !(await stat(actual)).isFile()) throw failure(403, 'invalid_asset');
      const body = await readFile(actual);
      res.writeHead(200, { 'content-type': MIME[extname(actual)] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : body); return;
    }
    // The target always remains fixed; only native root, API, and asset routes pass.
    if (!(url.pathname === '/' || /^\/(?:api|assets|plugins|client|resources)\//.test(url.pathname) || /^\/(?:favicon\.ico|favicon\.svg|manifest\.json)$/.test(url.pathname))) throw failure(404, 'not_found');
    const rootGet = url.pathname === '/' && req.method === 'GET';
    const upstream = await request(req.url, { method: req.method, headers: { ...headers, ...(rootGet ? { 'accept-encoding': 'identity' } : {}) }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : await bytes(req) });
    if (rootGet && upstream.statusCode === 200) {
      const original = await bytes(upstream, 8 * MAX_BODY);
      if (bootPresent(original.toString('utf8'))) {
        await checkProfile(headers);
        const transformed = await transformHtml(original.toString('utf8'), { assets: '/mobile-assets/', profile: 'companion', distDirectory });
        const output = Buffer.from(transformed);
        const forwarded = responseHeaders(upstream);
        for (const key of ['content-length', 'content-encoding', 'etag', 'last-modified']) delete forwarded[key];
        res.writeHead(200, { ...forwarded, 'content-length': output.length, 'cache-control': 'no-store' }); res.end(output); return;
      }
      if (original.includes('__DSH_BOOT__') || original.includes('__ModuleLoader__')) throw failure(502, 'unsupported_bootstrap');
      res.writeHead(200, responseHeaders(upstream)); res.end(original); return;
    }
    upstream.once('error', () => res.destroy());
    res.writeHead(upstream.statusCode, responseHeaders(upstream)); upstream.pipe(res);
  }
  const server = http.createServer((req, res) => handle(req, res).catch(error => {
    if (res.headersSent) { res.destroy(); return; }
    if (downloadPath(req.url)) {
      // The ticket is a bearer secret. Never reflect an arbitrary code/stack/URL.
      const status = [400, 403, 404, 405, 416, 429, 503].includes(error?.status) ? error.status : 502;
      json(res, status, { error: { code: 'download_unavailable', message: 'Download unavailable.' } }); return;
    }
    json(res, error.status ?? 502, { error: { code: error.code ?? 'upstream_unavailable', message: 'Request could not be completed.' } });
  }));
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    let validated;
    try { validated = validate(req, true); if (req.method !== 'GET' || validated.url.pathname !== '/api/remote.mux' || validated.url.search || req.headers.upgrade?.toLowerCase() !== 'websocket') throw failure(403, 'invalid_upgrade'); }
    catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const upstream = http.request({ hostname: target.hostname, port: target.port, method: 'GET', path: '/api/remote.mux', headers: { ...validated.headers, connection: 'Upgrade', upgrade: 'websocket' } });
    outgoing.add(upstream); upstream.once('close', () => outgoing.delete(upstream));
    upstream.on('upgrade', (response, remote, remoteHead) => {
      sockets.add(remote); remote.once('close', () => sockets.delete(remote));
      const headers = { ...cleanHeaders(response.headers), connection: 'Upgrade', upgrade: 'websocket' };
      socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n${Object.entries(headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => `${key}: ${item}\r\n`)).join('')}\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote); remote.pipe(socket);
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
    });
    upstream.on('response', response => { socket.write(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.end(); response.resume(); });
    upstream.on('error', () => socket.destroy());
    upstream.setTimeout(10000, () => upstream.destroy()); socket.on('close', () => upstream.destroy()); upstream.end();
  });
  return {
    server,
    listen: () => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolveListen(server.address()); }); }),
    close: async () => {
      closing = true;
      for (const upstream of outgoing) upstream.destroy();
      const stopped = server.listening ? new Promise((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); }) : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      await stopped;
      if (catalogPromise) await (await catalogPromise).close?.(); else await sessionCatalog?.close?.();
    },
  };
}
