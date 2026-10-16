import { createHash } from 'node:crypto';
import { resolveHost } from '../common.mjs';
import { appModelContracts, createAppModelOperations } from './app-models.mjs';
const { RemoteError } = await import(resolveHost('@deepseek-ai/dsh-typert-protocol'));
const { ReasoningEffortId } = await import(resolveHost('@deepseek-ai/dsh-llm'));

export const MODEL_MAX_BYTES = 64 * 1024;
const MAX_MODELS = 4096;
const MAX_PROVIDERS = 128;
const errors = {
  'model-invalid-request': 'Invalid model settings request.',
  'model-invalid-output': 'Invalid model settings metadata.',
  'model-catalog-limit': 'Model metadata exceeds the observation budget.',
  'model-catalog-unavailable': 'Model metadata is unavailable.',
  'model-cursor-stale': 'Model metadata changed; restart listing.',
  'model-unavailable': 'The requested model or reasoning effort is unavailable.',
  'model-read-only': 'The profile default is not writable.',
  'model-default-conflict': 'The profile default changed; reload before choosing again.',
  'model-save-unconfirmed': 'The profile default write could not be confirmed. Reload before another choice.',
};
function fail(code) { return new RemoteError(`companion/${code}`, errors[code], {}); }
function fields(value, allowed, code = 'model-invalid-request') {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) throw fail(code);
}
function id(value, maximum, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) throw fail(code);
  return value;
}
function label(value, maximum, fallback) {
  return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, maximum) || fallback : fallback;
}
function display(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) throw fail('model-invalid-output');
}
export function parseModelChoice(value, code = 'model-invalid-request') {
  fields(value, ['provider', 'model', 'reasoningEffort'], code);
  const result = { provider: id(value.provider, 128, code), model: id(value.model, 256, code) };
  if (Object.hasOwn(value, 'reasoningEffort')) result.reasoningEffort = id(value.reasoningEffort, 64, code);
  return result;
}
function equal(a, b) { return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort; }
export function parseModelCatalogRequest(value) {
  fields(value, ['limit', 'cursor']);
  const limit = Object.hasOwn(value, 'limit') ? value.limit : 64;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw fail('model-invalid-request');
  if (Object.hasOwn(value, 'cursor') && (typeof value.cursor !== 'string' || !/^[a-f0-9]{64}:[1-9][0-9]{0,3}$/.test(value.cursor))) throw fail('model-invalid-request');
  return { limit, ...(value.cursor === undefined ? {} : { cursor: value.cursor }) };
}
export function parseSelectDefaultModelRequest(value) {
  fields(value, ['provider', 'model', 'reasoningEffort', 'expectedCurrent']);
  const choice = parseModelChoice({ provider: value.provider, model: value.model,
    ...(Object.hasOwn(value, 'reasoningEffort') ? { reasoningEffort: value.reasoningEffort } : {}) });
  return { ...choice, expectedCurrent: parseModelChoice(value.expectedCurrent) };
}
function projectCatalog(raw) {
  if (!raw || !Array.isArray(raw.groups) || !Array.isArray(raw.routableProviders) || !Array.isArray(raw.failures)) throw fail('model-invalid-output');
  if (raw.groups.length > MAX_PROVIDERS || raw.routableProviders.length > MAX_PROVIDERS || raw.failures.length > MAX_PROVIDERS) throw fail('model-catalog-limit');
  const routableProviders = raw.routableProviders.map(provider => id(provider, 128, 'model-invalid-output'));
  if (new Set(routableProviders).size !== routableProviders.length) throw fail('model-invalid-output');
  const seen = new Set();
  const rows = [];
  for (const group of raw.groups) {
    const provider = id(group.id, 128, 'model-invalid-output');
    if (seen.has(provider) || !routableProviders.includes(provider) || !Array.isArray(group.models)) throw fail('model-invalid-output');
    seen.add(provider);
    const modelsSeen = new Set();
    for (const source of group.models) {
      if (rows.length >= MAX_MODELS) throw fail('model-catalog-limit');
      const modelId = id(source.id, 256, 'model-invalid-output');
      if (modelsSeen.has(modelId)) throw fail('model-invalid-output');
      modelsSeen.add(modelId);
      const model = { id: modelId, name: label(source.name, 128, modelId) };
      if (typeof source.description === 'string' && source.description.trim()) model.description = label(source.description, 160, '');
      if (source.reasoning !== undefined) {
        if (!Array.isArray(source.reasoning.efforts) || source.reasoning.efforts.length > 16) throw fail('model-invalid-output');
        const efforts = source.reasoning.efforts.map(effort => ({ id: id(effort.id, 64, 'model-invalid-output'),
          name: label(effort.name, 80, effort.id), ...(typeof effort.description === 'string' ? { description: label(effort.description, 120, '') } : {}) }));
        if (new Set(efforts.map(effort => effort.id)).size !== efforts.length) throw fail('model-invalid-output');
        model.reasoning = { efforts };
        if (source.reasoning.defaultEffort !== undefined) {
          const defaultEffort = id(source.reasoning.defaultEffort, 64, 'model-invalid-output');
          if (!efforts.some(effort => effort.id === defaultEffort)) throw fail('model-invalid-output');
          model.reasoning.defaultEffort = defaultEffort;
        }
      }
      rows.push({ provider, providerName: label(group.name, 128, provider), model });
    }
  }
  if (routableProviders.some(provider => !rows.some(row => row.provider === provider))) throw fail('model-invalid-output');
  return { rows, routableProviders, unavailableProviders: raw.failures.length };
}
function validFor(rows, choice) {
  const row = rows.find(row => row.provider === choice.provider && row.model.id === choice.model);
  return row !== undefined && (choice.reasoningEffort === undefined || row.model.reasoning?.efforts.some(effort => effort.id === choice.reasoningEffort));
}
function grouped(rows) {
  const groups = [];
  for (const row of rows) {
    let group = groups.find(group => group.id === row.provider);
    if (!group) { group = { id: row.provider, name: row.providerName, models: [] }; groups.push(group); }
    group.models.push(row.model);
  }
  return groups;
}
export function parseModelCatalogOutput(value) {
  fields(value, ['profile', 'current', 'groups', 'routableProviders', 'writable', 'unavailableProviders', 'nextCursor'], 'model-invalid-output');
  if (value.profile !== 'companion' || typeof value.writable !== 'boolean' || !Number.isSafeInteger(value.unavailableProviders) || value.unavailableProviders < 0 || value.unavailableProviders > MAX_PROVIDERS ||
    !(value.nextCursor === null || (typeof value.nextCursor === 'string' && /^[a-f0-9]{64}:[1-9][0-9]{0,3}$/.test(value.nextCursor)))) throw fail('model-invalid-output');
  parseModelChoice(value.current, 'model-invalid-output');
  if (!Array.isArray(value.groups) || !Array.isArray(value.routableProviders)) throw fail('model-invalid-output');
  // Strict codecs reject nested extras too; never accept raw registry/credential fields.
  for (const group of value.groups) {
    fields(group, ['id', 'name', 'models'], 'model-invalid-output');
    display(group.name, 128);
    if (!Array.isArray(group.models)) throw fail('model-invalid-output');
    for (const model of group.models) {
      fields(model, ['id', 'name', 'description', 'reasoning'], 'model-invalid-output');
      display(model.name, 128);
      if (Object.hasOwn(model, 'description')) display(model.description, 160);
      if (model.reasoning !== undefined) {
        fields(model.reasoning, ['efforts', 'defaultEffort'], 'model-invalid-output');
        if (!Array.isArray(model.reasoning.efforts)) throw fail('model-invalid-output');
        for (const effort of model.reasoning.efforts) {
          fields(effort, ['id', 'name', 'description'], 'model-invalid-output');
          display(effort.name, 80);
          if (Object.hasOwn(effort, 'description')) display(effort.description, 120);
        }
      }
    }
  }
  // A page carries all routable provider identities, but only this page's groups.
  projectCatalog({ ...value, routableProviders: value.groups.map(group => group.id), failures: [] });
  if (value.routableProviders.length > MAX_PROVIDERS ||
    new Set(value.routableProviders).size !== value.routableProviders.length ||
    value.routableProviders.some(provider => id(provider, 128, 'model-invalid-output') !== provider) ||
    value.groups.some(group => !value.routableProviders.includes(group.id)) ||
    value.groups.reduce((sum, group) => sum + group.models.length, 0) > 64 || Buffer.byteLength(JSON.stringify(value)) > MODEL_MAX_BYTES) throw fail('model-invalid-output');
  return value;
}
export function parseSelectDefaultModelOutput(value) {
  fields(value, ['profile', 'current', 'scope'], 'model-invalid-output');
  if (value.profile !== 'companion' || value.scope !== 'unconfigured-agents') throw fail('model-invalid-output');
  return { profile: 'companion', current: parseModelChoice(value.current, 'model-invalid-output'), scope: value.scope };
}

