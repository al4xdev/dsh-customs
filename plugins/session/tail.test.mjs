import test from 'node:test';
import assert from 'node:assert/strict';
import { persistedEventCount } from './tail.mjs';

test('physical tail probes tolerate synthetic query closers and stale/undurable watermark hints', async () => {
  for (const count of [0, 1, 2, 70, 50000]) {
    for (const hint of [undefined, 1, count + 3, count + 10000]) {
      let probes = 0;
      const handle = { read: async (offset, length) => { assert.equal(length, 1); probes++; return { events: offset < count ? [{ seq: offset }] : [] }; } };
      assert.equal(await persistedEventCount(handle, hint, new AbortController().signal), count);
      assert.ok(probes < 50);
    }
  }
});
test('physical tail probes observe cancellation before backend work', async () => {
  const ac = new AbortController(); ac.abort(); let read = false;
  await assert.rejects(persistedEventCount({ read: async () => { read = true; return { events: [] }; } }, 100, ac.signal));
  assert.equal(read, false);
});
