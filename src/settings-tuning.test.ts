// Settings round-trip hardening (LETAIR-144, ships in PR1): unknown top-level
// keys — `tuning` chief among them — must survive every read-merge-write
// cycle. The historical parser rebuilt exactly five known fields, so ANY
// settings write (a pause toggle from the UI, an exclusion edit) permanently
// erased a hand-added key; that made settings.json unable to carry the ops
// tuning transport at all.

import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, tuningValue, writeSettings } from "./settings.js";

let dir: string;
function settingsFile(content: unknown): string {
  dir = mkdtempSync(join(tmpdir(), "hx-settings-"));
  const p = join(dir, "settings.json");
  writeFileSync(p, JSON.stringify(content, null, 2));
  return p;
}

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("tuning round-trip", () => {
  it("readSettings carries tuning and unknown keys verbatim", async () => {
    const p = settingsFile({
      personalSync: true,
      tuning: { sweep: "legacy", uploadConcurrency: 2, chunkGrowth: false },
      futureKey: { anything: [1, 2, 3] },
    });
    const s = await readSettings(p);
    assert.deepEqual(s.tuning, { sweep: "legacy", uploadConcurrency: 2, chunkGrowth: false });
    assert.deepEqual((s as unknown as Record<string, unknown>)["futureKey"], { anything: [1, 2, 3] });
    assert.equal(tuningValue(s, "sweep"), "legacy");
    assert.equal(tuningValue(s, "uploadConcurrency"), 2);
    assert.equal(tuningValue(s, "missing"), undefined);
  });

  it("a settings write (UI pause toggle shape) preserves hand-added tuning", async () => {
    const p = settingsFile({
      excludeRules: ["~/private"],
      tuning: { sweep: "legacy" },
      futureKey: "kept",
    });
    await writeSettings({ pause: { untilMs: null } }, p);
    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    assert.deepEqual(onDisk.tuning, { sweep: "legacy" }, "tuning survived the rewrite");
    assert.equal(onDisk.futureKey, "kept", "unknown top-level key survived");
    assert.deepEqual(onDisk.pause, { untilMs: null }, "the patch itself applied");
    assert.deepEqual(onDisk.excludeRules, ["~/private"], "known fields untouched");
  });

  it("survives repeated write cycles (exclusion edit after pause toggle)", async () => {
    const p = settingsFile({ tuning: { childConcurrency: 8 } });
    await writeSettings({ pause: { untilMs: 123 } }, p);
    await writeSettings({ excludeRules: ["~/x"] }, p);
    await writeSettings({ pause: null }, p);
    const s = await readSettings(p);
    assert.deepEqual(s.tuning, { childConcurrency: 8 });
    assert.equal(s.pause, null);
    assert.deepEqual(s.excludeRules, ["~/x"]);
  });

  it("tuningValue never throws on mistyped tuning shapes", async () => {
    for (const bad of [42, "str", [1, 2], null, true]) {
      const p = settingsFile({ tuning: bad });
      const s = await readSettings(p);
      assert.equal(tuningValue(s, "sweep"), undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a corrupted file still falls back to defaults (tuning gone — documented)", async () => {
    dir = mkdtempSync(join(tmpdir(), "hx-settings-"));
    const p = join(dir, "settings.json");
    writeFileSync(p, "{not json");
    const s = await readSettings(p);
    assert.equal(s.tuning, undefined);
    assert.equal(s.personalSync, true);
  });
});
