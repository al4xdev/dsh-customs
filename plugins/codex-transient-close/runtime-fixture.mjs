import assert from 'node:assert/strict';
import { parentPort, workerData } from 'node:worker_threads';
import { resolveHost } from '../common.mjs';
import * as plugin from './index.mjs';

const host = async id => import(resolveHost(`@deepseek-ai/${id}`));
const { Context } = await host('cordis');
const llm = await host('dsh-llm');
const { default: Sessions } = await host('dsh-session');
const { default: Projections } = await host('dsh-session-projection');
const { default: Agents } = await host('dsh-agent');
const { default: SystemPrompt } = await host('dsh-system-prompt');
const { default: Tools, defineTool } = await host('dsh-tools');
const { default: Loop } = await host('dsh-agent-loop');
const retryPlugin = await host('dsh-llm-retry');

// Fail closed against accidental provider traffic, even if a fixture is changed.
globalThis.fetch = () => { throw new Error('Network forbidden in offline runtime fixture'); };
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket forbidden in offline runtime fixture'); } };

const failure = (message = 'WebSocket closed 1012 service restart', code = 'PI_AI_ERROR') => ({
  type: 'finish', reason: { kind: 'error', failure: { code, message } },
});
function* toolChunks(complete) {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: 'fixture-call', name: 'fixture_spy', argumentsDelta: '{}' };
  if (complete) yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fixture-call', name: 'fixture_spy', arguments: '{}' } };
}

async function scenario(settings) {
  const ctx = new Context();
  const calls = [], dispatches = [], atFailure = [], atBackoff = [], errors = [];
  const logs = new Map();
  const starts = [];
  let pluginFiber, retryFiber, retryDisposal;
  try {
    for (const service of [llm.default, Sessions, Projections, Agents, SystemPrompt, Tools]) await ctx.plugin(service);
    await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 });
    // Keep the official default maxRetries=5; shrink only the test clock delays.
    const policy = llm.resolveRetryPolicy({ mode: 'normal', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'fixture');
    assert.equal(policy.maxRetries, 5);
    const adapter = new class extends llm.LlmAdapter {
      providerRetryPolicy() { return policy; }
      listModels() { return [{ id: 'fixture-model', name: 'Fixture', contextWindow: 10000, maxTokens: 1000, input: ['text'], output: ['text'] }]; }
      async *stream(options) {
        assert.ok(llm.isAgentLoopRequest(options), 'real loop and plugin must share the host marker module');
        assert.ok(Object.isFrozen(options), 'loop requests remain immutable');
        const ordinal = calls.filter(call => call.sessionId === options.sessionId).length;
        calls.push({ ordinal, sessionId: options.sessionId, messages: options.messages, marked: llm.isAgentLoopRequest(options) });
        if (settings.exhaust || ordinal === 0) {
          yield* toolChunks(settings.complete);
          yield failure(settings.message, settings.code);
        } else if (ordinal === 1) {
          yield* toolChunks(true);
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }();
    ctx.llm.registerAdapter(['openai-codex'], adapter);
    ctx.tools.register(defineTool({ name: 'fixture_spy', description: 'Offline side-effect-free counter.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute(_args, exec) { dispatches.push(exec.agent.id); return 'fixture-only'; },
    }));
    ctx.on('agent/request-error', (payload, next) => {
      atFailure.push({ id: payload.agent.id, code: payload.failure.code, dispatchCount: dispatches.length,
        events: (logs.get(payload.agent.id) ?? []).map(event => event.type) });
      return next();
    }, { prepend: true });
    ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'start') starts.push(frame); });
    ctx.on('agent/error', payload => errors.push({ id: payload.agent.id, code: payload.error.code, message: payload.error.message }));
    ctx.on('session/event', (session, event) => {
      if (!logs.has(session.id)) logs.set(session.id, []);
      logs.get(session.id).push(event);
      if (event.type === 'llm/retry') {
        atBackoff.push({ id: session.id, dispatchCount: dispatches.length, retry: event.data.retry });
        if (settings.cancel) ctx.agents.get(session.id).cancel('user');
        if (settings.disposeRetry && !retryDisposal) retryDisposal = retryFiber.dispose();
      }
    });
    retryFiber = await ctx.plugin(retryPlugin);
    if (settings.enabled !== false) pluginFiber = await ctx.plugin(plugin);
    if (settings.reload) {
      await pluginFiber.dispose();
      pluginFiber = await ctx.plugin(plugin);
    }
    const agents = [];
    for (let i = 0; i < (settings.concurrent ? 2 : 1); i++) {
      const handle = await ctx.agents.create({ sessionId: `fixture-agent-${i}`, agentOptions: { provider: 'openai-codex', model: 'fixture-model' }, meta: { cwd: process.cwd() } });
      agents.push(handle.agent);
    }
    for (const agent of agents) agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'fixture input' }], source: { kind: 'user' } }));
    await Promise.all(agents.map(agent => agent.whenIdle()));
    if (settings.repeat) {
      for (const agent of agents) agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'second fixture turn' }], source: { kind: 'user' } }));
      await Promise.all(agents.map(agent => agent.whenIdle()));
    }
    await retryDisposal;
    return { calls, dispatches, atFailure, atBackoff, errors, starts,
      sessions: agents.map(agent => ({ id: agent.id, events: logs.get(agent.id) ?? [] })) };
  } finally {
    await ctx.fiber.dispose();
  }
}

try {
  parentPort.postMessage({ result: await scenario(workerData) });
} catch (error) {
  parentPort.postMessage({ error: { message: error.message, stack: error.stack } });
}
