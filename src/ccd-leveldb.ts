// Minimal, dependency-free leveldb reader — just enough to recover a Chromium
// Local Storage value after the WAL has compacted into Snappy-compressed .ldb
// SSTables. We DON'T open the database (Chromium uses a custom comparator that
// trips real leveldb clients) and we DON'T do key lookups — we decompress each
// data block and hand the raw bytes back so the caller can substring-scan for a
// known value, exactly like scanning a plaintext .log. The custom comparator
// only affects key ordering, which is irrelevant to a substring scan.
//
// Covers: the classic 48-byte SSTable footer, per-block Snappy compression
// (type 1) and the raw Snappy block format. Anything unexpected degrades to
// "yield nothing", so a format change can't crash the daemon.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// ── Snappy raw-block decompressor (not the framed stream format) ───────────
export function snappyDecompress(input: Buffer): Buffer {
  let pos = 0;
  // Preamble: uncompressed length as a base-128 varint.
  let len = 0;
  let shift = 0;
  while (pos < input.length) {
    const b = input[pos++]!;
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error("snappy: bad length varint");
  }
  const out = Buffer.allocUnsafe(len);
  let outPos = 0;
  while (pos < input.length) {
    const tag = input[pos++]!;
    const type = tag & 0x03;
    if (type === 0) {
      // Literal.
      let litLen = tag >> 2;
      if (litLen < 60) {
        litLen += 1;
      } else {
        const extra = litLen - 59; // 60→1B, 61→2B, 62→3B, 63→4B
        let v = 0;
        for (let i = 0; i < extra; i++) v |= input[pos++]! << (8 * i);
        litLen = (v >>> 0) + 1;
      }
      input.copy(out, outPos, pos, pos + litLen);
      pos += litLen;
      outPos += litLen;
    } else {
      // Copy (back-reference into already-written output).
      let copyLen: number;
      let offset: number;
      if (type === 1) {
        copyLen = ((tag >> 2) & 0x07) + 4;
        offset = ((tag >> 5) << 8) | input[pos++]!;
      } else if (type === 2) {
        copyLen = (tag >> 2) + 1;
        offset = (input[pos]! | (input[pos + 1]! << 8)) >>> 0;
        pos += 2;
      } else {
        copyLen = (tag >> 2) + 1;
        offset =
          (input[pos]! | (input[pos + 1]! << 8) | (input[pos + 2]! << 16) | (input[pos + 3]! << 24)) >>> 0;
        pos += 4;
      }
      let from = outPos - offset;
      if (from < 0) throw new Error("snappy: bad copy offset");
      for (let i = 0; i < copyLen; i++) out[outPos++] = out[from++]!;
    }
  }
  return out.subarray(0, outPos);
}

// ── Minimal SSTable parsing ────────────────────────────────────────────────
const SST_MAGIC_LO = 0x8b80fb57; // low 32 bits of 0xdb4775248b80fb57 (LE tail)
const SST_MAGIC_HI = 0xdb477524;

function readVarint(buf: Buffer, pos: number): [number, number] {
  let v = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++]!;
    v |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [v >>> 0, pos];
    shift += 7;
    if (shift > 35) break;
  }
  throw new Error("varint overrun");
}

interface BlockHandle {
  offset: number;
  size: number;
}

function readBlock(file: Buffer, handle: BlockHandle): Buffer {
  const raw = file.subarray(handle.offset, handle.offset + handle.size);
  const compression = file[handle.offset + handle.size]; // trailer: 1B type + 4B crc
  if (compression === 1) return snappyDecompress(raw);
  return raw;
}

/** Decompressed data blocks of an SSTable (.ldb), or [] if it can't be parsed. */
function ldbDataBlocks(file: Buffer): Buffer[] {
  if (file.length < 48) return [];
  const footer = file.subarray(file.length - 48);
  if (
    footer.readUInt32LE(40) !== SST_MAGIC_LO ||
    footer.readUInt32LE(44) !== SST_MAGIC_HI
  ) {
    return [];
  }
  // Footer: metaindex_handle (varint off+size) then index_handle (varint
  // off+size). We only use the index handle, so parse past the metaindex one.
  let p = 0;
  [, p] = readVarint(footer, p); // skip metaindex offset
  [, p] = readVarint(footer, p); // skip metaindex size
  const [off, pAfterOff] = readVarint(footer, p); // index offset
  const [size] = readVarint(footer, pAfterOff); // index size
  const indexBlock = readBlock(file, { offset: off, size });

  // Walk index-block entries; each entry's VALUE is a data BlockHandle. We
  // don't reconstruct keys — just skip the key delta and read the handle.
  const numRestarts = indexBlock.readUInt32LE(indexBlock.length - 4);
  const entriesEnd = indexBlock.length - 4 - numRestarts * 4;
  const blocks: Buffer[] = [];
  let q = 0;
  while (q < entriesEnd) {
    // Each index entry: shared-prefix len (unused here), non-shared key len,
    // value len, then the key delta and the value (a block handle).
    const [, qAfterShared] = readVarint(indexBlock, q);
    const [nonShared, qAfterNonShared] = readVarint(indexBlock, qAfterShared);
    const [valueLen, qAfterValueLen] = readVarint(indexBlock, qAfterNonShared);
    const vStart = qAfterValueLen + nonShared; // skip key delta
    q = vStart + valueLen;
    // The value is a block handle: offset varint followed by size varint.
    const [dOff, hpAfterOff] = readVarint(indexBlock, vStart);
    const [dSize] = readVarint(indexBlock, hpAfterOff);
    try {
      blocks.push(readBlock(file, { offset: dOff, size: dSize }));
    } catch {
      /* skip an undecodable block, keep going */
    }
  }
  return blocks;
}

/**
 * Yield every scannable buffer from a Chromium Local Storage leveldb dir, newest
 * file first: a .log yields its whole (plaintext) self; a .ldb yields each
 * decompressed data block. Callers substring-scan these for a known value.
 */
export async function* leveldbScanBuffers(dir: string): AsyncGenerator<Buffer> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  files = files.filter((f) => f.endsWith(".log") || f.endsWith(".ldb")).sort().reverse();
  for (const f of files) {
    let buf: Buffer;
    try {
      buf = await readFile(path.join(dir, f));
    } catch {
      continue;
    }
    if (f.endsWith(".log")) {
      yield buf;
    } else {
      let blocks: Buffer[];
      try {
        blocks = ldbDataBlocks(buf);
      } catch {
        blocks = [];
      }
      for (const b of blocks) yield b;
    }
  }
}
