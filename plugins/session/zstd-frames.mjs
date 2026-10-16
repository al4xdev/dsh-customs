import { constants as bufferConstants } from 'node:buffer';
import { constants, createZstdDecompress, zstdDecompressSync } from 'node:zlib';

// The JSONL persistence SDK writes a CONCATENATED container: one independently
// decodable frame for the header and one per durable event batch. Node 25.7's
// zstd decoders (sync and streaming alike) stop after the first frame and
// silently drop the rest, so this mirrors the SDK reader instead: locate frame
// boundaries structurally, then decode every complete frame on its own.
const ZSTD_MAGIC = 0xfd2fb528;
const OVERSIZED_FRAME_SLACK = 1024 * 1024;

/**
 * Same structural walk as @deepseek-ai/dsh-session-persistence-jsonl
 * scanZstdFrames: no block is decompressed. Invalid structure throws; bytes of
 * an incomplete final frame are reported as `tornStart` for prefix recovery.
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  const torn = start => ({ frames, tornStart: start });
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return torn(start);
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return torn(start);
    const descriptor = buffer.readUInt8(offset++);
    if ((descriptor & 0x18) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6, singleSegment = (descriptor & 0x20) !== 0, checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const headerBytes = (singleSegment ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) + contentSizeBytes;
    if (buffer.length - offset < headerBytes) return torn(start);
    offset += headerBytes;
    for (;;) {
      if (buffer.length - offset < 3) return torn(start);
      const block = buffer.readUIntLE(offset, 3);
      offset += 3;
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      // RLE blocks carry one repeated byte regardless of their regenerated size.
      const payload = type === 1 ? 1 : block >>> 3;
      if (buffer.length - offset < payload) return torn(start);
      offset += payload;
      if (block & 1) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return torn(start);
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

// Streaming fallback used only when one frame (or a torn tail) would exceed
// the caller's remaining decode budget: it stops pulling output at `limit`
// instead of materializing a decompression bomb.
async function boundedPrefix(frame, limit, flush) {
  const stream = createZstdDecompress(flush ? { finishFlush: constants.ZSTD_e_flush } : {});
  const chunks = [];
  let size = 0;
  stream.end(frame);
  try {
    for await (const chunk of stream) {
      chunks.push(chunk); size += chunk.length;
      if (size >= limit) break;
    }
  } finally { stream.destroy(); }
  return Buffer.concat(chunks).subarray(0, limit);
}

function decodeOne(frame, allowance, flush) {
  const limit = Math.max(1, Math.min(allowance, bufferConstants.MAX_LENGTH));
  try {
    return zstdDecompressSync(frame, { maxOutputLength: limit, ...(flush ? { finishFlush: constants.ZSTD_e_flush } : {}) });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') return boundedPrefix(frame, limit, flush);
    if (flush) throw error;
    throw new Error('corrupt Zstandard session log: frame failed validation', { cause: error });
  }
}

/**
 * Decode an encoded byte stream frame by frame. `budget()` is the caller's
 * remaining plaintext allowance; one byte beyond it is produced so the caller
 * can tell an exhausted budget from an exact fit. `onTornTail` runs after the
 * recoverable prefix of an incomplete final frame (an active writer's tail).
 */
export async function* decodeZstdFrames(encoded, { budget, onTornTail, onBudgetExceeded = () => {} }) {
  // Growable buffer: appending by doubling keeps one huge single-frame file
  // linear instead of re-concatenating it on every 64 KiB read.
  let buffer = Buffer.alloc(0), length = 0;
  for await (const chunk of encoded) {
    if (length + chunk.length > buffer.length) {
      const next = Buffer.allocUnsafe(Math.max(buffer.length * 2, length + chunk.length, 64 * 1024));
      buffer.copy(next, 0, 0, length); buffer = next;
    }
    chunk.copy(buffer, length); length += chunk.length;
    const { frames } = scanZstdFrames(buffer.subarray(0, length));
    for (const { start, end } of frames) {
      const output = await decodeOne(buffer.subarray(start, end), budget() + 1, false);
      if (output.length) yield output;
    }
    if (frames.length) {
      // Keep only the incomplete frame bytes; overlapping Buffer.copy is a memmove.
      const consumed = frames.at(-1).end;
      buffer.copy(buffer, 0, consumed, length); length -= consumed;
    }
    // Zstd never shrinks data by more than its block framing, so an incomplete
    // frame already this far past the plaintext budget cannot fit in it: decode
    // its bounded prefix and stop, instead of buffering an unbounded frame.
    if (length > budget() + OVERSIZED_FRAME_SLACK) {
      const prefix = await decodeOne(buffer.subarray(0, length), budget() + 1, true);
      if (prefix.length) yield prefix;
      onBudgetExceeded();
      return;
    }
  }
  if (!length) return;
  // EOF inside a frame: recover what is decodable, like the SDK's torn-frame
  // reader. Truncation alone never throws in flush mode; corruption still does.
  const prefix = await decodeOne(buffer.subarray(0, length), budget() + 1, true);
  if (prefix.length) yield prefix;
  onTornTail();
}
