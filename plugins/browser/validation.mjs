import { loadRuntime } from './deps.mjs';
import { fail } from './errors.mjs';
import { ROOT_SCHEMA, OUTPUT_SCHEMA } from './protocol.mjs';
import { DEFAULT_CONFIG } from './config.mjs';
import { catalogRevision, OPERATIONS, getOperation, operationAvailability, operationDefaults, operationExample } from './manifest.mjs';

const META = new Set(['help', 'describe', 'capabilities']);
const cache = new Map();
let ajvPromise;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Bound the lossless JSON tree before validation/serialization; never invoke accessors. */
function boundedJson(value, { maxBytes, maxDepth, maxNodes = 4096, maxArray = 1000, maxString = 32768, code }) {
  let bytes = 0, nodes = 0;
  const add = count => { bytes += count; if (bytes > maxBytes) fail(code, 'Browser JSON exceeds its bounded byte budget.'); };
  function visit(item, depth) {
    if (++nodes > maxNodes || depth > maxDepth) fail(code, 'Browser JSON is too deeply nested or contains too many values.');
    if (item === null || typeof item === 'boolean') { add(item === null ? 4 : item ? 4 : 5); return; }
    if (typeof item === 'number' && Number.isFinite(item)) { add(String(item).length); return; }
    if (typeof item === 'string') {
      if (item.length > maxString) fail(code, 'Browser JSON string exceeds its bounded length.');
      add(Buffer.byteLength(JSON.stringify(item))); return;
    }
    if (Array.isArray(item)) {
      if (item.length > maxArray || Object.keys(item).some(key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) fail(code, 'Browser JSON array exceeds its bounds or has non-JSON properties.');
      add(2 + Math.max(0, item.length - 1));
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code, 'Sparse/accessor arrays are not browser JSON.');
        visit(descriptor.value, depth + 1);
      }
      return;
    }
    if (!plain(item)) fail(code, 'Browser arguments/results must be lossless plain JSON.');
    const properties = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some(key => typeof key !== 'string') || Object.keys(properties).length > 128) fail(code, 'Browser JSON object contains too many or non-JSON properties.');
    const entries = Object.entries(properties);
    add(2 + Math.max(0, entries.length - 1));
    for (const [key, descriptor] of entries) {
      if (key.length > 128 || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code, 'Browser JSON object keys/accessors are not permitted.');
      add(Buffer.byteLength(JSON.stringify(key)) + 1);
      visit(descriptor.value, depth + 1);
    }
  }
  visit(value, 0);
}

// Only the deliberately small wire/protocol/meta subset is evaluated here. Rich leaves use AJV.
function basicSchema(schema, value) {
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter(child => basicSchema(child, value)).length !== 1) return false;
  if (schema.type === 'string' && (typeof value !== 'string' || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.minLength !== undefined && value.length < schema.minLength))) return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (['number', 'integer'].includes(schema.type) && (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value)) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (schema.type === 'array') {
    if (!Array.isArray(value) || (schema.maxItems !== undefined && value.length > schema.maxItems) || (schema.minItems !== undefined && value.length < schema.minItems)) return false;
    if (schema.items && value.some(item => !basicSchema(schema.items, item))) return false;
  }
  if (schema.type === 'object') {
    if (!plain(value) || schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) { if (!basicSchema(schema.properties[key], item)) return false; }
      else if (schema.additionalProperties === false) return false;
    }
  }
  return true;
}

