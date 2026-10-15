import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { snappyDecompress, leveldbScanBuffers } from "../../src/ccd-leveldb.js";
import { snappyCompress } from "./snappy.js";
import { buildLdb, buildLog, localStorageKey, localStorageValue } from "./leveldb-writer.js";
import { Prng } from "./prng.js";

describe("snappyCompress round-trips through the client's decoder", () => {
  it("empty, tiny, repetitive and random inputs", () => {
    const rng = new Prng("snappy");
    const cases: Buffer[] = [
      Buffer.alloc(0),
      Buffer.from("a"),
      Buffer.from("abcabcabcabcabcabcabcabcabcabc"),
      Buffer.from("x".repeat(100_000)),
      Buffer.from(rng.paragraph(50_000)),
      Buffer.from(Array.from({ length: 70_000 }, () => rng.int(0, 255))),
    ];
    for (const input of cases) {
      const compressed = snappyCompress(input);
      const back = snappyDecompress(compressed);
      expect(back.equals(input)).toBe(true);
    }
  });

  it("uses copies on repetitive data (the fixture exercises every element kind)", () => {
    const text = Buffer.from("the quick brown fox ".repeat(500));
    const compressed = snappyCompress(text);
    expect(compressed.length).toBeLessThan(text.length / 4);
    // A match further back than 2048 bytes forces a copy-2 element; a match
    // within 2048 bytes and 4..11 long takes copy-1.
    const tags = new Set<number>();
    let pos = 0;
    while (pos < compressed.length && (compressed[pos]! & 0x80) !== 0) pos++;
    pos++;
    // Decode the element stream just far enough to collect tag kinds.
    while (pos < compressed.length) {
      const tag = compressed[pos]!;
      tags.add(tag & 3);
      if ((tag & 3) === 0) {
        let len = tag >> 2;
        let extra = 0;
        if (len >= 60) {
          extra = len - 59;
          len = 0;
          for (let i = 0; i < extra; i++) len |= compressed[pos + 1 + i]! << (8 * i);
        }
        pos += 1 + extra + len + 1;
      } else if ((tag & 3) === 1) pos += 2;
      else if ((tag & 3) === 2) pos += 3;
      else pos += 5;
    }
    expect(tags.has(0)).toBe(true);
    expect(tags.has(1) || tags.has(2)).toBe(true);
  });
});

describe("buildLdb produces a table the client's leveldb scanner reads", () => {
  it("yields decompressed data blocks containing the stored values, newest file first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hx-harness-ldb-"));
    try {
      const rng = new Prng("ldb");
      const kvs = [];
      for (let i = 0; i < 300; i++) {
        kvs.push({
          key: localStorageKey("file://", `storage-${String(i).padStart(4, "0")}`),
          value: localStorageValue(rng.paragraph(120)),
        });
      }
      const groups = JSON.stringify({ state: { groupByByMode: { code: "custom" }, customGroups: [{ id: "cg-1", name: "Alpha" }] }, version: 0 });
      kvs.push({ key: localStorageKey("file://", "frame-store"), value: localStorageValue(groups) });
      writeFileSync(join(dir, "000005.ldb"), buildLdb(kvs, { compress: true }));
      writeFileSync(
        join(dir, "000003.log"),
        buildLog([[{ key: localStorageKey("file://", "frame-store"), value: localStorageValue('{"state":{"customGroups":[]},"version":0}') }]]),
      );
      const seen: Buffer[] = [];
      for await (const buf of leveldbScanBuffers(dir)) seen.push(buf);
      // The .ldb sorts after the .log, so its blocks come first. Filler keys
      // start with "s" so the "frame-store" key keeps its full spelling: leveldb
      // stores each key as a delta from the previous one, and the client scans
      // for the literal key bytes.
      expect(seen.length).toBeGreaterThan(2);
      const joined = Buffer.concat(seen).toString("latin1");
      expect(joined.includes('"name":"Alpha"')).toBe(true);
      const firstHit = seen.findIndex((b) => b.includes("frame-store"));
      expect(seen[firstHit]!.includes("Alpha")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
