import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import { hash, publicConfig, validEnvelope } from './contracts.mjs';

const OAUTH = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const result = (code, retryable = false, unregistered = false) => ({ ok: false, code, retryable, unregistered });
async function boundedJson(response) {
  if (!response.body?.getReader) throw new Error('response-format');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new Error('response-limit'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function credentials(path, projectId) {
  if (!isAbsolute(path)) throw new Error('credential-path');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 32768) throw new Error('credential-file');
    const c = JSON.parse(readFileSync(fd, 'utf8'));
    if (c.type !== 'service_account' || c.project_id !== projectId || c.token_uri !== OAUTH || typeof c.client_email !== 'string' ||
        !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$/.test(c.client_email) || typeof c.private_key !== 'string') throw new Error('credential-config');
    const key = createPrivateKey(c.private_key);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('credential-key');
    return { email: c.client_email, key };
  } finally { closeSync(fd); }
}

/** No ambient environment, ADC, metadata service or configurable endpoint. The optional
 * credential file is opened ONLY after explicit enabled + complete public configuration. */
export function createFcmSender(config = {}, { fetchImpl = globalThis.fetch, authProvider, now = Date.now, timeoutMs = 10000 } = {}) {
  const p = publicConfig(config);
  let credential, configured = config.enabled === true && !!p && typeof fetchImpl === 'function';
  let unavailable = 'unconfigured', cached, closed = false;
  const controllers = new Set();
  if (configured && typeof authProvider !== 'function') {
    if (typeof config.serviceAccountFile !== 'string' || !isAbsolute(config.serviceAccountFile)) configured = false;
    else {
      try { credential = credentials(config.serviceAccountFile, p.projectId); }
      catch { configured = false; unavailable = 'credentials-unavailable'; }
    }
  }
  const ready = () => configured && !closed;
  async function accessToken(signal) {
    if (authProvider) {
      const token = await authProvider({ signal, projectId: p.projectId });
      if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(token)) throw new Error('oauth-token');
      return token;
    }
    if (cached && cached.expiresAt - 90000 > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: credential.email, scope: SCOPE, aud: OAUTH, iat, exp: iat + 3600 })}`;
    const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), credential.key).toString('base64url')}`;
    const response = await fetchImpl(OAUTH, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error('oauth-rejected'); }
    const body = await boundedJson(response);
    if (body.token_type !== 'Bearer' || typeof body.access_token !== 'string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(body.access_token) ||
        !Number.isSafeInteger(body.expires_in) || body.expires_in < 1 || body.expires_in > 3600) throw new Error('oauth-format');
    cached = { token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return cached.token;
  }
  async function send({ token, data }) {
    if (!ready()) return result(unavailable);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_:.-]{16,4096}$/.test(token) || !validEnvelope(data) ||
        data.configDigest !== p.configDigest || data.tokenDigest !== hash(token)) return result('invalid-payload');
    const controller = new AbortController(); controllers.add(controller);
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(result('timeout', true)); }, Math.max(1, Math.min(timeoutMs, 30000))); });
    const operation = (async () => {
      try {
        const bearer = await accessToken(controller.signal);
        if (controller.signal.aborted || closed) return result('cancelled');
        const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${p.projectId}/messages:send`, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: '86400s' } } }) });
        if (response.status === 200) {
          const body = await boundedJson(response);
          return typeof body.name === 'string' && body.name.startsWith(`projects/${p.projectId}/messages/`) && body.name.length <= 512 ? { ok: true, code: 'accepted' } : result('invalid-response', true);
        }
        if (response.status === 401) cached = undefined;
        let unregistered = false;
        try { const body = await boundedJson(response); unregistered = body.error?.details?.some(d => d['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' && d.errorCode === 'UNREGISTERED') === true; } catch {}
        return result(unregistered ? 'unregistered' : response.status === 429 ? 'rate-limited' : response.status >= 500 ? 'upstream-unavailable' : 'rejected', response.status === 429 || response.status >= 500 || response.status === 401, unregistered);
      } catch { return result(controller.signal.aborted ? 'timeout' : 'transport-unavailable', true); }
    })();
    try { return await Promise.race([operation, deadline]); }
    finally { clearTimeout(timer); controller.abort(); controllers.delete(controller); }
  }
  return Object.freeze({ ready, status: () => ready() ? 'ready' : unavailable, send,
    close() { closed = true; cached = undefined; credential = undefined; for (const c of controllers) c.abort(); controllers.clear(); } });
}
