import { describe, it, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import {
  backfillDue,
  BACKFILL_INTERVAL_MS,
  markBackfillRun,
  mergeBackfill,
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

  it("claims a RECENT undelivered file — the blind spot the age test created", () => {
    // The regression this module now exists to prevent. A file appended minutes
    // ago inside a project directory untouched for a year is invisible to the
    // hot loop, which prunes by DIRECTORY mtime, and appending never bumps
    // that. While selection mirrored the live window this file belonged to no
    // sweep at all: owed forever, and reported as owed, because the status
    // report scans unwindowed. Age is not a proxy for "someone else owns it".
    const out = selectBackfill([file("fresh", 5_000, 0)], { files: {} }, NOW);
    assert.equal(out.length, 1, "owed-ness alone decides — never age");
  });

  it("ignores the clock entirely", () => {
    // Selection must be a pure function of (on disk, still owed). Pinning it
    // stops anyone reintroducing a window as an optimisation.
    const files = [file("a", 10, 0), file("b", 10, 400)];
    const at = (now: number) => selectBackfill(files, { files: {} }, now).map((f) => f.path);
    assert.deepEqual(at(NOW), ["a", "b"]);
    assert.deepEqual(at(NOW + 1_000 * DAY), ["a", "b"]);
    assert.deepEqual(at(0), ["a", "b"]);
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
    assert.deepEqual(out.map((f) => f.path).sort(), [
      "fresh-undelivered",
      "old-never-seen",
      "old-partial",
    ]);
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

  it("backfill also claims inside-window files, and the merge — not age — dedupes", () => {
    // Selection is deliberately overlapping now; mergeBackfill is what keeps
    // the hot loop and the sweep from queueing one file twice.
    const state = stateWith(entry("fresh", { letai: 40 }));
    const picked = selectBackfill([file("fresh", 100, NEW)], state, NOW);
    assert.equal(picked.length, 1, "owed is owed, whatever its age");
    const live = [file("fresh", 100, NEW)];
    assert.deepEqual(mergeBackfill(live, picked).added, [], "the pass already holds it");
  });

  it("a partial >30d file is still claimed by backfill", () => {
    const state = stateWith(entry("old-partial", { letai: 40 }));
    assert.equal(selectBackfill([file("old-partial", 100, OLD)], state, NOW).length, 1);
  });
});

// The merge is the whole duplicate-suppression story now that selection no
// longer partitions by age. It used to be three inline lines inside tickOnce,
// which is why none of this was covered.
describe("mergeBackfill", () => {
  it("drops sweep results the pass already holds", () => {
    const live = [file("a", 10, 1), file("b", 10, 1)];
    const { files, added } = mergeBackfill(live, [file("b", 10, 1), file("c", 10, 1)]);
    assert.deepEqual(added.map((f) => f.path), ["c"]);
    assert.deepEqual(files.map((f) => f.path), ["a", "b", "c"]);
  });

  it("collapses duplicates WITHIN the sweep result too", () => {
    // Not hygiene. Downstream, one path twice in a pass reads as two devices
    // contending for one session, and the contention path resets offsets — so
    // a duplicate here would re-upload a healthy file from zero, every sweep.
    const { files, added } = mergeBackfill([], [file("a", 10, 1), file("a", 10, 1)]);
    assert.equal(added.length, 1);
    assert.equal(files.length, 1);
  });

  it("returns the original array identity when nothing is added", () => {
    const live = [file("a", 10, 1)];
    const { files, added } = mergeBackfill(live, [file("a", 10, 1)]);
    assert.equal(added.length, 0);
    assert.equal(files, live, "no needless copy on the common path");
  });

  it("is a no-op on an empty sweep", () => {
    const live = [file("a", 10, 1)];
    assert.equal(mergeBackfill(live, []).files, live);
  });
});