/** Original V1 methods remain default-only; explicit app methods use the same save lane. */
export function createModelSettings(ctx, options = {}) {
  let saves = Promise.resolve();
  const current = () => {
    const defaults = ctx.get('agentDefaultModel');
    if (!defaults) throw fail('model-catalog-unavailable');
    return parseModelChoice(defaults.currentSelection(), 'model-invalid-output');
  };
  function writable() {
    try { return ctx.get('configEditor') !== undefined && ctx.get('settings')?.writable === true; }
    catch { return false; }
  }
  async function catalog(signal) {
    signal?.throwIfAborted();
    let raw;
    // Public lazy lookup keeps optional model capabilities from gating ordinary chat catalog.
    try { raw = await ctx.get('sessionController').modelCatalog(); }
    catch { signal?.throwIfAborted(); throw fail('model-catalog-unavailable'); }
    signal?.throwIfAborted();
    return projectCatalog(raw);
  }
  async function modelCatalog(raw, signal) {
    const request = parseModelCatalogRequest(raw);
    const inventory = await catalog(signal);
    const selected = current();
    const revision = createHash('sha256').update(JSON.stringify({ inventory, selected })).digest('hex');
    let offset = 0;
    if (request.cursor !== undefined) {
      const [hash, position] = request.cursor.split(':');
      offset = Number(position);
      if (hash !== revision) throw fail('model-cursor-stale');
      if (offset >= inventory.rows.length) throw fail('model-invalid-request');
    }
    const result = { profile: 'companion', current: selected, groups: [], routableProviders: inventory.routableProviders,
      writable: writable(), unavailableProviders: inventory.unavailableProviders, nextCursor: null };
    const page = [];
    for (let index = offset; index < inventory.rows.length && page.length < request.limit; index++) {
      const nextCursor = index + 1 < inventory.rows.length ? `${revision}:${index + 1}` : null;
      const groups = grouped([...page, inventory.rows[index]]);
      if (Buffer.byteLength(JSON.stringify({ ...result, groups, nextCursor })) > MODEL_MAX_BYTES) break;
      page.push(inventory.rows[index]); result.groups = groups; result.nextCursor = nextCursor;
    }
    if (offset < inventory.rows.length && page.length === 0) throw fail('model-catalog-limit');
    signal?.throwIfAborted();
    return parseModelCatalogOutput(result);
  }
  async function selectDefaultModel(raw, signal) {
    const request = parseSelectDefaultModelRequest(raw);
    const work = saves.then(async () => {
      signal?.throwIfAborted();
      if (!writable()) throw fail('model-read-only');
      if (!equal(current(), request.expectedCurrent)) throw fail('model-default-conflict');
      const { expectedCurrent: _expectedCurrent, ...choice } = request;
      const inventory = await catalog(signal);
      if (!validFor(inventory.rows, choice)) throw fail('model-unavailable');
      let resolved;
      try { resolved = await ctx.get('llm').resolveCallConfig({ provider: choice.provider, model: choice.model,
        ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(choice.reasoningEffort) }) }); }
      catch { throw fail('model-unavailable'); }
      const normalized = parseModelChoice({ provider: resolved.provider, model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: String(resolved.reasoningEffort) }) }, 'model-invalid-output');
      if (normalized.provider !== choice.provider || normalized.model !== choice.model ||
        (choice.reasoningEffort !== undefined && normalized.reasoningEffort !== choice.reasoningEffort) ||
        !validFor(inventory.rows, normalized)) throw fail('model-unavailable');
      signal?.throwIfAborted();
      if (!equal(current(), request.expectedCurrent)) throw fail('model-default-conflict');
      // Cancellation after admission cannot undo persistence and is not a replay signal.
      // SDK saveSelection may fulfill without an editor/entry: read-back catches that.
      if (!equal(current(), normalized)) {
        try { await ctx.get('agentDefaultModel').saveSelection(normalized); }
        catch { throw fail('model-save-unconfirmed'); }
      }
      let verified;
      try { verified = current(); } catch { throw fail('model-save-unconfirmed'); }
      if (!equal(verified, normalized)) throw fail('model-save-unconfirmed');
      return parseSelectDefaultModelOutput({ profile: 'companion', current: verified, scope: 'unconfigured-agents' });
    });
    saves = work.catch(() => {});
    return work;
  }
  const contracts = appModelContracts(parseModelChoice, parseSelectDefaultModelRequest);
  const app = createAppModelOperations(ctx, {
    current, contracts, parseChoiceRequest: parseSelectDefaultModelRequest, policy: options.appModelPolicy,
    checkWritable() { if (!writable()) throw fail('model-read-only'); },
    serialize(task) { const work = saves.then(task); saves = work.catch(() => {}); return work; },
    async normalize(choice, signal) {
      const inventory = await catalog(signal);
      if (!validFor(inventory.rows, choice)) throw fail('model-unavailable');
      let resolved;
      try { resolved = await ctx.get('llm').resolveCallConfig({ provider: choice.provider, model: choice.model,
        ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(choice.reasoningEffort) }) }); }
      catch { throw fail('model-unavailable'); }
      const normalized = parseModelChoice({ provider: resolved.provider, model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: String(resolved.reasoningEffort) }) }, 'model-invalid-output');
      if (normalized.provider !== choice.provider || normalized.model !== choice.model ||
        (choice.reasoningEffort !== undefined && normalized.reasoningEffort !== choice.reasoningEffort) || !validFor(inventory.rows, normalized)) throw fail('model-unavailable');
      return normalized;
    },
  });
  return Object.freeze({ modelCatalog, selectDefaultModel, ...app });
}
export const appModelCodecs = Object.freeze(appModelContracts(parseModelChoice, parseSelectDefaultModelRequest).codecs);
export const modelCodecs = Object.freeze({
  modelCatalogRequest: { mode: 'strict', typeSymbol: 'CompanionModelCatalogRequest', create: () => ({ parse: parseModelCatalogRequest }) },
  modelCatalogOutput: { mode: 'strict', typeSymbol: 'CompanionModelCatalogOutput', create: () => ({ parse: parseModelCatalogOutput }) },
  selectDefaultModelRequest: { mode: 'strict', typeSymbol: 'CompanionSelectDefaultModelRequest', create: () => ({ parse: parseSelectDefaultModelRequest }) },
  selectDefaultModelOutput: { mode: 'strict', typeSymbol: 'CompanionSelectDefaultModelOutput', create: () => ({ parse: parseSelectDefaultModelOutput }) },
});
