import { resolveHost } from '../common.mjs';
import { UNBOUNDED_RETRIES, policyFromKey } from './policy.mjs';
import { INITIAL_STATE, foldState, healthyStepProof } from '../agent-self-heal/logic.mjs';
import { stateSchema as ownerStateSchema, assertAuditReadable } from '../agent-self-heal/state-schema.mjs';
const { z } = await import(resolveHost('zod'));
export const ACCOUNTING_KEY = 'llmRecoveryAccounting';
// Only the newest owner mirror per policy key can still be in the native UI
// ledger, so a short sliding window suffices for unbounded chains. An evicted
// key can only make a mirror look like legacy spend, which fails closed.
export const MAX_MIRRORS = 16;
export const UNSAFE_REASONS = Object.freeze(['native-row-overflow', 'unknown-native-provenance', 'invalid-ownership-provenance']);
const natural = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positionSchema = z.object({ turn: natural.min(1), step: natural.min(1) }).strict();
const ownershipShape = { kind: z.literal('unified-agent-warning'), origin: positionSchema,
  provider: z.string(), retryId: z.string(), policyKey: z.string(), retry: natural,
  legacyNativeConsumed: natural, legacySemanticConsumed: natural, importedConsumed: natural };
// `retry` is always the chain cycle. v1 (owner6) mirrored it verbatim under one
// chain-wide retryId, which the native v4 session format rejects once a chain
// continues into another turn/step. v2 (owner7) declares the exact native mirror
// coordinates instead: ordinal `mirrorRetry` (1.. per turn/step/policy) under
// `retryId`, which is fresh for every new turn/step.
export const ownershipSchema = z.union([
  z.object({ version: z.literal(1), ...ownershipShape }).strict(),
  z.object({ version: z.literal(2), ...ownershipShape, mirrorRetry: natural.min(1) }).strict(),
]);
const add = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const scopedKey = row => JSON.stringify([row.provider, row.policyKey, row.retryId, row.turn, row.step]);
const mirrorKey = row => JSON.stringify([row.provider, row.policyKey, row.retryId, row.turn, row.step, row.retry]);
const ownedMirrorKey = (ownership, turn, step) => mirrorKey({ ...ownership, retry: ownership.mirrorRetry ?? ownership.retry, turn, step });
const unsafe = (state, reason) => ({ ...state, unsafe: true, unsafeReason: state.unsafeReason ?? reason });
/** Budget refusals carry a fixed `reason` the owner may log; messages stay fixed too. */
export class RecoveryHistoryError extends Error {
  constructor(message, reason) { super(message); this.name = 'RecoveryHistoryError'; this.reason = reason; }
}
function retryRow(data) {
  if (!data || typeof data.provider !== 'string' || !data.provider || typeof data.policyKey !== 'string'
    || typeof data.retryId !== 'string' || !data.retryId || !Number.isSafeInteger(data.retry) || data.retry < 0
    || !Number.isSafeInteger(data.turn) || data.turn < 1 || !Number.isSafeInteger(data.step) || data.step < 1) throw new Error('Unknown native retry provenance');
  const policy = policyFromKey(data.provider, data.policyKey);
  if (!policy) throw new Error('Unknown or unbounded legacy retry policy');
  return { ...data, policy };
}
function incorporate(state, row) {
  if (state.mirrors.includes(mirrorKey(row))) return state;
  const key = scopedKey(row), previous = state.rows[key] ?? 0, delta = Math.max(0, row.retry - previous);
  if (!delta) return state;
  // Bound bookkeeping independently from the historical floor. Overflow is a
  // refusal, never an eviction that could turn an unknown chain into credits.
  if (!(key in state.rows) && Object.keys(state.rows).length >= 128) return unsafe(state, 'native-row-overflow');
  return { ...state, rows: { ...state.rows, [key]: Math.max(previous, row.retry) },
    legacyConsumed: add(state.legacyConsumed, delta), legacyCap: Math.min(state.legacyCap, row.policy.maxRetries),
    legacyPolicyKey: state.legacyPolicyKey ?? row.policyKey };
}
function cleared(state, witness) {
  // Keep current-scope tombstones until native step/start clears its UI ledger;
  // a just-acknowledged old UI row must not immediately reimport settled spend.
  const { unsafeReason: _settled, ...rest } = state;
  return { ...rest, ownership: undefined, legacyConsumed: 0, legacyCap: UNBOUNDED_RETRIES,
    legacyPolicyKey: undefined, lastLegacySeq: 0, unsafe: false, witness };
}
// stateVersion 3: an uncapped legacyCap/ownership ordinal and a sliding mirror
// window. Version 2 checkpoints (cap 10 implied by their init) are not restored;
// the projection refolds the full native log, which old v1/v2 audits still pass.
export const recoveryAccountingProjection = {
  key: ACCOUNTING_KEY, stateVersion: 3,
  stateSchema: z.object({ ownership: ownershipSchema.optional(), mirrors: z.array(z.string()).max(MAX_MIRRORS),
    legacyConsumed: natural, legacyCap: natural, legacyPolicyKey: z.string().optional(),
    lastLegacySeq: natural, scope: positionSchema.optional(), rows: z.record(z.string(), natural),
    unsafe: z.boolean(), unsafeReason: z.enum(UNSAFE_REASONS).optional(), witness: ownerStateSchema }).strict(),
  init: () => ({ mirrors: [], legacyConsumed: 0, legacyCap: UNBOUNDED_RETRIES, lastLegacySeq: 0, rows: {}, unsafe: false, witness: { ...INITIAL_STATE } }),
  apply(state, event) {
    assertAuditReadable(event, ownerStateSchema);
    const before = state.witness, witness = foldState(before, event);
    let next = { ...state, witness };
    const healthyReceipt = event.type === 'agent/self-heal' && event.data.action === 'recovered'
      && witness.lastHealthyStep?.stepEndSeq > Math.max(before.lastHealthyStep?.stepEndSeq ?? 0, state.lastLegacySeq);
    const humanReceipt = event.type === 'agent/self-heal' && event.data.action === 'manual-resumed'
      && witness.lastManualResume?.stepStartSeq > Math.max(before.lastManualResume?.stepStartSeq ?? 0, state.lastLegacySeq);
    const healthy = healthyStepProof(witness);
    // Old technical-only histories could never emit an owner acknowledgement.
    // Completed alone is insufficient: require the exact existing nonempty,
    // committed assistant/tool causal witness after the last recorded spend.
    const historicalHealthy = !state.ownership && !before.chain && event.type === 'turn/end'
      && event.data?.reason?.kind === 'completed' && healthy?.turn === event.data.turn
      && witness.lastCompletedTurn?.seq === event.seq && healthy.stepEndSeq > state.lastLegacySeq;
    if (healthyReceipt || humanReceipt || historicalHealthy) next = cleared(next, witness);
    if (event.type === 'step/start') {
      const scope = positionSchema.safeParse({ turn: event.data?.turn, step: event.data?.step });
      if (scope.success && !same(scope.data, state.scope)) next = { ...next, scope: scope.data, rows: {}, mirrors: [] };
      // Neither a new step nor a failed/cancelled/completed-empty turn refunds.
      return next;
    }
    if (event.type === 'llm/retry') {
      const seq = Number.isSafeInteger(event.seq) && event.seq > 0 ? event.seq
        : Math.max(state.lastLegacySeq, before.pendingStep?.lastSeq ?? 0, before.lastCompletedTurn?.seq ?? 0);
      try {
        const row = retryRow(event.data);
        if (!same({ turn: row.turn, step: row.step }, next.scope)) next = { ...next, scope: { turn: row.turn, step: row.step }, rows: {} };
        const updated = incorporate(next, row);
        return next.mirrors.includes(mirrorKey(row)) ? updated : { ...updated, lastLegacySeq: Math.max(next.lastLegacySeq, seq) };
      } catch { return { ...unsafe(next, 'unknown-native-provenance'), lastLegacySeq: Math.max(next.lastLegacySeq, seq) }; }
    }
    if (event.type !== 'agent/self-heal' || event.data?.recoveryOwnership === undefined) return next;
    try {
      const ownership = ownershipSchema.parse(event.data.recoveryOwnership), chain = witness.chain;
      const existing = state.ownership && before.chain && same(state.ownership.origin, { turn: before.chain.turn, step: before.chain.step });
      const expectedNative = existing ? state.ownership.legacyNativeConsumed : state.legacyConsumed;
      const expectedSemantic = existing ? state.ownership.legacySemanticConsumed : before.chain?.cycle ?? 0;
      const key = ownedMirrorKey(ownership, event.data.turn, event.data.step);
      const duplicate = existing && same(ownership, state.ownership) && state.mirrors.includes(key);
      // No upper ordinal bound: unbounded chains are valid. Exact continuity
      // (previous cycle + 1) still prevents skipping or rewinding the count.
      if (state.unsafe || event.data.action !== 'reserved' || !chain || !same(chain, event.data.state.chain)
        || chain.turn !== ownership.origin.turn || chain.step !== ownership.origin.step || chain.cycle !== ownership.retry
        || ownership.retry < 1 || !Number.isSafeInteger(event.seq) || event.seq <= event.data.causalSeq
        || event.data.causalSeq !== chain.attemptSeq || ownership.legacyNativeConsumed !== expectedNative
        || ownership.legacySemanticConsumed !== expectedSemantic || ownership.importedConsumed !== add(expectedNative, expectedSemantic)
        || state.legacyConsumed !== expectedNative || !same({ turn: event.data.turn, step: event.data.step }, state.scope)
        || !duplicate && ownership.retry !== (existing ? before.chain.cycle : ownership.importedConsumed) + 1
        || !policyFromKey(ownership.provider, ownership.policyKey)) throw new Error('Invalid recovery ownership provenance');
      const mirrors = [...new Set([...next.mirrors, key])].slice(-MAX_MIRRORS);
      return { ...next, ownership, mirrors };
    } catch { return unsafe(next, 'invalid-ownership-provenance'); }
  },
};

