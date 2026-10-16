import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PREFIX, TICKET, httpsOrigin } from './registry.mjs';

const headers = Object.freeze({
  'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', 'content-security-policy': "sandbox; default-src 'none'",
  'x-frame-options': 'DENY', 'accept-ranges': 'none',
});
const quoted = name => name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
const encoded = name => encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
function reply(req, res, status, code, extra = {}) {
  if (res.headersSent) { res.destroy(); return; }
  const body = Buffer.from(code);
  res.writeHead(status, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length, ...extra });
  res.end(req.method === 'HEAD' ? undefined : body);
}
function cleanAuthority(req, publicOrigin, localHost) {
  const expectedHost = new URL(publicOrigin).host;
  const allowed = req.headers.host === expectedHost || localHost && req.headers.host === localHost;
  const counts = new Map();
  for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
    const key = req.rawHeaders[i].toLowerCase(); counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (!allowed || ['host', 'origin', 'sec-fetch-site', 'range', 'content-length'].some(key => (counts.get(key) ?? 0) > 1)) return false;
  if (req.headers.origin !== undefined && req.headers.origin !== publicOrigin && !(localHost && req.headers.origin === `http://${localHost}`)) return false;
  if (req.headers['sec-fetch-site'] !== undefined && !['none', 'same-origin', 'same-site'].includes(req.headers['sec-fetch-site'])) return false;
  if (req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') return false;
  if (req.headers.purpose !== undefined || req.headers['sec-purpose'] !== undefined) return false;
  return true;
}

/** No auth-cookie exception is installed here: this owns only an opaque non-/api route. */
export function createDownloadRoute(registry, { origin, localHost } = {}) {
  httpsOrigin(origin);
  return Object.freeze({ kind: 'prefix', path: PREFIX, async handler(req, res) {
    if (!cleanAuthority(req, origin, localHost)) return reply(req, res, 403, 'download-refused');
    const match = typeof req.url === 'string' && req.url.match(/^\/companion-download\/([A-Za-z0-9_-]{43})$/);
    if (!match || !TICKET.test(match[1])) return reply(req, res, 404, 'download-unavailable');
    if (!['GET', 'HEAD'].includes(req.method)) return reply(req, res, 405, 'method-not-allowed', { allow: 'GET, HEAD' });
    if (req.headers.range !== undefined) return reply(req, res, 416, 'range-not-supported');
    let lease;
    try {
      lease = registry.acquire(match[1], req.method === 'HEAD');
      await lease.verify();
      res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': lease.size,
        'content-disposition': `attachment; filename="${quoted(lease.name)}"; filename*=UTF-8''${encoded(lease.name)}` });
      if (req.method === 'HEAD') { res.end(); return; }
      const deadline = AbortSignal.timeout(30_000);
      const signal = AbortSignal.any([lease.signal, deadline]);
      async function* chunks() {
        for (let offset = 0; offset < lease.size; offset += 64 * 1024) {
          signal.throwIfAborted(); await lease.verify(); signal.throwIfAborted();
          yield lease.chunk(offset, 64 * 1024);
        }
      }
      // pipeline owns backpressure, disconnect cancellation and quiescence. Never zero
      // a revoked snapshot until it has detached every queued HTTP chunk view.
      await pipeline(Readable.from(chunks()), res, { signal });
      lease.release(true);
    } catch (error) {
      lease?.release?.(false);
      const code = error?.code;
      reply(req, res, ['companion-files/busy', 'companion-files/rate-limited'].includes(code) ? 429 : 404, 'download-unavailable');
    }
  } });
}
