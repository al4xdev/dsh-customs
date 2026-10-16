import { appModelError } from './app-models.mjs';
import { sdk } from './sdk.mjs';
import { createBoundLocalDiscovery } from './bound-local-discovery.mjs';
import { createLocalModelPolicy } from './local-model-policy.mjs';
import { locateLocalProviderOwner } from './local-provider-owner.mjs';
const { symbols } = await sdk('cordis');
const original = service => service?.[symbols.original] ?? service;
const unavailable = () => appModelError('model-unavailable');

/** Trusted JS composition options ONLY. Construction does not require Loader/LLM or HTTP. */
export function createCompanionLocalPolicy(ctx, { ownerId, trustedBaseURL, serverAuthMode, fetchImpl, timeoutMs } = {}) {
  const root = ctx.root, observer = ctx.fiber, rootFiber = root.fiber;
  const observerUid = observer.uid, rootUid = rootFiber.uid;
  const profile = ctx.get('profileContext'), directory = profile?.dir;
  let discovery, assembled = false, closed = false, ready = false, readyIdentity, stopReady;
  const close = () => { closed = true; stopReady?.(); return discovery?.close() ?? Promise.resolve(); };
  const fail = () => { close(); throw unavailable(); };
  const scopeCurrent = () => {
    if (closed || ctx.root !== root || ctx.fiber !== observer || root.fiber !== rootFiber || observer.uid === null || rootFiber.uid === null || observer.uid !== observerUid || rootFiber.uid !== rootUid ||
        profile?.name !== 'companion' || typeof directory !== 'string' || !directory.startsWith('/') || ctx.get('profileContext') !== profile || root.get('profileContext') !== profile || profile.dir !== directory) fail();
  };
  const observeReady = () => {
    const service = ctx.get('appReady');
    if (readyIdentity !== undefined && original(service) !== readyIdentity) fail();
    if (readyIdentity !== undefined) return;
    if (typeof service?.onReady !== 'function') return;
    readyIdentity = original(service);
    stopReady = service.onReady(() => { if (!closed) ready = true; });
  };
  // A missing/not-yet-fired readiness owner is unavailable, never a guessed timer.
  // Waiting for Loader here would deadlock this row's own activation.
  observeReady();
  const bound = () => {
    scopeCurrent();
    if (original(ctx.get('appReady')) !== original(root.get('appReady'))) fail();
    observeReady();
    if (!ready || observer.state !== 2 || rootFiber.state !== 2) throw unavailable();
    if (!assembled) {
      assembled = true;
      try {
        if (ownerId !== undefined && (typeof ownerId !== 'string' || !ownerId)) fail();
        const ownerEntry = ownerId === undefined ? locateLocalProviderOwner(ctx) : ctx.get('loader')?.resolve(ownerId);
        discovery = createBoundLocalDiscovery(ctx, { ownerEntry, expectedOwnerId: ownerId === undefined ? ownerEntry.id : ownerId, trustedBaseURL, serverAuthMode,
          ...(fetchImpl ? { fetchImpl } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      } catch { fail(); }
    }
    if (!discovery) fail();
    try { discovery.current(); scopeCurrent(); return discovery; } catch { fail(); }
  };
  const policy = createLocalModelPolicy(signal => bound().readAdvertisedModelIds(signal), {
    current: () => bound().current(), close,
  });
  ctx.effect(() => close, 'lazy Companion local model policy');
  return Object.freeze({ ...policy, close });
}
