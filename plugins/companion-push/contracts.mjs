import { createHash } from 'node:crypto';

export const PACKAGE = 'dev.alex.dsh.companion';
export const MAX_DEVICES = 32;
export const MAX_EVENTS = 256;
export const MAX_ATTEMPTS = 3;
export const LEASE_MS = 86400000;
export const METHODS = Object.freeze(['goalPush/register', 'goalPush/unregister', 'goalPush/status']);
export const hash = text => createHash('sha256').update(text).digest('hex');
export const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
export const digest = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
export const id = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(s);
export const generation = n => Number.isSafeInteger(n) && n >= 0;
export function refuse(code) { const error = new Error('Companion push unavailable.'); error.code = `goalPush/${code}`; throw error; }
export function fields(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) refuse('invalid-request');
}
export function sessions(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 256 && value.every(id) && new Set(value).size === value.length;
}
export function publicConfig(config) {
  const p = config?.publicConfig;
  if (!p || typeof p.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(p.projectId) ||
      typeof p.senderId !== 'string' || !/^[0-9]{6,32}$/.test(p.senderId) ||
      typeof p.appId !== 'string' || !new RegExp(`^1:${p.senderId}:android:[a-f0-9]{16,64}$`).test(p.appId) || p.androidPackage !== PACKAGE) return null;
  return Object.freeze({ projectId: p.projectId, senderId: p.senderId, appId: p.appId, androidPackage: PACKAGE,
    configDigest: hash([p.projectId, p.appId, p.senderId, PACKAGE].join('|')) });
}
export function eventId(sessionId, goalId, revision) { return hash(JSON.stringify(['companion', sessionId, goalId, revision])); }
export function validPayload(p) {
  try { fields(p, ['version', 'eventId', 'goalId', 'revision', 'sessionId', 'phase', 'timestamp']); } catch { return false; }
  return p.version === 1 && p.phase === 'completed' && id(p.sessionId) && id(p.goalId) && Number.isSafeInteger(p.revision) && p.revision > 1 &&
    generation(p.timestamp) && p.eventId === eventId(p.sessionId, p.goalId, p.revision);
}
export function envelope(payload, receipt) {
  if (!validPayload(payload)) refuse('invalid-event');
  const data = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)]));
  for (const key of ['bindingId', 'deviceId', 'ownerScopeId', 'registrationId', 'authGeneration', 'configDigest', 'tokenDigest']) data[key] = String(receipt[key]);
  if (Buffer.byteLength(JSON.stringify(data)) > 3500) refuse('payload-limit');
  return data;
}
export function validEnvelope(data) {
  try {
    fields(data, ['version', 'eventId', 'goalId', 'revision', 'sessionId', 'phase', 'timestamp', 'bindingId', 'deviceId', 'ownerScopeId', 'registrationId', 'authGeneration', 'configDigest', 'tokenDigest']);
    if (Object.values(data).some(v => typeof v !== 'string') || Buffer.byteLength(JSON.stringify(data)) > 3500) return false;
    const canonicalInteger = v => /^(0|[1-9][0-9]*)$/.test(v) && generation(Number(v)) && String(Number(v)) === v;
    return data.version === '1' && canonicalInteger(data.revision) && canonicalInteger(data.timestamp) && canonicalInteger(data.authGeneration) &&
      validPayload({ version: 1, eventId: data.eventId, goalId: data.goalId, revision: Number(data.revision), sessionId: data.sessionId, phase: data.phase, timestamp: Number(data.timestamp) }) &&
      uuid(data.bindingId) && uuid(data.deviceId) && uuid(data.registrationId) && digest(data.ownerScopeId) && digest(data.configDigest) && digest(data.tokenDigest);
  } catch { return false; }
}
export function validRegistration(r) {
  try { fields(r, ['version', 'deviceId', 'token', 'tokenDigest', 'configDigest', 'authGeneration', 'sessionIds']); } catch { return false; }
  return r.version === 1 && uuid(r.deviceId) && typeof r.token === 'string' && /^[A-Za-z0-9_:.-]{16,4096}$/.test(r.token) &&
    digest(r.tokenDigest) && r.tokenDigest === hash(r.token) && digest(r.configDigest) && generation(r.authGeneration) && sessions(r.sessionIds);
}
export function validReceipt(r) {
  try { fields(r, ['version', 'registrationId', 'bindingId', 'profile', 'ownerScopeId', 'authGeneration', 'deviceId', 'tokenDigest', 'configDigest', 'expiresAt', 'issuedAt', 'sessionIds']); } catch { return false; }
  return r.version === 1 && uuid(r.registrationId) && uuid(r.bindingId) && r.profile === 'companion' && digest(r.ownerScopeId) &&
    generation(r.authGeneration) && uuid(r.deviceId) && digest(r.tokenDigest) && digest(r.configDigest) && generation(r.issuedAt) &&
    generation(r.expiresAt) && r.expiresAt > r.issuedAt && r.expiresAt - r.issuedAt <= LEASE_MS && sessions(r.sessionIds);
}
