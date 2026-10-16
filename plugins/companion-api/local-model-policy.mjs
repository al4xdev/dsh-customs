import { appModelError } from './app-models.mjs';
import { AGY_PROVIDER, assertAGYBudget } from './agy-budget.mjs';
import { sdk } from './sdk.mjs';
import { pressureFacts } from './local-model-descriptors.mjs';
import { supportedLocalModels as localModels, supportedLocalModelPolicies as localModelPolicies,
  assertSupportedLocalAdvertisedModel as assertLocalAdvertisedModel } from './local-model-variants.mjs';
const [{ symbols }, { scopeOf, scopeChainOf }, { standingMountFor, livePresetMounts }] = await Promise.all([
  sdk('cordis'), sdk('dsh-scope'), sdk('dsh-agent-preset-registry'),
]);
const original = service => service?.[symbols.original] ?? service;
const ACTIVE = 2;
const unavailable = () => appModelError('model-unavailable');

/** Trusted binding callbacks only; neither callback nor source identity is a wire argument. */
export function createLocalModelPolicy(readAdvertisedModelIds, { current = () => {}, close = () => {} } = {}) {
  const rejectedActors = new WeakSet();
  const check = signal => { signal?.throwIfAborted(); current(); };
  async function assertLocalModel(choice, signal, llm, guard = () => {}) {
    // AGY uses normal native authentication, not the unrelated local-server binding.
    if (choice?.provider === AGY_PROVIDER) return assertAGYBudget(choice, llm, signal, guard);
    if (choice?.provider !== 'strata-local') return;
    try {
      const descriptor = localModels.find(model => model.id === choice.model);
      if (!descriptor || typeof readAdvertisedModelIds !== 'function') throw unavailable();
      const policy = localModelPolicies.find(row => row.model === choice.model);
      const valid = () => { check(signal); guard(); };
      valid();
      const ids = await readAdvertisedModelIds(signal); valid();
      if (!Array.isArray(ids) || ids.length > 32 || ids.some(id => typeof id !== 'string' || !id || id.length > 256 || Buffer.byteLength(id) > 256 || /[\p{Cc}\p{Cf}]/u.test(id))) throw unavailable();
      assertLocalAdvertisedModel(choice.model, ids);
      const info = await llm.resolveModelInfo(choice.provider, choice.model, signal); valid();
      const resolved = await llm.resolveCallConfig({ ...choice, maxTokens: descriptor.maxTokens }, signal); valid();
      if (info.provider !== choice.provider || info.id !== choice.model || info.context?.contextWindow !== descriptor.contextWindow ||
          resolved.provider !== choice.provider || resolved.model !== choice.model || resolved.reasoningEffort !== choice.reasoningEffort || resolved.maxTokens !== descriptor.maxTokens) throw unavailable();
      pressureFacts({ contextWindow: info.context?.contextWindow, reservedCompletionTokens: resolved.maxTokens,
        headroomTokens: policy.headroomTokens, summaryMaxTokens: policy.maxTokens });
      return { descriptor, policy, info };
    } catch { throw unavailable(); }
  }
  function installRequestPolicy(ctx) {
    const root = ctx.root, observer = ctx.fiber, rootFiber = root.fiber;
    const observerUid = observer.uid, rootUid = rootFiber.uid;
    const profile = ctx.get('profileContext'), directory = profile?.dir;
    let source, closed = false;
    const ownerFailed = () => { closed = true; close(); throw unavailable(); };
    const ownerCurrent = () => {
      if (closed || ctx.root !== root || ctx.fiber !== observer || root.fiber !== rootFiber || observer.uid === null || rootFiber.uid === null || observer.uid !== observerUid || rootFiber.uid !== rootUid ||
          observer.state !== ACTIVE || rootFiber.state !== ACTIVE || profile?.name !== 'companion' || typeof directory !== 'string' || !directory.startsWith('/') || ctx.get('profileContext') !== profile || root.get('profileContext') !== profile || profile.dir !== directory) ownerFailed();
      if (!source) source = Object.fromEntries(['agents', 'sessions', 'llm', 'agentPresets'].map(key => [key, original(ctx.get(key))]));
      if (Object.entries(source).some(([key, value]) => !value || original(ctx.get(key)) !== value || original(root.get(key)) !== value)) ownerFailed();
    };
    return ctx.on('agent/request', async ({ agent, signal }, next) => {
      const session = agent?.session, header = session?.header;
      // Eligibility is decided BEFORE next(). A targeted root changing roles while
      // awaited must reject; it must not escape by becoming an apparent foreign role.
      const targeted = header?.agentPreset === 'companion' && header.origin === undefined && header.parentSession === undefined && header.isSeeded === false;
      if (!targeted) return next();
      const id = agent.id, actorFiber = agent.ctx.fiber, actorUid = actorFiber.uid;
      const requestSources = Object.fromEntries(['agents', 'sessions', 'llm', 'agentPresets'].map(key => [key, original(ctx.get(key))]));
      const { agents, sessions } = requestSources;
      const fields = Object.fromEntries(['id', 'createdAt', 'cwd', 'agentPreset', 'origin', 'parentSession', 'isSeeded'].map(key => [key, header[key]]));
      const mount = standingMountFor(agent.ctx), mountUid = mount?.fiber.uid;
      const actorCurrent = () => {
        if (ctx.root !== root || ctx.fiber !== observer || root.fiber !== rootFiber || observer.uid === null || rootFiber.uid === null || observer.uid !== observerUid || rootFiber.uid !== rootUid ||
            ctx.get('profileContext') !== profile || root.get('profileContext') !== profile || profile?.name !== 'companion' || profile.dir !== directory ||
            Object.entries(requestSources).some(([key, value]) => original(ctx.get(key)) !== value || original(root.get(key)) !== value)) ownerFailed();
        if (rejectedActors.has(agent) || agent.id !== id || agent.session !== session || session.header !== header || session.id !== id || header.id !== id ||
            Object.entries(fields).some(([key, value]) => header[key] !== value) || actorFiber.uid === null || actorFiber.uid !== actorUid || actorFiber.state !== ACTIVE || agent.ctx.fiber !== actorFiber || agent.ctx.root !== root ||
            original(ctx.get('agents')) !== agents || original(root.get('agents')) !== agents || original(ctx.get('sessions')) !== sessions || original(root.get('sessions')) !== sessions ||
            agents?.get(id) !== agent || sessions?.get(id) !== session || !agents?.roots().includes(agent)) {
          rejectedActors.add(agent); throw unavailable();
        }
      };
      actorCurrent();
      const proposed = await next(); actorCurrent();
      if (proposed.provider !== 'strata-local' && proposed.provider !== AGY_PROVIDER) return proposed;
      const guard = () => {
        ownerCurrent(); actorCurrent();
        if (!mount || mount.fiber.uid === null || mount.fiber.uid !== mountUid || mount.fiber.state !== ACTIVE || mount.presetId !== 'companion' ||
            standingMountFor(agent.ctx)?.key !== mount.key || !scopeChainOf(scopeOf(agent.ctx)).includes(mount.key) || !livePresetMounts(rootFiber).some(row => row.key === mount.key) ||
            ctx.get('agentPresets').composedPreset(agent.ctx) !== 'companion') { rejectedActors.add(agent); throw unavailable(); }
      };
      const verifyPreset = async () => {
        guard(); const lease = await ctx.get('agentPresets').acquireScope('companion');
        try { guard(); if (lease.key !== mount.key) { rejectedActors.add(agent); throw unavailable(); } }
        finally { await lease[Symbol.asyncDispose](); }
        guard();
      };
      try {
        guard(); await verifyPreset(); guard();
        if (proposed.provider === AGY_PROVIDER) {
          const resolved = await assertAGYBudget(proposed, ctx.get('llm'), signal, guard);
          await verifyPreset(); guard(); signal?.throwIfAborted();
          return resolved;
        }
        const { descriptor, policy, info } = await assertLocalModel(proposed, signal, ctx.get('llm'), guard); guard();
        const { maxTokens: _oldCap, ...withoutInheritedCap } = proposed;
        const resolved = await ctx.get('llm').resolveCallConfig({ ...withoutInheritedCap, maxTokens: descriptor.maxTokens }, signal); guard();
        await verifyPreset(); guard(); check(signal);
        if (resolved.provider !== proposed.provider || resolved.model !== proposed.model || resolved.reasoningEffort !== proposed.reasoningEffort || resolved.maxTokens !== descriptor.maxTokens) throw unavailable();
        pressureFacts({ contextWindow: info.context?.contextWindow, reservedCompletionTokens: resolved.maxTokens,
          headroomTokens: policy.headroomTokens, summaryMaxTokens: policy.maxTokens });
        return resolved;
      } catch { throw unavailable(); }
    }, { prepend: true });
  }
  return Object.freeze({ assertLocalModel, installRequestPolicy });
}
