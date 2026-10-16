import { randomUUID } from 'node:crypto';
import { parseArgs, hash } from './contracts.mjs';
import { callerKey, prepare, revalidate } from './preflight.mjs';
import { approve } from './approval.mjs';
import { provision } from './provisioner.mjs';
import { publicResult } from './operation-store.mjs';

export function createController(ctx, { authority, store, installModelSelection, handles = new Map() }) {
  let tail = Promise.resolve();
  let phase = 'idle';
  const capabilities = () => ({ tool: 'session_create', version: 1, operations: ['help', 'capabilities', 'status', 'create'], delivery_default: 'empty', target_default: 'current', preset: 'companion', new_project: authority.ready, projects_root: `${authority.root}/projects`, project_boundary: 'canonical direct named children only; writable only with live incarnation proof', cold_resume_authority: false, approval: 'native allowed-once; trusted answerer chain, not cryptographic human attestation', default_model_changes: false, retry: 'no automatic continuation; same key returns receipts only', readable_approval: 'full reason emitted; mobile structured detail renderer still requires separate integration' });
  async function create(request, exec) {
    exec.signal.throwIfAborted();
    if (typeof exec.callId !== 'string' || !exec.callId) return { code: 'caller_unavailable', effect: 'none', retry_safe: false };
    const caller = callerKey(exec);
    const requestHash = hash(request);
    const operationId = store.operationId(caller, request.idempotency_key ?? `call:${exec.callId}`);
    phase = 'readonly-ledger';
    const previous = await store.read(operationId, caller);
    exec.signal.throwIfAborted();
    if (previous) {
      if (previous.request_hash !== requestHash) return { code: 'idempotency_conflict', effect: 'none', retry_safe: false, operation_id: operationId };
      return publicResult(previous);
    }
    let lease;
    try {
      phase = 'readonly-preflight';
      const intent = await prepare(ctx, request, exec, authority, { operation_id: operationId, session_id: `session-${randomUUID()}`, request_id: randomUUID() });
      phase = 'native-approval';
      await approve(ctx, exec, intent);
      await revalidate(ctx, exec, authority, intent, intent.facts);
      lease = await store.begin(intent, requestHash);
      await provision(ctx, exec, authority, intent, lease, { installModelSelection, handles });
      return publicResult(lease.record);
    } catch (error) {
      if (lease) return publicResult(lease.record);
      return { code: error.code ?? (exec.signal.aborted ? 'cancelled' : 'create_unavailable'), effect: 'none', retry_safe: false, operation_id: operationId, recovery_required: ['operation_exists', 'ledger_owner_held', 'ledger_owner_dead'].includes(error.code) };
    } finally { await lease?.release(); phase = 'idle'; }
  }
  return {
    capabilities,
    diagnostics: () => ({ phase }),
    async execute(input, exec) {
      const args = parseArgs(input);
      if (args.operation === 'help' || args.operation === 'capabilities') return capabilities();
      const caller = callerKey(exec);
      if (args.operation === 'status') {
        const record = await store.read(args.operation_id, caller);
        exec.signal.throwIfAborted();
        return record ? publicResult(record) : { code: 'operation_not_found', effect: 'none' };
      }
      // Serialize approval plus provisioning; a second pending operation cannot overtake the first.
      const result = tail.then(() => create(args.request, exec));
      tail = result.catch(() => {});
      return result;
    },
    async drain() { await tail; },
  };
}
