import http from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_BYTES } from './registry.mjs';

const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-disposition', 'cache-control', 'x-content-type-options', 'referrer-policy', 'content-security-policy', 'x-frame-options', 'accept-ranges'];
function fail(req, res, status) {
  if (res.headersSent) { res.destroy(); return; }
  const body = Buffer.from('download-unavailable');
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length,
    'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
}
/** Parent-review candidate only. Call AFTER the existing proxy's validate(req).
 * No credentials, arbitrary target, body, redirect, encoded path, query or fallback.
 */
export async function proxyTicketDownload(req, res, { backend, publicOrigin = 'https://dsh.tail37b3d7.ts.net:8443' }) {
  const target = new URL(backend);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('invalid-download-upstream');
  const authority = new URL(publicOrigin);
  if (authority.protocol !== 'https:' || authority.origin !== publicOrigin) throw new Error('invalid-download-origin');
  const counts = new Map();
  for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
    const key = req.rawHeaders[i].toLowerCase(); counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (req.headers.host !== authority.host || req.headers.origin !== undefined && req.headers.origin !== publicOrigin ||
      req.headers['sec-fetch-site'] !== undefined && !['none', 'same-origin', 'same-site'].includes(req.headers['sec-fetch-site']) ||
      ['host', 'origin', 'sec-fetch-site', 'range', 'content-length'].some(key => (counts.get(key) ?? 0) > 1)) return fail(req, res, 403);
  if (!/^\/companion-download\/[A-Za-z0-9_-]{43}$/.test(req.url ?? '')) return fail(req, res, 404);
  if (!['GET', 'HEAD'].includes(req.method)) return fail(req, res, 405);
  if (req.headers.range !== undefined) return fail(req, res, 416);
  if (req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') return fail(req, res, 400);
  if (req.headers.purpose !== undefined || req.headers['sec-purpose'] !== undefined) return fail(req, res, 403);
  // Preserve public Host/Origin for the existing backend guard, nothing else.
  const forwarded = Object.fromEntries(['host', 'origin', 'sec-fetch-site'].flatMap(key => typeof req.headers[key] === 'string' ? [[key, req.headers[key]]] : []));
  let upstream, request;
  const deadline = AbortSignal.timeout(30_000);
  const abort = () => { request?.destroy(); upstream?.destroy(); };
  res.once('close', abort);
  try {
    upstream = await new Promise((resolveRequest, reject) => {
      request = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: forwarded, signal: deadline }, resolveRequest);
      request.once('error', reject); request.end();
    });
    if (upstream.headers['set-cookie'] !== undefined || upstream.headers.location !== undefined || upstream.headers['content-encoding'] !== undefined) { upstream.destroy(); return fail(req, res, 502); }
    if (upstream.statusCode !== 200) {
      const status = [403, 404, 405, 416, 429, 503].includes(upstream.statusCode) ? upstream.statusCode : 502;
      upstream.destroy(); return fail(req, res, status);
    }
    const rawLength = upstream.headers['content-length'];
    if (typeof rawLength !== 'string' || !/^\d{1,8}$/.test(rawLength) || Number(rawLength) > MAX_BYTES || !String(upstream.headers['content-disposition']).startsWith('attachment;')) {
      upstream.destroy(); return fail(req, res, 502);
    }
    const length = Number(rawLength);
    const headers = Object.fromEntries(RESPONSE_HEADERS.flatMap(key => typeof upstream.headers[key] === 'string' ? [[key, upstream.headers[key]]] : []));
    headers['cache-control'] = 'private, no-store'; headers['referrer-policy'] = 'no-referrer'; headers['x-content-type-options'] = 'nosniff';
    headers['content-type'] = 'application/octet-stream'; headers['accept-ranges'] = 'none';
    headers['content-security-policy'] = "sandbox; default-src 'none'"; headers['x-frame-options'] = 'DENY';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { upstream.destroy(); res.end(); return; }
    let received = 0;
    const bounded = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > length || received > MAX_BYTES ? new Error('download-size-mismatch') : null, chunk);
    }, flush(callback) { callback(received !== length ? new Error('download-size-mismatch') : null); } });
    await pipeline(upstream, bounded, res, { signal: deadline });
  } catch { abort(); fail(req, res, 502); }
  finally { res.removeListener('close', abort); }
}
