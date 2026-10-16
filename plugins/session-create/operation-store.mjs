import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, fail, freeze } from './contracts.mjs';
import { procReliable, processStart } from '../session/bridge-security.mjs';

// Same kernel identity as bridge records: PID plus Linux start ticks, so a
// reused PID is not mistaken for the owner that wrote the lock.
async function ownerIdentity() {
  try { return { pid: process.pid, startTime: await processStart(process.pid) }; } catch { return { pid: process.pid, startTime: null }; }
}
async function ownerState(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || typeof owner.startTime !== 'string' || !await procReliable()) return 'unknown';
  try { return await processStart(owner.pid) === owner.startTime ? 'alive' : 'dead'; }
  catch (error) { return error?.code === 'ENOENT' ? 'dead' : 'unknown'; }
}

/** One host owner at a time, durable per-operation receipts; never a cross-domain transaction. */
export class OperationStore {
  constructor(root) { if (!isAbsolute(root)) fail('ledger_path_invalid'); this.root = root; }
  operationId(caller, key) { return hash({ caller, key }); }
  async read(id, caller) {
    if (!/^[a-f0-9]{64}$/u.test(id)) fail('invalid_operation_id');
    let value;
    try { value = JSON.parse(await readFile(join(this.root, `${id}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (value.version !== 1 || value.operation_id !== id || value.caller !== caller || !Array.isArray(value.journal) || !value.effects) fail('operation_unavailable');
    // An in-flight write intent is deliberately UNKNOWN after reconnect/restart.
    if (value.pending_stage) {
      value.status = 'unknown'; value.effects[value.pending_stage] = { ...value.effects[value.pending_stage], state: 'unknown' };
      value.recovery_required = true;
    }
    return freeze(value);
  }
  async begin(intent, requestHash) {
    // Called ONLY after the native body gate returns allowed-once and revalidation succeeds.
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = join(this.root, 'owner.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') await this.refuseHeldLock(lockPath); throw error; }
    let closed = false;
    const release = async () => { if (closed) return; closed = true; await lock.close(); await unlink(lockPath); };
    try {
      await lock.writeFile(JSON.stringify({ operation_id: intent.operation_id, epoch: intent.authority_epoch, ...await ownerIdentity() })); await lock.sync();
      if (await this.read(intent.operation_id, intent.caller)) fail('operation_exists');
      const record = {
        version: 1, operation_id: intent.operation_id, caller: intent.caller, request_hash: requestHash,
        intent_hash: intent.intent_hash, approved_intent: intent, status: 'pending', pending_stage: null,
        effects: { projects_parent: { state: 'not_started' }, directory: { state: 'not_started' }, project: { state: 'not_started' }, session: { state: 'not_started' }, association: { state: 'not_started' }, submission: { state: 'not_started' } },
        journal: [], retry_safe: false, recovery_required: false,
      };
      await this.save(record);
      return { record, release, stage: (name, action) => this.stage(record, name, action), finish: (status, code) => this.finish(record, status, code) };
    } catch (error) { await release().catch(() => {}); throw error; }
  }
  /**
   * Explains, never resolves, a held lock. A dead owner may have crashed in the
   * middle of an effect, so its journal can hold an UNKNOWN operation: removing
   * the lock stays a reviewed manual step, exactly as before.
   */
  async refuseHeldLock(lockPath) {
    let owner;
    try {
      // O_NONBLOCK: a planted FIFO must not hang the caller; size-bounded read.
      const file = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { const stat = await file.stat(); if (stat.isFile() && stat.size <= 4096) owner = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
    } catch { /* Unreadable or torn lock: the owner stays unknown. */ }
    const state = await ownerState(owner);
    // Kept short: callers clip reasons at 240 characters, and the actionable part comes last.
    const operation = /^[a-f0-9]{64}$/u.test(owner?.operation_id ?? '') ? ` (operation ${owner.operation_id.slice(0, 16)}…)` : '';
    if (state === 'dead') fail('ledger_owner_dead', `Journal owner pid ${owner.pid} is gone${operation}, maybe mid-operation. Check status; the owner (human) then deletes owner.lock in the ledger by hand. Never automatic.`);
    fail('ledger_owner_held', state === 'alive'
      ? `Journal owned by running pid ${owner.pid}${operation}; wait for it. Never delete or take over the lock automatically.`
      : 'Journal owner held or left uncertain after crash (no verifiable owner); do not delete/take over automatically.');
  }
  async save(record) {
    const path = join(this.root, `${record.operation_id}.json`);
    const temporary = join(this.root, `.write-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, path); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    const directory = await open(this.root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async stage(record, name, action) {
    if (!Object.hasOwn(record.effects, name) || record.pending_stage) fail('journal_invalid_transition');
    record.pending_stage = name;
    record.journal.push({ stage: name, edge: 'starting' });
    await this.save(record);
    try {
      const receipt = await action();
      record.effects[name] = { state: 'confirmed', ...receipt };
      record.journal.push({ stage: name, edge: 'confirmed' });
      record.pending_stage = null;
      await this.save(record);
      return receipt;
    } catch (error) {
      if (error?.noEffect === true) {
        // The action itself proved the request never reached its destination
        // (refused before sending, or by the destination before its own lease):
        // a definite not_started, not an UNKNOWN that demands recovery.
        record.pending_stage = null;
        record.effects[name] = { state: 'not_started' };
        record.journal.push({ stage: name, edge: 'not_started' });
        record.code = error.code ?? 'not_started';
        await this.save(record).catch(() => {});
        throw error;
      }
      // Throwing native services may have committed. Even cancellation is not non-delivery proof.
      record.pending_stage = name;
      record.effects[name] = { ...record.effects[name], state: 'unknown' };
      record.status = 'unknown'; record.recovery_required = true;
      record.code = error.code ?? 'effect_unknown';
      // Preserve pending_stage so a lost receipt cannot become a restart retry.
      await this.save(record).catch(() => {});
      throw error;
    }
  }
  async finish(record, status, code) {
    const confirmed = Object.values(record.effects).some(effect => effect.state === 'confirmed');
    record.status = record.pending_stage || Object.values(record.effects).some(effect => effect.state === 'unknown') ? 'unknown' : status === 'not_started' && confirmed ? 'partial' : status;
    record.recovery_required = !['completed', 'not_started'].includes(record.status);
    if (code) record.code = code;
    await this.save(record);
  }
}
export function publicResult(record) {
  return {
    operation_id: record.operation_id, intent_hash: record.intent_hash, status: record.status,
    session_id: record.approved_intent.session_id, request_id: record.approved_intent.request_id,
    cwd: record.approved_intent.cwd, delivery: record.approved_intent.delivery.mode,
    effects: record.effects, code: record.code ?? null, retry_safe: false,
    recovery_required: record.recovery_required, completed: false,
    model_binding: record.approved_intent.model_binding,
    note: 'Completed provisioning is not completion of an Agent request. Partial objects are retained; UNKNOWN must not be retried automatically.',
  };
}
