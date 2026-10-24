// A minimal leveldb SSTable (.ldb) and write-ahead log (.log) WRITER, used to
// generate the Claude Desktop "Local Storage" fixture.
//
// Chromium persists Claude Desktop's sidebar grouping as a value in a leveldb
// under <app data>/Local Storage/leveldb. The client (src/ccd-prefs.ts) never
// opens the database; it reads every .log whole and decompresses every data
// block of every .ldb (src/ccd-leveldb.ts), then substring-scans the bytes.
// A fixture therefore has to be a structurally valid table: the client finds
// the index block through the 48-byte footer, walks its entries to each data
// block's handle, and decompresses the blocks whose trailer says Snappy.
//
// Table layout (leveldb/doc/table_format.md):
//   [data block]* [meta index block] [index block] [footer]
//   block        = entries, restart array (uint32 LE each), num_restarts (uint32 LE)
//   on disk      = block bytes (maybe compressed) + 1 type byte + 4-byte masked CRC32C
//   entry        = varint shared, varint unshared, varint value_len, key delta, value
//   handle       = varint offset, varint size   (size excludes the 5-byte trailer)
//   footer       = metaindex handle, index handle, padding to 40 bytes, 8-byte magic
//
// Keys are leveldb INTERNAL keys: the user key followed by 8 bytes holding
// (sequence << 8 | type) little-endian; type 1 = value. Chromium's Local
// Storage user keys look like `_<origin>\0\x01<name>`, and values carry a
// leading type byte (0 = UTF-16LE, 1 = Latin-1). The client's scan depends on
// the Latin-1 form, which is what Chromium writes when every character fits.

import { snappyCompress } from "./snappy.js";

export interface KeyValue {
  key: Buffer;
  value: Buffer;
}

export interface LdbOptions {
  /** Target uncompressed data-block size; leveldb's default is 4 KiB. */
  blockSize?: number;
  /** Restart interval within a block; leveldb's default is 16. */
  restartInterval?: number;
  /** Snappy-compress each block (type 1). Chromium's tables are. */
  compress?: boolean;
  /** Sequence number stamped into the first internal key. */
  firstSequence?: number;
}

const MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);
const TYPE_VALUE = 1;

/** Chromium Local Storage leveldb key for `name` under `origin`. */
export function localStorageKey(origin: string, name: string): Buffer {
  return Buffer.concat([Buffer.from(`_${origin}`, "latin1"), Buffer.from([0x00, 0x01]), Buffer.from(name, "latin1")]);
}

/** Chromium Local Storage value with the Latin-1 type byte. */
export function localStorageValue(text: string): Buffer {
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(text, "latin1")]);
}

function internalKey(userKey: Buffer, sequence: number): Buffer {
  const tail = Buffer.alloc(8);
  // (sequence << 8) | type, as a little-endian 64-bit number. Sequences in a
  // fixture are small, so a 32-bit shift path is exact.
  tail.writeUInt32LE(((sequence << 8) | TYPE_VALUE) >>> 0, 0);
  tail.writeUInt32LE(Math.floor(sequence / 2 ** 24), 4);
  return Buffer.concat([userKey, tail]);
}

