import { createHash } from 'node:crypto';

export const DEDICATED_ROOT = '/home/alex/git/my/dsh-companion-workspace';
export const MAX_TEXT_BYTES = 16 * 1024;
export class CreateError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
export function fail(code, message) { throw new CreateError(code, message); }
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function record(value, keys, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_request');
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value') || !Object.getOwnPropertyDescriptor(value, key).enumerable))) fail('unknown_field');
  for (const key of required) if (!Object.hasOwn(value, key)) fail('missing_field', key);
}
function text(value, limit, controlFree = false) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit || value.includes('\0') || (controlFree && /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value))) fail('invalid_text');
  // Unpaired UTF-16 would be replaced during UTF-8 transport, violating literal/hash binding.
  if ([...value].some(character => { const point = character.codePointAt(0); return point >= 0xd800 && point <= 0xdfff; })) fail('invalid_unicode');
  return value;
}
export function projectName(value) {
  text(value, 80, true);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(value)) fail('invalid_project_name');
  return value;
}
export function parseArgs(args) {
  record(args, ['operation', 'request', 'operation_id'], ['operation']);
  if (['help', 'capabilities'].includes(args.operation)) { record(args, ['operation']); return freeze({ operation: args.operation }); }
  if (args.operation === 'status') {
    record(args, ['operation', 'operation_id'], ['operation_id']);
    if (typeof args.operation_id !== 'string' || !/^[a-f0-9]{64}$/u.test(args.operation_id)) fail('invalid_operation_id');
    return freeze({ operation: 'status', operation_id: args.operation_id });
  }
  if (args.operation !== 'create') fail('invalid_operation');
  record(args, ['operation', 'request'], ['request']);
  const request = args.request;
  record(request, ['version', 'owner_intent', 'delivery', 'target', 'preset', 'model', 'idempotency_key'], ['version', 'owner_intent']);
  if (request.version !== 1) fail('unsupported_version');
  text(request.owner_intent, 4096, true);
  const delivery = request.delivery === undefined ? { mode: 'empty' } : request.delivery;
  record(delivery, ['mode', 'text'], ['mode']);
  if (delivery.mode === 'empty') record(delivery, ['mode'], ['mode']);
  else if (delivery.mode === 'submit') { record(delivery, ['mode', 'text'], ['mode', 'text']); text(delivery.text, MAX_TEXT_BYTES); }
  else fail('invalid_delivery');
  const target = request.target === undefined ? { kind: 'current' } : request.target;
  record(target, ['kind', 'project_id', 'name', 'path', 'directory'], ['kind']);
  if (target.kind === 'current') record(target, ['kind'], ['kind']);
  else if (target.kind === 'existing_project') { record(target, ['kind', 'project_id'], ['kind', 'project_id']); text(target.project_id, 160, true); }
  else if (target.kind === 'new_project') {
    record(target, ['kind', 'name', 'path', 'directory'], ['kind', 'name']); projectName(target.name);
    if (target.path !== undefined) text(target.path, 4096, true);
    if (target.directory !== undefined && !['must_exist', 'create_child'].includes(target.directory)) fail('invalid_directory_mode');
  } else fail('invalid_target');
  if (request.preset !== undefined && request.preset !== 'companion') fail('preset_unavailable');
  if (request.model !== undefined) {
    record(request.model, ['provider', 'model', 'reasoning_effort'], ['provider', 'model']);
    text(request.model.provider, 160, true); text(request.model.model, 160, true);
    if (request.model.reasoning_effort !== undefined) text(request.model.reasoning_effort, 160, true);
  }
  if (request.idempotency_key !== undefined) {
    if (typeof request.idempotency_key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(request.idempotency_key)) fail('invalid_idempotency_key');
  }
  return freeze({ operation: 'create', request: JSON.parse(JSON.stringify({ ...request, delivery, target: target.kind === 'new_project' ? { ...target, directory: target.directory ?? 'create_child' } : target, preset: 'companion' })) });
}
const string = description => ({ type: 'string', description });
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
export const requestSchema = object({
  version: { type: 'integer', const: 1 }, owner_intent: string('Explain the owner request; this is not proof of authorization.'),
  delivery: { description: 'Default empty: no prompt, draft or model. submit explicitly authorizes immediate queue/run after native human review.', oneOf: [object({ mode: { type: 'string', const: 'empty' } }, ['mode']), object({ mode: { type: 'string', const: 'submit' }, text: string('Full literal nonblank text, at most 16 KiB UTF-8; never truncated in approval.') }, ['mode', 'text'])] },
  target: { oneOf: [object({ kind: { type: 'string', const: 'current' } }, ['kind']), object({ kind: { type: 'string', const: 'existing_project' }, project_id: string('Exact registry ID; only dedicated root or approved direct projects children.') }, ['kind', 'project_id']), object({ kind: { type: 'string', const: 'new_project' }, name: string('Single ASCII leaf [A-Za-z0-9][A-Za-z0-9_-]{0,63}; folder and initial title.'), path: string('If supplied, must equal dedicatedRoot/projects/name. No arbitrary cwd.'), directory: { type: 'string', enum: ['must_exist', 'create_child'], description: 'Default create_child. Missing projects parent may be created after approval; existing target in create_child is a conflict.' } }, ['kind', 'name'])] },
  preset: { type: 'string', const: 'companion' }, model: object({ provider: string('Must match current effective route; never changes global default.'), model: string('Must match current effective model.'), reasoning_effort: string('Must match effective effort.') }, ['provider', 'model']),
  idempotency_key: string('Caller-scoped stable key. Same key/different request conflicts; existing operations are never automatically retried.'),
}, ['version', 'owner_intent']);
export const parameters = object({ operation: { type: 'string', enum: ['help', 'capabilities', 'status', 'create'] }, request: requestSchema, operation_id: string('Caller-bound operation ID returned by create; status is strictly read-only.') }, ['operation']);
export const outputSchema = { type: 'object', additionalProperties: true };
