export const PUBLIC_ORIGIN = 'https://dsh.tail37b3d7.ts.net:8443';

const MAX_RAW_ENTRIES = 2048;
const MAX_HEADER_BYTES = 16384;
const invalidOptions = () => { throw new TypeError('companion-transport/invalid-policy-options'); };
const refusal = (status, code) => ({ status, code });

function canonicalOrigin(value, protocol) {
  if (typeof value !== 'string' || value.length > 2048) return invalidOptions();
  try {
    const url = new URL(value);
    // URL parsing is configuration validation ONLY. Request Origin/Host values
    // are compared literally: no scheme/path/userinfo/port normalization loophole.
    if (url.protocol !== protocol || url.origin !== value || url.username || url.password) return invalidOptions();
    return url;
  } catch { return invalidOptions(); }
}
function policyOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return invalidOptions();
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) return invalidOptions();
  if (Reflect.ownKeys(options).some(key => typeof key !== 'string' || !['publicOrigin', 'localOrigins', 'upgrade'].includes(key))) return invalidOptions();
  if (Object.values(Object.getOwnPropertyDescriptors(options)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) return invalidOptions();
  const { publicOrigin = PUBLIC_ORIGIN, localOrigins = [], upgrade = false } = options;
  if (!Array.isArray(localOrigins) || localOrigins.length > 32 || typeof upgrade !== 'boolean') return invalidOptions();
  const publicUrl = canonicalOrigin(publicOrigin, 'https:');
  const locals = Array.from(localOrigins, value => canonicalOrigin(value, 'http:'));
  // A local HTTP alias cannot silently weaken the public HTTPS Origin policy.
  if (locals.some(url => url.host === publicUrl.host)) return invalidOptions();
  return { publicOrigin, publicHost: publicUrl.host, localHosts: new Set(locals.map(url => url.host)), localOrigins: new Set(localOrigins), upgrade };
}
function rawHeaderCounts(raw) {
  if (raw === undefined) return { host: 0, origin: 0, site: 0 };
  if (!Array.isArray(raw) || raw.length % 2 !== 0 || raw.length > MAX_RAW_ENTRIES) return null;
  const counts = { host: 0, origin: 0, site: 0 };
  let bytes = 0;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]; const value = raw[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string' || name.length > MAX_HEADER_BYTES || value.length > MAX_HEADER_BYTES) return null;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > MAX_HEADER_BYTES) return null;
    const lower = name.toLowerCase();
    if (lower === 'host') counts.host++;
    else if (lower === 'origin') counts.origin++;
    else if (lower === 'sec-fetch-site') counts.site++;
  }
  return counts;
}

/** Pure admission supplement, never authentication, routing or credential access. */
export function classifyRequest(req, options = {}) {
  const policy = policyOptions(options);
  const headers = req?.headers;
  const raw = rawHeaderCounts(req?.rawHeaders);
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers) || raw === null || raw.host > 1 || !Object.hasOwn(headers, 'host')) return refusal(403, 'invalid_host');
  const host = headers.host;
  const local = typeof host === 'string' && policy.localHosts.has(host);
  if (typeof host !== 'string' || (!local && host !== policy.publicHost)) return refusal(403, 'invalid_host');
  const attachedOrigin = Object.hasOwn(headers, 'origin');
  const origin = headers.origin;
  if (raw.origin > 1 || (attachedOrigin && (typeof origin !== 'string' || (local ? !policy.localOrigins.has(origin) : origin !== policy.publicOrigin)))) return refusal(403, 'invalid_origin');
  if ((policy.upgrade || !['GET', 'HEAD'].includes(req?.method)) && !attachedOrigin) return refusal(403, 'origin_required');
  const site = headers['sec-fetch-site'];
  // Node normally provides one lowercase-key string. Reject ambiguous duplicate
  // or noncanonical fetch markers rather than letting an array hide cross-site.
  if (raw.site > 1 || (Object.hasOwn(headers, 'sec-fetch-site') && !['same-origin', 'same-site', 'none'].includes(site))) return refusal(403, 'invalid_origin');
  const path = req?.url;
  // Queries (including bootstrap tokens) remain opaque; validate before ANY URL
  // normalization. No URL parser, decoding or request mutation occurs here.
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\r\n]/.test(path)) return refusal(400, 'invalid_path');
  return null;
}
