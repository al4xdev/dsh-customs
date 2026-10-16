import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadSide } from './read-side.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function ctxFor(header, events, root = '/authored/budget') {
  return { sessionPersistence: { name: 'session-persistence-jsonl', identity: Symbol(), config: { root, compression: 'none' }, stat: async id => id === header.id ? { header, revision: 'r', sizeBytes: 10 } : undefined, list: async () => [{ header, revision: 'r', sizeBytes: 10 }], open: async (_, access) => { assert.equal(access, 'read'); return { header, read: async (offset, length) => ({ events: events.slice(offset, offset + length) }), close: async () => {} }; } }, sessions: { get: () => undefined, list: () => [] } };
}
const exec = { signal: new AbortController().signal };

test('1KiB read pages preserve terminal/polling identity and advance oversized Unicode previews', async () => {
  const header = { id: 'fixture', version: 4, createdAt: 1, cwd: '/authored/budget', isSeeded: false };
  const events = Array.from({ length: 3 }, (_, seq) => ({ seq, time: seq, type: 'user/message', data: { content: [{ type: 'text', text: '😀'.repeat(2000) }] } }));
  const api = createReadSide(ctxFor(header, events));
  const sourceId = api.locator.source().sourceId;
  let cursor, pages = 0, seen = [];
  do {
    const result = await api.execute({ operation: 'read', sourceId, sessionId: header.id, maxBytes: 1024, ...(cursor ? { cursor } : {}) }, exec);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
    assert.ok(result.pollingCursor); assert.equal(result.events.length, 1);
    assert.equal(result.events[0].omitted, 'row exceeds byte budget');
    seen.push(result.events[0].seq); cursor = result.nextCursor; assert.ok(++pages < 5);
  } while (cursor);
  assert.deepEqual(seen, [0, 1, 2]);
});

test('near4096 UTF8 physical paths retain pathRef and progress instead of repeating an oversized row', async () => {
  await mkdir('.dumps/session-tests', { recursive: true });
  let root = await mkdtemp(join(process.cwd(), '.dumps/session-tests/long-path-'));
  for (let i = 0; i < 18; i++) root = join(root, 'x'.repeat(180));
  const project = join(root, '--actual-project--'), directory = join(project, 'fixture');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'session.v4.jsonl'), 'authored marker; body never read');
  const header = { id: 'fixture', version: 4, createdAt: 1, cwd: '/actual/project', isSeeded: false };
  const api = createReadSide(ctxFor(header, [], root));
  const page = await api.execute({ operation: 'paths', directory: project, maxBytes: 1024 }, exec);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1024); assert.equal(page.nextCursor, null);
  assert.equal(page.paths.length, 1); assert.ok(page.paths[0].pathRef); assert.equal(page.paths[0].omitted, 'row exceeds byte budget');
  const context = await api.execute({ operation: 'context', pathRef: page.paths[0].pathRef }, exec);
  assert.equal(context.sessionId, header.id);
});

test('head is anchored to proven user input instead of preceding injected user-role instructions', async () => {
  const header = { id: 'fixture', version: 4, createdAt: 1, cwd: '/project', isSeeded: false };
  const events = [{ seq: 0, time: 0, type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'synthetic AGENTS context' }] } }, { seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'actual original owner request' }] } }];
  const api = createReadSide(ctxFor(header, events));
  const result = await api.execute({ operation: 'context', sessionId: 'fixture', anchor: 'head', before: 0, after: 1 }, exec);
  assert.equal(result.originalRequestConfirmed, true); assert.equal(result.events[0].seq, 1);
});
