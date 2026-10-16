import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reserveReceipt } from './resume-client.mjs';

test('checkpoint receipt is exclusive until a proven no-effect failure frees it, once', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-receipt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const receipt = path.join(dir, 'checkpoint.json');
  await reserveReceipt(receipt, { requestId: 'first', state: 'reserved' });
  for (const state of ['reserved', 'launching', 'admitted', 'unknown']) {
    await fs.writeFile(receipt, JSON.stringify({ requestId: 'first', state }));
    await assert.rejects(reserveReceipt(receipt, { requestId: 'second', state: 'reserved' }), { code: 'EEXIST' });
  }
  await fs.writeFile(receipt, JSON.stringify({ requestId: 'first', state: 'failed-none' }));
  // Two concurrent fresh attempts: exactly one claims the freed checkpoint.
  const results = await Promise.allSettled(['a', 'b'].map(requestId => reserveReceipt(receipt, { requestId, state: 'reserved' })));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'EEXIST');
  assert.equal(JSON.parse(await fs.readFile(receipt, 'utf8')).state, 'reserved');
  const history = (await fs.readdir(dir)).filter(name => name.startsWith('checkpoint.json.failed-'));
  assert.equal(history.length, 1, 'the failed-none attempt is kept as history');
});

test('reclaiming a failed-none checkpoint has exactly one winner under contention', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-receipt-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (let round = 0; round < 60; round++) {
    const receipt = path.join(dir, `checkpoint-${round}.json`);
    await fs.writeFile(receipt, JSON.stringify({ requestId: `failed-${round}`, state: 'failed-none' }));
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => reserveReceipt(receipt, { requestId: `r${round}-${index}`, state: 'reserved' })));
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1, `round ${round}`);
    const winner = JSON.parse(await fs.readFile(receipt, 'utf8'));
    assert.equal(winner.state, 'reserved');
  }
});
