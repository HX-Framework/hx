// Minimal, dependency-free leveldb reader — just enough to recover a Chromium
// Local Storage value after the WAL has compacted into Snappy-compressed .ldb
// SSTables. We DON'T open the database (it is locked while Claude Desktop
// runs) and we never seek by key order. Two readers live here:
//
//   • leveldbScanBuffers: every data block decompressed and handed back raw,
//     newest file name first, for a caller's substring scan. It cannot tell an
//     old value from a new one, and a .log value over 32 KiB has record
//     headers inside it. Kept for stores that are not real leveldb (tests) and
//     for the unread ids of builds this reader does not know.
//   • readLeveldbKeys: the records of chosen keys with their sequence numbers,
//     so the newest write of a key wins whatever file it is in (see below).
//
// Covers: the classic 48-byte SSTable footer, per-block Snappy compression
// (type 1), the raw Snappy block format and the write-ahead log's record
// framing. Anything unexpected degrades to "yield nothing", so a format change
// can't crash the daemon.

import { open, readFile, readdir, stat } from "node:fs/promises";
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

// ── Records: the newest write of a key ─────────────────────────────────────
//
// Claude Desktop rewrites its whole sidebar state (1.6 MB on a long-lived
// machine) on every change, so one key has many records: in the write-ahead
// log (.log) and in the tables (.ldb) compacted from older logs, until a
// compaction drops the shadowed ones. leveldb tells them apart by sequence
// number, never by file: the live .log has a LOWER number than the table just
// flushed from the log before it, and within a .log the first match of a key
// is its OLDEST write. So readLeveldbKeys collects every record of the keys
// asked for, each with its sequence number, and the highest wins; a deletion
// that wins means the key is gone. A log record is reassembled from its
// fragments before it is read, and its checksums are verified when it holds a
// wanted key, so a value over 32 KiB reads whole and a torn tail is ignored.
//
// A table never changes once written, so its records are cached by name, size
// and mtime; a .log is read again when it grows. Values are not kept: the
// caller reads the winner's value (readLeveldbValue) when the winner changed.

const LOG_BLOCK = 32_768;
const LOG_HEADER = 7;
// Fragment types: a whole record, or its first, middle (3) and last pieces.
const LOG_FULL = 1;
const LOG_FIRST = 2;
const LOG_LAST = 4;
const TYPE_DELETION = 0;
const TYPE_VALUE = 1;

/** One record of a key the caller asked for. */
export interface LeveldbRecord {
  /** The user key, one character per byte. */
  key: string;
  /** leveldb's sequence number: the higher, the newer. */
  seq: number;
  /** A value (true) or a deletion (false). */
  live: boolean;
  /** The file's name in the leveldb directory. */
  file: string;
  /** A table's data block (offset and size), or the offset of a log record's
   *  first fragment with blockSize -1. */
  block: number;
  blockSize: number;
  /** The value's start and length inside the decoded block or record. */
  at: number;
  len: number;
}

const CRC32C_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** leveldb's masked CRC32C of a log fragment: its type byte, then its data. */
function logFragmentCrc(type: number, data: Buffer): number {
  let c = CRC32C_TABLE[(0xffffffff ^ type) & 0xff]! ^ (0xffffffff >>> 8);
  for (let i = 0; i < data.length; i++) c = CRC32C_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  const crc = (c ^ 0xffffffff) >>> 0;
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
}

interface LogFragment {
  pos: number;
  crc: number;
  type: number;
  data: Buffer;
}

/**
 * The complete logical records of a write-ahead log from `from` (a fragment
 * boundary), each with its fragments. A record leveldb would not have written
 * (a zero run, damage) drops the rest of its 32 KiB block, as leveldb's reader
 * does; a record cut off by the end of the file is a write still in progress
 * and ends the walk.
 */
