import { refusal, SESSION_ID } from './contracts.mjs';

export const MESSAGE_HEADS_MAX_IDS = 20;
export const MESSAGE_HEADS_MAX_BYTES = 32 * 1024;
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const messageId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value);
const sessionId = value => typeof value === 'string' && SESSION_ID.test(value);
function exact(value, keys, code) {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw refusal(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)) ||
      Reflect.ownKeys(descriptors).some(key => !keys.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw refusal(code);
}
function boundedArray(value, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MESSAGE_HEADS_MAX_IDS) throw refusal(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw refusal(code);
  const items = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw refusal(code);
    items.push(descriptor.value);
  }
  return items;
}
export function parseMessageHeadsRequest(value) {
  exact(value, ['sessionIds'], 'invalid-request');
  const sessionIds = boundedArray(value.sessionIds, 'invalid-request');
  if (sessionIds.some(id => !sessionId(id)) || new Set(sessionIds).size !== sessionIds.length) throw refusal('invalid-request');
  return { sessionIds };
}
export function parseMessageHeadsOutput(value) {
  exact(value, ['version', 'profile', 'heads'], 'invalid-output');
  if (value.version !== 1 || value.profile !== 'companion') throw refusal('invalid-output');
  const heads = boundedArray(value.heads, 'invalid-output').map(row => {
    exact(row, ['sessionId', 'createdAt', 'knowledge', 'asOfSeq', 'lastVisibleAssistant'], 'invalid-output');
    if (!sessionId(row.sessionId)) throw refusal('invalid-output');
    if (row.knowledge === 'unknown') {
      if (!(row.createdAt === null || integer(row.createdAt)) || row.asOfSeq !== null || row.lastVisibleAssistant !== null) throw refusal('invalid-output');
    } else if (row.knowledge === 'current') {
      if (!integer(row.createdAt) || !integer(row.asOfSeq, -1)) throw refusal('invalid-output');
      if (row.lastVisibleAssistant !== null) {
        const head = row.lastVisibleAssistant;
        exact(head, ['seq', 'messageId', 'time', 'interrupted'], 'invalid-output');
        if (!integer(head.seq) || head.seq > row.asOfSeq || !messageId(head.messageId) || !integer(head.time) || typeof head.interrupted !== 'boolean') throw refusal('invalid-output');
      }
    } else throw refusal('invalid-output');
    return { sessionId: row.sessionId, createdAt: row.createdAt, knowledge: row.knowledge, asOfSeq: row.asOfSeq,
      lastVisibleAssistant: row.lastVisibleAssistant === null ? null : { ...row.lastVisibleAssistant } };
  });
  if (new Set(heads.map(row => row.sessionId)).size !== heads.length) throw refusal('invalid-output');
  const output = { version: 1, profile: 'companion', heads };
  if (Buffer.byteLength(JSON.stringify(output)) > MESSAGE_HEADS_MAX_BYTES) throw refusal('invalid-output');
  return output;
}
export const messageHeadsCodecs = Object.freeze({
  request: { mode: 'strict', typeSymbol: 'CompanionMessageHeadsRequest', create: () => ({ parse: parseMessageHeadsRequest }) },
  output: { mode: 'strict', typeSymbol: 'CompanionMessageHeadsOutput', create: () => ({ parse: parseMessageHeadsOutput }) },
});
