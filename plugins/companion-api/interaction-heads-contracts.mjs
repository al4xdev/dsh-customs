import { resolveHost } from './interaction-sdk.mjs';
const { RemoteError } = await import(resolveHost('@deepseek-ai/dsh-typert-protocol'));

export const INTERACTION_HEADS_LIMITS = Object.freeze({ maxIds: 20, maxBytes: 32768, maxActive: 128, maxContinued: 32 });
const sessionId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
export const validInteractionCallId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value);
export const interactionRefusal = code => new RemoteError(`companion/${code}`, 'Companion interaction metadata unavailable or invalid.', {});

export function exactRecord(value, keys, code = 'invalid-output') {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw interactionRefusal(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)) ||
      Reflect.ownKeys(descriptors).some(key => !keys.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw interactionRefusal(code);
}
export function denseArray(value, maximum, code = 'invalid-output') {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) throw interactionRefusal(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw interactionRefusal(code);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw interactionRefusal(code);
    return descriptor.value;
  });
}
export function parseInteractionHeadsRequest(value) {
  exactRecord(value, ['sessionIds'], 'invalid-request');
  const sessionIds = denseArray(value.sessionIds, INTERACTION_HEADS_LIMITS.maxIds, 'invalid-request');
  if (sessionIds.some(id => !sessionId(id)) || new Set(sessionIds).size !== sessionIds.length) throw interactionRefusal('invalid-request');
  return { sessionIds };
}
export function parseInteractionHeadsOutput(value) {
  exactRecord(value, ['version', 'profile', 'heads']);
  if (value.version !== 1 || value.profile !== 'companion') throw interactionRefusal('invalid-output');
  const heads = denseArray(value.heads, INTERACTION_HEADS_LIMITS.maxIds).map(row => {
    exactRecord(row, ['sessionId', 'createdAt', 'knowledge', 'asOfSeq', 'continuedCallIds']);
    if (!sessionId(row.sessionId)) throw interactionRefusal('invalid-output');
    let continuedCallIds = null;
    if (row.knowledge === 'unknown') {
      if (!(row.createdAt === null || integer(row.createdAt)) || row.asOfSeq !== null || row.continuedCallIds !== null) throw interactionRefusal('invalid-output');
    } else if (row.knowledge === 'current') {
      if (!integer(row.createdAt) || !integer(row.asOfSeq, -1)) throw interactionRefusal('invalid-output');
      continuedCallIds = denseArray(row.continuedCallIds, INTERACTION_HEADS_LIMITS.maxContinued);
      if (continuedCallIds.some(id => !validInteractionCallId(id)) || new Set(continuedCallIds).size !== continuedCallIds.length) throw interactionRefusal('invalid-output');
    } else throw interactionRefusal('invalid-output');
    return { sessionId: row.sessionId, createdAt: row.createdAt, knowledge: row.knowledge, asOfSeq: row.asOfSeq, continuedCallIds };
  });
  if (new Set(heads.map(head => head.sessionId)).size !== heads.length) throw interactionRefusal('invalid-output');
  const result = { version: 1, profile: 'companion', heads };
  if (Buffer.byteLength(JSON.stringify(result)) > INTERACTION_HEADS_LIMITS.maxBytes) throw interactionRefusal('invalid-output');
  return result;
}
export const interactionHeadsCodecs = Object.freeze({
  request: { mode: 'strict', typeSymbol: 'CompanionInteractionHeadsRequest', create: () => ({ parse: parseInteractionHeadsRequest }) },
  output: { mode: 'strict', typeSymbol: 'CompanionInteractionHeadsOutput', create: () => ({ parse: parseInteractionHeadsOutput }) },
});