function* logRecords(buf: Buffer, from = 0): Generator<{ start: number; data: Buffer; frags: LogFragment[] }> {
  let pos = from;
  let pending: LogFragment[] | null = null;
  while (pos < buf.length) {
    const left = LOG_BLOCK - (pos % LOG_BLOCK);
    if (left < LOG_HEADER) {
      pos += left; // the block's zero trailer
      continue;
    }
    if (pos + LOG_HEADER > buf.length) break;
    const crc = buf.readUInt32LE(pos);
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6]!;
    if (type < LOG_FULL || type > LOG_LAST || LOG_HEADER + len > left) {
      pending = null;
      pos += left;
      continue;
    }
    if (pos + LOG_HEADER + len > buf.length) break;
    const frag: LogFragment = { pos, crc, type, data: buf.subarray(pos + LOG_HEADER, pos + LOG_HEADER + len) };
    pos += LOG_HEADER + len;
    if (type === LOG_FULL) {
      pending = null;
      yield { start: frag.pos, data: frag.data, frags: [frag] };
    } else if (type === LOG_FIRST) {
      pending = [frag];
    } else if (pending) {
      pending.push(frag);
      if (type === LOG_LAST) {
        const frags: LogFragment[] = pending;
        pending = null;
        yield { start: frags[0]!.pos, data: Buffer.concat(frags.map((f) => f.data)), frags };
      }
    }
  }
}

/** The wanted keys' records in one write-ahead log: each record is a write
 *  batch (sequence, count, then puts and deletes), entry i at sequence + i. */
function logFileRecords(buf: Buffer, file: string, match: (key: Buffer) => boolean): LeveldbRecord[] {
  const out: LeveldbRecord[] = [];
  for (const rec of logRecords(buf)) {
    const d = rec.data;
    if (d.length < 12) continue;
    const seq0 = d.readUInt32LE(0) + d.readUInt32LE(4) * 2 ** 32;
    const count = d.readUInt32LE(8);
    const found: LeveldbRecord[] = [];
    let p = 12;
    try {
      for (let i = 0; i < count && p < d.length; i++) {
        const tag = d[p++]!;
        if (tag !== TYPE_VALUE && tag !== TYPE_DELETION) break;
        let klen: number;
        [klen, p] = readVarint(d, p);
        const keyAt = p;
        p += klen;
        let at = 0;
        let len = 0;
        if (tag === TYPE_VALUE) {
          [len, p] = readVarint(d, p);
          at = p;
          p += len;
        }
        if (p > d.length) break;
        const key = d.subarray(keyAt, keyAt + klen);
        if (match(key)) {
          found.push({ key: key.toString("latin1"), seq: seq0 + i, live: tag === TYPE_VALUE, file, block: rec.start, blockSize: -1, at, len });
        }
      }
    } catch {
      // A length past the end: the batch is damaged, and its checksum says so.
    }
    if (found.length > 0 && rec.frags.every((f) => logFragmentCrc(f.type, f.data) === f.crc)) out.push(...found);
  }
  return out;
}

/** The data-block handles of a table, from its index block; [] when it has
 *  no valid footer (a table still being written, or not a table). */
function ldbBlockHandles(file: Buffer): BlockHandle[] {
  if (file.length < 48) return [];
  const footer = file.subarray(file.length - 48);
  if (footer.readUInt32LE(40) !== SST_MAGIC_LO || footer.readUInt32LE(44) !== SST_MAGIC_HI) return [];
  let p = 0;
  [, p] = readVarint(footer, p);
  [, p] = readVarint(footer, p);
  const [off, pAfterOff] = readVarint(footer, p);
  const [size] = readVarint(footer, pAfterOff);
  if (off + size + 1 > file.length) return [];
  const index = readBlock(file, { offset: off, size });
  if (index.length < 4) return [];
  const end = index.length - 4 - index.readUInt32LE(index.length - 4) * 4;
  const handles: BlockHandle[] = [];
  let q = 0;
  while (q < end) {
    const [, q1] = readVarint(index, q);
    const [nonShared, q2] = readVarint(index, q1);
    const [valueLen, q3] = readVarint(index, q2);
    const vStart = q3 + nonShared;
    q = vStart + valueLen;
    const [dOff, hp] = readVarint(index, vStart);
    const [dSize] = readVarint(index, hp);
    handles.push({ offset: dOff, size: dSize });
  }
  return handles;
}

