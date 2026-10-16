import { isAbsolute } from 'node:path';

export const READ_OPERATIONS = ['sources', 'describe', 'paths', 'search', 'context'];
export const READ_LIMITS = Object.freeze({ candidates: 8, maxCandidates: 64, events: 20000, bytes: 8 * 1024 * 1024, durationMs: 2000, entries: 20000, cuts: 3, cutBytes: 16 * 1024 * 1024, refs: 1024, searchStates: 512, searchStateBytes: 4 * 1024 * 1024, searchStateMaxBytes: 32768, ttlMs: 60000 });
const string = description => ({ type: 'string', description });
const integer = description => ({ type: 'integer', description });
const paging = { cursor: string('Opaque continuation, bound to this source, filters and cut. nextCursor is null at completion.'), limit: integer('Rows/messages, default 32, maximum 100.'), maxBytes: integer('UTF-8 JSON output budget: 1024..32768, default 8192.') };
const source = { sourceId: string('Identity returned by sources; changes when the public persistence service/configuration changes.'), pathRef: string('Opaque reference returned by paths; a locator, never a grant.') };
const filters = { project: string('Exact original header cwd, before display redaction.'), projectPrefix: string('Absolute cwd component prefix: /a includes /a/x, not /ab.'), directory: string('Absolute physical directory within the configured persistence root. Symlinks/ambiguous layouts are refused.') };
const target = { ...source, sessionId: string('Native logical session id; not a raw filesystem segment.') };
const text = { textOffset: integer('Offset in redacted message text.'), textLimit: integer('Redacted message characters: 1..4096, default 512.') };
const budgets = { candidateBudget: integer('Candidates inspected per call: 1..64, default 8.'), scanBytes: integer('Retained/redacted event byte budget: 1024..8388608. Not a decompressor/RAM limit.'), scanEvents: integer('Logical events inspected: 1..20000.'), durationMs: integer('Cooperative time budget: 1..2000ms; cannot interrupt a synchronous native call.') };
export const READ_SCHEMAS = Object.freeze({
  describe: { targetOperation: string('Operation whose exact parameters and semantics should be described.') },
  sources: { ...paging },
  paths: { ...target, ...filters, ...paging },
  list: { ...source, ...filters, ...paging, state: { type: 'string', enum: ['alive', 'ended', 'waiting', 'unknown'] }, writer: { type: 'string', enum: ['held', 'not-observed', 'unknown'] } },
  search: { ...target, ...filters, ...paging, ...budgets, query: string('Literal text, maximum 512 Unicode code points; never SQL or executable FTS syntax.'), mode: { type: 'string', enum: ['phrase', 'substring'], description: 'phrase: token phrase candidates when managed SQLite is enabled; substring: literal whitespace-flexible scan. Defaults to phrase.' }, types: { type: 'array', items: { type: 'string', enum: ['user/message', 'assistant/message'] }, description: 'Only authorized message-text types, never tool arguments/results.' }, surface: { type: 'string', enum: ['current', 'shadowed', 'log-only'] }, fromTime: integer('Inclusive event timestamp lower bound.'), toTime: integer('Inclusive event timestamp upper bound.') },
  context: { ...target, ...filters, ...paging, ...text, ...budgets, anchor: { type: 'string', enum: ['head', 'tail', 'seq', 'both'], description: 'Defaults to both: original head and recent tail are separate windows, message-aligned.' }, seq: integer('Exact logical event anchor for anchor:seq.'), before: integer('Preceding messages: 0..50, default 6.'), after: integer('Following messages: 0..50, default 6.') },
  read: { ...target, ...filters, ...paging, ...text, ...budgets, offset: integer('Zero-based logical event offset, not a physical line.'), revision: string('Previous cut revision for polling; not combined with offset.'), pollingCursor: string('Separate append-safe watermark; only this field requests a fresh source cut.') },
});
export function readError(code, reason = code) { return Object.assign(new Error(reason), { code, sessionReadError: true }); }
export function validReadId(id) { return typeof id === 'string' && id.length > 0 && Buffer.byteLength(id) <= 4096 && !/[\0\r\n]/.test(id); }
export function usesReadRouter(args) { return READ_OPERATIONS.includes(args?.operation) || args?.operation === 'read' && args.project !== undefined || ['list', 'read'].includes(args?.operation) && ['sourceId', 'pathRef', 'projectPrefix', 'directory', 'pollingCursor', 'candidateBudget', 'scanBytes', 'scanEvents', 'durationMs'].some(key => args[key] !== undefined); }
export function parseReadRequest(input) {
  const schema = READ_SCHEMAS[input?.operation];
  if (!schema || !input || typeof input !== 'object' || Array.isArray(input)) throw readError('invalid_argument');
  for (const key of Object.keys(input)) if (key !== 'operation' && !Object.hasOwn(schema, key)) throw readError('invalid_argument', `unexpected argument: ${key}`);
  for (const [key, value] of Object.entries(input)) {
    if (key === 'operation' || value === undefined) continue;
    const field = schema[key];
    if (field.type === 'string' && (typeof value !== 'string' || !value.length || /[\0\r\n]/.test(value) || Buffer.byteLength(value) > (key === 'cursor' || key === 'pollingCursor' ? 2048 : 4096))) throw readError('invalid_argument', `invalid ${key}`);
    if (field.type === 'integer' && (!Number.isSafeInteger(value) || value < 0)) throw readError('invalid_argument', `invalid ${key}`);
    if (field.enum && !field.enum.includes(value)) throw readError('invalid_argument', `invalid ${key}`);
  }
  for (const key of ['project', 'projectPrefix', 'directory']) if (input[key] !== undefined && !isAbsolute(input[key])) throw readError('invalid_argument', `${key} must be absolute`);
  if (input.sessionId !== undefined && !validReadId(input.sessionId)) throw readError('invalid_argument', 'invalid sessionId');
  if (['read', 'context'].includes(input.operation) && input.sessionId === undefined && input.pathRef === undefined) throw readError('invalid_argument', 'sessionId or session pathRef required');
  if (input.sessionId !== undefined && input.pathRef !== undefined) throw readError('invalid_argument', 'choose sessionId or pathRef');
  if (input.operation === 'describe' && !Object.hasOwn(READ_SCHEMAS, input.targetOperation)) throw readError('unknown_operation');
  if (input.operation === 'search') {
    if (typeof input.query !== 'string' || !input.query.trim() || Array.from(input.query).length > 512) throw readError('invalid_argument', 'query must contain 1..512 code points');
    if (input.types !== undefined && (!Array.isArray(input.types) || !input.types.length || input.types.length > 2 || input.types.some(type => !['user/message', 'assistant/message'].includes(type)))) throw readError('invalid_argument', 'invalid types');
    if (input.fromTime !== undefined && input.toTime !== undefined && input.fromTime > input.toTime) throw readError('invalid_argument', 'invalid time interval');
  }
  if (input.anchor === 'seq' && input.seq === undefined || input.seq !== undefined && input.anchor !== 'seq') throw readError('invalid_argument', 'seq requires anchor:seq');
  if (input.offset !== undefined && (input.cursor !== undefined || input.revision !== undefined || input.pollingCursor !== undefined)) throw readError('invalid_argument', 'offset cannot be combined with cursor/revision/pollingCursor');
  if (input.cursor !== undefined && input.pollingCursor !== undefined) throw readError('invalid_argument', 'choose continuation or polling');
  const out = { ...input, limit: input.limit ?? 32, maxBytes: input.maxBytes ?? 8192, textLimit: input.textLimit ?? 512, textOffset: input.textOffset ?? 0, candidateBudget: input.candidateBudget ?? READ_LIMITS.candidates, scanBytes: input.scanBytes ?? READ_LIMITS.bytes, scanEvents: input.scanEvents ?? READ_LIMITS.events, durationMs: input.durationMs ?? READ_LIMITS.durationMs };
  for (const [key, min, max] of [['limit', 1, 100], ['maxBytes', 1024, 32768], ['textLimit', 1, 4096], ['candidateBudget', 1, 64], ['scanBytes', 1024, READ_LIMITS.bytes], ['scanEvents', 1, READ_LIMITS.events], ['durationMs', 1, READ_LIMITS.durationMs], ['before', 0, 50], ['after', 0, 50]]) if (out[key] !== undefined && (out[key] < min || out[key] > max)) throw readError('invalid_argument', `${key} must be ${min}..${max}`);
  return out;
}
