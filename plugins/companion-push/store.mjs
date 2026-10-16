import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, generation, hash, MAX_ATTEMPTS, MAX_DEVICES, MAX_EVENTS, refuse, uuid, validPayload, validReceipt } from './contracts.mjs';
import { procReliableSync, processStartSync } from '../session/bridge-security.mjs';

export const MAX_BYTES = 2 * 1024 * 1024;
const exact = (x, names) => x && Object.keys(x).sort().join(',') === names.split(',').sort().join(',');
function privateStat(stat, directory = false) {
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) refuse('store-permissions');
}
export function validState(s) {
  if (!exact(s, 'version,profile,ownerScopeId,devices,events') || s.version !== 1 || s.profile !== 'companion' || !digest(s.ownerScopeId) ||
      !Array.isArray(s.devices) || s.devices.length > MAX_DEVICES || !Array.isArray(s.events) || s.events.length > MAX_EVENTS) return false;
  const deviceIds = new Set();
  for (const d of s.devices) {
    if (!exact(d, 'deviceId,generation,active,token,receipt') || !uuid(d.deviceId) || deviceIds.has(d.deviceId) || !generation(d.generation) || typeof d.active !== 'boolean') return false;
    deviceIds.add(d.deviceId);
    if (d.active ? !validReceipt(d.receipt) || d.receipt.deviceId !== d.deviceId || d.receipt.authGeneration !== d.generation || d.receipt.ownerScopeId !== s.ownerScopeId ||
        typeof d.token !== 'string' || !/^[A-Za-z0-9_:.-]{16,4096}$/.test(d.token) || hash(d.token) !== d.receipt.tokenDigest : d.token !== null || d.receipt !== null) return false;
  }
  const eventIds = new Set();
  for (const e of s.events) {
    if (!exact(e, 'payload,targets') || !validPayload(e.payload) || eventIds.has(e.payload.eventId) || !Array.isArray(e.targets) || e.targets.length > MAX_DEVICES) return false;
    eventIds.add(e.payload.eventId);
    const targetIds = new Set();
    for (const t of e.targets) {
      if (!exact(t, 'deviceId,registrationId,bindingId,state,attempts,nextAt') || !deviceIds.has(t.deviceId) || !uuid(t.registrationId) || !uuid(t.bindingId) ||
          targetIds.has(t.deviceId) || !['pending', 'delivered', 'exhausted', 'revoked'].includes(t.state) || !generation(t.attempts) || t.attempts > MAX_ATTEMPTS || !generation(t.nextAt)) return false;
      targetIds.add(t.deviceId);
    }
  }
  return true;
}

// The lock names its writer (pid + Linux start ticks) so a crash-left lock can be
// told apart from a running sender. Unreadable/legacy locks stay "unknown".
function lockOwnerState(lock) {
  let owner;
  try {
    // O_NONBLOCK: a planted FIFO must not hang the constructor.
    const fd = openSync(lock, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const stat = fstatSync(fd); if (stat.isFile() && stat.size <= 4096) owner = JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
  } catch { return 'unknown'; }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || typeof owner.startTime !== 'string' || !procReliableSync()) return 'unknown';
  try { return processStartSync(owner.pid) === owner.startTime ? 'alive' : 'dead'; }
  catch (error) { return error?.code === 'ENOENT' ? 'dead' : 'unknown'; }
}

/** Lifetime writer lock deliberately survives a crash. Never silently reclaim another sender's
 * authority or evict a delivered ID. Recovery requires the stopped-profile operator's review;
 * an orphaned lock (dead writer) is only REPORTED as `store-lock-orphaned`, never taken over. */
export class PrivateStore {
  constructor(profileDirectory) {
    if (!isAbsolute(profileDirectory)) refuse('store-path');
    const root = realpathSync(profileDirectory);
    if (root !== resolve(profileDirectory)) refuse('store-path');
    this.directory = join(root, 'companion-push');
    try { mkdirSync(this.directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    privateStat(lstatSync(this.directory), true);
    if (realpathSync(this.directory) !== this.directory) refuse('store-path');
    this.path = join(this.directory, 'state-v1.json');
    this.lock = join(this.directory, 'writer.lock');
    try { this.lockFd = openSync(this.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') refuse(lockOwnerState(this.lock) === 'dead' ? 'store-lock-orphaned' : 'store-locked'); throw error; }
    this.closed = false;
    try {
      let startTime = null;
      try { startTime = processStartSync(process.pid); } catch { /* Non-Linux: the owner stays unverifiable. */ }
      writeFileSync(this.lockFd, JSON.stringify({ version: 1, pid: process.pid, startTime })); fsyncSync(this.lockFd);
      let fd;
      try {
        fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd); privateStat(stat);
        if (stat.size > MAX_BYTES) refuse('store-limit');
        this.state = JSON.parse(readFileSync(fd, 'utf8'));
        if (!validState(this.state)) refuse('store-invalid');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.state = { version: 1, profile: 'companion', ownerScopeId: hash(`companion-push-owner-v1|${randomUUID()}`), devices: [], events: [] };
        this.save(this.state);
      } finally { if (fd !== undefined) closeSync(fd); }
    } catch (error) { this.close(); throw error; }
  }
  read() { if (this.closed) refuse('store-closed'); return structuredClone(this.state); }
  /** Capacity facts without cloning the (up to 2 MiB) state on every status call. */
  usage(deviceId) {
    if (this.closed) refuse('store-closed');
    return { events: this.state.events.length, devices: this.state.devices.length, knownDevice: this.state.devices.some(d => d.deviceId === deviceId) };
  }
  save(state) {
    if (this.closed || !validState(state)) refuse('store-invalid');
    const bytes = JSON.stringify(state) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) refuse('store-limit');
    const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path); renamed = true;
      const fdDir = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(fdDir); } finally { closeSync(fdDir); }
      this.state = structuredClone(state);
    } catch (error) {
      // A failed post-rename fsync is ambiguous. Disable this writer rather than overwrite from stale memory.
      if (renamed) this.closed = true;
      throw error;
    } finally { if (!renamed) { try { unlinkSync(temporary); } catch {} } }
  }
  change(mutator) { const state = this.read(); const result = mutator(state); this.save(state); return result; }
  close() {
    this.closed = true;
    if (this.lockFd !== undefined) { closeSync(this.lockFd); this.lockFd = undefined; unlinkSync(this.lock); }
  }
}