/** Merge the current native UI projection by ordinal delta, not by adding its
 * already-folded cumulative row. Historical failed turns survive UI resets.
 * Every refusal is a RecoveryHistoryError with a fixed, loggable reason.
 */
export function recoveryBudget(state, accounting, ledger, policy, provider, localCap = UNBOUNDED_RETRIES) {
  const refuse = (message, reason) => { throw new RecoveryHistoryError(message, reason); };
  if (!recoveryAccountingProjection.stateSchema.safeParse(accounting).success) refuse('Invalid recovery accounting state', 'invalid-accounting-state');
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) refuse('Missing native retry ledger', 'missing-native-ledger');
  let merged = accounting;
  for (const [key, entry] of Object.entries(ledger)) {
    let parsed;
    try { parsed = JSON.parse(key); } catch { refuse('Unknown native retry scope', 'unknown-native-scope'); }
    if (!Array.isArray(parsed) || parsed.length !== 2 || !accounting.scope) refuse('Unknown native retry scope', 'unknown-native-scope');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['retry', 'retryId'].includes(key))) refuse('Unknown native retry row', 'unknown-native-row');
    let row;
    try { row = retryRow({ ...entry, provider: parsed[0], policyKey: parsed[1], ...accounting.scope }); }
    catch { refuse('Unknown native retry provenance', 'unknown-native-provenance'); }
    merged = incorporate(merged, row);
  }
  // Older checkpoints set `unsafe` without a reason; it is still refused.
  if (merged.unsafe) refuse('Unsafe historical retry provenance', merged.unsafeReason ?? 'unspecified');
  const owner = merged.ownership, chain = state.chain;
  const currentOwner = chain && owner && same(owner.origin, { turn: chain.turn, step: chain.step });
  let cap = Math.min(localCap, policy.maxRetries, chain?.maxCycles ?? UNBOUNDED_RETRIES, merged.legacyCap);
  if (currentOwner) {
    const captured = policyFromKey(provider, owner.policyKey);
    if (!captured || merged.legacyConsumed !== owner.legacyNativeConsumed) refuse('Unified retry provenance mismatch', 'ownership-mismatch');
    cap = Math.min(cap, captured.maxRetries);
    return { consumed: chain.cycle, cap, policy: { ...captured, maxRetries: cap },
      legacyNativeConsumed: owner.legacyNativeConsumed, legacySemanticConsumed: owner.legacySemanticConsumed,
      importedConsumed: owner.importedConsumed, retryId: owner.retryId };
  }
  const captured = merged.legacyPolicyKey ? policyFromKey(provider, merged.legacyPolicyKey) : policy;
  if (!captured) refuse('Unknown legacy retry policy', 'unknown-legacy-policy');
  const semantic = chain?.cycle ?? 0, native = merged.legacyConsumed;
  return { consumed: add(native, semantic), cap, policy: { ...captured, maxRetries: cap },
    legacyNativeConsumed: native, legacySemanticConsumed: semantic, importedConsumed: add(native, semantic) };
}
