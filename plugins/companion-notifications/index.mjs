import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute } from 'node:path';
import { MockSink, eventId } from './mock-sink.mjs';

export const name = 'companion-notifications';
export const inject = ['agents', 'goals', 'agentPresets', 'profileContext'];

async function nativeApis() {
  for (const base of [process.argv[1], '/home/alex/.local/share/dsh-cli/package.json']) {
    let require;
    try { require = createRequire(base); require.resolve('@deepseek-ai/dsh-goal'); } catch { continue; }
    return { ...await import(require.resolve('@deepseek-ai/dsh-scope')), ...await import(require.resolve('@deepseek-ai/dsh-goal')) };
  }
  throw new Error('companion-notifications native SDK unavailable');
}

export async function apply(ctx, config = {}) {
  const api = await nativeApis();
  const key = api.scopeOf(ctx);
  const profile = ctx.get('profileContext');
  // Reject BEFORE creating any sink or hook. A config string alone is not a runtime binding.
  if (config.profile !== 'companion' || !key || profile?.name !== 'companion' || !isAbsolute(profile?.dir ?? '')) {
    throw new Error('companion-notifications requires the companion profile and preset scope');
  }
  const sink = new MockSink(profile.dir);
  ctx.on('goal/changed', ({ agent, change }) => {
    try {
      if (ctx.get('profileContext') !== profile || profile.name !== 'companion' ||
          ctx.agents.get(agent.id) !== agent || !ctx.agents.roots().includes(agent) ||
          agent.session.id !== agent.id || agent.session.header.agentPreset !== 'companion' ||
          agent.session.header.origin === 'subagent' || agent.session.header.isSeeded ||
          ctx.agentPresets.composedPreset(agent.ctx) !== 'companion' ||
          !api.scopeChainOf(api.scopeOf(agent.ctx)).includes(key) ||
          change?.operation !== 'complete' || change.goal?.phase !== 'complete') return;
      const current = ctx.goals.get(agent);
      if (!isDeepStrictEqual(current, change.goal) || change.ref.id !== current.id || change.ref.revision !== current.revision) return;
      const events = agent.session.snapshotEvents();
      const terminal = events.at(-1);
      if (terminal?.type !== 'goal/change' || terminal.data.operation !== 'complete' ||
          terminal.data.goal.id !== current.id || terminal.data.goal.revision !== current.revision) return;
      // A real typed event is necessary, but not sufficient: native strict replay proves
      // the prior nonterminal revision and exact complete transition in THIS session.
      const before = api.foldGoal(events.slice(0, -1));
      const after = api.foldGoal(events);
      if (before.goal?.id !== current.id || before.goal.phase === 'complete' ||
          before.goal.revision + 1 !== current.revision || !isDeepStrictEqual(after.goal, terminal.data.goal)) return;
      sink.deliver({ version: 1, eventId: eventId(agent.id, current.id, current.revision),
        goalId: current.id, revision: current.revision, sessionId: agent.id,
        phase: 'completed', timestamp: after.updatedAt });
    } catch {
      // Never forward an exception (which may contain private paths/objectives),
      // throw through the native completion, retry forever, or mutate the goal.
      ctx.logger.warn('companion-notifications: mock delivery failed; native goal unchanged');
    }
  });
}
