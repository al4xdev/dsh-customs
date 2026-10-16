import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, fail, freeze } from './contracts.mjs';

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
    catch (error) { if (error.code === 'EEXIST') fail('ledger_owner_held', 'Journal owner held or left uncertain after crash; do not delete/take over automatically.'); throw error; }
    let closed = false;
    const release = async () => { if (closed) return; closed = true; await lock.close(); await unlink(lockPath); };
    try {
      await lock.writeFile(JSON.stringify({ operation_id: intent.operation_id, epoch: intent.authority_epoch })); await lock.sync();
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
    record.status = record.pending_stage || Object.values(record.effects).some(effect => effect.state === 'unknown') ? 'unknown' : status;
    record.recovery_required = record.status !== 'completed';
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
