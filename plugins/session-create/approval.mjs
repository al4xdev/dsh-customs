import { createHash } from 'node:crypto';
import { fail } from './contracts.mjs';
import { escapeHidden } from '../session/approval-text.mjs';

export function displayJson(value) {
  // JSON already escapes ASCII controls/newlines. Escape every invisible or
  // zero-width character too (Cf incl. tags/bidi/ZWJ/BOM, private use,
  // unassigned, separators, variation selectors), preserving a complete
  // reversible representation, not a clipped summary.
  return escapeHidden(JSON.stringify(value, null, 2));
}

export function approvalPreview(intent) {
  const submit = intent.delivery.mode === 'submit';
  const fields = {
    operation_id: intent.operation_id, intent_hash: intent.intent_hash,
    source_session: intent.binding.caller, new_session_id: intent.session_id,
    delivery: submit ? 'CRIAR E ENVIAR AGORA — Agent poderá executar e consumir quota' : 'CRIAR VAZIA — sem pedido, draft ou modelo executado',
    cwd: intent.cwd, target: intent.target, directory: intent.directory,
    create_projects_parent: intent.create_projects_parent, existing_project: intent.project,
    preset: intent.binding.preset, preset_binding: intent.binding.preset_binding,
    model: intent.binding.model, model_binding: intent.model_binding,
    calling_policy: intent.binding.policy, new_session_policy: { mode: 'workspace-write', approval: 'ask', workspaceRoot: intent.cwd },
    owner_intent: intent.owner_intent,
    limitations: 'Projeto, sessão, associação e envio NÃO são atômicos. Falha pode preservar resultados parciais. Sem exclusão, archive, stop ou retry automático. Confiança inclui a cadeia de answerers/UI do host; SDK não atesta autoria humana criptograficamente.',
  };
  // The actual submission remains byte-for-byte literal. The review is complete
  // escaped JSON, so prompt-controlled delimiters/bidi cannot spoof trusted fields.
  if (submit) {
    fields.initial_text_utf8_bytes = Buffer.byteLength(intent.delivery.text, 'utf8');
    fields.initial_text_sha256 = createHash('sha256').update(intent.delivery.text, 'utf8').digest('hex');
    fields.initial_text_full = intent.delivery.text;
    fields.initial_text_encoding = 'Full reversible JSON string; controls and bidi are escaped, never truncated. Submission uses original text.';
  }
  return `Nova sessão — permitir esta intenção uma vez\n${displayJson(fields)}`;
}
export async function approve(ctx, exec, intent) {
  exec.signal.throwIfAborted();
  if (!exec.agent || typeof ctx.approval?.request !== 'function') fail('approval_unavailable');
  const outcome = await ctx.approval.request(Object.freeze({ agent: exec.agent, toolName: 'session_create', callId: exec.callId, reason: approvalPreview(intent), signal: exec.signal }));
  exec.signal.throwIfAborted();
  if (outcome !== 'allowed-once') fail(`approval_${['rejected', 'cancelled', 'unavailable'].includes(outcome) ? outcome : 'unavailable'}`);
  // No token or grant is exposed to callers or stored for future continuation.
}
