import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, symlinkSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { MockSink, MAX_EVENTS, eventId, validPayload } from './mock-sink.mjs';

function fixture() {
  mkdirSync('.dumps/tasks', { recursive: true });
  const root = mkdtempSync(resolve('.dumps/tasks/task99-unit-'));
  return { root, sink: new MockSink(root) };
}
function payload(n = 1) {
  const sessionId = `own-session-${n}`, goalId = `goal-own-${n}`, revision = 2;
  return { version: 1, eventId: eventId(sessionId, goalId, revision), goalId, revision, sessionId, phase: 'completed', timestamp: 1000 };
}

test('atomic persistent delivery, duplicate replay, separate revisions and restart retain exact IDs', () => {
  const { root, sink } = fixture();
  assert.equal(sink.deliver(payload()), true);
  for (let i = 0; i < 25; i++) assert.equal(new MockSink(root).deliver(payload()), false);
  assert.equal(sink.read().events.length, 1);
  const second = { ...payload(), revision: 3 }; second.eventId = eventId(second.sessionId, second.goalId, 3);
  assert.equal(sink.deliver(second), true);
  assert.equal(new MockSink(root).read().events.length, 2);
  assert.equal(lstatSync(sink.path).mode & 0o777, 0o600);
  assert.equal(lstatSync(sink.directory).mode & 0o777, 0o700);
});

test('bounded capacity fails closed without evicting old dedup identities', () => {
  const { sink } = fixture();
  for (let i = 1; i <= MAX_EVENTS; i++) sink.deliver(payload(i));
  const before = readFileSync(sink.path, 'utf8');
  assert.throws(() => sink.deliver(payload(MAX_EVENTS + 1)), /mock-capacity/);
  assert.equal(readFileSync(sink.path, 'utf8'), before);
  assert.equal(sink.deliver(payload(1)), false);
});

test('strict versioned minimal payload rejects private additions, unbounded IDs and malformed ref/event identities', () => {
  const { sink } = fixture();
  const candidates = [
    { ...payload(), objective: 'secret' }, { ...payload(), title: 'even optional titles are disabled' },
    { ...payload(), version: 2 }, { ...payload(), phase: 'complete' }, { ...payload(), revision: 1 },
    { ...payload(), sessionId: '../private' }, { ...payload(), goalId: 'a'.repeat(161) },
    { ...payload(), eventId: 'forged' }, { ...payload(), timestamp: NaN },
  ];
  for (const candidate of candidates) { assert.equal(Boolean(validPayload(candidate)), false); assert.throws(() => sink.deliver(candidate), /payload/); }
  assert.equal(sink.read().events.length, 0);
});

test('held lock/corrupt ledger fail closed and do not reset the durable ledger', () => {
  const { sink } = fixture();
  sink.deliver(payload());
  const before = readFileSync(sink.path, 'utf8');
  writeFileSync(`${sink.path}.lock`, 'own competing writer');
  assert.throws(() => sink.deliver(payload(2)), { code: 'EEXIST' });
  assert.equal(readFileSync(sink.path, 'utf8'), before);
  const corrupt = fixture().sink;
  writeFileSync(corrupt.path, '{bad-json');
  assert.throws(() => corrupt.deliver(payload()));
  assert.equal(readFileSync(corrupt.path, 'utf8'), '{bad-json');
});

test('reject symlinked sink directories and ledger leaves rather than following into foreign state', () => {
  const { root, sink } = fixture();
  const foreign = join(root, 'foreign'); writeFileSync(foreign, 'own foreign fixture');
  symlinkSync(foreign, sink.path);
  assert.throws(() => sink.deliver(payload()), { code: 'ELOOP' });
  assert.equal(readFileSync(foreign, 'utf8'), 'own foreign fixture');
  const other = mkdtempSync(resolve('.dumps/tasks/task99-linked-'));
  symlinkSync(sink.directory, join(other, 'companion-notifications'));
  assert.throws(() => new MockSink(other), /directory-invalid/);
});
