import { createRequire } from 'node:module';
import { createGoalPush } from './source.mjs';
import { fields, generation, refuse, uuid, validReceipt, validRegistration } from './contracts.mjs';

function resolveSdk(id) {
  for (const base of [process.argv[1], '/home/alex/.local/share/dsh-cli/package.json']) {
    try { return createRequire(base).resolve(id); } catch {}
  }
  throw new Error('Companion push public SDK unavailable.');
}
const [{ scopeOf, scopeChainOf }, { foldGoal }, { symbols }, { TypertRemoteService, RemoteError }] = await Promise.all([
  import(resolveSdk('@deepseek-ai/dsh-scope')), import(resolveSdk('@deepseek-ai/dsh-goal')),
  import(resolveSdk('@deepseek-ai/cordis')), import(resolveSdk('@deepseek-ai/dsh-typert-protocol')),
]);
export const name = 'companion-push-unused-proposal';
export const inject = ['typert', 'connection', 'agents', 'goals', 'agentPresets', 'profileContext', 'companionNativeGoals'];
const METHODS = ['register', 'unregister', 'status'];
export function parseGoalPushRequest(method, value) {
  if (method === 'register') { if (!validRegistration(value)) refuse('invalid-request'); }
  else if (method === 'unregister' || method === 'status') {
    fields(value, method === 'unregister' ? ['version', 'deviceId', 'registrationId', 'authGeneration'] : ['version', 'deviceId', 'authGeneration']);
    if (value.version !== 1 || !uuid(value.deviceId) || !generation(value.authGeneration) || method === 'unregister' && !uuid(value.registrationId)) refuse('invalid-request');
  } else refuse('invalid-request');
  return value;
}
function output(method, value) {
  const invalid = () => { throw new RemoteError('goalPush/invalid-output', 'Invalid push observation.', {}); };
  if (method === 'register') { if (!validReceipt(value)) invalid(); }
  else if (method === 'unregister') {
    fields(value, ['version', 'unregistered']); if (value.version !== 1 || value.unregistered !== true) invalid();
  } else {
    fields(value, ['version', 'profile', 'enabled', 'configured', 'registrationReady', 'reason', 'receipt']);
    if (value.version !== 1 || value.profile !== 'companion' || ['enabled', 'configured', 'registrationReady'].some(k => typeof value[k] !== 'boolean') ||
        typeof value.reason !== 'string' || !/^[a-z-]{1,64}$/.test(value.reason) || value.receipt !== null && !validReceipt(value.receipt)) invalid();
  }
  return value;
}
export function contribution() {
  return { package: 'dsh-customs-companion-push-unused', face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
    invocations: METHODS.map(method => ({ id: `goalPush/${method}`, service: 'companionGoalPush', namespace: 'goalPush', method,
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: {
        mode: 'strict', typeSymbol: `GoalPush-${method}-Request`, create: () => ({ parse: value => parseGoalPushRequest(method, value) }),
      } }], cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: `GoalPush-${method}-Response`, create: () => ({ parse: value => output(method, value) }) } })) };
}
/** Additive to the public Gateway. Never replaces its sole /api slot, mounts a second HTTP
 * endpoint, or substitutes a guessed operator for an absent invocation. UNUSED until Parent gate. */
export class CompanionGoalPushService extends TypertRemoteService {
  static inject = inject;
  constructor(ctx, config = {}) {
    super(ctx, 'companionGoalPush', { namespace: 'goalPush' });
    this.source = createGoalPush(ctx, { scopeOf, scopeChainOf, foldGoal,
      identityOf: service => service?.identity ?? service?.[symbols.original] ?? service,
      ownsSession: (sessionId, peer) => ctx.companionNativeGoals.ownsSession(sessionId, peer) }, config);
    ctx.typert.register(contribution());
    ctx.effect(() => {
      // A bounded persisted attempt counter is the retry authority, not the clock. No timer in defaults.
      let timer, dispose;
      if (config.enabled === true) {
        dispose = ctx.on('goal/changed', event => {
          if (this.source.onGoalChanged(event)) void this.source.flush().catch(() => ctx.logger.warn('companion-push: outbox unavailable; native goal unchanged'));
        });
        timer = setInterval(() => { void this.source.flush().catch(() => ctx.logger.warn('companion-push: outbox unavailable; native goal unchanged')); }, 5000);
        timer.unref?.();
      }
      return () => { clearInterval(timer); dispose?.(); this.source.close(); };
    }, 'unused companion push scoped outbox');
  }
  async invokePush(method, request, signal) {
    const invocation = this.ctx.invocation;
    if (!invocation || invocation.service !== 'companionGoalPush' || invocation.request.namespace !== 'goalPush' ||
        invocation.request.method !== method || invocation.peer !== this.ctx.connection.operator) {
      throw new RemoteError('goalPush/operator-required', 'An authenticated operator invocation is required.', {});
    }
    const result = await this.source.dispatch(`goalPush/${method}`, { args: { request } }, signal, invocation.peer);
    if (!result.ok) throw new RemoteError(result.error.code, result.error.message, {});
    return result.value;
  }
  register(request, signal) { return this.invokePush('register', request, signal); }
  unregister(request, signal) { return this.invokePush('unregister', request, signal); }
  status(request, signal) { return this.invokePush('status', request, signal); }
}
export async function apply(ctx, config = {}) { await ctx.plugin(CompanionGoalPushService, config); }
