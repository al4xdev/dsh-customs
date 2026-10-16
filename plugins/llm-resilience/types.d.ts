import type { Context } from '@deepseek-ai/cordis';
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';

export type TransientCode = 'EMPTY_RESPONSE' | 'RATE_LIMIT' | 'SERVER' | 'TIMEOUT' | 'TRANSPORT';
export type RecoveryCode = TransientCode | 'PI_AI_ERROR' | 'INVALID_REQUEST';
/** Explicit plugin-owned overrides, not a native provider's resolved defaults. */
export interface PolicyPatch {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  retryableCodes?: readonly RecoveryCode[];
}
export interface AuxiliaryConfig {
  maxBufferBytes?: number;
  maxChunks?: number;
  replaySafePurposes?: readonly string[];
}
export interface SelfHealConfig {
  /** Admission cap only; never creates a second retry allowance. */
  maxCycles?: number;
  /** Deprecated: if supplied these must equal the policy backoff. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}
export interface ResilienceConfig {
  policy?: PolicyPatch;
  providers?: Readonly<Record<string, PolicyPatch>>;
  auxiliary?: AuxiliaryConfig;
  selfHeal?: SelfHealConfig;
}
export interface EffectivePolicy extends Readonly<Required<Omit<PolicyPatch, 'retryableCodes'>>> {
  readonly mode: 'normal';
  readonly retryableCodes: readonly string[];
  readonly sourceExtension: Readonly<{ antigravityQuotaReset: boolean }>;
}
export interface RetryPlan {
  readonly phase: 'recovery';
  readonly provider: string;
  readonly policy: EffectivePolicy;
  readonly policyKey: string;
  readonly retry: number;
  readonly delayMs: number;
}
export interface SelfHealPlan {
  readonly phase: 'self-heal';
  readonly policyKey: string;
  readonly retry: number;
  readonly delayMs: number;
}
export interface ControllerInternals {
  random?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  clock?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(timer: unknown): void;
  };
}
export interface ResilienceController {
  readonly recoveryVersion: 2;
  readonly recoveryHistoryVersion: 2;
  readonly config: Readonly<{
    policy: Readonly<Required<PolicyPatch> & { mode: 'normal' }>;
    providers: Readonly<Record<string, Readonly<PolicyPatch>>>;
    auxiliary: Readonly<Required<AuxiliaryConfig>>;
    selfHeal: Readonly<Required<SelfHealConfig>>;
  }>;
  readonly signal: AbortSignal;
  policyFor(provider: string, registeredPolicy?: ResolvedRetryPolicy): EffectivePolicy;
  plan(input: { provider: string; failure: LlmFailure | RecoveryFacts; previousRetry?: number; registeredPolicy?: ResolvedRetryPolicy; policy?: EffectivePolicy }): RetryPlan | undefined;
  /** Deprecated compatibility view of the same backoff; never another allowance. */
  selfHealPlan(cycle: number): SelfHealPlan | undefined;
  wait(plan: RetryPlan | SelfHealPlan, signal?: AbortSignal): Promise<boolean>;
  dispose(): Promise<void>;
}
export interface RecoveryFacts {
  readonly code: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
  readonly diagnosticCategory?: string;
  readonly category?: string;
  readonly cancelled?: boolean;
  readonly aborted?: boolean;
  readonly permanent?: boolean;
  readonly invalidFailureFacts?: boolean;
}
export declare function createController(config?: ResilienceConfig, internals?: ControllerInternals): ResilienceController;
export declare function installMainDriver(ctx: Context, controller: ResilienceController): () => Promise<void>;
export declare const Config: (config?: ResilienceConfig) => ResilienceConfig;
export declare const name: 'alex-llm-resilience';
export declare const inject: readonly ['llm', 'agents', 'sessionProjections'];
export declare function apply(ctx: Context, config?: ResilienceConfig, internals?: ControllerInternals): void;

declare module '@deepseek-ai/cordis' {
  interface Context {
    llmResilience: ResilienceController;
    /** Contextual-recovery capability; absent on the legacy technical owner. */
    llmRecovery: ResilienceController;
    /** Ready only after the history-v2 projection is registered. */
    llmRecoveryHistory: ResilienceController;
  }
}
