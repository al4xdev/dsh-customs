import { resolveHost } from '../common.mjs';
import { outputSchema } from './contracts.mjs';
import { parseProfileArgs as parseArgs, profileParameters as parameters } from './profile-contracts.mjs';
const { scopeOf } = await import(resolveHost('@deepseek-ai/dsh-scope'));
const { validateJsonSchemaValue } = await import(resolveHost('@deepseek-ai/dsh-tools'));
export const name = 'companion-session-create';
export const inject = ['tools', 'sessionCreateOwner'];

export function apply(ctx, config = {}) {
  if (config.profile !== 'companion' || !scopeOf(ctx)) throw new Error('session_create must be scoped to the companion preset');
  const owner = ctx.get('sessionCreateOwner');
  if (typeof owner?.execute !== 'function') throw new Error('native root-owned session_create service unavailable');
  ctx.tools.guard(exec => exec.name === 'session_create' && exec.agent?.session.header.agentPreset !== 'companion' ? 'session-create-scope-denied' : undefined);
  // Raw closed root avoids defineTool's implicit OPEN parameter-root contract.
  ctx.tools.register({
    name: 'session_create',
    description: 'Create a session in the REAL dsh-tui profile, standard preset, through an already-open compatible host; never create another Companion as fallback. Start with capabilities to discover host IDs; if multiple hosts exist, select exact request.host_id. An old/missing bridge requires opening/reloading dsh-tui, not silently changing profile. Native allowed-once approval in Companion binds destination profile, model, actual policies, cwd and full literal task. Destination may use danger-full-access/never; approval displays it explicitly, without changing global defaults. Default delivery empty: no prompt, draft, model execution or UI switch. Explicit submit admits the literal task and may run Agent/consume quota. Current cwd/projects stay within dedicatedRoot boundaries. Handles belong to the destination host, independent of the calling Companion. help/capabilities/status are read-only. UNKNOWN requires owner recovery; no automatic retry, cleanup or replay of approval.',
    parameters,
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }], presentationMeta: (_args, value) => value },
    isConcurrencySafe: args => { try { return parseArgs(args).operation !== 'create'; } catch { return false; } },
    async execute(args, exec) {
      const violations = validateJsonSchemaValue(parameters, args);
      if (violations.length) throw new Error('Invalid session_create arguments');
      parseArgs(args);
      if (exec.agent?.session.header.agentPreset !== 'companion') throw new Error('session-create-scope-denied');
      return owner.execute(args, exec);
    },
    presentCall: args => ({ card: 'generic', title: 'Nova sessão — confirmação obrigatória', rawInput: args }),
  });
}
