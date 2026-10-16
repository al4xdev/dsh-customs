import { sdk } from './sdk.mjs';
const [{ symbols }, PiAi, { isVolatile }] = await Promise.all([sdk('cordis'), sdk('dsh-llm-pi-ai'), sdk('cosmokit')]);
const ACTIVE = 2; // Public Cordis FiberState.ACTIVE (a TypeScript const enum).
const original = service => service?.[symbols.original] ?? service;
export const MAX_BYTES = 32 * 1024;
const PROVIDER = 'strata-local', API = 'openai-completions';
function unavailable(reason) {
  const error = new Error('Local model unavailable.');
  error.code = 'companion/model-unavailable'; error.reason = reason;
  return error;
}
function approvedURL(value) {
  if (typeof value !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/v1$/.test(value)) throw unavailable('local-endpoint-refused');
  let parsed;
  try { parsed = new URL(value); } catch { throw unavailable('local-endpoint-refused'); }
  if (parsed.port === '' || Number(parsed.port) > 65535 || parsed.href !== `${value}`) throw unavailable('local-endpoint-refused');
  return `${value}/models`;
}
function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(unavailable('local-metadata-unavailable'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
async function boundedBody(response, signal, check) {
  if (response.status !== 200 || response.redirected || !response.body) throw unavailable('local-metadata-unavailable');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d{1,8}$/.test(declared) || Number(declared) > MAX_BYTES)) throw unavailable('local-metadata-unavailable');
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      check(); signal.throwIfAborted();
      const part = await abortable(reader.read(), signal);
      check(); signal.throwIfAborted();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || (bytes += part.value.byteLength) > MAX_BYTES) throw unavailable('local-metadata-unavailable');
      chunks.push(part.value);
    }
    if (declared !== null && Number(declared) !== bytes) throw unavailable('local-metadata-unavailable');
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

