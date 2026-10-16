import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { hash } from './contracts.mjs';
import { sameIdentity, GRANT_TTL } from '../session/bridge-security.mjs';

const digest = value => createHmac('sha256', value.key).update(JSON.stringify(value.payload)).digest('hex');
function payload(g) {
  return [g.version, g.operation, g.bridgeId, g.pid, g.startTime, g.preparationId, g.preparationHash, g.nonce, g.issuedAt, g.expiresAt];
}
/** Separate domain from send grants: no unsigned proposal fields authorize creation. */
export function signCreateGrant(preparation, record, key) {
  const issuedAt = Date.now();
  const grant = { version: 1, operation: 'create-session', bridgeId: record.bridgeId, pid: record.pid, startTime: record.startTime, preparationId: preparation.id, preparationHash: preparation.hash, nonce: randomBytes(24).toString('hex'), issuedAt, expiresAt: Math.min(preparation.expiresAt, issuedAt + GRANT_TTL) };
  return { ...grant, mac: digest({ key, payload: payload(grant) }) };
}
export function verifyCreateGrant(grant, request, identity, key, now = Date.now()) {
  if (!grant || grant.version !== 1 || grant.operation !== 'create-session' || !sameIdentity(grant, identity) || grant.preparationId !== request.preparationId || grant.preparationHash !== request.preparationHash || !/^[a-f0-9]{64}$/.test(grant.preparationHash ?? '') || !/^[a-f0-9]{48}$/.test(grant.nonce ?? '') || !Number.isSafeInteger(grant.issuedAt) || !Number.isSafeInteger(grant.expiresAt) || grant.issuedAt > now || grant.expiresAt <= now || grant.expiresAt - grant.issuedAt > GRANT_TTL || !/^[a-f0-9]{64}$/.test(grant.mac ?? '')) return false;
  return timingSafeEqual(Buffer.from(grant.mac, 'hex'), Buffer.from(digest({ key, payload: payload(grant) }), 'hex'));
}
export function preparationHash(preparation) {
  const { hash: ignored, ...bound } = preparation;
  return hash(bound);
}