async function compiler() {
  if (!ajvPromise) {
    ajvPromise = loadRuntime('ajv/dist/2020.js').then(module => {
      const Ajv = module.default;
      return new Ajv({ strict: true, strictRequired: false, allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false, ownProperties: true });
    }).catch(error => { ajvPromise = undefined; throw error; });
  }
  return ajvPromise;
}
async function validator(operation, kind) {
  const key = `${operation}:${kind}`;
  if (!cache.has(key)) {
    const descriptor = getOperation(operation);
    const compiled = compiler().then(ajv => ajv.compile(kind === 'input' ? descriptor.inputSchema : descriptor.outputSchema)).catch(error => { cache.delete(key); throw error; });
    cache.set(key, compiled);
  }
  return cache.get(key);
}
function mergeDefaults(value, defaults) {
  return Object.fromEntries([...new Set([...Object.keys(defaults), ...Object.keys(value)])].map(key => {
    const supplied = Object.hasOwn(value, key);
    const item = supplied ? value[key] : defaults[key];
    return [key, plain(item) ? mergeDefaults(item, supplied && plain(defaults[key]) ? defaults[key] : {}) : Array.isArray(item) ? item.map(child => plain(child) ? mergeDefaults(child, {}) : child) : item];
  }));
}
function targetDefaults(value) {
  if (Array.isArray(value)) { for (const child of value) targetDefaults(child); return; }
  if (!plain(value)) return;
  if (value.kind === 'role' && !Object.hasOwn(value, 'exact')) value.exact = true;
  for (const child of Object.values(value)) targetDefaults(child);
}
function scanTargets(value, config) {
  if (Array.isArray(value)) { for (const item of value) scanTargets(item, config); return; }
  if (!plain(value)) return;
  if (value.kind === 'css' && !config.allowCss) fail('POLICY_DENIED', 'CSS target escape hatch is administratively disabled.');
  for (const item of Object.values(value)) scanTargets(item, config);
}
function checkBudget(value, maximum, label) {
  if (value !== undefined && value > maximum) fail('LIMIT_EXCEEDED', `${label} exceeds the effective browser budget.`);
}
function semanticArgs(request, descriptor, config) {
  const args = request.args;
  scanTargets(args, config);
  if (['session.open', 'session.replace'].includes(request.operation)) {
    if (!config.allowedEngines.includes(args.engine)) fail('POLICY_DENIED', 'Requested engine is not permitted by this profile/project.');
    if (args.downloads && !config.allowDownloads) fail('POLICY_DENIED', 'Downloads are administratively disabled.');
    const emulation = args.emulation;
    if (emulation?.viewport) {
      checkBudget(emulation.viewport.width, config.limits.viewportWidth, 'Viewport width');
      checkBudget(emulation.viewport.height, config.limits.viewportHeight, 'Viewport height');
    }
    if (emulation?.screen) {
      checkBudget(emulation.screen.width, config.limits.viewportWidth, 'Screen width');
      checkBudget(emulation.screen.height, config.limits.viewportHeight, 'Screen height');
    }
    checkBudget(emulation?.deviceScaleFactor, config.limits.dpr, 'Device scale factor');
    if (emulation?.viewport && emulation.viewport.width * emulation.viewport.height * (emulation.deviceScaleFactor ?? 1) ** 2 > config.limits.pixels) fail('LIMIT_EXCEEDED', 'Device viewport exceeds the effective pixel budget.');
  }
  if (request.operation === 'page.navigate' || request.operation === 'page.create') {
    if (args.url !== 'about:blank') {
      let url;
      try { url = new URL(args.url); } catch { fail('INVALID_ARGS', 'Navigation requires an absolute HTTP(S) URL or about:blank.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('INVALID_ARGS', 'Navigation scheme/embedded credentials are not permitted.');
    }
  }
  if (args.timeoutMs !== undefined) {
    const cap = request.operation.startsWith('page.') && ['page.navigate', 'page.back', 'page.forward', 'page.reload'].includes(request.operation) ? config.limits.navigationMs : config.limits.actionMs;
    checkBudget(args.timeoutMs, Math.min(cap, config.limits.rootMs), 'Operation timeout');
  }
  checkBudget(args.readiness?.timeoutMs, Math.min(config.limits.actionMs, config.limits.rootMs), 'Screenshot readiness timeout');
  for (const dimensions of [request.operation === 'emulate.viewport' ? args : undefined, args.size, args.clip]) {
    if (dimensions) {
      checkBudget(dimensions.width, config.limits.viewportWidth, 'Width');
      checkBudget(dimensions.height, args.clip ? 12000 : config.limits.viewportHeight, 'Height');
      checkBudget(dimensions.width * dimensions.height, config.limits.pixels, 'Pixels');
    }
  }
  for (const candidate of [args.point, args.from, args.to]) {
    if (candidate && (candidate.x >= config.limits.viewportWidth || candidate.y >= config.limits.viewportHeight)) fail('LIMIT_EXCEEDED', 'Gesture point exceeds the configured viewport bounds; actual Page bounds are also checked by the worker.');
  }
  checkBudget(args.fps, config.limits.videoFps, 'Video FPS');
  checkBudget(args.maxDurationMs, config.limits.videoDurationMs, 'Video duration');
  if ((args.includeHeaders || args.includeBody) && config.sensitiveOps === 'disabled') fail('POLICY_DENIED', 'Sensitive request headers/bodies are administratively disabled.');
  return descriptor.operation === 'diagnostics.request' && (args.includeHeaders || args.includeBody) ? Object.freeze({ ...descriptor, sensitive: true }) : descriptor;
}

/** Relocate only declared metadata, never leaf fields, authority or an inferred target. */
function normalizeEnvelope(input, descriptor) {
  const request = { ...input, args: { ...input.args } };
  const keys = ['catalogRevision'];
  if (['help', 'describe'].includes(input.operation)) keys.push('path');
  if (descriptor.requiresSession) keys.push('sessionId');
  if (descriptor.usesPage) keys.push('pageId');
  for (const key of keys) {
    if (!Object.hasOwn(request.args, key)) continue;
    if (Object.hasOwn(request, key) && request[key] !== request.args[key]) fail('INVALID_ENVELOPE', `Conflicting ${key} at the top level and in args; supply one identical value. No operation was executed.`);
    request[key] = request.args[key];
    delete request.args[key];
  }
  return request;
}

/** Bounds precede copying; the same idempotent normalization guards policy, broker and worker. */
export async function validateCall(input, { config = DEFAULT_CONFIG } = {}) {
  boundedJson(input, { maxBytes: config.limits.inputBytes, maxDepth: 12, code: 'INVALID_ENVELOPE' });
  if (!basicSchema(ROOT_SCHEMA, input)) fail('INVALID_ENVELOPE', 'Invalid browser envelope; operation and exact args object are required.');
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/.test(input.operation) || input.operation.length > 160) fail('UNKNOWN_OPERATION', 'Browser operation must be an exact curated path.');
  let descriptor = getOperation(input.operation);
  if (!descriptor) fail('UNKNOWN_OPERATION', input.operation === 'page.goto'
    ? 'page.goto is not a browser operation. Use page.navigate: {"operation":"page.navigate","sessionId":"<refs.sessionId>","pageId":"<refs.pageId>","args":{"url":"http://127.0.0.1:8000/"}}. Reuse owned refs from session.open; do not guess IDs.'
    : 'Browser operation is not in the reviewed catalog. Discover valid names with {"operation":"help","args":{}}; no operation was executed.');
  input = normalizeEnvelope(input, descriptor);
  if (!basicSchema(ROOT_SCHEMA, input)) fail('INVALID_ENVELOPE', 'Browser metadata must use the declared string types, including when supplied inside args. No operation was executed.');
  for (const key of ['sessionId', 'pageId', 'catalogRevision']) {
    if (input[key] !== undefined && (input[key].length === 0 || input[key].length > 160 || /\s|\0/.test(input[key]))) fail('INVALID_ENVELOPE', 'Browser reference/revision must be a bounded opaque id.');
  }
  if (input.catalogRevision !== undefined && input.catalogRevision !== catalogRevision(config)) fail('CATALOG_CHANGED', 'Browser catalog changed; describe the operation again before effects.');
  if (META.has(input.operation)) {
    if (input.sessionId !== undefined || input.pageId !== undefined) fail('INVALID_ARGS', 'Catalog operations do not accept session/page ids.');
    if (input.operation === 'describe' && !input.path) fail('INVALID_ARGS', 'Describe requires an exact leaf in top-level path: {"operation":"describe","path":"page.navigate","args":{}}. For branches use {"operation":"help","path":"page","args":{}}.');
    if (input.operation === 'capabilities' && input.path !== undefined) fail('INVALID_ARGS', 'Capabilities does not accept path.');
    if (input.path !== undefined) {
      if (input.path.length > 160 || (input.path !== '' && !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/.test(input.path))) fail('INVALID_ARGS', 'Catalog path is not valid.');
      if (input.path && !OPERATIONS.some(item => item.operation === input.path || item.operation.startsWith(`${input.path}.`))) fail('UNKNOWN_OPERATION', 'Catalog path does not exist.');
      if (input.operation === 'describe' && !getOperation(input.path)) fail('UNKNOWN_OPERATION', `Describe requires a leaf, not a branch. Use ${JSON.stringify({ operation: 'help', path: input.path, args: {} })}; each item provides its nextCall.`);
    }
    if (!basicSchema(descriptor.inputSchema, input.args)) fail('INVALID_ARGS', 'Invalid catalog arguments. Use {"operation":"help","path":"session","args":{}} or {"operation":"describe","path":"session.open","args":{}}. Help allows only query/limit/cursor/availability; describe and capabilities use empty args after metadata relocation. Code and unknown fields remain forbidden.');
  } else {
    if (input.path !== undefined) fail('INVALID_ARGS', 'Executable operations use operation only; path is reserved for catalog discovery.');
    if (descriptor.requiresSession !== (input.sessionId !== undefined)) fail('INVALID_ARGS', descriptor.requiresSession
      ? `This operation requires an owned sessionId returned by session.open. Reuse existing refs; place sessionId/pageId at the top level. Example: ${JSON.stringify(operationExample(descriptor, config))}. If none is open, call {"operation":"session.open","args":{}}.`
      : 'This operation does not accept sessionId.');
    if (input.pageId !== undefined && !descriptor.usesPage) fail('INVALID_ARGS', 'This operation does not accept pageId; capture/artifact handles already identify their owned source.');
    const availability = operationAvailability(descriptor, config);
    if (availability.state !== 'verified') fail(availability.state === 'unsupported' ? 'UNSUPPORTED_CAPABILITY' : 'POLICY_DENIED', availability.reason ?? 'Operation is unavailable.');
    const validate = await validator(input.operation, 'input');
    if (!validate(input.args)) fail('INVALID_ARGS', `Arguments do not match the exact ${input.operation} schema. Inspect ${JSON.stringify({ operation: 'describe', path: input.operation, args: {} })}; its example includes required fields. Unknown fields/types are not removed or coerced.`, { fieldErrors: validate.errors.slice(0, 8).map(error => ({ path: error.instancePath.slice(0, 256), keyword: error.keyword })) });
  }
  const defaults = operationDefaults(descriptor, config);
  const request = { ...input, args: mergeDefaults(input.args, defaults) };
  targetDefaults(request.args);
  if (!META.has(input.operation)) {
    const validate = await validator(input.operation, 'input');
    if (!validate(request.args)) fail('INVALID_ARGS', 'Normalized defaults violate the operation schema or configured bounds.');
    descriptor = semanticArgs(request, descriptor, config);
  }
  boundedJson(request, { maxBytes: config.limits.inputBytes, maxDepth: 12, code: 'INVALID_ENVELOPE' });
  return { request, descriptor, effects: [...descriptor.effects] };
}

/** Paths/ownership are checked by the artifact manager; this verifies lossless protocol facts. */
export async function validateOutput(operation, responseValue, { config = DEFAULT_CONFIG } = {}) {
  boundedJson(responseValue, { maxBytes: 262144, maxDepth: 20, maxNodes: 12000, maxArray: 2000, maxString: 65536, code: 'BACKEND_INVALID_OUTPUT' });
  if (!basicSchema(OUTPUT_SCHEMA, responseValue) || responseValue.operation !== operation) fail('BACKEND_INVALID_OUTPUT', 'Browser returned an invalid canonical protocol response.');
  const descriptor = getOperation(operation);
  if (!descriptor) fail('BACKEND_INVALID_OUTPUT', 'Browser output belongs to an unknown operation.');
  if (responseValue.catalogRevision !== catalogRevision(config)) fail('BACKEND_INVALID_OUTPUT', 'Browser output catalog revision does not match the host.');
  if (META.has(operation)) {
    if (!basicSchema(descriptor.outputSchema, responseValue.data)) fail('BACKEND_INVALID_OUTPUT', 'Catalog output does not match its declared schema.');
  } else {
    const validate = await validator(operation, 'output');
    if (!validate(responseValue.data)) fail('BACKEND_INVALID_OUTPUT', 'Browser operation output does not match its declared schema.');
  }
  for (const key of ['generation']) if (responseValue.refs[key] !== undefined && (!Number.isSafeInteger(responseValue.refs[key]) || responseValue.refs[key] < 1)) fail('BACKEND_INVALID_OUTPUT', 'Browser generation must be a positive integer.');
  for (const artifact of responseValue.artifacts) {
    for (const key of ['bytes', 'width', 'height', 'durationMs', 'generation', 'frameIndex']) {
      if (artifact[key] !== undefined && (!Number.isFinite(artifact[key]) || artifact[key] < 0 || (['bytes', 'width', 'height', 'generation', 'frameIndex'].includes(key) && !Number.isSafeInteger(artifact[key])))) fail('BACKEND_INVALID_OUTPUT', 'Artifact numeric metadata is not finite and valid.');
    }
    if (artifact.path !== undefined && (artifact.path.length > 4096 || artifact.path.includes('\0'))) fail('BACKEND_INVALID_OUTPUT', 'Artifact path metadata is invalid.');
    if (artifact.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(artifact.sha256)) fail('BACKEND_INVALID_OUTPUT', 'Artifact checksum metadata is invalid.');
    if (artifact.state === 'finalized' && artifact.bytes === 0 && artifact.kind !== 'text') fail('BACKEND_INVALID_OUTPUT', 'Empty non-text artifact cannot be marked finalized.');
  }
  for (const image of responseValue.imageRefs) {
    for (const key of ['bytes', 'width', 'height']) if (!Number.isSafeInteger(image[key]) || image[key] < 1) fail('BACKEND_INVALID_OUTPUT', 'Image attachment dimensions/bytes must be positive integers.');
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType)) fail('BACKEND_INVALID_OUTPUT', 'Image attachment media type is not supported.');
    if (image.originalDimensions && ['width', 'height'].some(key => !Number.isSafeInteger(image.originalDimensions[key]) || image.originalDimensions[key] < 1)) fail('BACKEND_INVALID_OUTPUT', 'Original image dimensions are invalid.');
  }
  if (responseValue.status === 'completed' && responseValue.effects.some(effect => effect.state === 'unknown' || effect.state === 'partial')) fail('BACKEND_INVALID_OUTPUT', 'A completed operation cannot conceal an unknown/partial effect.');
  if (operation.startsWith('media.video.') && responseValue.data.scope === 'context') fail('BACKEND_INVALID_OUTPUT', 'Page-scoped video cannot be reported as context-wide.');
  if (['media.video.stop', 'media.trace.stop'].includes(operation) && responseValue.data.state === 'finalized' && !responseValue.artifacts.some(artifact => artifact.state === 'finalized')) fail('BACKEND_INVALID_OUTPUT', 'Finalized media requires a finalized artifact, not only a capture id.');
  return responseValue;
}
