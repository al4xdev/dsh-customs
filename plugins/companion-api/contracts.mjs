import { resolveHost } from '../common.mjs';
const { RemoteError } = await import(resolveHost('@deepseek-ai/dsh-typert-protocol'));

export const MAX_BYTES = 32 * 1024;
export const MIN_BYTES = 1024;
export const MAX_SNAPSHOTS = 4096;
export const MAX_TITLE = 240;
export const SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/;
const CURSOR = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const messages = Object.freeze({
  'invalid-request': 'Invalid companion catalog request.',
  'invalid-output': 'Invalid companion catalog response.',
  'invalid-cursor': 'Companion catalog cursor is invalid or belongs to another instance.',
  'cursor-stale': 'Companion catalog membership changed; restart listing.',
  'catalog-limit': 'Companion catalog metadata exceeds the observation budget.',
  'catalog-ambiguous': 'Companion catalog contains ambiguous session identities.',
  'metadata-unavailable': 'Companion catalog metadata is unavailable.',
  'foreign-session': 'The requested session is not a verified companion chat.',
  'profile-mismatch': 'Companion catalog is available only in the companion backend profile.',
});
export function refusal(code) { return new RemoteError(`companion/${code}`, messages[code] ?? 'Companion catalog request refused.', {}); }
function plain(value) { return typeof value === 'object' && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function fields(value, allowed, code) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) throw refusal(code);
}
function timestamp(value) { return Number.isSafeInteger(value) && value >= 0; }
export function validCursor(value) { return typeof value === 'string' && value.length <= 2048 && CURSOR.test(value); }
export function parseListRequest(value) {
  fields(value, ['limit', 'cursor'], 'invalid-request');
  const limit = Object.hasOwn(value, 'limit') ? value.limit : 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw refusal('invalid-request');
  if (Object.hasOwn(value, 'cursor') && !validCursor(value.cursor)) throw refusal('invalid-request');
  return { limit, ...(Object.hasOwn(value, 'cursor') ? { cursor: value.cursor } : {}) };
}
export function parseDetailRequest(value) {
  fields(value, ['id'], 'invalid-request');
  if (!Object.hasOwn(value, 'id') || typeof value.id !== 'string' || !SESSION_ID.test(value.id)) throw refusal('invalid-request');
  return { id: value.id };
}
/** Header alone grants membership. Optional display hints never grant it. */
export function companionMetadata(snapshot, hints) {
  const header = snapshot?.header;
  if (header?.agentPreset !== 'companion' || typeof header.id !== 'string' || !SESSION_ID.test(header.id)) return null;
  const row = { id: header.id };
  if (timestamp(header.createdAt)) row.createdAt = header.createdAt;
  if (typeof hints?.title === 'string') {
    const title = hints.title.replace(/\p{Cc}/gu, ' ').trim().slice(0, MAX_TITLE);
    if (title.length > 0) row.title = title;
  }
  if (timestamp(hints?.updatedAt)) row.updatedAt = hints.updatedAt;
  return row;
}
export function parseMetadata(value) {
  fields(value, ['id', 'title', 'createdAt', 'updatedAt'], 'invalid-output');
  if (!Object.hasOwn(value, 'id') || typeof value.id !== 'string' || !SESSION_ID.test(value.id)) throw refusal('invalid-output');
  if (Object.hasOwn(value, 'title') && (typeof value.title !== 'string' || value.title.length === 0 || value.title.length > MAX_TITLE || /\p{Cc}/u.test(value.title))) throw refusal('invalid-output');
  for (const key of ['createdAt', 'updatedAt']) if (Object.hasOwn(value, key) && !timestamp(value[key])) throw refusal('invalid-output');
  return { ...value };
}
export function parseListOutput(value) {
  fields(value, ['profile', 'chats', 'nextCursor'], 'invalid-output');
  if (value.profile !== 'companion' || !Array.isArray(value.chats) || value.chats.length > 100 || !(value.nextCursor === null || validCursor(value.nextCursor))) throw refusal('invalid-output');
  const chats = value.chats.map(parseMetadata);
  if (new Set(chats.map(row => row.id)).size !== chats.length) throw refusal('invalid-output');
  const result = { profile: 'companion', chats, nextCursor: value.nextCursor };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw refusal('invalid-output');
  return result;
}
export function parseDetailOutput(value) {
  fields(value, ['profile', 'chat'], 'invalid-output');
  if (value.profile !== 'companion') throw refusal('invalid-output');
  return { profile: 'companion', chat: parseMetadata(value.chat) };
}
export const codecs = Object.freeze({
  listRequest: { mode: 'strict', typeSymbol: 'CompanionListRequest', create: () => ({ parse: parseListRequest }) },
  detailRequest: { mode: 'strict', typeSymbol: 'CompanionDetailRequest', create: () => ({ parse: parseDetailRequest }) },
  listOutput: { mode: 'strict', typeSymbol: 'CompanionListOutput', create: () => ({ parse: parseListOutput }) },
  detailOutput: { mode: 'strict', typeSymbol: 'CompanionDetailOutput', create: () => ({ parse: parseDetailOutput }) },
});
