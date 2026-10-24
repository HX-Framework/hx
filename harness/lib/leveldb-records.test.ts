// The client's record reader (src/ccd-leveldb.ts: LeveldbKeyReader) against
// stores this writer builds the way leveldb lays them out: the newest write of
// a key wins by sequence number wherever it sits.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LeveldbKeyReader,
  decodeLocalStorageValue,
  localStorageKeyMatcher,
  readLeveldbValue,
} from "../../src/ccd-leveldb.js";
import { buildLdbEntries, buildLogBatches, localStorageKey, localStorageValue } from "./leveldb-writer.js";

const K = localStorageKey("https://claude.ai", "dframe-store");
const OTHER = localStorageKey("https://claude.ai", "branch-status-cache");
const text = (s: string): Buffer => localStorageValue(s);

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function store(files: Record<string, Buffer>): string {
  dir = mkdtempSync(join(tmpdir(), "hx-ldb-records-"));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return dir;
}

async function newestValue(d: string, names = ["dframe-store"]): Promise<string | null> {
  const recs = await new LeveldbKeyReader(d, localStorageKeyMatcher(names)).newest();
  const rec = [...recs.values()][0];
  if (!rec) return "<none>";
  if (!rec.live) return null;
  const raw = await readLeveldbValue(d, rec);
  return raw === null ? "<unreadable>" : decodeLocalStorageValue(raw);
}

describe("LeveldbKeyReader: the newest write wins by sequence number", () => {
  it("whatever file it is in: a log numbered below a table, a compaction output numbered above both", async () => {
    // What a live store looks like: 000006.log took over before the table of
    // the previous log (000007) was written, and a compaction (000008) holds
    // the oldest version under the highest number.
    const d = store({
      "000006.log": buildLogBatches([{ seq: 30, entries: [{ key: K, value: text("v3") }] }]),
      "000007.ldb": buildLdbEntries([{ key: K, seq: 20, value: text("v2") }]),
      "000008.ldb": buildLdbEntries([{ key: K, seq: 10, value: text("v1") }]),
    });
    expect(await newestValue(d)).toBe("v3");
  });

  it("within a log, the later batch (the old byte scan took the first, oldest one)", async () => {
    const d = store({
      "000003.log": buildLogBatches([
        { seq: 1, entries: [{ key: K, value: text("old") }] },
        { seq: 2, entries: [{ key: OTHER, value: text("x") }, { key: K, value: text("new") }] },
      ]),
    });
    expect(await newestValue(d)).toBe("new");
  });

  it("within a table, the newest of several versions", async () => {
    const d = store({
      "000004.ldb": buildLdbEntries([
        { key: K, seq: 5, value: text("five") },
        { key: K, seq: 9, value: text("nine") },
        { key: OTHER, seq: 7, value: text("other") },
      ]),
    });
    expect(await newestValue(d)).toBe("nine");
  });

  it("a deletion that wins hides every older value", async () => {
    const d = store({
      "000004.ldb": buildLdbEntries([{ key: K, seq: 5, value: text("five") }]),
      "000005.log": buildLogBatches([{ seq: 6, entries: [{ key: K, value: null }] }]),
    });
    expect(await newestValue(d)).toBeNull();
  });
});

describe("LeveldbKeyReader: the write-ahead log's framing", () => {
  it("a value over 32 KiB reads whole from its first, middle and last fragments", async () => {
    const big = "x".repeat(100_000) + "end";
    const d = store({
      "000003.log": buildLogBatches([
        { seq: 1, entries: [{ key: OTHER, value: text("y".repeat(30_000)) }] },
        { seq: 2, entries: [{ key: K, value: text(big) }] },
      ]),
    });
    expect(await newestValue(d)).toBe(big);
  });

  it("a batch cut off by the end of the file (a write in progress) is not read", async () => {
    const whole = buildLogBatches([
      { seq: 1, entries: [{ key: K, value: text("complete") }] },
      { seq: 2, entries: [{ key: K, value: text("z".repeat(50_000)) }] },
    ]);
    const d = store({ "000003.log": whole.subarray(0, whole.length - 100) });
    expect(await newestValue(d)).toBe("complete");
  });

  it("a fragment whose checksum does not match drops its batch", async () => {
    const log = buildLogBatches([
      { seq: 1, entries: [{ key: K, value: text("good") }] },
      { seq: 2, entries: [{ key: K, value: text("damaged") }] },
    ]);
    log[log.length - 2] ^= 0xff; // a byte of the second batch's value
    const d = store({ "000003.log": log });
    expect(await newestValue(d)).toBe("good");
  });

  it("a table still being written (no footer yet) holds nothing", async () => {
    const table = buildLdbEntries([{ key: K, seq: 50, value: text("later") }]);
    const d = store({
      "000003.log": buildLogBatches([{ seq: 40, entries: [{ key: K, value: text("now") }] }]),
      "000004.ldb": table.subarray(0, table.length - 20),
    });
    expect(await newestValue(d)).toBe("now");
  });
});

describe("Local Storage keys and values", () => {
  it("matches the names under any origin, and no longer name", () => {
    const match = localStorageKeyMatcher(["dframe-store", "frame-store"]);
    expect(match(localStorageKey("https://claude.ai", "dframe-store"))).toBe(true);
    expect(match(localStorageKey("file://", "frame-store"))).toBe(true);
    expect(match(localStorageKey("https://claude.ai", "dframe-store.backup.v1"))).toBe(false);
    expect(match(Buffer.from("META:https://claude.ai", "latin1"))).toBe(false);
  });

  it("decodes Chromium's two encodings: 1 Latin-1, 0 UTF-16LE", () => {
    expect(decodeLocalStorageValue(Buffer.concat([Buffer.from([1]), Buffer.from("Café", "latin1")]))).toBe("Café");
    const wide = "Group → 日本";
    expect(decodeLocalStorageValue(Buffer.concat([Buffer.from([0]), Buffer.from(wide, "utf16le")]))).toBe(wide);
    expect(decodeLocalStorageValue(Buffer.from("{}"))).toBeNull();
  });
});
