import { resolveHost } from '../../../plugins/common.mjs';
import { createNativeGoals, parseNativeGoalRequest } from './source.mjs';
const [{ scopeOf, scopeChainOf }, { symbols }, { TypertRemoteService, RemoteError }] = await Promise.all([
  import(resolveHost('@deepseek-ai/dsh-scope')), import(resolveHost('@deepseek-ai/cordis')),
  import(resolveHost('@deepseek-ai/dsh-typert-protocol')),
]);

export const name = 'companion-native-goals-unused-proposal';
export const inject = ['typert', 'connection', 'agents', 'goals', 'sessionProjections', 'agentPresets', 'profileContext'];
const METHODS = ['read', 'catalog', 'control'];
const output = { mode: 'strict', typeSymbol: 'NativeGoalsObservation', create: () => ({ parse(value) {
  if (!value || value.version !== 1 || Buffer.byteLength(JSON.stringify(value)) > 65536) throw new RemoteError('nativeGoals/invalid-output', 'Invalid native observation.', {});
  return value;
} }) };
export function contribution() {
  return { package: 'dsh-customs-native-goals-proposal', face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
    invocations: METHODS.map(method => ({ id: `nativeGoals/${method}`, service: 'companionNativeGoals', namespace: 'nativeGoals', method,
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: {
        mode: 'strict', typeSymbol: `NativeGoals-${method}`, create: () => ({ parse: value => parseNativeGoalRequest(method, value) }),
      } }], cancellation: { parameter: 'signal' }, result: output })) };
}

/** A new contribution to the EXISTING Gateway, never a second /api interceptor or a replacement fallback. */
export class CompanionNativeGoalsService extends TypertRemoteService {
  static inject = inject;
  constructor(ctx) {
    super(ctx, 'companionNativeGoals', { namespace: 'nativeGoals' });
    this.source = createNativeGoals(ctx, { scopeOf, scopeChainOf,
      // Public Cordis tracing proxies are unwrapped for identity ONLY, not to call private APIs.
      identityOf: service => service?.identity ?? service?.[symbols.original] ?? service });
    ctx.typert.register(contribution());
    ctx.effect(() => () => this.source.close(), 'native goals observation capabilities');
  }
  async invokeNative(method, request, signal) {
    const invocation = this.ctx.invocation;
    if (!invocation || invocation.service !== 'companionNativeGoals' || invocation.request.namespace !== 'nativeGoals' ||
        invocation.request.method !== method || invocation.peer !== this.ctx.connection.operator) {
      throw new RemoteError('nativeGoals/operator-required', 'An authenticated operator invocation is required.', {});
    }
    const result = await this.source.dispatch(`nativeGoals/${method}`, { args: { request } }, signal, invocation.peer);
    if (!result.ok) throw new RemoteError(result.error.code, result.error.message, {});
    return result.value;
  }
  /** Host-only resolver for the separate, unused push proposal. Not a Remote invocation. */
  ownsSession(sessionId, peer) { return this.source.ownsSession(sessionId, peer); }
  read(request, signal) { return this.invokeNative('read', request, signal); }
  catalog(request, signal) { return this.invokeNative('catalog', request, signal); }
  control(request, signal) { return this.invokeNative('control', request, signal); }
}
export async function apply(ctx) { await ctx.plugin(CompanionNativeGoalsService); }