function varint(v: number): Buffer {
  const out: number[] = [];
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

function sharedPrefix(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** Encode a block from sorted entries: entries, restarts, num_restarts. */
export function encodeBlock(entries: KeyValue[], restartInterval: number): Buffer {
  const parts: Buffer[] = [];
  const restarts: number[] = [0];
  let size = 0;
  let prev: Buffer = Buffer.alloc(0);
  entries.forEach((e, i) => {
    if (i > 0 && i % restartInterval === 0) {
      restarts.push(size);
      prev = Buffer.alloc(0);
    }
    const shared = sharedPrefix(prev, e.key);
    const unshared = e.key.length - shared;
    const chunk = Buffer.concat([
      varint(shared),
      varint(unshared),
      varint(e.value.length),
      e.key.subarray(shared),
      e.value,
    ]);
    parts.push(chunk);
    size += chunk.length;
    prev = e.key;
  });
  const trailer = Buffer.alloc(4 * (restarts.length + 1));
  restarts.forEach((r, i) => trailer.writeUInt32LE(r, i * 4));
  trailer.writeUInt32LE(restarts.length, restarts.length * 4);
  return Buffer.concat([...parts, trailer]);
}

// CRC32C (Castagnoli), masked the way leveldb masks block checksums.
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32c(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function maskCrc(crc: number): number {
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
}

interface Handle {
  offset: number;
  size: number;
}

function encodeHandle(h: Handle): Buffer {
  return Buffer.concat([varint(h.offset), varint(h.size)]);
}

/**
 * Write a complete .ldb table holding `kvs` (user keys; sorted here by bytes,
 * which is what the fixture needs — Chromium's comparator differs only in
 * ways a substring scan never sees).
 */
export function buildLdb(kvs: KeyValue[], opts: LdbOptions = {}): Buffer {
  const blockSize = opts.blockSize ?? 4096;
  const restartInterval = opts.restartInterval ?? 16;
  const compress = opts.compress ?? true;
  let sequence = opts.firstSequence ?? 1;
  const sorted = [...kvs].sort((a, b) => Buffer.compare(a.key, b.key));
  const entries: KeyValue[] = sorted.map((kv) => ({ key: internalKey(kv.key, sequence++), value: kv.value }));

  const file: Buffer[] = [];
  let offset = 0;
  const indexEntries: KeyValue[] = [];

  const writeBlock = (raw: Buffer, type: 0 | 1): Handle => {
    const data = type === 1 ? snappyCompress(raw) : raw;
    const typed = Buffer.concat([data, Buffer.from([type])]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(maskCrc(crc32c(typed)), 0);
    file.push(typed, crc);
    const handle = { offset, size: data.length };
    offset += typed.length + 4;
    return handle;
  };

  // Data blocks: fill each to about blockSize of raw bytes.
  let pending: KeyValue[] = [];
  let pendingBytes = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    const raw = encodeBlock(pending, restartInterval);
    const handle = writeBlock(raw, compress ? 1 : 0);
    indexEntries.push({ key: pending[pending.length - 1]!.key, value: encodeHandle(handle) });
    pending = [];
    pendingBytes = 0;
  };
  for (const e of entries) {
    pending.push(e);
    pendingBytes += e.key.length + e.value.length + 8;
    if (pendingBytes >= blockSize) flush();
  }
  flush();

  // Meta index (no filter block): an empty block.
  const metaHandle = writeBlock(encodeBlock([], restartInterval), 0);
  // Index block: never compressed, so a reader with no Snappy can still find blocks.
  const indexHandle = writeBlock(encodeBlock(indexEntries, 1), 0);

  const footer = Buffer.alloc(48);
  const handles = Buffer.concat([encodeHandle(metaHandle), encodeHandle(indexHandle)]);
  handles.copy(footer, 0);
  MAGIC.copy(footer, 40);
  file.push(footer);
  return Buffer.concat(file);
}

/**
 * A leveldb write-ahead log (.log) holding one write batch per call. Record
 * framing: 4-byte checksum, 2-byte length, 1-byte type (1 = full record), then
 * the batch: 8-byte sequence, 4-byte count, and per entry a type byte (1 =
 * value), varint key length, key, varint value length, value. Records never
 * cross the 32 KiB block boundary here because fixtures stay small.
 */
export function buildLog(batches: KeyValue[][], firstSequence = 1): Buffer {
  const records: Buffer[] = [];
  let sequence = firstSequence;
  for (const batch of batches) {
    const head = Buffer.alloc(12);
    head.writeUInt32LE(sequence >>> 0, 0);
    head.writeUInt32LE(0, 4);
    head.writeUInt32LE(batch.length, 8);
    const body = Buffer.concat([
      head,
      ...batch.map((kv) =>
        Buffer.concat([Buffer.from([TYPE_VALUE]), varint(kv.key.length), kv.key, varint(kv.value.length), kv.value]),
      ),
    ]);
    const header = Buffer.alloc(7);
    header.writeUInt32LE(maskCrc(crc32c(Buffer.concat([Buffer.from([1]), body]))), 0);
    header.writeUInt16LE(body.length, 4);
    header[6] = 1;
    records.push(header, body);
    sequence += batch.length;
  }
  return Buffer.concat(records);
}

/** One internal entry for buildLdbEntries: a value, or a deletion (null). */
export interface LeveldbEntry {
  key: Buffer;
  seq: number;
  value: Buffer | null;
}

function internalKeyOf(userKey: Buffer, sequence: number, type: number): Buffer {
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE((((sequence % 2 ** 24) * 256) | type) >>> 0, 0);
  tail.writeUInt32LE(Math.floor(sequence / 2 ** 24), 4);
  return Buffer.concat([userKey, tail]);
}

/**
 * A table holding exactly the entries given, each with its own sequence
 * number, deletions included: several versions of one key, as a table that
 * no compaction has cleaned yet holds them. Sorted as leveldb sorts internal
 * keys: user key ascending, then the newest first.
 */
export function buildLdbEntries(entries: LeveldbEntry[], opts: LdbOptions = {}): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(a.key, b.key) || b.seq - a.seq);
  return buildLdbInternal(
    sorted.map((e) => ({ key: internalKeyOf(e.key, e.seq, e.value === null ? 0 : TYPE_VALUE), value: e.value ?? Buffer.alloc(0) })),
    opts,
  );
}

function buildLdbInternal(entries: KeyValue[], opts: LdbOptions): Buffer {
  const blockSize = opts.blockSize ?? 4096;
  const restartInterval = opts.restartInterval ?? 16;
  const compress = opts.compress ?? true;
  const file: Buffer[] = [];
  let offset = 0;
  const indexEntries: KeyValue[] = [];
  const writeBlock = (raw: Buffer, type: 0 | 1): Handle => {
    const data = type === 1 ? snappyCompress(raw) : raw;
    const typed = Buffer.concat([data, Buffer.from([type])]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(maskCrc(crc32c(typed)), 0);
    file.push(typed, crc);
    const handle = { offset, size: data.length };
    offset += typed.length + 4;
    return handle;
  };
  let pending: KeyValue[] = [];
  let pendingBytes = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    const handle = writeBlock(encodeBlock(pending, restartInterval), compress ? 1 : 0);
    indexEntries.push({ key: pending[pending.length - 1]!.key, value: encodeHandle(handle) });
    pending = [];
    pendingBytes = 0;
  };
  for (const e of entries) {
    pending.push(e);
    pendingBytes += e.key.length + e.value.length + 8;
    if (pendingBytes >= blockSize) flush();
  }
  flush();
  const metaHandle = writeBlock(encodeBlock([], restartInterval), 0);
  const indexHandle = writeBlock(encodeBlock(indexEntries, 1), 0);
  const footer = Buffer.alloc(48);
  Buffer.concat([encodeHandle(metaHandle), encodeHandle(indexHandle)]).copy(footer, 0);
  MAGIC.copy(footer, 40);
  file.push(footer);
  return Buffer.concat(file);
}

/** One write batch for buildLogBatches: entries at seq, seq + 1, … (a null
 *  value is a deletion). */
export interface LogBatch {
  seq: number;
  entries: Array<{ key: Buffer; value: Buffer | null }>;
}

const LOG_BLOCK_SIZE = 32_768;
const LOG_HEADER_SIZE = 7;

/**
 * A write-ahead log framed exactly as leveldb's log writer frames it: a batch
 * longer than what is left of a 32 KiB block is split into first, middle and
 * last fragments, and a block's tail shorter than a header is zero-filled.
 * With `startOffset`, the bytes to append to a log that long.
 */
export function buildLogBatches(batches: LogBatch[], opts: { startOffset?: number } = {}): Buffer {
  const out: Buffer[] = [];
  // Appending to a log of `startOffset` bytes continues its current block.
  let blockOffset = (opts.startOffset ?? 0) % LOG_BLOCK_SIZE;
  for (const batch of batches) {
    const head = Buffer.alloc(12);
    head.writeUInt32LE(batch.seq % 2 ** 32, 0);
    head.writeUInt32LE(Math.floor(batch.seq / 2 ** 32), 4);
    head.writeUInt32LE(batch.entries.length, 8);
    const body = Buffer.concat([
      head,
      ...batch.entries.map((e) =>
        e.value === null
          ? Buffer.concat([Buffer.from([0]), varint(e.key.length), e.key])
          : Buffer.concat([Buffer.from([TYPE_VALUE]), varint(e.key.length), e.key, varint(e.value.length), e.value]),
      ),
    ]);
    let left = body.length;
    let ptr = 0;
    let begin = true;
    do {
      const leftover = LOG_BLOCK_SIZE - blockOffset;
      if (leftover < LOG_HEADER_SIZE) {
        if (leftover > 0) out.push(Buffer.alloc(leftover));
        blockOffset = 0;
      }
      const avail = LOG_BLOCK_SIZE - blockOffset - LOG_HEADER_SIZE;
      const len = Math.min(left, avail);
      const end = left === len;
      const type = begin && end ? 1 : begin ? 2 : end ? 4 : 3;
      const data = body.subarray(ptr, ptr + len);
      const header = Buffer.alloc(LOG_HEADER_SIZE);
      header.writeUInt32LE(maskCrc(crc32c(Buffer.concat([Buffer.from([type]), data]))), 0);
      header.writeUInt16LE(len, 4);
      header[6] = type;
      out.push(header, data);
      blockOffset += LOG_HEADER_SIZE + len;
      ptr += len;
      left -= len;
      begin = false;
    } while (left > 0);
  }
  return Buffer.concat(out);
}
