import { refusal } from './contracts.mjs';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fields(value, allowed, code) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(key =>
    typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw refusal(code);
}
export function parseCatalogStateRequest(value) {
  fields(value, [], 'invalid-request');
  return {};
}
export function parseCatalogState(value) {
  fields(value, ['version', 'profile', 'sourceId', 'revision'], 'invalid-output');
  if (value.version !== 1 || value.profile !== 'companion' || typeof value.sourceId !== 'string' || !uuid.test(value.sourceId) ||
    !Number.isSafeInteger(value.revision) || value.revision < 0) throw refusal('invalid-output');
  // This is a metadata invalidation clock, not a timestamp, completion, acknowledgement or control permit.
  return { version: 1, profile: 'companion', sourceId: value.sourceId, revision: value.revision };
}
export const catalogStateCodecs = Object.freeze({
  request: { mode: 'strict', typeSymbol: 'CompanionCatalogStateRequest', create: () => ({ parse: parseCatalogStateRequest }) },
  output: { mode: 'strict', typeSymbol: 'CompanionCatalogState', create: () => ({ parse: parseCatalogState }) },
});
