import { inlineForApproval, literalBlock, refusedCharacter } from '../session/approval-text.mjs';
import { COMPANION_WORKSPACE_ROOT } from '../session/host-paths.mjs';

export const WORKSPACE_ROOT = COMPANION_WORKSPACE_ROOT;
export const MAX_COMMAND_BYTES = 64 * 1024;
// Denials reach the model verbatim as the tool error. Keep the stable code as a
// prefix and say what to do instead: the native sandbox notes and the bash/fs
// schemas still advertise sandbox_permissions, so a bare code invites retries.
export const ESCALATION_DENIED = 'workspace-escalation-denied: Companion never widens its sandbox, so sandbox_permissions, justification and policy fields are always refused here, even when a sandbox notice suggests retrying with them. Do not retry with them. Explain to the owner (human) which action needs wider access and that it has to be done outside Companion.';
export const cwdDenied = root => `workspace-cwd-denied: Bash in Companion always runs in ${root}; other or relative workdir values are refused, not resolved. Omit workdir (or pass exactly that absolute path) and put \`cd <subdirectory> && ...\` inside the command, which the owner (human) reviews literally.`;
export const invisibleDenied = codePoint => `workspace-command-invisible-character: the command contains ${codePoint}, an invisible, bidirectional or control character that the owner (human) cannot review in the approval card. Rewrite it without such characters (line breaks and tabs are fine), e.g. with printf escapes if those bytes are really needed.`;
/** Stable machine code of a denial reason (the text before the first colon). */
export const denialCode = reason => typeof reason === 'string' ? reason.split(':', 1)[0] : reason;
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
  if (privileged.some(key => own(exec.arguments, key))) return ESCALATION_DENIED;
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
  const refused = refusedCharacter(args.command);
  if (refused) return { kind: 'deny', reason: invisibleDenied(refused) };
  if (typeof args.description !== 'string' || !args.description.trim()) return { kind: 'deny', reason: 'workspace-bash-arguments-invalid' };
  if (own(args, 'workdir') && args.workdir !== policy.workspaceRoot) return { kind: 'deny', reason: cwdDenied(policy.workspaceRoot) };
  if (own(args, 'timeoutMs') && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return { kind: 'deny', reason: 'workspace-bash-arguments-invalid' };
  }
  if (own(args, 'run_in_background') && args.run_in_background !== false) return { kind: 'deny', reason: 'workspace-background-denied' };
  if (Buffer.byteLength(policy.workspaceRoot, 'utf8') > MAX_CWD_BYTES) return { kind: 'deny', reason: 'workspace-cwd-preview-invalid' };
  return {
    kind: 'ask',
    // Size and digest come before the literal, which is always last; rare
    // invisible characters (ZWJ, ZWSP...) are shown escaped, never hidden.
    reason: `Bash — permitir este comando uma vez\nCWD: ${inlineForApproval(policy.workspaceRoot)}\nSandbox: workspace-write (sem ampliação)\n${literalBlock('Comando', args.command)}`,
  };
}
