// A Snappy raw-block COMPRESSOR, the counterpart of src/ccd-leveldb.ts's
// decompressor. The harness needs it to write a Claude Desktop leveldb .ldb
// fixture whose data blocks are Snappy-compressed the way Chromium writes
// them, so the client's own decoder (and later hx2's) is exercised on real
// compressed bytes rather than on a plaintext .log alone.
//
// Format (the raw block format, not the framed stream): a varint preamble
// with the uncompressed length, then a sequence of elements:
//   literal  tag & 3 == 0, length-1 in the upper 6 bits, or 60..63 with
//            1..4 little-endian extra length bytes;
//   copy-1   tag & 3 == 1, length 4..11, offset < 2048 (3 bits in the tag
//            plus one byte);
//   copy-2   tag & 3 == 2, length 1..64, 16-bit little-endian offset;
//   copy-4   tag & 3 == 3, length 1..64, 32-bit little-endian offset.
//
// Greedy hash-table matching is enough: the fixture only has to be valid
// Snappy that uses every element kind, and the round trip is pinned by a
// test against the client's decoder.

const HASH_BITS = 14;
const MIN_MATCH = 4;
const MAX_COPY_LEN = 64;

export function snappyCompress(input: Buffer): Buffer {
  const out: number[] = [];
  writeVarint(out, input.length);
  const n = input.length;
  if (n === 0) return Buffer.from(out);

  const table = new Int32Array(1 << HASH_BITS).fill(-1);
  let ip = 0;
  let literalStart = 0;
  const hashAt = (i: number): number => {
    const v = input.readUInt32LE(i);
    return Math.imul(v, 0x1e35a7bd) >>> (32 - HASH_BITS);
  };

  while (ip + MIN_MATCH <= n) {
    const h = hashAt(ip);
    const candidate = table[h]!;
    table[h] = ip;
    if (
      candidate >= 0 &&
      ip - candidate < 2 ** 31 &&
      input.readUInt32LE(candidate) === input.readUInt32LE(ip)
    ) {
      // Extend the match forward.
      let len = MIN_MATCH;
      while (ip + len < n && input[candidate + len] === input[ip + len]) len++;
      if (literalStart < ip) emitLiteral(out, input, literalStart, ip);
      emitCopy(out, ip - candidate, len);
      ip += len;
      literalStart = ip;
      continue;
    }
    ip++;
  }
  if (literalStart < n) emitLiteral(out, input, literalStart, n);
  return Buffer.from(out);
}

function writeVarint(out: number[], v: number): void {
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function emitLiteral(out: number[], input: Buffer, start: number, end: number): void {
  let len = end - start;
  let pos = start;
  // A literal element carries at most 2^32 bytes; we split at 2^16 for simplicity.
  while (len > 0) {
    const take = Math.min(len, 65536);
    const n = take - 1;
    if (n < 60) {
      out.push(n << 2);
    } else if (n < 256) {
      out.push(60 << 2, n);
    } else if (n < 65536) {
      out.push(61 << 2, n & 0xff, (n >>> 8) & 0xff);
    } else {
      out.push(62 << 2, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff);
    }
    for (let i = 0; i < take; i++) out.push(input[pos + i]!);
    pos += take;
    len -= take;
  }
}

function emitCopy(out: number[], offset: number, len: number): void {
  while (len > 0) {
    if (len >= 4 && len <= 11 && offset < 2048) {
      out.push(((len - 4) << 2) | ((offset >>> 8) << 5) | 1, offset & 0xff);
      return;
    }
    const take = Math.min(len, MAX_COPY_LEN);
    // Never leave a tail of 1..3 bytes that only copy-1 could not express
    // but copy-2/4 can; copy-2 and copy-4 take any length 1..64, so a tail
    // is fine. Prefer the shorter encoding when the offset allows it.
    if (offset < 65536) {
      out.push(((take - 1) << 2) | 2, offset & 0xff, (offset >>> 8) & 0xff);
    } else {
      out.push(
        ((take - 1) << 2) | 3,
        offset & 0xff,
        (offset >>> 8) & 0xff,
        (offset >>> 16) & 0xff,
        (offset >>> 24) & 0xff,
      );
    }
    len -= take;
  }
}
