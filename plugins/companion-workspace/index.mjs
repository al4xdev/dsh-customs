import { assertMount, bashDecision, guardReason, GUARDED_TOOLS } from './guard-policy.mjs';
import { resolveInstalled } from '../session/host-paths.mjs';

export const name = 'companion-workspace';
export const inject = ['tools', 'sandboxPolicy', 'sandbox', 'shell'];

async function hostScopeOf() {
  return (await import(resolveInstalled('@deepseek-ai/dsh-scope', 'companion-workspace native scope service unavailable'))).scopeOf;
}

export async function apply(ctx, config = {}) {
  const scopeOf = await hostScopeOf();
  installWorkspaceGuard(ctx, config, scopeOf(ctx));
}

/** Explicit scope argument lets pure fixtures exercise mounting without creating SDK services. */
export function installWorkspaceGuard(ctx, config, scopeKey) {
  // Do not touch services, hooks or registrations before rejecting an accidental global mount.
  assertMount(config?.profile, scopeKey);
  const policyService = ctx.get('sandboxPolicy');
  const sandbox = ctx.get('sandbox');
  const shell = ctx.get('shell');
  if (typeof policyService?.resolve !== 'function' || typeof sandbox?.confine !== 'function' ||
      typeof shell?.sandboxMode !== 'string') throw new Error('companion-workspace requires native sandbox services');
  const guarded = new Set(GUARDED_TOOLS);
  let authority;
  const attachAuthority = owner => {
    if (typeof owner?.attachGuard !== 'function' || typeof owner.allows !== 'function' ||
        typeof owner.validate !== 'function' || typeof owner.capabilities !== 'function') throw new Error('invalid session-create authority');
    authority = owner;
    const dispose = owner.attachGuard({ workspaceRoot: owner.capabilities().workspaceRoot, revision: 1 });
    return () => { authority = undefined; dispose(); };
  };
  // Preset standing mounts can precede the optional root owner. The public
  // injection lifecycle joins it later and withdraws proofs when it disappears.
  if (typeof ctx.inject === 'function') ctx.inject(['sessionCreateAuthority'], scope => {
    scope.effect(() => attachAuthority(scope.get('sessionCreateAuthority')));
  });
  else if (ctx.get('sessionCreateAuthority')) ctx.effect(() => attachAuthority(ctx.get('sessionCreateAuthority')));
  const resolvePolicy = exec => {
    if (!guarded.has(exec?.name)) return undefined;
    try { return policyService.resolve({ session: exec.agent?.session }); } catch { return undefined; }
  };

  const preparedBash = new WeakSet();
  const preparedScope = new WeakMap();
  const approvedCwd = (exec, policy) => authority?.allows(exec, policy) && preparedScope.get(exec) === exec.agent?.session.header.cwd
    ? preparedScope.get(exec) : undefined;
  // SDK registration effects own both disposers through this preset context.
  // A different middleware short-circuiting this hook cannot silently dispatch Bash.
  ctx.tools.guard(exec => guardReason(exec, resolvePolicy(exec), approvedCwd(exec, resolvePolicy(exec))) ??
    (exec.name === 'bash' && !preparedBash.has(exec) ? 'workspace-bash-approval-required' : undefined));
  ctx.on('tools/pre-execute', async (exec, next) => {
    const policy = resolvePolicy(exec);
    // A child proof is checked asynchronously against approved canonical inode facts.
    // If this listener is bypassed, the monotonic guard has no prepared scope to trust.
    if (guarded.has(exec.name) && authority?.allows(exec, policy)) {
      if (!await authority.validate(exec, policy)) return { kind: 'deny', reason: 'workspace-project-authority-changed' };
      if (exec.signal?.aborted) return { kind: 'cancel' };
      preparedScope.set(exec, exec.agent.session.header.cwd);
    }
    const denied = guardReason(exec, policy, approvedCwd(exec, policy));
    if (denied) return { kind: 'deny', reason: denied };
    if (exec.name !== 'bash') return next();
    const decision = bashDecision(exec, policy, approvedCwd(exec, policy));
    if (decision.kind !== 'ask') return decision;
    if (exec.signal?.aborted) return { kind: 'cancel' };
    try {
      // Public confine prepares enforcing argv, never dispatches the Bash payload.
      // Native provider setup may probe its runner; partial enforcement is rejected
      // here rather than discovering it after an approved destructive call.
      const facts = await sandbox.confine(['bash', '-c', exec.arguments.command], policy, exec.signal);
      if (facts?.enforcement !== 'full') return { kind: 'deny', reason: 'workspace-sandbox-not-full' };
    } catch {
      return exec.signal?.aborted ? { kind: 'cancel' } : { kind: 'deny', reason: 'workspace-sandbox-unavailable' };
    }
    if (exec.signal?.aborted) return { kind: 'cancel' };
    if (authority?.allows(exec, policy) && !await authority.validate(exec, resolvePolicy(exec))) return { kind: 'deny', reason: 'workspace-project-authority-changed' };
    const changed = guardReason(exec, resolvePolicy(exec), approvedCwd(exec, resolvePolicy(exec)));
    if (changed) return { kind: 'deny', reason: changed };
    // Never delegate Bash to an allow fallback. Native ToolRuntime awaits a
    // fresh human allowed-once and rechecks cancellation before its body.
    preparedBash.add(exec);
    return decision;
  });
}