/** Internal composition API, never a remote/wire factory. Does not probe on construction. */
export function createBoundLocalDiscovery(ctx, { ownerEntry, expectedOwnerId, trustedBaseURL, fetchImpl = globalThis.fetch, timeoutMs = 1500, serverAuthMode } = {}) {
  const url = approvedURL(trustedBaseURL);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000 || typeof fetchImpl !== 'function' || serverAuthMode !== undefined && serverAuthMode !== 'direct-llama-no-auth') throw unavailable('local-binding-unsupported');
  const root = ctx.root, profile = ctx.get('profileContext'), directory = profile?.dir;
  const loader = ctx.get('loader'), llm = ctx.get('llm');
  const owner = ownerEntry?.fiber, config = owner?.config, reference = config?.providers;
  if (profile?.name !== 'companion' || typeof directory !== 'string' || !directory.startsWith('/') || !loader || !llm ||
      !ownerEntry || !expectedOwnerId || ownerEntry.id !== expectedOwnerId || !owner || owner.runtime?.callback !== PiAi.apply || !isVolatile(reference)) throw unavailable('local-binding-unsupported');
  const source = { loader: original(loader), llm: original(llm) }, raw = reference.get();
  const observerFiber = ctx.fiber, rootFiber = root.fiber;
  const observerUid = observerFiber.uid, rootUid = rootFiber.uid, ownerUid = owner.uid;
  const lifetime = new AbortController(), pending = new Set(); let failure;
  const stops = [];
  const latch = reason => { if (!failure) { failure = reason; lifetime.abort(); } };
  const failSource = reason => { latch(reason); throw unavailable(failure); };
  const current = () => {
    if (failure) throw unavailable(failure);
    try {
      if (ctx.root !== root || ctx.fiber !== observerFiber || root.fiber !== rootFiber || observerFiber.uid === null || rootFiber.uid === null || owner.uid === null || observerFiber.uid !== observerUid || rootFiber.uid !== rootUid || owner.uid !== ownerUid || ctx.fiber.state !== ACTIVE || root.fiber.state !== ACTIVE || ctx.get('profileContext') !== profile || root.get('profileContext') !== profile || profile.name !== 'companion' || profile.dir !== directory ||
          ['loader', 'llm'].some(key => original(ctx.get(key)) !== source[key] || original(root.get(key)) !== source[key]) ||
          loader.resolve(expectedOwnerId) !== ownerEntry || ownerEntry.disabled || ownerEntry.fiber !== owner || owner.state !== ACTIVE || owner.ctx.root !== root || owner.runtime?.callback !== PiAi.apply ||
          owner.config !== config || config.providers !== reference || reference.get() !== raw || !Object.isFrozen(raw)) failSource('local-source-changed');
      const route = raw?.[PROVIDER];
      if (!route || route.baseURL !== trustedBaseURL || route.api !== API) failSource('local-endpoint-refused');
      // This optional INTERNAL static deployment contract says native auth cannot
      // account-route a direct llama server. Never read even the credential-ref value.
      if (Object.hasOwn(route, 'apiKeyEnv') && serverAuthMode !== 'direct-llama-no-auth' || route.headers != null && Object.keys(route.headers).length !== 0) failSource('local-binding-unsupported');
      const directoryEntries = llm.listConfigurableProviders().filter(item => item.provider === PROVIDER);
      if (directoryEntries.length !== 1 || directoryEntries[0].settingsNs !== ownerEntry.options.id || directoryEntries[0].settingsPath?.length !== 2 ||
          directoryEntries[0].settingsPath[0] !== 'providers' || directoryEntries[0].settingsPath[1] !== PROVIDER || directoryEntries[0].error) failSource('local-binding-unsupported');
      const owners = [...loader.entries()].filter(entry => entry.fiber?.state === ACTIVE && entry.fiber.runtime?.callback === PiAi.apply &&
        isVolatile(entry.fiber.config?.providers) && entry.fiber.config.providers.get()?.[PROVIDER] !== undefined);
      if (owners.length !== 1 || owners[0] !== ownerEntry || !llm.listProviders().some(item => item.id === PROVIDER)) failSource('local-source-changed');
      return Object.freeze({ provider: PROVIDER, state: 'current' });
    } catch (error) {
      if (error?.code === 'companion/model-unavailable') throw error;
      failSource('local-source-changed');
    }
  };
  current();
  // This event is owner-fiber scoped: attaching to the observer/root would miss it.
  stops.push(owner.ctx.on('loader/volatile-update', () => latch('local-source-changed')));
  stops.push(owner.ctx.on('internal/status', changed => { if (changed === owner && owner.state !== ACTIVE) latch('local-source-changed'); }));
  stops.push(ctx.on('llm/adapters-updated', () => latch('local-source-changed')));
  const stopFence = ctx.on('llm/stream', async function* (options, next) {
    if (options.provider === PROVIDER) { current(); if (options.signal?.aborted) throw unavailable('local-metadata-unavailable'); }
    // This is only a source fence: never rewrite route, model, effort or cap.
    for await (const chunk of next()) { if (options.provider === PROVIDER) current(); yield chunk; }
  }, { prepend: true });
  const stopOwners = () => { for (const stop of stops.splice(0)) stop(); };
  const close = () => {
    latch('local-source-changed'); stopOwners();
    // Keep a closed fence until THIS observing plugin context is disposed. Removing it
    // on manual close would let an already admitted native request escape the barrier.
    return Promise.allSettled([...pending]).then(() => undefined);
  };
  ctx.effect(() => () => { const drained = close(); stopFence(); return drained; }, 'bound local metadata source');

  async function probe(signal) {
    current(); if (signal?.aborted) throw unavailable('local-metadata-unavailable');
    const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const combined = AbortSignal.any([lifetime.signal, timeout.signal, ...(signal ? [signal] : [])]);
    let response;
    try {
      current(); combined.throwIfAborted();
      const request = Promise.resolve(fetchImpl(url, { method: 'GET', credentials: 'omit', redirect: 'error', signal: combined }));
      request.then(late => { if (combined.aborted) late?.body?.cancel().catch(() => {}); }, () => {});
      response = await abortable(request, combined);
      current(); combined.throwIfAborted();
      if (response.url && response.url !== url) throw unavailable('local-metadata-unavailable');
      const text = await boundedBody(response, combined, current);
      current(); combined.throwIfAborted();
      const payload = JSON.parse(text);
      if (!Array.isArray(payload?.data) || payload.data.length > 32) throw unavailable('local-metadata-unavailable');
      const ids = payload.data.map(item => item?.id);
      if (ids.some(id => typeof id !== 'string' || id.length === 0 || id.length > 256 || Buffer.byteLength(id) > 256 || /[\p{Cc}\p{Cf}]/u.test(id)) || new Set(ids).size !== ids.length) throw unavailable('local-metadata-unavailable');
      current(); return Object.freeze(ids);
    } catch (error) {
      if (failure) throw unavailable(failure);
      if (error?.code === 'companion/model-unavailable') throw error;
      throw unavailable('local-metadata-unavailable');
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  function readAdvertisedModelIds(signal) {
    current();
    if (pending.size >= 2) return Promise.reject(unavailable('local-metadata-unavailable'));
    const work = probe(signal); pending.add(work);
    return work.finally(() => pending.delete(work));
  }
  return Object.freeze({ readAdvertisedModelIds, current, close });
}
