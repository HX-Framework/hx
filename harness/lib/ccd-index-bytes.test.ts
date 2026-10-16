import { describe, expect, test } from "bun:test";

import { ccdIndexByteDiffs } from "./compare.js";

const name = (k: string): string => k;

function index(files: Array<[string, number, number]>, savedAtMs = 1_760_000_000_000): string {
  return JSON.stringify({
    v: 1,
    savedAtMs,
    dirs: { "/s/a/o": { mtimeMs: 1_767_603_600_123.4567, files: files.map(([p]) => p) } },
    files: Object.fromEntries(
      files.map(([p, size, mtimeMs]) => [p, { size, mtimeMs, record: { ccdSessionId: `local_${p.slice(-6, -5)}`, cliSessionId: null, title: "t", titleSource: "ai", isArchived: false, lastActivityAt: 1_767_607_200_000 } }]),
    ),
  });
}

describe("ccdIndexByteDiffs", () => {
  const a = index([
    ["/s/a/o/local_1.json", 273, 1_767_603_600_104.731],
    ["/s/a/o/local_2.json", 280, 1_767_603_660_112.65],
  ]);

  test("identical files compare equal", () => {
    expect(ccdIndexByteDiffs(a, a, name)).toEqual([]);
  });

  test("the save's clock and the order of the entries are not compared", () => {
    const b = index(
      [
        ["/s/a/o/local_2.json", 280, 1_767_603_660_112.65],
        ["/s/a/o/local_1.json", 273, 1_767_603_600_104.731],
      ],
      1_760_000_009_999,
    );
    // The listing keeps its order: only the files map is reordered.
    const fixed = b.replace('"files":["/s/a/o/local_2.json","/s/a/o/local_1.json"]', '"files":["/s/a/o/local_1.json","/s/a/o/local_2.json"]');
    expect(ccdIndexByteDiffs(a, fixed, name)).toEqual([]);
  });

  test("a number JSON.stringify would print differently is a difference", () => {
    const b = a.replace('"size":273,', '"size":273.0,');
    const diffs = ccdIndexByteDiffs(a, b, name);
    expect(diffs.length).toBe(1);
    expect(diffs[0]).toContain("candidate: not what JSON.stringify writes");
  });

  test("an escape JSON.stringify would not write is a difference", () => {
    const b = a.replace('"title":"t"', '"title":"\\u0074"');
    expect(ccdIndexByteDiffs(a, b, name)[0]).toContain("candidate: not what JSON.stringify writes");
  });

  test("a changed value or key order inside an entry is a difference", () => {
    const b = a.replace('"mtimeMs":1767603600104.731', '"mtimeMs":1767603600104.7312');
    expect(ccdIndexByteDiffs(a, b, name)).toEqual(['files: /s/a/o/local_1.json: {"size":273,"mtimeMs":1767603600104.731,"record":{"ccdSessionId":"local_1","cliSessionId":null,"title":"t","titleSource":"ai","isArchived":false,"lastActivityAt":1767607200000}} ≠ {"size":273,"mtimeMs":1767603600104.7312,"record":{"ccdSessionId":"local_1","cliSessionId":null,"title":"t","titleSource":"ai","isArchived":false,"lastActivityAt":1767607200000}}']);
    const c = a.replace('{"size":273,"mtimeMs":1767603600104.731,', '{"mtimeMs":1767603600104.731,"size":273,');
    expect(ccdIndexByteDiffs(a, c, name).length).toBe(1);
  });

  test("an entry only one side has is a difference", () => {
    const b = index([["/s/a/o/local_1.json", 273, 1_767_603_600_104.731]]);
    expect(ccdIndexByteDiffs(a, b, name)).toContain("files: /s/a/o/local_2.json: only in the reference");
  });
});
