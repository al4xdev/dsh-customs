import type { Context } from '@deepseek-ai/cordis';
import type { ContextFormed } from '@deepseek-ai/dsh-llm/message';
import type { SessionSeq } from '@deepseek-ai/dsh-session';
export interface Config { /** Optional finite cap (nonnegative safe integer); absent inherits the shared unbounded policy. */ maxCycles?: number }
export interface SafeFailureFacts {
  readonly code: 'PI_AI_ERROR' | 'EMPTY_RESPONSE' | 'INVALID_REQUEST' | 'SERVER' | 'TIMEOUT' | 'TRANSPORT' | 'RATE_LIMIT' | 'ANTIGRAVITY_QUOTA_RESET';
  readonly summary: string;
  readonly diagnosticCategory?: 'unclassified-provider-failure' | 'empty-answer' | 'malformed-tool-call' | 'image-input-processing' | 'model-request-failure';
  readonly remediation?: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
  /** A malformed/zero provider minimum was ignored (local schedule applies). */
  readonly ignoredProviderHint?: true;
  readonly phase?: 'sse' | 'sse-terminal' | 'model-input-processing';
  readonly terminalCategory?: 'malformed-function-call' | 'image-input-processing';
  readonly provider: 'openai-codex' | 'google-antigravity' | 'other-provider';
  readonly model?: string;
  /** Process-local ordinal for other configured routes, never their raw identity. */
  readonly routeAlias?: string;
  readonly transientRetries?: number;
  readonly outputCap?: number;
}
export interface SelfHealChain {
  readonly turn: number;
  readonly step: number;
  /** Unbounded count; the unbounded cap sentinel is Number.MAX_SAFE_INTEGER. */
  readonly cycle: number;
  readonly maxCycles: number;
  readonly status: 'reserved' | 'admitted' | 'retry-requested' | 'suspended' | 'aborted' | 'append-failed' | 'recovered';
  readonly attemptSeq: SessionSeq;
  /** The chain's last admitted notice; carried by later cycles that add none. */
  readonly messageId?: string;
  readonly observationSeq?: SessionSeq;
  /** Code of the last admitted notice and notices so far (bounded per chain). */
  readonly warnedCode?: SafeFailureFacts['code'];
  readonly warnings?: number;
}
export interface HealthyStepProof {
  readonly kind: 'healthy-step';
  readonly turn: number;
  readonly step: number;
  readonly startSeq: SessionSeq;
  readonly assistantSeq: SessionSeq;
  readonly stepEndSeq: SessionSeq;
}
export interface HumanResumeProof {
  readonly kind: 'human-resume';
  readonly authority: 'live-root-inbox';
  readonly turn: number;
  readonly step: number;
  readonly inboxSeq: SessionSeq;
  readonly claimSeq: SessionSeq;
  readonly stepStartSeq: SessionSeq;
}
/** Numeric-only staged evidence; step/end alone does not authorize renewal. */
export interface HealthyStepCandidate {
  readonly turn: number;
  readonly step: number;
  readonly startSeq: SessionSeq;
  readonly lastSeq: SessionSeq;
  readonly valid: boolean;
  readonly assistantSeq?: SessionSeq;
  readonly finishKind?: 'stop' | 'tool-calls';
  readonly stepEndSeq?: SessionSeq;
  readonly toolCount: number;
  readonly callSeqs: readonly SessionSeq[];
  readonly resultCallSeqs: readonly SessionSeq[];
}
export interface SelfHealState {
  readonly lastHealthyTurn: number;
  readonly seen?: { readonly attemptSeq: SessionSeq; readonly emptyCount: number };
  readonly chain?: SelfHealChain;
  readonly lastRecovered?: SelfHealChain;
  /** 3 for this owner; 2 states from owner6 remain readable. */
  readonly policyVersion?: 2 | 3;
  readonly pendingStep?: HealthyStepCandidate;
  readonly lastHealthyStep?: HealthyStepProof;
  readonly inboxEvidence?: { readonly insertSeqs: readonly SessionSeq[]; readonly claimSeq?: SessionSeq };
  readonly lastManualResume?: HumanResumeProof & { readonly previousChain?: SelfHealChain };
  readonly lastCompletedTurn?: { readonly turn: number; readonly seq: SessionSeq };
}
export interface SelfHealAudit {
  /** 2 for this owner (policy 3); version-1 audits from older owners stay readable. */
  readonly version: 1 | 2;
  readonly action: 'observed' | 'reserved' | 'observation-admitted' | 'retry-requested' | 'suspended' | 'aborted' | 'append-failed' | 'recovered' | 'manual-resumed';
  readonly turn: number;
  readonly step: number;
  readonly state: SelfHealState;
  readonly causalSeq?: SessionSeq;
  readonly facts?: SafeFailureFacts;
  readonly progress?: HealthyStepProof | HumanResumeProof;
  /** Additive metadata: legacy strict state/action readers remain valid. */
  readonly recoveryWait?: { readonly version: 1; readonly phase: 'self-heal' | 'contextual-recovery'; readonly retry: number; readonly delayMs: number; readonly policyKey: string; readonly scheduledAtMs: number; readonly notBeforeMs: number; readonly providerMinimumMs?: number };
  /** `retry` is the chain cycle. v2 declares the native llm/retry mirror
   * coordinates (`retryId`, `mirrorRetry`: 1.. per turn/step/policy key). */
  readonly recoveryOwnership?: {
    readonly version: 1 | 2; readonly kind: 'unified-agent-warning';
    readonly origin: { readonly turn: number; readonly step: number };
    readonly provider: string; readonly policyKey: string; readonly retryId: string; readonly retry: number;
    readonly mirrorRetry?: number;
    readonly legacyNativeConsumed: number; readonly legacySemanticConsumed: number; readonly importedConsumed: number;
  };
  /** A live root human inbox message ended the local backoff early. */
  readonly recoveryWake?: { readonly version: 1; readonly kind: 'live-human-inbox'; readonly inboxSeq: SessionSeq };
}
declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    'self-heal-observation': ContextFormed & {
      readonly kind: 'self-heal-observation';
      readonly label: 'Self-heal' | 'Harness warning';
      readonly form: 'notice';
      readonly summary: string;
      readonly chain?: string;
      /** Written by older owners only; contract 3 notices carry no counter. */
      readonly cycle?: number;
      readonly attemptSeq: SessionSeq;
    };
  }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'agent/self-heal': SelfHealAudit }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { agentSelfHeal: SelfHealState }
}
export declare const name: 'alex-agent-self-heal';
export declare const inject: readonly ['agents', 'sessionProjections', 'llmRecoveryUnbounded'];
export declare function apply(ctx: Context, config?: Config): void;
export declare const stateSchema: { parse(value: unknown): SelfHealState };
