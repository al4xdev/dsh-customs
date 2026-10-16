import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, readFileSync, writeFileSync, fstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MAX_EVENTS = 256;
export const MAX_BYTES = 512 * 1024;
const keys = 'eventId,goalId,phase,revision,sessionId,timestamp,version';
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
export function eventId(sessionId, goalId, revision) {
  return createHash('sha256').update(JSON.stringify(['companion', sessionId, goalId, revision])).digest('hex');
}
export function validPayload(p) {
  return p && Object.keys(p).sort().join(',') === keys && p.version === 1 && p.phase === 'completed' &&
    id(p.sessionId) && id(p.goalId) && Number.isSafeInteger(p.revision) && p.revision > 1 &&
    Number.isSafeInteger(p.timestamp) && p.timestamp >= 0 && p.eventId === eventId(p.sessionId, p.goalId, p.revision);
}

/** The mock delivery IS the atomic ledger entry: no dual-write/external-side-effect gap.
 * Capacity fails closed rather than evicting dedup identities and notifying old goals again.
 * The contract for any future adapter is deliver(payload), idempotent on eventId; none is installed here.
 */
export class MockSink {
  constructor(profileDirectory) {
    const root = realpathSync(profileDirectory);
    this.directory = join(root, 'companion-notifications');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (realpathSync(this.directory) !== resolve(this.directory)) throw new Error('mock-directory-invalid');
    this.path = join(this.directory, 'mock-v1.json');
  }
  read() {
    let fd;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('mock-ledger-invalid');
      const data = JSON.parse(readFileSync(fd, 'utf8'));
      if (Object.keys(data).sort().join(',') !== 'events,profile,version' || data.version !== 1 || data.profile !== 'companion' ||
          !Array.isArray(data.events) || data.events.length > MAX_EVENTS || !data.events.every(validPayload) ||
          new Set(data.events.map(p => p.eventId)).size !== data.events.length) throw new Error('mock-ledger-invalid');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, profile: 'companion', events: [] };
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  deliver(payload) {
    if (!validPayload(payload)) throw new Error('mock-payload-invalid');
    // Cross-mount/process serialization. A crash-held lock deliberately fails closed;
    // an operator may remove it only with the Companion stopped after reviewing the ledger.
    const lock = `${this.path}.lock`;
    const lockFd = openSync(lock, 'wx', 0o600);
    let temporary;
    try {
      const data = this.read();
      if (data.events.some(p => p.eventId === payload.eventId)) return false;
      if (data.events.length >= MAX_EVENTS) throw new Error('mock-capacity');
      data.events.push(payload);
      const bytes = JSON.stringify(data) + '\n';
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('mock-capacity');
      temporary = join(this.directory, `.mock-${randomUUID()}.tmp`);
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
      temporary = undefined;
      const dirFd = openSync(this.directory, constants.O_RDONLY);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      return true;
    } finally {
      if (temporary) unlinkSync(temporary);
      closeSync(lockFd);
      unlinkSync(lock);
    }
  }
}
