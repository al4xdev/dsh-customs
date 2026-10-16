import { resolveHost } from '../common.mjs';
import { POLICY_VERSION, LEGACY_POLICY_VERSIONS, READABLE_AUDIT_VERSIONS, MAX_STEP_CALLS, MAX_HUMAN_GRANTS, MAX_CHAIN_WARNINGS } from './logic.mjs';
import { WARNING_CODES } from './sanitizer.mjs';
const { z } = await import(resolveHost('zod'));
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
// Cycle counts and caps are unbounded (the unbounded sentinel is MAX_SAFE_INTEGER).
// Older bundles cap these at 10, so a newer checkpoint is not a safe downgrade.
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const chainSchema = z.object({ turn: integer, step: integer, cycle: count, maxCycles: count,
  status: z.enum(['reserved', 'admitted', 'retry-requested', 'suspended', 'aborted', 'append-failed', 'recovered']), attemptSeq: integer,
  messageId: z.string().min(1).max(128).optional(), observationSeq: integer.optional(),
  // Code of the last admitted notice and the number of notices in this chain.
  warnedCode: z.enum(WARNING_CODES).optional(), warnings: z.number().int().min(1).max(MAX_CHAIN_WARNINGS).optional() }).strict();
const progressSchema = z.object({ kind: z.literal('healthy-step'), turn: integer, step: integer,
  startSeq: integer, assistantSeq: integer, stepEndSeq: integer }).strict();
const manualProgressShape = { kind: z.literal('human-resume'), authority: z.literal('live-root-inbox'),
  turn: integer, step: integer, inboxSeq: integer, claimSeq: integer, stepStartSeq: integer };
const candidateSchema = z.object({ turn: integer, step: integer, startSeq: integer, lastSeq: integer, valid: z.boolean(),
  assistantSeq: integer.optional(), finishKind: z.enum(['stop', 'tool-calls']).optional(), stepEndSeq: integer.optional(),
  toolCount: z.number().int().min(0).max(MAX_STEP_CALLS), callSeqs: z.array(integer).max(MAX_STEP_CALLS),
  resultCallSeqs: z.array(integer).max(MAX_STEP_CALLS) }).strict();
const policyVersions = [...LEGACY_POLICY_VERSIONS, POLICY_VERSION].map(version => z.literal(version));
// Shared by the owner projection (checkpoint stateVersion 1: every older state
// still parses) and the derived history witness.
export const stateSchema = z.object({ lastHealthyTurn: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  policyVersion: z.union(policyVersions).optional(), pendingStep: candidateSchema.optional(), lastHealthyStep: progressSchema.optional(),
  inboxEvidence: z.object({ insertSeqs: z.array(integer).max(MAX_HUMAN_GRANTS), claimSeq: integer.optional() }).strict().optional(),
  lastManualResume: z.object({ ...manualProgressShape, previousChain: chainSchema.optional() }).strict().optional(),
  lastCompletedTurn: z.object({ turn: integer, seq: integer }).strict().optional(),
  seen: z.object({ attemptSeq: integer, emptyCount: z.number().int().min(0).max(2) }).strict().optional(),
  chain: chainSchema.optional(), lastRecovered: chainSchema.optional() }).strict();
const ACTIONS = new Set(['observed', 'reserved', 'observation-admitted', 'retry-requested',
  'suspended', 'aborted', 'append-failed', 'recovered', 'manual-resumed']);
/** Never turn an unknown owner protocol into a fresh, unspent recovery budget. */
export function assertAuditReadable(event, stateSchema) {
  if (event.type !== 'agent/self-heal') return;
  const data = event.data;
  if (!READABLE_AUDIT_VERSIONS.includes(data?.version) || !ACTIONS.has(data.action)) {
    throw new Error('agent-self-heal: unsupported required audit version or action; refusing recovery replay.');
  }
  stateSchema.parse(data.state);
}