/** The wanted keys' records in one table. Its keys are leveldb INTERNAL keys:
 *  the user key, then 8 bytes of (sequence << 8 | type) little-endian. */
function tableFileRecords(buf: Buffer, file: string, match: (key: Buffer) => boolean): LeveldbRecord[] {
  const out: LeveldbRecord[] = [];
  let handles: BlockHandle[];
  try {
    handles = ldbBlockHandles(buf);
  } catch {
    return out;
  }
  let key = Buffer.allocUnsafe(256);
  for (const h of handles) {
    if (h.offset + h.size + 1 > buf.length) continue;
    let block: Buffer;
    try {
      block = readBlock(buf, h);
    } catch {
      continue;
    }
    if (block.length < 4) continue;
    const end = block.length - 4 - block.readUInt32LE(block.length - 4) * 4;
    let keyLen = 0;
    let q = 0;
    try {
      while (q < end) {
        let shared: number;
        let nonShared: number;
        let vlen: number;
        [shared, q] = readVarint(block, q);
        [nonShared, q] = readVarint(block, q);
        [vlen, q] = readVarint(block, q);
        if (shared > keyLen || q + nonShared + vlen > end) break;
        if (shared + nonShared > key.length) {
          const grown = Buffer.allocUnsafe(Math.max(shared + nonShared, key.length * 2));
          key.copy(grown, 0, 0, keyLen);
          key = grown;
        }
        block.copy(key, shared, q, q + nonShared);
        keyLen = shared + nonShared;
        q += nonShared;
        const at = q;
        q += vlen;
        if (keyLen < 8) continue;
        const user = key.subarray(0, keyLen - 8);
        if (!match(user)) continue;
        const lo = key.readUInt32LE(keyLen - 8);
        const hi = key.readUInt32LE(keyLen - 4);
        const type = lo & 0xff;
        if (type !== TYPE_VALUE && type !== TYPE_DELETION) continue;
        out.push({ key: user.toString("latin1"), seq: (lo >>> 8) + hi * 2 ** 24, live: type === TYPE_VALUE, file, block: h.offset, blockSize: h.size, at, len: vlen });
      }
    } catch {
      // A damaged block: keep what it gave up to the damage.
    }
  }
  return out;
}

/** Chromium Local Storage keys, `_<origin>\0\x01<name>`, of the names given,
 *  under any origin (Claude Desktop builds have used file:// and
 *  https://claude.ai). */
export function localStorageKeyMatcher(names: string[]): (key: Buffer) => boolean {
  const wanted = names.map((n) => Buffer.from(n, "latin1"));
  return (key) => {
    if (key.length < 3 || key[0] !== 0x5f) return false;
    const z = key.indexOf(0);
    if (z < 1 || key[z + 1] !== 0x01) return false;
    const tail = key.subarray(z + 2);
    return wanted.some((w) => w.equals(tail));
  };
}

/** The name part of a Local Storage key matched above. */
export function localStorageKeyName(key: string): string {
  const z = key.indexOf("\x00");
  return z < 0 ? key : key.slice(z + 2);
}

/** Is record `a` newer than `b`? The sequence number decides; two records
 *  with the same number (only a hand-made store has them) go to the file whose
 *  name sorts later, then to the later position in it. */
export function isNewerRecord(a: LeveldbRecord, b: LeveldbRecord): boolean {
  if (a.seq !== b.seq) return a.seq > b.seq;
  if (a.file !== b.file) return a.file > b.file;
  return a.block > b.block;
}

