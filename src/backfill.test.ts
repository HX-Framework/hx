import { describe, it, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import {
  backfillDue,
  BACKFILL_INTERVAL_MS,
  LIVE_WINDOW_MS,
  markBackfillRun,
  resetBackfillSchedule,
  selectBackfill,
} from "./backfill.js";
import type { FileState, HxState } from "./state.js";
import type { DiscoveredFile } from "./sources.js";

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const DAY = 86_400_000;

const file = (path: string, size: number, ageDays: number): DiscoveredFile => ({
  path,
  size,
  mtimeMs: NOW - ageDays * DAY,
  source: "claude",
  rootDir: "/root",
});

const entry = (path: string, offsets: Record<string, number>): FileState => ({
  path,
  family: "claude-cli",
  sessionId: path,
  offsets,
  lastMtimeMs: NOW,
  lastUploadAtMs: NOW,
});

const stateWith = (...entries: FileState[]): HxState => ({
  files: Object.fromEntries(entries.map((e) => [e.path, e])),
});

describe("selectBackfill", () => {
  it("picks up a file that aged out with NO upload state — the stranded case", () => {
    // The exact shape measured on a real device: 106 files, 112.5 MB, no state
    // entry at all. Live discovery cannot see them (past the window) and the
    // reattribute sweep skips them ("live ingest owns them" — it does not).
    const out = selectBackfill([file("old", 5_000, 45)], { files: {} }, NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.path, "old");
  });

  it("picks up a partial that aged out mid-upload", () => {
    const out = selectBackfill([file("old", 5_000, 45)], stateWith(entry("old", { letai: 1_000 })), NOW);
    assert.equal(out.length, 1);
  });

  it("leaves a fully delivered old file alone", () => {
    const out = selectBackfill([file("old", 5_000, 45)], stateWith(entry("old", { letai: 5_000 })), NOW);
    assert.equal(out.length, 0);
  });

  it("stays eligible while ANY destination is still owed bytes", () => {
    // minOffset, not one store: a file complete on the primary but zero on a
    // second destination is not delivered.
    const out = selectBackfill(
      [file("old", 5_000, 45)],
      stateWith(entry("old", { letai: 5_000, orgA: 0 })),
      NOW,
    );
    assert.equal(out.length, 1);
  });

  it("never touches files inside the live window, even undelivered ones", () => {
    // The hot loop owns those; claiming them here would queue the same file
    // twice in one pass.
    const out = selectBackfill([file("fresh", 5_000, 2)], { files: {} }, NOW);
    assert.equal(out.length, 0);
  });

  it("treats the window boundary as belonging to the live sweep", () => {
    const exactly = selectBackfill(
      [{ ...file("edge", 10, 0), mtimeMs: NOW - LIVE_WINDOW_MS }],
      { files: {} },
      NOW,
    );
    assert.equal(exactly.length, 0, "exactly at the window is still live");
    const past = selectBackfill(
      [{ ...file("edge", 10, 0), mtimeMs: NOW - LIVE_WINDOW_MS - 1 }],
      { files: {} },
      NOW,
    );
    assert.equal(past.length, 1);
  });

  it("separates a mixed disk correctly", () => {
    const out = selectBackfill(
      [
        file("fresh-undelivered", 100, 1),
        file("old-never-seen", 100, 60),
        file("old-partial", 100, 60),
        file("old-done", 100, 60),
      ],
      stateWith(entry("old-partial", { letai: 40 }), entry("old-done", { letai: 100 })),
      NOW,
    );
    assert.deepEqual(out.map((f) => f.path).sort(), ["old-never-seen", "old-partial"]);
  });
});

describe("backfill schedule", () => {
  beforeEach(() => resetBackfillSchedule());

  it("is due on the very first call so a restart always sweeps once", () => {
    assert.equal(backfillDue("main", NOW), true);
  });

  it("is not due again until the interval elapses", () => {
    markBackfillRun("main", NOW);
    assert.equal(backfillDue("main", NOW + BACKFILL_INTERVAL_MS - 1), false);
    assert.equal(backfillDue("main", NOW + BACKFILL_INTERVAL_MS), true);
  });

  it("tracks lanes independently", () => {
    markBackfillRun("main", NOW);
    assert.equal(backfillDue("main", NOW), false);
    assert.equal(backfillDue("local", NOW), true, "the --local tee sweeps on its own schedule");
  });
});

// The coverage matrix the backfill + the (now unwindowed) canonical audit
// must jointly satisfy after a gateway change. Neither mechanism covers it
// alone, and a gap in either one loses history silently.
describe("gateway-change coverage matrix", () => {
  const OLD = 60; // days — outside the live window
  const NEW = 2;  // days — inside it

  it("backfill owns >30d files with NO delivery record", () => {
    const out = selectBackfill([file("old-never", 100, OLD)], { files: {} }, NOW);
    assert.equal(out.length, 1);
  });

  it("backfill DELIBERATELY skips >30d files whose offsets claim delivery", () => {
    // This is the case the audit must cover: after beta → prod the offsets are
    // stale-but-complete, so the file looks done. If the audit is windowed,
    // nothing reaches this file and its history never re-uploads.
    const state = stateWith(entry("old-looks-done", { letai: 100 }));
    const out = selectBackfill([file("old-looks-done", 100, OLD)], state, NOW);
    assert.equal(out.length, 0, "backfill must not claim it — the audit verifies it against the server");
  });

  it("backfill leaves everything inside the live window to the hot loop", () => {
    const state = stateWith(entry("fresh", { letai: 40 }));
    assert.equal(selectBackfill([file("fresh", 100, NEW)], state, NOW).length, 0);
  });

  it("a partial >30d file is still claimed by backfill", () => {
    const state = stateWith(entry("old-partial", { letai: 40 }));
    assert.equal(selectBackfill([file("old-partial", 100, OLD)], state, NOW).length, 1);
  });
});
