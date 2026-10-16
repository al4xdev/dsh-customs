#!/usr/bin/env node
// READ-ONLY scanner for session logs whose llm/retry / llm/retry-started rows
// break the native v4 session-format relationship (owner6 reused one chain-wide
// retryId/ordinal across turns/steps, so such logs fail to reopen with
// "llm/retry skips its policy attempt sequence"). It opens files for reading
// only, never repairs, and prints session ids, paths, fixed rule names and
// event sequence numbers — never event contents.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xFD2FB528;
const LOG_NAME = /^session\.v4\.jsonl(\.zstd)?$/;
const MAX_DEPTH = 6;
const RELEVANT = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'request/header', 'llm/retry', 'llm/retry-started', 'agent/self-heal']);

/** Structural Zstandard frame ranges, like the SDK backend's own scanner: Node's
 * one-shot decoder only returns the FIRST frame of a concatenated buffer. A torn
 * final frame is reported, not decoded. */
export function zstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  const torn = start => ({ frames, tornStart: start });
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 5) return torn(start);
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`);
    offset += 4;
    const descriptor = buffer.readUInt8(offset++);
    if ((descriptor & 24) !== 0) throw new Error(`reserved zstd frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6, singleSegment = (descriptor & 32) !== 0, checksum = (descriptor & 4) !== 0;
    const dictionaryBytes = (descriptor & 3) === 3 ? 4 : descriptor & 3;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const header = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < header) return torn(start);
    offset += header;
    for (;;) {
      if (buffer.length - offset < 3) return torn(start);
      const block = buffer.readUIntLE(offset, 3);
      offset += 3;
      const type = (block >>> 1) & 3, size = block >>> 3;
      if (type === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`);
      const payload = type === 1 ? 1 : size;
      if (buffer.length - offset < payload) return torn(start);
      offset += payload;
      if (block & 1) break;
    }
    if (checksum) { if (buffer.length - offset < 4) return torn(start); offset += 4; }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** Yield complete JSONL lines of one log, decompressing zstd frame by frame. */
function* logLines(path) {
  const bytes = readFileSync(path);
  let pending = '';
  const chunks = path.endsWith('.zstd') ? (function* () {
    const { frames, tornStart } = zstdFrames(bytes);
    for (const frame of frames) yield zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8');
    if (tornStart !== undefined) yield null;
  })() : [bytes.toString('utf8')];
  for (const chunk of chunks) {
    if (chunk === null) { yield { torn: true }; continue; }
    const text = pending + chunk;
    const lines = text.split('\n');
    pending = lines.pop();
    for (const line of lines) if (line) yield { line };
  }
  // A final record without a newline is a torn tail, as in the SDK reader.
  if (pending) yield { torn: true };
}

const typeOf = line => { const match = /^\{"type":"([^"\\]{1,64})"/.exec(line); return match?.[1]; };

/** Replay only the native v4 retry relationship rules; first violation wins. */
export function scanLog(path) {
  let header, turn = null, step = null, nextStep = 1, provider, torn = false, retryRows = 0, violation, ownerV2 = false;
  const retries = [], started = new Set();
  for (const item of logLines(path)) {
    if (item.torn) { torn = true; continue; }
    if (header === undefined) {
      try { header = JSON.parse(item.line); } catch { return { path, unreadable: 'invalid-header' }; }
      continue;
    }
    const type = typeOf(item.line);
    if (!RELEVANT.has(type) || (violation && (ownerV2 || type !== 'agent/self-heal'))) continue;
    let event;
    try { event = JSON.parse(item.line); } catch { return { path, id: header?.id, unreadable: 'invalid-event-row' }; }
    const data = event.data ?? {}, fail = rule => { violation = { rule, seq: event.seq }; };
    // Payload-v2 owner audits (owner7) make a rollback to owner6 unsafe.
    if (type === 'agent/self-heal') { if (data.version === 2) ownerV2 = true; continue; }
    if (type === 'turn/start') { turn = data.turn; nextStep = 1; step = null; }
    else if (type === 'turn/end') { turn = null; step = null; }
    else if (type === 'step/start') step = data.step;
    else if (type === 'step/end') { step = null; nextStep += 1; }
    else if (type === 'request/header') provider = data.header?.config?.provider;
    else if (type === 'llm/retry') {
      retryRows++;
      const prior = retries.findLast(row => row.turn === data.turn && row.step === data.step && row.provider === data.provider && row.policyKey === data.policyKey);
      if (turn === null || data.turn !== turn || data.step !== (step ?? nextStep - 1)) fail('retry-outside-current-step');
      else if (provider !== undefined && data.provider !== provider) fail('retry-provider-mismatch');
      else if (data.retry !== (prior === undefined ? 1 : prior.retry + 1)) fail('retry-skips-attempt-sequence');
      else if (prior === undefined ? retries.some(row => row.retryId === data.retryId) : prior.retryId !== data.retryId) fail('retry-id-reused-across-chains');
      retries.push(data);
    } else if (type === 'llm/retry-started') {
      const scheduled = retries.find(row => row.retryId === data.retryId && row.retry === data.retry);
      const key = JSON.stringify([data.retryId, data.retry]);
      if (!scheduled) fail('retry-started-unpaired');
      else if (scheduled.turn !== data.turn || scheduled.step !== data.step) fail('retry-started-moved');
      else if (started.has(key)) fail('retry-started-repeated');
      started.add(key);
    }
  }
  return { path, id: typeof header?.id === 'string' ? header.id : undefined, retryRows, torn, ownerV2, ...(violation ? { violation } : {}) };
}

function* logFiles(root, depth = 0) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow links out of the sessions tree
    if (entry.isDirectory() && depth < MAX_DEPTH) yield* logFiles(path, depth + 1);
    else if (entry.isFile() && LOG_NAME.test(entry.name)) yield path;
  }
}

export function scanSessions({ dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh') } = {}) {
  if (!isAbsolute(dshHome)) throw new TypeError('dshHome must be absolute');
  const root = join(dshHome, 'sessions');
  const broken = [], unreadable = [], ownerV2 = [];
  let scanned = 0, withRetries = 0;
  try { if (!lstatSync(root).isDirectory()) throw new Error(); } catch { return { schema: 1, kind: 'retry-ordinal-scan', root, scanned, withRetries, broken, ownerV2, unreadable, contentsPrinted: false }; }
  for (const path of logFiles(root)) {
    scanned++;
    let result;
    try { result = scanLog(path); } catch { unreadable.push({ path, reason: 'decode-failed' }); continue; }
    if (result.unreadable) { unreadable.push({ path, reason: result.unreadable }); continue; }
    if (result.retryRows) withRetries++;
    if (result.ownerV2) ownerV2.push({ id: result.id, path });
    if (result.violation) broken.push({ id: result.id, path, rule: result.violation.rule, seq: result.violation.seq, ...(result.torn ? { tornTail: true } : {}) });
  }
  // ownerV2: sessions already written by owner7 (payload-v2 audits); owner6
  // refuses them, so a rollback is unsafe for exactly these sessions.
  return { schema: 1, kind: 'retry-ordinal-scan', root, scanned, withRetries, broken, ownerV2, unreadable, contentsPrinted: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) { console.log('Usage: node tools/resilience/scan-retry-ordinals.mjs [--dsh-home ABS]\nRead-only: lists session logs whose llm/retry ordinals break the v4 rule, and sessions holding owner7\npayload-v2 audits (rollback-unsafe). Ids/paths/rule names/seq numbers only; no repair.'); process.exit(0); }
    if (args.length && (args.length !== 2 || args[0] !== '--dsh-home')) throw new Error('Unknown option; use --dsh-home ABS');
    const report = scanSessions(args.length ? { dshHome: resolve(args[1]) } : {});
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.broken.length ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