function isStoreFile(name: string): boolean {
  return name.endsWith(".log") || name.endsWith(".ldb");
}

/**
 * The records of the matching keys across a Local Storage leveldb directory,
 * with per-file caches. One instance per directory.
 */
export class LeveldbKeyReader {
  private readonly files = new Map<string, { stamp: string; records: LeveldbRecord[] }>();

  constructor(
    readonly dir: string,
    private readonly match: (key: Buffer) => boolean,
  ) {}

  /** The newest record of every matching key (a deletion included), by user
   *  key. A file that vanishes mid-read means a compaction moved the records:
   *  the whole read runs again, up to three times. */
  async newest(): Promise<Map<string, LeveldbRecord>> {
    let records: LeveldbRecord[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const got = await this.readOnce();
      records = got.records;
      if (got.complete) break;
    }
    const best = new Map<string, LeveldbRecord>();
    for (const r of records) {
      const cur = best.get(r.key);
      if (!cur || isNewerRecord(r, cur)) best.set(r.key, r);
    }
    return best;
  }

  private async readOnce(): Promise<{ records: LeveldbRecord[]; complete: boolean }> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      this.files.clear();
      return { records: [], complete: true };
    }
    names = names.filter(isStoreFile).sort();
    const records: LeveldbRecord[] = [];
    const present = new Set<string>();
    let complete = true;
    for (const name of names) {
      const p = path.join(this.dir, name);
      let stamp: string;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file of the Local Storage leveldb
        const st = await stat(p);
        stamp = `${st.size}:${st.mtimeMs}`;
      } catch {
        complete = false;
        continue;
      }
      present.add(name);
      const hit = this.files.get(name);
      if (hit && hit.stamp === stamp) {
        records.push(...hit.records);
        continue;
      }
      let buf: Buffer;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file of the Local Storage leveldb
        buf = await readFile(p);
      } catch {
        complete = false;
        continue;
      }
      const found = name.endsWith(".log") ? logFileRecords(buf, name, this.match) : tableFileRecords(buf, name, this.match);
      this.files.set(name, { stamp, records: found });
      records.push(...found);
    }
    for (const name of [...this.files.keys()]) if (!present.has(name)) this.files.delete(name);
    return { records, complete };
  }
}

/** The value of a live record, or null when its file changed or vanished. */
export async function readLeveldbValue(dir: string, rec: LeveldbRecord): Promise<Buffer | null> {
  if (!rec.live) return null;
  const p = path.join(dir, rec.file);
  try {
    if (rec.blockSize >= 0) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file of the Local Storage leveldb
      const fh = await open(p, "r");
      try {
        const raw = Buffer.allocUnsafe(rec.blockSize + 1);
        const { bytesRead } = await fh.read(raw, 0, raw.length, rec.block);
        if (bytesRead !== raw.length) return null;
        const block = raw[rec.blockSize] === 1 ? snappyDecompress(raw.subarray(0, rec.blockSize)) : raw.subarray(0, rec.blockSize);
        return rec.at + rec.len <= block.length ? block.subarray(rec.at, rec.at + rec.len) : null;
      } finally {
        await fh.close();
      }
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file of the Local Storage leveldb
    const buf = await readFile(p);
    for (const r of logRecords(buf, rec.block)) {
      if (r.start !== rec.block || rec.at + rec.len > r.data.length) return null;
      return r.data.subarray(rec.at, rec.at + rec.len);
    }
    return null;
  } catch {
    return null;
  }
}

/** A Local Storage value as text: a leading 0 means UTF-16LE, 1 means
 *  Latin-1 (Chromium's two encodings); anything else is not such a value. */
export function decodeLocalStorageValue(v: Buffer): string | null {
  if (v.length === 0) return null;
  if (v[0] === 1) return v.subarray(1).toString("latin1");
  if (v[0] === 0) return v.subarray(1, 1 + ((v.length - 1) & ~1)).toString("utf16le");
  return null;
}
