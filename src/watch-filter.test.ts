import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { collectBehind, filterWatched, snapshotFrom } from "./watch.js";
import { DEFAULT_SETTINGS, type HxSettings } from "./settings.js";
import type { DiscoveredFile } from "./sources.js";
import type { FileState, HxState } from "./state.js";

const file = (p: string): DiscoveredFile => ({ path: p, size: 10, mtimeMs: 1, source: "claude", rootDir: "/home/u/.claude" });

const entry = (p: string, over: Partial<FileState>): FileState => ({
  path: p,
  family: "claude-cli",
  sessionId: p,
  offsets: {},
  lastMtimeMs: 1,
  lastUploadAtMs: 0,
  ...over,
});

// Asserts POSIX path semantics with POSIX literals, so it cannot hold on
// Windows, where those are not absolute paths. Not a gap in Windows support.
describe.skipIf(process.platform === "win32")("filterWatched", () => {
  const files = [file("/a"), file("/b"), file("/c")];
  const state: HxState = {
    files: {
      "/a": entry("/a", { cwd: "~/keep", repoSlug: "acme/app" }),
      "/b": entry("/b", { cwd: "~/private", repoSlug: null }),
      // "/c" has no entry yet — must pass (the tick's pre-upload check covers it)
    },
  };

  it("passes everything under default settings", () => {
    assert.deepEqual(filterWatched(files, state, DEFAULT_SETTINGS).map((f) => f.path), ["/a", "/b", "/c"]);
  });

  it("drops excluded folders but keeps unknown files", () => {
    const s: HxSettings = { ...DEFAULT_SETTINGS, excludeRules: ["~/private"] };
    assert.deepEqual(filterWatched(files, state, s).map((f) => f.path), ["/a", "/c"]);
  });

  it("drops repo-less sessions when personal sync is off", () => {
    const s: HxSettings = { ...DEFAULT_SETTINGS, personalSync: false };
    assert.deepEqual(filterWatched(files, state, s).map((f) => f.path), ["/a", "/c"]);
  });

  it("drops sessions the server permanently deleted (tombstoned)", () => {
    const s: HxState = { ...state, deletedSessions: { "claude-cli:/b": 1 } };
    assert.deepEqual(filterWatched(files, s, DEFAULT_SETTINGS).map((f) => f.path), ["/a", "/c"]);
  });

  it("still passes an untracked file even when its session is tombstoned", () => {
    // No state entry means no identity to match here — the tick seeds the
    // entry and its local tombstone check (or, if the tombstone was lost, one
    // 410 round trip) stops the upload; the next pass drops the file above.
    const s: HxState = { files: {}, deletedSessions: { "claude-cli:/c": 1 } };
    assert.deepEqual(filterWatched([file("/c")], s, DEFAULT_SETTINGS).map((f) => f.path), ["/c"]);
  });

  it("keeps a tombstoned session out of the sync snapshot entirely", () => {
    // The incident shape: a fully-present local file whose session was hard-
    // deleted server-side read as "1 session pending" in hx status forever.
    const s: HxState = { ...state, deletedSessions: { "claude-cli:/b": 1 } };
    const snap = snapshotFrom(filterWatched(files, s, DEFAULT_SETTINGS), s);
    assert.equal(snap.total, 2);
    assert.equal(snap.totalBytes, 20);
  });

  it("keeps a tombstoned session out of the behind/unwatched fold too", () => {
    // Same contract once the file ages past the discovery window: a deleted
    // session is neither "behind" nor "unwatched" — without the gate it would
    // resurface in Sync gaps and redden `hx doctor sync` after ~30 days.
    const p = "/home/u/.claude/projects/x/gone.jsonl";
    const roots = [{ configDir: "/home/u/.claude", origin: "default" as const, exists: true }];
    const base: HxState = {
      files: { [p]: entry(p, { lastKnownSize: 10, offsets: {} }) },
    };
    const withoutTombstone = collectBehind(base, new Set(), new Set(), roots);
    assert.equal(withoutTombstone.behind.length, 1);
    const s: HxState = { ...base, deletedSessions: { [`claude-cli:${p}`]: 1 } };
    const withTombstone = collectBehind(s, new Set(), new Set(), roots);
    assert.equal(withTombstone.behind.length, 0);
    assert.equal(withTombstone.unwatched, 0);
  });
});
