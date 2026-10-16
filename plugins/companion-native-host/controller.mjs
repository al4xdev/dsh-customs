import { randomUUID } from 'node:crypto';

const unavailable = () => { const error = new Error('Companion native host unavailable.'); error.code = 'companionHost/unavailable'; return error; };
// Cordis publishes uid:number|null, not isDisposed. Pin the incarnation across awaits; root uid0 is valid.
const active = (fiber, uid) => Number.isSafeInteger(uid) && uid >= 0 && fiber?.uid === uid;

/** Owns lifecycle only; provenance is pinned to the original root and public registry. */
export function createHostController(ctx, { identityOf, livePresetMounts, createScope, configCurrent = () => true }, install) {
  // Public diagnostic nonce only: never a scope key, ownership proof or permit.
  const instanceId = randomUUID();
  const root = ctx.root, rootFiber = root.fiber, ownerFiber = ctx.fiber;
  const rootUid = rootFiber?.uid, ownerUid = ownerFiber?.uid;
  const profile = root.get('profileContext'), directory = profile?.dir;
  const bindings = ['connection', 'agentPresets', 'agents', 'goals', 'sessionProjections', 'typert', 'typertGateway'];
  const captured = new Map(bindings.map(key => [key, identityOf(root.get(key))]));
  const presets = root.get('agentPresets'), connection = root.get('connection');
  const operator = connection?.operator, operatorContext = operator?.ctx;
  const operatorFiber = operatorContext?.fiber, operatorUid = operatorFiber?.uid;
  let phase = 'pending', reason = 'awaiting-native-preset', retained, scope, sources = [], pushLoaded = false;
  let startupCommitted = false, latched = false, epoch = 0, writer = Promise.resolve(), starting, reconciling, closing;
  const pendingCancel = new Set();
  function cancel() { for (const callback of pendingCancel) callback(); }
  function wait(pending) {
    // Lifetime-promise races retain a losing .then for every successful RPC.
    // Only genuinely pending work owns a removable cancellation subscriber.
    return new Promise((resolve, reject) => {
      const onCancel = () => { pendingCancel.delete(onCancel); reject(unavailable()); };
      if (latched) onCancel(); else pendingCancel.add(onCancel);
      // Observe late rejection even when cancellation already won. The public
      // work still owns any eventual resource until its acquisition cleanup runs.
      Promise.resolve(pending).then(value => {
        pendingCancel.delete(onCancel); resolve(value);
      }, error => { pendingCancel.delete(onCancel); reject(error); });
    });
  }
  const current = () => !latched && ctx.root === root && root.fiber === rootFiber && ctx.fiber === ownerFiber && active(rootFiber, rootUid) && active(ownerFiber, ownerUid) &&
    root.get('profileContext') === profile && ctx.get('profileContext') === profile && profile?.name === 'companion' && profile.dir === directory &&
    configCurrent() && bindings.every(key => captured.get(key) !== undefined && identityOf(root.get(key)) === captured.get(key) && identityOf(ctx.get(key)) === captured.get(key)) &&
    !!operator && connection.operator === operator && operator.ctx === operatorContext && operatorContext?.fiber === operatorFiber && active(operatorFiber, operatorUid);
  function status() {
    if (phase === 'ready' && !current()) invalidate('source-changed');
    return Object.freeze({ version: 1, instanceId, phase, reason, pushLoaded, startupCommitted,
      available: phase === 'ready' && current(), retryable: ['suspended', 'reconciling', 'pending'].includes(phase),
      requiresRecreate: phase === 'stale', generation: epoch });
  }
  async function acquire() {
    // Registry diagnostics can themselves await Loader settlement. Cancel the
    // owned wait, but dispose a lease that the public call issues after teardown.
    let abandoned = false, issued;
    const pending = Promise.resolve().then(() => presets.acquireScope('companion')).then(async lease => {
      issued = lease;
      if (abandoned) { await lease[Symbol.asyncDispose](); throw unavailable(); }
      return lease;
    });
    try { return await wait(pending); }
    catch (error) { abandoned = true; await issued?.[Symbol.asyncDispose](); throw error; }
  }
  function closeSources() { for (const source of sources) { try { source.close(); } catch {} } }
  async function releaseScope() {
    closeSources(); sources = []; pushLoaded = false;
    if (scope) { const owned = scope; await owned.dispose(); scope = undefined; }
  }
  async function release() {
    // A failed dispose must not permit a second writer or relinquish its lease.
    await releaseScope();
    if (retained) { const owned = retained; await owned[Symbol.asyncDispose](); retained = undefined; }
  }
  const write = operation => { const task = writer.then(operation); writer = task.catch(() => {}); return task; };
  function invalidate(why = 'lifecycle-changed') {
    if (latched) return;
    latched = true; epoch++; phase = 'stale'; reason = why; closeSources(); cancel();
    void write(release).catch(() => { reason = 'teardown-unconfirmed'; });
  }
  const valid = token => token === epoch && phase === 'ready' && current();
  async function runAt(token, operation) {
    if (!valid(token)) { if (phase === 'ready' && !current()) invalidate('source-changed'); throw unavailable(); }
    let check;
    try {
      check = await acquire();
      if (!valid(token) || check.key !== retained?.key) {
        if (!latched && token === epoch) invalidate('preset-generation-changed');
        throw unavailable();
      }
      return await operation();
    } catch (error) {
      if (error?.code === 'companionHost/unavailable') throw error;
      if (!check) { invalidate('preset-unavailable'); throw unavailable(); }
      throw error;
    } finally { await check?.[Symbol.asyncDispose](); }
  }
  const mountFor = key => livePresetMounts(rootFiber).find(m => m.presetId === 'companion' && m.key === key && active(m.fiber, m.fiber?.uid));
  async function installAt(token) {
    if (!current() || token !== epoch) throw unavailable();
    const mount = mountFor(retained.key), mountUid = mount?.fiber?.uid;
    if (!mount) throw unavailable();
    scope = createScope(ctx, retained.key);
    const pending = Promise.resolve(install(scope.ctx, { run: operation => runAt(token, operation), invalidate, valid: () => valid(token) })).then(result => {
      if (latched || token !== epoch) for (const source of result.sources) { try { source.close(); } catch {} }
      return result;
    });
    const result = await wait(pending);
    sources = result.sources; pushLoaded = result.pushLoaded;
    if (!current() || token !== epoch || !active(mount.fiber, mountUid)) { closeSources(); throw unavailable(); }
  }
  async function start() {
    if (!startupCommitted || latched || phase === 'ready' || reconciling) return;
    if (starting) return starting;
    const token = epoch;
    starting = write(async () => {
      try {
        if (!current()) { invalidate('source-changed'); return; }
        if (token !== epoch) return;
        retained = await acquire();
        await installAt(token);
        if (current() && token === epoch) { phase = 'ready'; reason = 'startup-committed-native-preset-retained'; }
      } catch {
        if (!latched && !current()) invalidate('source-changed');
        await release();
        if (!latched && token === epoch) { phase = 'pending'; reason = 'awaiting-native-preset'; }
      }
    }).finally(() => { starting = undefined; });
    return starting;
  }
  function commit() { if (latched) return Promise.resolve(); startupCommitted = true; return start(); }
  function reconcile(settle) {
    if (latched || !startupCommitted) return Promise.resolve();
    epoch++; phase = 'suspended'; reason = 'loader-settlement'; closeSources();
    if (reconciling) return reconciling;
    // Never return this task from a Loader event or await settlement while holding
    // the writer lock. Disposal can cancel settlement involving its own initializer.
    // One bounded deadline for the entire change, not a retry/polling scheduler.
    // This also cancels a registry audit which began waiting on Loader again.
    const deadline = setTimeout(() => invalidate('loader-settlement-timeout'), 15000);
    deadline.unref?.();
    reconciling = Promise.resolve().then(async () => {
      for (let attempt = 0; attempt < 8 && !latched; attempt++) {
        const token = epoch;
        try {
          await wait(Promise.resolve().then(settle));
          if (latched) return;
          if (token !== epoch) continue;
          await write(async () => {
            if (latched || token !== epoch) return;
            phase = 'reconciling'; reason = 'public-provenance-audit';
            if (!current()) throw unavailable();
            if (!retained) { invalidate('initial-provenance-unavailable'); return; }
            let check;
            try {
              check = await acquire();
              if (!current()) throw unavailable();
              if (token !== epoch) return;
              if (check.key !== retained.key || !mountFor(check.key)) { invalidate('preset-generation-changed'); return; }
              await releaseScope();
              if (!current()) throw unavailable();
              if (token !== epoch) return;
              await installAt(token);
              if (current() && token === epoch) { phase = 'ready'; reason = 'reconciled-same-public-provenance'; }
            } finally { await check?.[Symbol.asyncDispose](); }
          });
          if (token === epoch || latched) return;
        } catch { invalidate('loader-reconciliation-unproven'); return; }
      }
      if (!latched) invalidate('loader-change-budget-exhausted');
    }).finally(() => {
      clearTimeout(deadline); reconciling = undefined;
      // A change queued between the final epoch check and this finalizer must not
      // leave an unowned suspended state after its only continuation has ended.
      if (!latched && phase !== 'ready') invalidate('loader-reconciliation-incomplete');
    });
    return reconciling;
  }
  return Object.freeze({ start, commit, reconcile, run: operation => runAt(epoch, operation), invalidate, status,
    settled: () => reconciling ?? starting ?? writer,
    async close() {
      if (closing) return closing;
      latched = true; epoch++; phase = 'closed'; reason = 'disposed'; closeSources(); cancel();
      closing = write(release);
      return closing;
    } });
}
