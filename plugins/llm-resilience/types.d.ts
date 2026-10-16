import type { Context } from '@deepseek-ai/cordis';
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';

export type TransientCode = 'EMPTY_RESPONSE' | 'RATE_LIMIT' | 'SERVER' | 'TIMEOUT' | 'TRANSPORT';
export type RecoveryCode = TransientCode | 'PI_AI_ERROR' | 'INVALID_REQUEST';
/** Explicit plugin-owned overrides, not a native provider's resolved defaults. */
export interface PolicyPatch {
  /** Nonnegative safe integer; omitted everywhere = no count limit (Number.MAX_SAFE_INTEGER sentinel). */
  maxRetries?: number;
  /** Largest honored provider minimum (Retry-After/quota reset), 1..86400000; default 86400000. */
  maxProviderWaitMs?: number;
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
  readonly kind: 'wait';
  readonly phase: 'recovery';
  readonly provider: string;
  readonly policy: EffectivePolicy;
  readonly policyKey: string;
  readonly retry: number;
  readonly delayMs: number;
  /** Provider-declared minimum; a wake never ends the wait before it. */
  readonly minimumDelayMs?: number;
}
export type RefusalReason = 'route-opt-out' | 'unrepresentable-policy' | 'controller-disposed' | 'invalid-retry-ordinal'
  | 'retries-disabled' | 'retry-budget-exhausted' | 'ineligible-failure' | 'quota-reset-without-hint' | 'provider-wait-over-cap' | 'invalid-failure-facts';
export interface RetryRefusal { readonly kind: 'refused'; readonly reason: RefusalReason }
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
  /** Monotonic milliseconds (default performance.now). */
  now?: () => number;
  /** Wall-clock milliseconds (default Date.now); keeps advancing through suspend. */
  wallNow?: () => number;
  /** Re-check period for real timers (default 60000; injected timers: no slicing). */
  wallClockSliceMs?: number;
  clock?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(timer: unknown): void;
    now?(): number;
    wallNow?(): number;
  };
}
export interface ResilienceController {
  readonly recoveryVersion: 3;
  readonly recoveryHistoryVersion: 3;
  readonly config: Readonly<{
    policy: Readonly<Required<PolicyPatch> & { mode: 'normal' }>;
    providers: Readonly<Record<string, Readonly<PolicyPatch>>>;
    auxiliary: Readonly<Required<AuxiliaryConfig>>;
    selfHeal: Readonly<Required<SelfHealConfig>>;
  }>;
  readonly signal: AbortSignal;
  policyFor(provider: string, registeredPolicy?: ResolvedRetryPolicy): EffectivePolicy;
  plan(input: { provider: string; failure: LlmFailure | RecoveryFacts; previousRetry?: number; registeredPolicy?: ResolvedRetryPolicy; policy?: EffectivePolicy }): RetryPlan | undefined;
  /** Same decision as plan(), with a fixed loggable reason when refused. */
  schedule(input: { provider: string; failure: LlmFailure | RecoveryFacts; previousRetry?: number; registeredPolicy?: ResolvedRetryPolicy; policy?: EffectivePolicy }): RetryPlan | RetryRefusal;
  /** Deprecated compatibility view of the same backoff; never another allowance. */
  selfHealPlan(cycle: number): SelfHealPlan | undefined;
  /** An aborted `wake` ends the local backoff early, never before `minimumDelayMs`. */
  wait(plan: RetryPlan | SelfHealPlan, signal?: AbortSignal, options?: { wake?: AbortSignal; onWoken?: () => void; notBeforeMs?: number }): Promise<boolean>;
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
    /** Contract 3, ready after the accounting-v3 projection is registered. The
     * older llmResilience/llmRecovery/llmRecoveryHistory names (contract 2) are
     * deliberately not published by this controller. */
    llmRecoveryUnbounded: ResilienceController;
  }
}
