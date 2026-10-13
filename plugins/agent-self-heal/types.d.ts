import type { Context } from '@deepseek-ai/cordis';
import type { ContextFormed } from '@deepseek-ai/dsh-llm/message';
import type { SessionSeq } from '@deepseek-ai/dsh-session';
export interface Config { /** Integer 0..10; default 3. Zero disables admission. */ maxCycles?: number }
export interface SafeFailureFacts {
  readonly code: 'PI_AI_ERROR' | 'EMPTY_RESPONSE' | 'INVALID_REQUEST';
  readonly summary: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
  readonly phase?: 'sse' | 'sse-terminal';
  readonly terminalCategory?: 'malformed-function-call';
  readonly provider: 'openai-codex' | 'google-antigravity' | 'other-provider';
  readonly model?: string;
  readonly outputCap?: number;
}
export interface SelfHealChain {
  readonly turn: number;
  readonly step: number;
  readonly cycle: number;
  readonly maxCycles: number;
  readonly status: 'reserved' | 'admitted' | 'retry-requested' | 'suspended' | 'aborted' | 'append-failed' | 'recovered';
  readonly attemptSeq: SessionSeq;
  readonly messageId?: string;
  readonly observationSeq?: SessionSeq;
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
  readonly policyVersion?: 2;
  readonly pendingStep?: HealthyStepCandidate;
  readonly lastHealthyStep?: HealthyStepProof;
  readonly inboxEvidence?: { readonly insertSeqs: readonly SessionSeq[]; readonly claimSeq?: SessionSeq };
  readonly lastManualResume?: HumanResumeProof & { readonly previousChain?: SelfHealChain };
  readonly lastCompletedTurn?: { readonly turn: number; readonly seq: SessionSeq };
}
export interface SelfHealAudit {
  readonly version: 1;
  readonly action: 'observed' | 'reserved' | 'observation-admitted' | 'retry-requested' | 'suspended' | 'aborted' | 'append-failed' | 'recovered' | 'manual-resumed';
  readonly turn: number;
  readonly step: number;
  readonly state: SelfHealState;
  readonly causalSeq?: SessionSeq;
  readonly facts?: SafeFailureFacts;
  readonly progress?: HealthyStepProof | HumanResumeProof;
}
declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    'self-heal-observation': ContextFormed & {
      readonly kind: 'self-heal-observation';
      readonly label: 'Self-heal';
      readonly form: 'notice';
      readonly summary: string;
      readonly chain: string;
      readonly cycle: number;
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
export declare const inject: readonly ['agents', 'sessionProjections'];
export declare function apply(ctx: Context, config?: Config): void;
export declare const stateSchema: { parse(value: unknown): SelfHealState };
