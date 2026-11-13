import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ToolResultClearing, { MARKER } from './index.mjs';

// A session the size of the real API surface the pruner touches: an event log, the surface
// node list, message derivation, and replay-style appends with surface replacement.
function fakeSession(id = 'sess-1') {
  const log = [], nodes = [];
  const session = {
    id, log,
    surface: { nodes },
    eventAt: seq => log[seq],
    deriveEventMessage: event => event.data.message,
    append(type, data, options = {}) {
      const event = { seq: log.length, type, time: session.clock, data };
      log.push(event);
      const op = options.surfaceOp;
      if (op?.op === 'replace') nodes.splice(nodes.indexOf(op.startSeq), 1, event.seq);
      else if (type !== 'compaction/prune') nodes.push(event.seq);
      return event;
    },
    clock: 1_000_000,
  };
  return session;
}
let callNo = 0;
function call(session, name, text, extra = []) {
  const id = `call-${++callNo}`;
  session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id, name, arguments: '{}' }] } });
  session.append('tool/result', { message: { role: 'tool', toolCallId: id, source: { kind: 'tool', callId: id }, content: [{ type: 'text', text }, ...extra] } });
  return id;
}
function service(config = {}) {
  const listeners = new Map();
  const ctx = {
    reflect: { provide() {} },
    on(event, listener, prepend) { listeners.set(event, { listener, prepend }); },
    logger: { info() {}, warn() {} },
    tokenMeter: { estimateMessage: m => Math.ceil(m.content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 100), 0) / 4) + 4 },
  };
  const dir = mkdtempSync(join(tmpdir(), 'trc-test-'));
  const pruner = new ToolResultClearing(ctx, { clearAtLeastTokens: 1000, keepRecent: 2, dir, ...config });
  return { pruner, listeners, dir };
}
const resultTexts = session => session.surface.nodes.map(seq => session.eventAt(seq)).filter(e => e.type === 'tool/result').map(e => e.data.message.content[0].text);

test('keeps the newest results whole and clears older clearable ones to a saved file', () => {
  const { pruner, dir } = service();
  const session = fakeSession();
  const big = n => `${n}:`.padEnd(3000, 'x');
  call(session, 'read', big('r1'));
  call(session, 'subagent', big('child'));        // a child's work is never cleared
  call(session, 'bash', big('b1'), [{ type: 'image', attachment: { id: 'img' } }]);
  call(session, 'grep', big('g1'));
  call(session, 'bash', big('b2'));
  call(session, 'read', big('r2'));
  const outcome = pruner.pruneSession(session);
  const texts = resultTexts(session);
  assert.ok(texts[0].startsWith(MARKER) && texts[2].startsWith(MARKER) && texts[3].startsWith(MARKER));
  assert.equal(texts[1], big('child'));
  // The two newest clearable results stay; their size is under the trim threshold too.
  assert.equal(texts[4], big('b2'));
  assert.equal(texts[5], big('r2'));
  assert.equal(outcome.pruned.length, 0);
  // Non-text blocks survive the clearing; the marker points at the saved original.
  const cleared = session.eventAt(session.surface.nodes[5]).data.message.content;
  assert.deepEqual(cleared[1], { type: 'image', attachment: { id: 'img' } });
  const path = texts[0].match(/: (\/\S+)\]$/)[1];
  assert.ok(path.startsWith(dir));
  assert.equal(readFileSync(path, 'utf8'), big('r1'));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // Each replacement is preceded by a shadow-price event, as the stock pruner does.
  assert.equal(session.log.filter(e => e.type === 'compaction/prune').length, 3);
});

test('below the minimum saving nothing is cleared, and stock trimming still applies', () => {
  const { pruner } = service({ clearAtLeastTokens: 1_000_000, thresholdChars: 8192 });
  const session = fakeSession();
  call(session, 'read', 'small old result '.repeat(20));
  call(session, 'bash', 'y'.repeat(20000));
  call(session, 'bash', 'z'.repeat(100));
  call(session, 'bash', 'w'.repeat(100));
  const outcome = pruner.pruneSession(session);
  const texts = resultTexts(session);
  assert.equal(texts[0], 'small old result '.repeat(20));
  assert.equal(outcome.pruned.length, 1);
  assert.match(texts[1], /tool result middle pruned/);
});

test('clearing is idempotent: cleared markers are not cleared or counted again', () => {
  const { pruner } = service();
  const session = fakeSession();
  for (let i = 0; i < 5; i++) call(session, 'bash', `${i}`.padEnd(5000, 'x'));
  assert.ok(pruner.clearOld(session));
  const before = session.log.length;
  assert.equal(pruner.clearOld(session), null);
  assert.equal(session.log.length, before);
});

test('the idle trigger clears only after the configured gap since the last reply', async () => {
  const { pruner, listeners } = service({ idleSeconds: 3900 });
  const session = fakeSession();
  for (let i = 0; i < 5; i++) call(session, 'read', `${i}`.padEnd(5000, 'x'));
  const { listener, prepend } = listeners.get('agent/pre-step');
  assert.equal(prepend, true);
  const step = () => listener({ agent: { session }, signal: new AbortController().signal }, async () => 'next');
  pruner.now = () => session.clock + 3000 * 1000;
  assert.equal(await step(), 'next');
  assert.ok(!resultTexts(session).some(t => t.startsWith(MARKER)));
  pruner.now = () => session.clock + 3901 * 1000;
  assert.equal(await step(), 'next');
  assert.equal(resultTexts(session).filter(t => t.startsWith(MARKER)).length, 3);
});

test('idleSeconds 0 registers no idle listener', () => {
  const { listeners } = service({ idleSeconds: 0 });
  assert.equal(listeners.has('agent/pre-step'), false);
});

test('a result whose file cannot be saved is left untouched', () => {
  // A directory below a regular file can never be created (ENOTDIR).
  const blocker = join(mkdtempSync(join(tmpdir(), 'trc-block-')), 'file');
  writeFileSync(blocker, '');
  const { pruner } = service({ dir: join(blocker, 'sub') });
  const session = fakeSession();
  for (let i = 0; i < 5; i++) call(session, 'bash', `${i}`.padEnd(5000, 'x'));
  assert.equal(pruner.clearOld(session), null);
  assert.ok(!resultTexts(session).some(t => t.startsWith(MARKER)));
});
