export const WORKSPACE_ROOT = '/home/alex/git/my/dsh-companion-workspace';
export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_CWD_BYTES = 4096;
export const GUARDED_TOOLS = Object.freeze(['read', 'write', 'edit', 'read_image', 'list', 'bash']);
const guarded = new Set(GUARDED_TOOLS);
const readTools = new Set(['read', 'read_image', 'list']);
// Only top-level capability controls, not arbitrary file content or business fields.
const privileged = Object.freeze([
  'sandbox_permissions', 'justification', 'sandboxPolicy', 'sandbox_policy',
  'sandboxMode', 'sandbox_mode', 'workspaceRoot', 'approvalPolicy', 'approval_policy',
]);
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function assertMount(profile, scopeKey) {
  if (profile !== 'companion' || !scopeKey) throw new Error('companion-workspace requires the companion preset scope');
}

/** Native ToolGuard contract: a string denies; undefined does not grant anything. */
export function guardReason(exec, policy, authorizedCwd) {
  if (!guarded.has(exec?.name)) return undefined;
  const header = exec.agent?.session?.header;
  if (header?.agentPreset !== 'companion') return 'workspace-session-scope-denied';
  // Legacy sessions retain their immutable cwd. Broad host reads are safe in
  // both native restricted modes; never turn that into a repo-root write grant.
  if (readTools.has(exec.name)) {
    if (!['read-only', 'workspace-write'].includes(policy?.mode)) return 'workspace-policy-denied';
  } else {
    // authorizedCwd is supplied only by the host's live incarnation proof, never arguments.
    if (header.cwd !== WORKSPACE_ROOT && (typeof authorizedCwd !== 'string' || header.cwd !== authorizedCwd)) return 'workspace-session-scope-denied';
    if (policy?.mode !== 'workspace-write' || policy.workspaceRoot !== header.cwd) return 'workspace-policy-denied';
  }
  if (!record(exec.arguments)) return 'workspace-arguments-invalid';
  if (privileged.some(key => own(exec.arguments, key))) return 'workspace-escalation-denied';
  if (exec.signal?.aborted) return 'workspace-call-cancelled';
  return undefined;
}

/** No model summary participates in the literal approval preview. */
export function bashDecision(exec, policy, authorizedCwd) {
  const denied = guardReason(exec, policy, authorizedCwd);
  if (denied) return { kind: 'deny', reason: denied };
  if (exec?.name !== 'bash') return { kind: 'deny', reason: 'workspace-not-bash' };
  const args = exec.arguments;
  if (typeof args.command !== 'string' || !args.command.trim() || args.command.includes('\0') ||
      Buffer.byteLength(args.command, 'utf8') > MAX_COMMAND_BYTES) return { kind: 'deny', reason: 'workspace-command-preview-invalid' };
  if (typeof args.description !== 'string' || !args.description.trim()) return { kind: 'deny', reason: 'workspace-bash-arguments-invalid' };
  if (own(args, 'workdir') && args.workdir !== policy.workspaceRoot) return { kind: 'deny', reason: 'workspace-cwd-denied' };
  if (own(args, 'timeoutMs') && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return { kind: 'deny', reason: 'workspace-bash-arguments-invalid' };
  }
  if (own(args, 'run_in_background') && args.run_in_background !== false) return { kind: 'deny', reason: 'workspace-background-denied' };
  if (Buffer.byteLength(policy.workspaceRoot, 'utf8') > MAX_CWD_BYTES) return { kind: 'deny', reason: 'workspace-cwd-preview-invalid' };
  return {
    kind: 'ask',
    reason: `Bash — permitir este comando uma vez\nCWD: ${policy.workspaceRoot}\nSandbox: workspace-write (sem ampliação)\nComando literal completo:\n${args.command}`,
  };
}
