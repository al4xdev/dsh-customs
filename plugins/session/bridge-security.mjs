import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'session-companion');
export const MAX_FRAME = 64 * 1024;
export const MAX_TEXT = 16 * 1024;
export const GRANT_TTL = 15_000;
export const capabilities = Object.freeze({ list: true, inspect: true, send: true, resume: false, boundary: 'next-turn', approval: 'companion-required' });
export function failure(code, message, extra = {}) { return { ok: false, error: { code, message }, capabilities, ...extra }; }
export function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
export function validateSend(value) {
  return validId(value?.sessionId) && validId(value?.requestId) && typeof value?.text === 'string' && value.text.length > 0 && Buffer.byteLength(value.text) <= MAX_TEXT;
}
export async function privateStat(file, kind, mode) {
  const stat = await fs.lstat(file);
  if ((kind === 'dir' ? !stat.isDirectory() : kind === 'socket' ? !stat.isSocket() : !stat.isFile()) || stat.uid !== process.getuid() || (stat.mode & 0o777) !== mode) throw new Error(`Unsafe ${kind} permissions or owner`);
  return stat;
}
export async function prepareRoot(root = DEFAULT_ROOT) {
  root = path.resolve(root);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await privateStat(root, 'dir', 0o700);
  await fs.mkdir(path.join(root, 'bridges'), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await privateStat(path.join(root, 'bridges'), 'dir', 0o700);
  const keyPath = path.join(root, 'grant.key');
  // Publish a complete key with exclusive link, so concurrent hosts never observe a partially written key.
  const temporary = path.join(root, `.grant-${randomBytes(16).toString('hex')}.tmp`);
  const file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(randomBytes(32)); await file.sync(); await file.close();
    await fs.link(temporary, keyPath).catch(error => { if (error.code !== 'EEXIST') throw error; });
  } finally { await file.close().catch(() => {}); await fs.unlink(temporary); }
  return { root, key: await readKey(root) };
}
export async function readKey(root) {
  await privateStat(root, 'dir', 0o700);
  const file = await fs.open(path.join(root, 'grant.key'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size !== 32) throw new Error('Unsafe grant key');
    return await file.readFile();
  } finally { await file.close(); }
}
// Linux start ticks disambiguate reused PIDs; a timestamp claimed by a peer is not enough.
export async function processStart(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid PID');
  const value = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
}
export function sameIdentity(a, b) { return a?.bridgeId === b?.bridgeId && a?.pid === b?.pid && a?.startTime === b?.startTime; }
export function grantPayload(request, identity, agentIdentity, now = Date.now()) {
  return { version: 1, operation: 'send', bridgeId: identity.bridgeId, pid: identity.pid, startTime: identity.startTime, sessionId: request.sessionId, agentIdentity, text: request.text, requestId: request.requestId, nonce: randomBytes(24).toString('hex'), issuedAt: now, expiresAt: now + GRANT_TTL };
}
function canonical(p) {
  return JSON.stringify([p.version, p.operation, p.bridgeId, p.pid, p.startTime, p.sessionId, p.agentIdentity, p.text, p.requestId, p.nonce, p.issuedAt, p.expiresAt]);
}
export function signGrant(payload, key) { return { ...payload, mac: createHmac('sha256', key).update(canonical(payload)).digest('hex') }; }
export function verifyGrant(grant, request, identity, key, now = Date.now()) {
  if (!grant || grant.version !== 1 || grant.operation !== 'send' || !sameIdentity(grant, identity) || grant.sessionId !== request.sessionId || grant.text !== request.text || grant.requestId !== request.requestId || !validId(grant.agentIdentity) || !/^[a-f0-9]{48}$/.test(grant.nonce ?? '') || !Number.isSafeInteger(grant.issuedAt) || !Number.isSafeInteger(grant.expiresAt) || grant.issuedAt > now || grant.expiresAt <= now || grant.expiresAt - grant.issuedAt > GRANT_TTL || !/^[a-f0-9]{64}$/.test(grant.mac ?? '')) return false;
  const expected = signGrant(grant, key).mac;
  return timingSafeEqual(Buffer.from(grant.mac, 'hex'), Buffer.from(expected, 'hex'));
}
export async function validateRecord(record) {
  if (!record || !validId(record.bridgeId) || !Number.isSafeInteger(record.pid) || typeof record.startTime !== 'string' || !/^\d+$/.test(record.startTime) || typeof record.root !== 'string') throw new Error('Invalid discovery identity');
  const root = path.resolve(record.root);
  await privateStat(root, 'dir', 0o700);
  await privateStat(path.join(root, 'bridges'), 'dir', 0o700);
  if (record.socketPath !== path.join(root, 'bridges', `${record.bridgeId}.sock`)) throw new Error('Invalid socket path');
  await privateStat(record.socketPath, 'socket', 0o600);
  if (await processStart(record.pid) !== record.startTime) throw new Error('Stale process identity');
}
