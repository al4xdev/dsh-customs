import { defineTool, stringOutput, assertActive } from '../common.mjs';

export const name = 'alex-shell-reconsider';
export const inject = ['tools'];

// Commands that should strictly use native tools instead of shell
const READ_OPS = /^(?:sudo\s+)?(cat|head|tail|less|more)\b/;
const LIST_OPS = /^(?:sudo\s+)?(ls|tree|find)\b/;
const GREP_OPS = /^(?:sudo\s+)?(grep|egrep|fgrep|rg)\b/;
const DESTRUCTIVE_OPS = /\b(?:sudo\s+)?(rm|unlink)\b/;

/**
 * Classifies a shell command to identify reading, directory exploration,
 * content search, or destructive file deletions.
 */
function classifyCommand(rawCommand) {
  if (typeof rawCommand !== 'string') return null;
  const trimmed = rawCommand.trim();
  if (!trimmed) return null;

  // Split sequential pipelines/chains (&&, ||, ;)
  const chains = trimmed.split(/&&|\|\||;/).map(c => c.trim()).filter(Boolean);

  for (const chain of chains) {
    // Check for destructive removals anywhere in the chain
    if (DESTRUCTIVE_OPS.test(chain)) {
      return {
        type: 'destructive',
        reason: 'Destructive command (rm/unlink) blocked. Prefer the native `trash` tool for recoverable removal. If permanent deletion is strictly required by the user, confirm via shell_reconsider(necessary=true).'
      };
    }

    // Inspect the leading command of any pipeline (e.g. "cat x | grep y" -> head is "cat x").
    // Downstream filters on legitimate process output (e.g. "npm test | grep FAIL") are preserved.
    const head = chain.split('|')[0].trim();

    if (READ_OPS.test(head)) {
      return {
        type: 'read',
        reason: 'Shell command blocked: for viewing file contents, use the native `read` tool instead of shell.'
      };
    }

    if (LIST_OPS.test(head)) {
      return {
        type: 'list',
        reason: 'Shell command blocked: for exploring directories and listing files, use the native `list` (or `glob`) tool instead of shell.'
      };
    }

    if (GREP_OPS.test(head)) {
      return {
        type: 'grep',
        reason: 'Shell command blocked: for searching file content, use the native `grep` tool instead of shell.'
      };
    }
  }

  return null;
}

const fingerprint = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/**
 * Relaxes the description requirement on the bash tool:
 * 1. Removes 'description' from parameters.required so schema validation passes.
 * 2. Augments exec.arguments in tools/execute if description is omitted by the model.
 * 3. Wraps bash.execute as a fallback.
 */
export function apply(ctx, config = {}) {
  const patchBash = agent => {
    const bash = ctx.tools.get('bash', agent) ?? ctx.tools.get('bash');
    if (!bash) return;

    if (bash.parameters?.required && Array.isArray(bash.parameters.required)) {
      bash.parameters.required = bash.parameters.required.filter(key => key !== 'description');
    }

    if (!bash._descriptionRelaxed) {
      bash._descriptionRelaxed = true;
      const originalExecute = bash.execute;
      bash.execute = async function (args, exec) {
        const normalized = { ...args };
        if (typeof normalized.description !== 'string' || normalized.description.trim().length === 0) {
          normalized.description = typeof normalized.command === 'string' && normalized.command.trim()
            ? `Run: ${normalized.command.slice(0, 60)}`
            : 'Execute bash command';
        }
        return originalExecute.call(this, normalized, exec);
      };
    }
  };

  patchBash();
  ctx.on('tools/change', () => patchBash());

  // Hook tools/execute waterfall: populate description before dispatchToolBody runs tool.execute
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'bash') {
      patchBash(exec.agent);
      if (!exec.arguments?.description || typeof exec.arguments.description !== 'string' || !exec.arguments.description.trim()) {
        exec.arguments = {
          ...exec.arguments,
          description: typeof exec.arguments?.command === 'string' && exec.arguments.command.trim()
            ? `Run: ${exec.arguments.command.slice(0, 60)}`
            : 'Execute bash command',
        };
      }
    }
    return next();
  });

  // Retain config compatibility for existing profile overlays
  const interval = config.interval ?? 50;
  const unit = config.unit ?? 'steps';
  if (!Number.isSafeInteger(interval) || interval < 1) throw new Error('shell-reconsider: interval must be a positive integer.');
  if (!['steps', 'turns'].includes(unit)) throw new Error('shell-reconsider: unit must be steps or turns.');
  const states = new WeakMap();
  const stateOf = session => {
    let state = states.get(session);
    if (!state) states.set(session, state = { ticks: 0, last: null, pending: null, permit: null, notices: new Map() });
    return state;
  };

  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const state = stateOf(agent.session), key = unit === 'turns' ? turn : `${turn}:${step}`;
    if (state.turn !== turn) { state.turn = turn; state.pending = null; state.permit = null; }
    // Retries of the same request do not consume the interval again.
    if (key !== state.last) { state.last = key; state.ticks++; }
    return next();
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'bash') patchBash(exec.agent);
    // PTC subcalls cannot perform a separate model confirmation inside their program.
    if (exec.name !== 'bash' || !exec.agent || exec.parent || exec.signal.aborted) return next();
    const state = stateOf(exec.agent.session), key = fingerprint(exec.arguments);
    if (state.permit !== null) {
      const permitted = state.permit === key;
      state.permit = null; // A grant is single-use, not a general shell bypass.
      if (permitted) return next();
    }

    const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : '';
    const check = classifyCommand(command);

    // Legitimate development commands (git, npm, build, test, python, etc.) pass straight through.
    if (!check) return next();

    if (check.type === 'destructive') {
      state.pending = key;
      state.notices.set(exec.callId, { event: null, exposed: false });
      return { kind: 'deny', reason: check.reason };
    }

    // Read/list/grep operations: direct deny pointing to native tools (read, list, glob, grep).
    state.notices.set(exec.callId, { event: null, exposed: false });
    return { kind: 'deny', reason: check.reason };
  }, true);

  ctx.tools.register(defineTool({
    name: 'shell_reconsider',
    description: 'Answer a pending shell necessity check for a blocked destructive command. true allows one identical bash retry; false cancels it. No shell command is run by this tool.',
    parameters: { necessary: { type: 'boolean', required: true, description: 'Is shell necessary rather than a dedicated tool?' } },
    output: stringOutput,
    async execute({ necessary }, exec) {
      assertActive(exec);
      if (!exec.agent) throw new Error('An agent is required.');
      const state = stateOf(exec.agent.session);
      if (!state.pending) return 'No pending shell check.';
      state.permit = necessary ? state.pending : null;
      state.pending = null;
      return necessary ? 'true' : 'false';
    },
  }));

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return;
    const entry = states.get(session)?.notices.get(event.data.message.toolCallId);
    if (entry) entry.event = event;
  });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const state = states.get(agent.session);
    if (state) for (const [callId, entry] of state.notices) {
      if (!entry.event) continue;
      if (!entry.exposed) { entry.exposed = true; continue; }
      const event = entry.event;
      // Keep immutable audit history and tool-call pairing, but remove the instruction
      // from future model requests after the model has had one opportunity to see it.
      if (agent.session.surface.nodes.includes(event.seq)) agent.session.append('tool/result', {
        ...event.data,
        message: { ...event.data.message, content: [{ type: 'text', text: 'Shell was not executed.' }] },
      }, { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] });
      state.notices.delete(callId);
    }
    return next();
  });
}
