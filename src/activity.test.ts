import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendActivity, parseActivityLines, readActivity, type ActivityEntry } from "./activity.js";

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "hx-activity-")), "activity.jsonl");

const entry = (at: number, over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  at,
  sessionId: "s1",
  family: "claude-cli",
  bytes: 100,
  dest: "letai",
  ...over,
});

describe("activity journal", () => {
  it("appends and reads back, filtered by time", async () => {
    const p = tmpPath();
    assert.deepEqual(await readActivity(0, p), []);
    await appendActivity(entry(100), p);
    await appendActivity(entry(200, { dest: "org1", bytes: 50 }), p);
    const all = await readActivity(0, p);
    assert.equal(all.length, 2);
    const recent = await readActivity(150, p);
    assert.deepEqual(recent.map((e) => e.at), [200]);
  });

  it("parses defensively: garbage and missing fields are skipped", () => {
    const good = JSON.stringify(entry(5));
    const out = parseActivityLines(`not json\n{"at":"nope"}\n\n${good}\n`, 0);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.at, 5);
  });
});
