import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHostController } from './controller.mjs';

export const name = 'companion-native-host-unused-proposal';
export const inject = ['connection', 'typert', 'typertGateway', 'agents', 'goals', 'sessionProjections', 'agentPresets', 'profileContext'];
function resolveSdk(id) {
  for (const base of [process.argv[1], '/home/alex/.local/share/dsh-cli/package.json']) {
    try { return createRequire(base).resolve(id); } catch {}
  }
  throw new Error('Companion native host public SDK unavailable.');
}

/** UNUSED host-plane assembly. Only explicit Parent-gated enablement acquires an SDK scope. */
export async function createCompanionNativeHost(ctx, config = {}) {
  if (config.enabled !== true) {
    const instanceId = randomUUID();
    return Object.freeze({ status: () => ({ version: 1, instanceId, phase: 'disabled', reason: 'disabled', pushLoaded: false,
      startupCommitted: false, available: false, retryable: false, requiresRecreate: false, generation: 0 }), async close() {} });
  }
  const profile = ctx.get('profileContext');
  const root = ctx.root, owner = ctx.fiber, rootFiber = root.fiber, ownerUid = owner.uid, rootUid = rootFiber.uid;
  const lifetimeCurrent = () => ctx.root === root && ctx.fiber === owner && root.fiber === rootFiber &&
    Number.isSafeInteger(ownerUid) && ownerUid >= 0 && owner.uid === ownerUid && Number.isSafeInteger(rootUid) && rootUid >= 0 && rootFiber.uid === rootUid;
  if (profile?.name !== 'companion' || !isAbsolute(profile.dir ?? '') || !ctx.get('connection')?.operator) throw new Error('Companion native host requires the actual companion profile.');
  const [{ createScope }, { livePresetMounts }, { symbols }, { RemoteError, TypertRemoteService }] = await Promise.all([
    import(resolveSdk('@deepseek-ai/dsh-scope')), import(resolveSdk('@deepseek-ai/dsh-agent-preset-registry')),
    import(resolveSdk('@deepseek-ai/cordis')), import(resolveSdk('@deepseek-ai/dsh-typert-protocol')),
  ]);
  const identityOf = service => service?.identity ?? service?.[symbols.original] ?? service;
  const initialConfig = structuredClone(config), entry = owner.entry;
  const ownerOptions = entry ? structuredClone(entry.options) : undefined;
  const ownerParent = entry?.parent, ownerRuntime = owner.runtime, publicLoader = ctx.root.get('loader');
  // A stale factory argument is not current configuration authority. Require the
  // actual public Loader row, its current owner fiber/runtime/placement and both
  // resolved fiber config and raw row specification. Unknown provenance stays shut.
  const configCurrent = () => lifetimeCurrent() && !!entry && typeof publicLoader?.entries === 'function' &&
    identityOf(ctx.root.get('loader')) === identityOf(publicLoader) && identityOf(ctx.get('loader')) === identityOf(publicLoader) &&
    entry.fiber === owner && owner.entry === entry && owner.runtime === ownerRuntime &&
    entry.parent === ownerParent && [...publicLoader.entries()].includes(entry) &&
    isDeepStrictEqual(entry.options, ownerOptions) && isDeepStrictEqual(owner.config, initialConfig) && isDeepStrictEqual(config, initialConfig);
  const controller = createHostController(ctx, { createScope, livePresetMounts, identityOf, configCurrent }, async (hostCtx, boundary) => {
    const { CompanionNativeGoalsService } = await import('../../android/companion/backend-native-goals/index.mjs');
    class GuardedNativeGoals extends CompanionNativeGoalsService {
      async invokeNative(method, request, signal) {
        if (!this.ctx.invocation) return super.invokeNative(method, request, signal);
        try { return await boundary.run(() => super.invokeNative(method, request, signal)); }
        catch (error) { if (error?.code === 'companionHost/unavailable') throw new RemoteError('nativeGoals/unavailable', 'Companion native source lifecycle changed.', {}); throw error; }
      }
      ownsSession(sessionId, peer) { return boundary.valid() && super.ownsSession(sessionId, peer); }
    }
    await hostCtx.plugin(GuardedNativeGoals);
    const sources = [hostCtx.get('companionNativeGoals').source];
    let pushLoaded = false;
    // Disabled/unconfigured push never even imports its entry or opens its private runtime store.
    if (config.push?.enabled === true) {
      const { publicConfig } = await import('../companion-push/contracts.mjs');
      if (publicConfig(config.push) && isAbsolute(config.push.serviceAccountFile ?? '')) {
        const { CompanionGoalPushService } = await import('../companion-push/index.mjs');
        class GuardedGoalPush extends CompanionGoalPushService {
          async invokePush(method, request, signal) {
            if (!this.ctx.invocation) return super.invokePush(method, request, signal);
            try { return await boundary.run(() => super.invokePush(method, request, signal)); }
            catch (error) { if (error?.code === 'companionHost/unavailable') throw new RemoteError('goalPush/unavailable', 'Companion push source lifecycle changed.', {}); throw error; }
          }
        }
        await hostCtx.plugin(GuardedGoalPush, config.push);
        sources.push(hostCtx.get('companionGoalPush').source); pushLoaded = true;
      }
    }
    return { sources, pushLoaded };
  });
  // This receiver survives native-scope teardown, giving Android an explicit
  // unavailable/retryable/recreate state without resolving any Agent or event stream.
  class HostAvailability extends TypertRemoteService {
    static inject = ['typert'];
    constructor(host) {
      super(host, 'companionHostAvailability', { namespace: 'companionHost' });
      host.get('typert').register({ package: 'companion-native-host-availability-v1', face: 'host', schemas: [],
        model: { services: [], events: [], objects: [] }, invocations: [{ id: 'companionHost/status', service: 'companionHostAvailability',
          namespace: 'companionHost', method: 'status', invocation: { kind: 'direct' }, parameters: [],
          result: { mode: 'strict', typeSymbol: 'CompanionHostStatus', create: () => ({ parse(value) {
            if (!value || Object.keys(value).length !== 10 || value.version !== 1 ||
                typeof value.instanceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.instanceId) ||
                !['pending', 'ready', 'suspended', 'reconciling', 'stale', 'closed'].includes(value.phase) ||
                typeof value.reason !== 'string' || !/^[a-z-]{1,64}$/.test(value.reason) ||
                ['pushLoaded', 'startupCommitted', 'available', 'retryable', 'requiresRecreate'].some(key => typeof value[key] !== 'boolean') ||
                !Number.isSafeInteger(value.generation) || value.generation < 0) throw new RemoteError('companionHost/invalid-output', 'Invalid availability observation.', {});
            return value;
          } }) } }] });
    }
    status() {
      if (this.ctx.invocation?.peer !== ctx.root.get('connection')?.operator) throw new RemoteError('companionHost/operator-required', 'Operator required.', {});
      return controller.status();
    }
  }
  const statusFiber = ctx.plugin(HostAvailability);
  await statusFiber.await();
  const disposers = [];
  let closed = false, startupTask, closing;
  const loader = ctx.root.get('loader');
  const settle = async () => {
    if (typeof loader?.await !== 'function') throw new Error('Public Loader settlement unavailable.');
    await loader.await();
    if (closed || !lifetimeCurrent()) return;
    const { auditStartupEntries } = await import(resolveSdk('@deepseek-ai/dsh-app-boot'));
    await auditStartupEntries(ctx.root, 'companion-native-host', () => {});
  };
  // Synchronous suspension; the owned finite continuation is NOT returned into
  // the Loader's initializer/update chain (which settlement itself waits for).
  const changed = () => { if (!closed && controller.status().startupCommitted) void controller.reconcile(settle); };
  disposers.push(ctx.on('loader/entry-init', changed));
  disposers.push(ctx.on('loader/config-update', changed));
  disposers.push(ctx.on('loader/partial-dispose', changed));
  disposers.push(ctx.on('loader/volatile-update', changed));
  disposers.push(ctx.on('loader/patch-context', (_entry, next) => { changed(); return next(); }));
  disposers.push(ctx.on('agent/created', async () => { if (controller.status().startupCommitted) await controller.start(); }));
  const commit = () => {
    if (closed || !lifetimeCurrent()) return;
    startupTask = controller.commit().catch(() => controller.invalidate('startup-commit-failed'));
    return startupTask;
  };
  const appReady = ctx.get('appReady');
  if (typeof appReady?.onReady === 'function') {
    disposers.push(appReady.onReady(commit));
    // Even an already-committed host may need Loader settlement while acquiring its
    // first preset lease. Never await that task from this row's own initializer.
  } else {
    const loader = ctx.get('loader');
    if (typeof loader?.await === 'function') {
      // One owned continuation after factory return, not a timer/poll or scheduler.
      // Awaiting Loader settlement HERE would include our own initializer and deadlock.
      startupTask = Promise.resolve().then(async () => {
        if (closed) return;
        await loader.await();
        if (closed || !lifetimeCurrent()) return;
        // Settlement alone ignores required-entry failures. Use the SAME public
        // startup policy as boot, without duplicate optional warning output.
        const { auditStartupEntries } = await import(resolveSdk('@deepseek-ai/dsh-app-boot'));
        if (!closed) await auditStartupEntries(ctx.root, 'companion-native-host', () => {});
      }).then(commit).catch(() => { if (!closed) controller.invalidate('loader-startup-audit-failed'); });
    }
  }
  return Object.freeze({ status: controller.status, settled: controller.settled,
    // Do not await a pending Loader settlement from its own disposal path. Cancellation
    // makes that continuation inert; controller.close awaits actual owned scope/lease work.
    async close() {
      if (closing) return closing;
      closed = true; for (const dispose of disposers) dispose();
      closing = (async () => { await controller.close(); await statusFiber.dispose(); })();
      return closing;
    } });
}
export async function apply(ctx, config = {}) {
  const assembly = await createCompanionNativeHost(ctx, config);
  ctx.effect(() => () => assembly.close(), 'unused Companion native host retained scope');
}
