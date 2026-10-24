// The "scoped" Claude Desktop fixture is what the manifest says it is: the
// client's own reader, pointed at the generated store, uploads exactly the
// expected mirror, and the mirror of the second account once the switch is
// appended to the log.

import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGroupMirror, setCcdLeveldbDirForTests } from "../../src/ccd-prefs.js";
import { setCcdSessionsDirForTests } from "../../src/ccd.js";
import { generateHome, type ExpectedGroupMirror } from "./gen-home.js";

const work = mkdtempSync(join(tmpdir(), "hx-ccd-scoped-fixture-"));
afterAll(() => {
  setCcdLeveldbDirForTests(null);
  setCcdSessionsDirForTests(null);
  rmSync(work, { recursive: true, force: true });
});

const pick = (blob: Record<string, unknown>, want: ExpectedGroupMirror): Record<string, unknown> =>
  Object.fromEntries(Object.keys(want).map((k) => [k, blob[k]]));

describe("gen-home ccdLayout scoped", () => {
  it("reads to the expected mirror, then to the second account's after the switch", async () => {
    const home = join(work, "home");
    const m = generateHome({ out: home, shape: "small", seed: "ccd-accounts", now: Date.now(), ccdLayout: "scoped" });
    const ccd = join(home, "Library", "Application Support", "Claude");
    setCcdLeveldbDirForTests(join(ccd, "Local Storage", "leveldb"));
    setCcdSessionsDirForTests(join(ccd, "claude-code-sessions"));

    const first = await buildGroupMirror(1_000);
    expect(pick(first as unknown as Record<string, unknown>, m.expectations.groupMirror)).toEqual(m.expectations.groupMirror as unknown as Record<string, unknown>);

    const log = join(home, m.ccdSwitch!.file);
    const before = readFileSync(log).length;
    appendFileSync(log, Buffer.from(m.ccdSwitch!.appendBase64, "base64"));
    expect(readFileSync(log).length).toBeGreaterThan(before + 64 * 1024); // three blocks' worth: first, middle, last fragments
    const after = await buildGroupMirror(2_000);
    expect(pick(after as unknown as Record<string, unknown>, m.expectations.groupMirrorAfterSwitch!)).toEqual(m.expectations.groupMirrorAfterSwitch as unknown as Record<string, unknown>);
  });
});
