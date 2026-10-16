import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, zstdCompressSync } from 'node:zlib';
import { decodeZstdFrames, scanZstdFrames } from './zstd-frames.mjs';

const checksummed = text => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
async function* chunks(buffer, size) { for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size); }
async function decode(buffer, { size = 7, budget = Infinity } = {}) {
  let torn = 0, total = 0; const out = [];
  for await (const part of decodeZstdFrames(chunks(buffer, size), { budget: () => budget - total, onTornTail: () => { torn++; } })) { out.push(part); total += part.length; }
  return { text: Buffer.concat(out).toString(), torn };
}

test('every frame of a concatenated container is decoded, across arbitrary read boundaries', async () => {
  const rows = Array.from({ length: 40 }, (_, n) => `{"seq":${n}}\n`);
  // Mixed checksum flags, an RLE-friendly frame and an empty frame, like real SDK batches.
  const file = Buffer.concat([...rows.map((row, n) => n % 2 ? checksummed(row) : zstdCompressSync(Buffer.from(row))), zstdCompressSync(Buffer.from('z'.repeat(70_000) + '\n')), zstdCompressSync(Buffer.alloc(0))]);
  assert.equal(scanZstdFrames(file).frames.length, 42); assert.equal(scanZstdFrames(file).tornStart, undefined);
  for (const size of [1, 7, 65536, file.length]) {
    const { text, torn } = await decode(file, { size });
    assert.equal(text, rows.join('') + 'z'.repeat(70_000) + '\n'); assert.equal(torn, 0);
  }
});

test('a torn final frame yields its recoverable prefix and reports the tail once', async () => {
  const head = checksummed('{"type":"session"}\n'), tail = checksummed('x'.repeat(5000) + '\n');
  for (const cut of [1, 3, 4, 9, tail.length - 4, tail.length - 1]) {
    const file = Buffer.concat([head, tail.subarray(0, cut)]);
    assert.equal(scanZstdFrames(file).tornStart, head.length);
    const { text, torn } = await decode(file);
    assert.ok(text.startsWith('{"type":"session"}\n')); assert.equal(torn, 1);
  }
});

test('structural corruption and invalid frames are errors, not partial reads', async () => {
  const good = zstdCompressSync(Buffer.from('ok\n'));
  assert.throws(() => scanZstdFrames(Buffer.from('not zstd')), /invalid frame magic/);
  assert.throws(() => scanZstdFrames(Buffer.concat([good, Buffer.from('garbage!')])), /invalid frame magic/);
  const flipped = Buffer.from(checksummed('payload that has a checksum\n')); flipped[flipped.length - 1] ^= 0xff;
  await assert.rejects(decode(flipped), /corrupt Zstandard/);
});

test('the decode budget bounds a decompression bomb to one byte past the allowance', async () => {
  const bomb = zstdCompressSync(Buffer.alloc(8 * 1024 * 1024, 0x61));
  const { text } = await decode(Buffer.concat([zstdCompressSync(Buffer.from('first\n')), bomb]), { budget: 1000 });
  assert.equal(text.length, 1001); assert.ok(text.startsWith('first\n'));
});

test('an incomplete frame that cannot fit the budget is never buffered whole', async () => {
  const { randomBytes } = await import('node:crypto');
  const huge = zstdCompressSync(randomBytes(4 * 1024 * 1024)); // incompressible: ~4 MiB on disk
  let exceeded = 0, total = 0, peak = 0;
  async function* reads() { for (let offset = 0; offset < huge.length; offset += 65536) { peak = offset; yield huge.subarray(offset, offset + 65536); } }
  for await (const part of decodeZstdFrames(reads(), { budget: () => 512 * 1024 - total, onTornTail: () => assert.fail('not a torn tail'), onBudgetExceeded: () => { exceeded++; } })) total += part.length;
  assert.equal(exceeded, 1); assert.ok(total <= 512 * 1024 + 1);
  assert.ok(peak < 512 * 1024 + 2 * 1024 * 1024, `stopped reading early (${peak})`);
});
